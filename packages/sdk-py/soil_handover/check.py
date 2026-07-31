"""Save-time checking and grading: the open baseline.

``check_handover`` is deterministic, lint-style analysis of the handover
document itself. Every rule has an id, a severity and a plain-language
explanation, all documented openly in ``docs/checking.md``. Same input, same
report, byte for byte, and byte-identical to the TypeScript reference in
``packages/sdk-ts/src/check.ts`` for the same document. Nothing here calls a
model, reaches the network, or measures anything outside the document.

The boundary, stated plainly: the baseline checker is deterministic analysis
of the document itself. Whether a handover actually restores a session is a
different question, answered only by a real load.

The grade band belongs to the report and stops there. It is printed on the
card, present in ``--json``, and it decides the exit code. It is NOT written
into the document: the ``quality.capture`` observation this module builds
carries counts, names and findings, and no band, no score and no aggregate of
any kind. A judgement made by a producer the reader never met has no business
travelling inside the thing it judges.

Two string units live in this module and they answer two different questions.
The ``notes`` bound is counted in Unicode code points with
:func:`~soil_handover.sections.text_length`, the format's unit. The rule
thresholds and the numbers quoted inside finding messages are counted in
UTF-16 code units, because the reference implementation measures them with
JavaScript's ``String.prototype.length`` and a port that counted differently
would produce a different report for the same bytes.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Callable

from .sections import SECTION_KEYS, SECTION_TIERS, text_length
from .store import count_sections
from .types import Handover, HandoverObservation, SectionCounts

#: The version of this rule set. It moves when a rule is added or tuned, so a
#: report always says which rules produced it.
CHECK_VERSION = "1.0.0"

#: The grade bands, best first.
CHECK_GRADES = ("strong", "adequate", "thin", "failing")

#: How much one rule outcome matters, decided by the rule that produced it. A
#: ``problem`` undermines the document's ability to restore anything. A
#: ``caution`` is a concrete weakness worth fixing. ``advice`` is a soft
#: signal that never lowers the grade.
#:
#: Severity classifies the individual rule outcome. It is never a judgement of
#: the handover, and summing severities into one word is the report's
#: business, not the document's.
CHECK_SEVERITIES = ("problem", "caution", "advice")

#: Every rule in the baseline, with its one-line explanation. The full
#: rationale for each lives in ``docs/checking.md``; this mapping is what the
#: CLI prints next to a finding.
CHECK_RULES: dict[str, str] = {
    "completeness.missing-without-reason": (
        "a section is declared missing with no reason stated anywhere"
    ),
    "completeness.no-durable-truth": (
        "no durable-tier section carries content, so nothing outlives the"
        " session"
    ),
    "self-containment.fetch-pointer": (
        "the text sends the reader somewhere else instead of carrying the"
        " content"
    ),
    "time.unanchored": (
        "a frontier section uses time words with no capture-time anchor"
    ),
    "decisions.entry-without-reason": (
        "a decision is stated with no recorded reason, which invites"
        " relitigation"
    ),
    "anchors.no-exact-values": (
        "the section talks about configuration but carries no exact values"
    ),
    "gaps.blocked-without-omission-note": (
        "a section was withheld but the safety record does not say what or"
        " where"
    ),
    "restore.absent": (
        "content was captured but there are no restore instructions to boot"
        " it"
    ),
    "restore.thin": (
        "the restore instructions are far shorter than the content they must"
        " boot"
    ),
    "size.one-liner": (
        "a one-line section in an otherwise rich document reads as thinness"
    ),
}


@dataclass(frozen=True)
class CheckFinding:
    """One finding from one rule.

    ``section`` is the section the finding points at, or ``None`` for a
    document-level finding.
    """

    rule: str
    severity: str
    message: str
    section: str | None = None


@dataclass(frozen=True)
class CheckCounts:
    """Findings counted by severity."""

    problems: int
    cautions: int
    advice: int


@dataclass(frozen=True)
class CheckReport:
    """The whole report. Ephemeral output: nothing in it is part of the
    document.

    ``grade`` is the band. Report only: it is never written onto a handover.
    ``sections`` holds the section counts, as ``count_sections`` reports them.
    """

    check_version: str
    grade: str
    counts: CheckCounts
    findings: tuple[CheckFinding, ...]
    sections: SectionCounts


def grade_from_counts(counts: CheckCounts) -> str:
    """The grade mapping, documented in ``docs/checking.md`` and applied
    nowhere else. Counts in, band out, no judgement calls:

    - ``failing``: 3 or more problems
    - ``thin``: 1 or 2 problems, or 6 or more cautions
    - ``adequate``: no problems, 1 to 5 cautions
    - ``strong``: no problems, no cautions; advice never lowers the grade
    """
    if counts.problems >= 3:
        return "failing"
    if counts.problems >= 1 or counts.cautions >= 6:
        return "thin"
    if counts.cautions >= 1:
        return "adequate"
    return "strong"


# The reference implementation runs on JavaScript strings, so its ``trim``,
# its ``\\s`` and its ``\\b`` are ECMAScript's. Python's defaults differ at
# the edges (``str.strip`` keeps a byte order mark, ``\\s`` and ``\\b`` read
# the whole Unicode table), and a checker that trims or matches differently
# produces a different report for the same document. So the ECMAScript sets
# are spelled out once here and used everywhere in this module.
_JS_WHITESPACE = (
    "\t\n\v\f\r \u00a0\u1680"
    + "".join(chr(c) for c in range(0x2000, 0x200B))
    + "\u2028\u2029\u202f\u205f\u3000\ufeff"
)

# The same set as a regex class body, for the places the reference writes \s.
_WS = (
    "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a"
    "\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
)


def _js_trim(text: str) -> str:
    return text.strip(_JS_WHITESPACE)


def _u16_len(text: str) -> int:
    """The string's length in UTF-16 code units, the unit the reference
    measures rule thresholds in."""
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in text)


def _u16_slice(text: str, units: int) -> str:
    """The prefix of ``text`` that fits in at most ``units`` UTF-16 code
    units, never splitting a surrogate pair."""
    n = 0
    for i, ch in enumerate(text):
        width = 2 if ord(ch) > 0xFFFF else 1
        if n + width > units:
            return text[:i]
        n += width
    return text


# ECMAScript regex flags: the reference's /i patterns fold ASCII case, and its
# \b, \d and \w are ASCII. re.ASCII pins Python's \b and \d to the same sets.
_FLAGS = re.IGNORECASE | re.ASCII

# Phrases that point away from the document. A handover assumes its reader
# has nothing else, so "see the repo" is content that failed to travel. Each
# pattern is a heuristic: deterministic, documented, and tuned to phrases
# that present somewhere else as where the content lives.
_FETCH_POINTERS = [
    re.compile(
        r"\bsee (?:the )?(?:repo|repository|docs|documentation|readme|wiki"
        r"|codebase|source|thread|conversation|chat)\b",
        _FLAGS,
    ),
    re.compile(r"\bin the (?:docs|documentation|readme|wiki)\b", _FLAGS),
    re.compile(r"\bconsult\b", _FLAGS),
    re.compile(r"\brefer to\b", _FLAGS),
    re.compile(
        rf"\b(?:see|check|visit|read|browse)[{_WS}]+https?://",
        _FLAGS,
    ),
    re.compile(
        rf"\b(?:described|documented|explained|detailed|available|found)"
        rf"[{_WS}]+(?:at|in)[{_WS}]+https?://",
        _FLAGS,
    ),
]

# Words that are true only at one moment.
_VOLATILE_TERMS = re.compile(
    r"\b(?:currently|right now|now|today|tonight|yesterday|tomorrow"
    r"|this week|last week|this morning|this afternoon|at the moment"
    r"|just now|recently)\b",
    _FLAGS,
)

# Phrases that pin volatile words to the capture.
_CAPTURE_ANCHORS = re.compile(
    r"\b(?:at capture|at the capture|as of (?:this|the) capture"
    r"|at the time of capture|when this was (?:captured|written)"
    r"|at save time|as of \d{4}-\d{2}-\d{2})\b",
    _FLAGS,
)

# Verbs that state a decision. Scoped to the decisions section only.
_DECISION_VERBS = re.compile(
    r"\b(?:decided|decision|locked|chose|chosen|agreed|settled|adopted"
    r"|picked|selected|went with|opted|will use|use[sd]?|switched to"
    r"|migrated to|standardi[sz]ed)\b",
    _FLAGS,
)

# Markers that a reason was recorded. ``cannot`` and ``could not`` count
# because a stated inability is a stated reason.
_REASON_MARKERS = re.compile(
    r"\b(?:because|since|due to|so that|reason|why|after|caused|led to"
    r"|avoid|avoids|avoided|prevent|prevents|prevented|otherwise"
    r"|rather than|instead of|cannot|could not)\b",
    _FLAGS,
)

# Terms that say the section is talking about configuration.
_CONFIG_TERMS = re.compile(
    r"\b(?:config|configuration|configured|environment variable|env var"
    r"|port|version|pinned|flag|timeout|limit|ceiling|budget|quota"
    r"|threshold)\b",
    _FLAGS,
)

_ASCII_DIGIT = re.compile(r"\d", re.ASCII)

_WS_RUN = re.compile(rf"[{_WS}]+")

_ENTRY_MARKER = re.compile(rf"(?:\d+[.)][{_WS}]+|[-*•▸][{_WS}]+)", re.ASCII)

# The floor parameters for the restore-instructions length rule.
_RESTORE_MIN_CHARS = 300
_RESTORE_FRACTION = 0.05
_RESTORE_APPLIES_FROM = 1000

# The parameters for the one-liner rule.
_ONE_LINER_MAX_CHARS = 40
_ONE_LINER_MIN_SECTIONS = 5
_ONE_LINER_MIN_MEDIAN = 200


def _available_summary(handover: Handover, key: str) -> str | None:
    sections = handover.get("sections") or {}
    section = sections.get(key)
    if not isinstance(section, dict):
        return None
    summary = section.get("summary")
    if (
        section.get("status") == "available"
        and isinstance(summary, str)
        and len(_js_trim(summary)) > 0
    ):
        return summary
    return None


def _first_match(text: str, patterns: list[re.Pattern[str]]) -> str | None:
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            return match.group(0)
    return None


def split_entries(text: str) -> list[str]:
    """Split a section's prose into entries: numbered items, bulleted items,
    and blank-line-separated paragraphs. Deterministic, no interpretation."""
    entries: list[str] = []
    current: list[str] = []

    def flush() -> None:
        nonlocal current
        if current:
            entries.append(" ".join(current))
        current = []

    for raw in text.split("\n"):
        line = _js_trim(raw)
        if len(line) == 0:
            flush()
            continue
        if _ENTRY_MARKER.match(line):
            flush()
        current.append(line)
    flush()
    return entries


def _lower_median(values: list[int]) -> int:
    """The lower median of a list of numbers."""
    ordered = sorted(values)
    if not ordered:
        return 0
    return ordered[(len(ordered) - 1) // 2]


def _preview(text: str, maximum: int = 60) -> str:
    flat = _js_trim(_WS_RUN.sub(" ", text))
    if _u16_len(flat) <= maximum:
        return flat
    return f"{_u16_slice(flat, maximum - 1)}…"


def _note_list(handover: Handover, group: str, key: str) -> list[str]:
    record = handover.get(group)
    if not isinstance(record, dict):
        return []
    entries = record.get(key)
    if not isinstance(entries, list):
        return []
    return [entry for entry in entries if isinstance(entry, str)]


def check_handover(handover: Handover) -> CheckReport:
    """Check a handover: run every rule, count the findings, map the counts
    to a grade band. The input is assumed structurally valid; run
    ``validate_handover`` first, the way the CLI does.

    Pure and deterministic on purpose. No I/O, no clock, no randomness, no
    model. The report is honest exactly because every finding can be traced
    to a documented rule and re-produced by anyone from the same bytes.
    """
    findings: list[CheckFinding] = []

    def add(
        rule: str,
        severity: str,
        message: str,
        section: str | None = None,
    ) -> None:
        findings.append(
            CheckFinding(
                rule=rule, severity=severity, message=message, section=section
            )
        )

    sections = handover.get("sections") or {}
    missing_inputs = _note_list(handover, "quality", "missingInputs")
    unsafe_omissions = _note_list(handover, "safety", "unsafeOmissions")

    # completeness.missing-without-reason: a gap is fine, an unexplained gap
    # is not. A reason can live in the section's own note or in the
    # document-level quality.missingInputs list.
    if len(missing_inputs) == 0:
        for key in SECTION_KEYS:
            section = sections.get(key)
            if not isinstance(section, dict):
                continue
            summary = section.get("summary")
            if section.get("status") == "missing" and (
                summary is None
                or (isinstance(summary, str) and len(_js_trim(summary)) == 0)
            ):
                add(
                    "completeness.missing-without-reason",
                    "caution",
                    "declared missing, with no note here and nothing in"
                    " quality.missingInputs saying why",
                    key,
                )

    # gaps.blocked-without-omission-note: blocked means withheld for safety,
    # and the safety record is where the withheld fact is supposed to be.
    for key in SECTION_KEYS:
        section = sections.get(key)
        if (
            isinstance(section, dict)
            and section.get("status") == "blocked"
            and len(unsafe_omissions) == 0
        ):
            add(
                "gaps.blocked-without-omission-note",
                "caution",
                "withheld for safety, but safety.unsafeOmissions does not"
                " name what exists or where it is configured",
                key,
            )

    # completeness.no-durable-truth: with zero durable sections, nothing in
    # the document outlives the session it came from.
    durable_available = [
        key
        for key in SECTION_KEYS
        if SECTION_TIERS[key] == "durable"
        and _available_summary(handover, key) is not None
    ]
    if len(durable_available) == 0:
        add(
            "completeness.no-durable-truth",
            "problem",
            "none of the six durable-tier sections carries content, so the"
            " project's lasting truth did not travel",
        )

    # self-containment.fetch-pointer: per section. A pointer inside the
    # restore instructions is a problem, because the boot prompt must stand
    # alone; in any other section it is a caution.
    for key in SECTION_KEYS:
        text = _available_summary(handover, key)
        if text is None:
            continue
        match = _first_match(text, _FETCH_POINTERS)
        if match is not None:
            add(
                "self-containment.fetch-pointer",
                "problem" if key == "restoreInstructions" else "caution",
                f'sends the reader elsewhere ("{_preview(match, 40)}"), but a'
                " handover reader has no repo, no docs and no earlier thread",
                key,
            )

    # time.unanchored: frontier sections describe a moment. Time words with
    # no capture anchor in the same section will read as the present to a
    # reader arriving later.
    for key in SECTION_KEYS:
        if SECTION_TIERS[key] != "frontier":
            continue
        text = _available_summary(handover, key)
        if text is None:
            continue
        volatile = _VOLATILE_TERMS.search(text)
        if volatile and not _CAPTURE_ANCHORS.search(text):
            add(
                "time.unanchored",
                "caution",
                f'uses "{volatile.group(0)}" with no capture-time anchor, so'
                " a later reader cannot tell when it was true",
                key,
            )

    # decisions.entry-without-reason: a decision with no recorded reason is
    # the exact thing a later session relitigates.
    decisions_text = _available_summary(handover, "decisions")
    if decisions_text is not None:
        for i, entry in enumerate(split_entries(decisions_text)):
            if _DECISION_VERBS.search(entry) and not _REASON_MARKERS.search(
                entry
            ):
                add(
                    "decisions.entry-without-reason",
                    "caution",
                    f"entry {i + 1} states a decision with no recorded reason"
                    f' ("{_preview(entry)}")',
                    "decisions",
                )

    # anchors.no-exact-values: architecture and constraints that mention
    # configuration but carry no digits have probably lost their pins.
    for key in ("architecture", "constraints"):
        text = _available_summary(handover, key)
        if (
            text is not None
            and _CONFIG_TERMS.search(text)
            and not _ASCII_DIGIT.search(text)
        ):
            add(
                "anchors.no-exact-values",
                "advice",
                "mentions configuration but holds no numbers, versions or"
                " pins; exact values are what survive a move",
                key,
            )

    # restore.absent and restore.thin: the restore instructions are the boot
    # prompt. Captured content with no boot prompt, or a boot prompt far
    # smaller than the content, will not bring a cold session back.
    restore_text = _available_summary(handover, "restoreInstructions")
    other_available_chars = sum(
        _u16_len(_available_summary(handover, key) or "")
        for key in SECTION_KEYS
        if key != "restoreInstructions"
    )
    if restore_text is None and other_available_chars > 0:
        add(
            "restore.absent",
            "problem",
            "content was captured but restoreInstructions is empty, so"
            " nothing tells the next session how to begin",
            "restoreInstructions",
        )
    if (
        restore_text is not None
        and other_available_chars >= _RESTORE_APPLIES_FROM
    ):
        floor = max(
            _RESTORE_MIN_CHARS,
            math.floor(other_available_chars * _RESTORE_FRACTION),
        )
        if _u16_len(restore_text) < floor:
            add(
                "restore.thin",
                "problem",
                f"the restore instructions are {_u16_len(restore_text)}"
                f" characters against {other_available_chars} of captured"
                f" content, below the documented floor of {floor}",
                "restoreInstructions",
            )

    # size.one-liner: in a document whose sections are otherwise substantial,
    # a near-empty available section is a thinness signal, not an error.
    available_lengths = [
        _u16_len(text)
        for text in (
            _available_summary(handover, key) for key in SECTION_KEYS
        )
        if text is not None
    ]
    if (
        len(available_lengths) >= _ONE_LINER_MIN_SECTIONS
        and _lower_median(available_lengths) >= _ONE_LINER_MIN_MEDIAN
    ):
        for key in SECTION_KEYS:
            text = _available_summary(handover, key)
            if text is not None and _u16_len(text) < _ONE_LINER_MAX_CHARS:
                add(
                    "size.one-liner",
                    "advice",
                    f"carries {_u16_len(text)} characters in a document whose"
                    " sections are otherwise substantial",
                    key,
                )

    # Deterministic order: document-level findings first, then sections in
    # canonical order, then rule id, then message.
    def section_index(key: str | None) -> int:
        return -1 if key is None else SECTION_KEYS.index(key)

    findings.sort(
        key=lambda f: (section_index(f.section), f.rule, f.message)
    )

    counts = CheckCounts(
        problems=sum(1 for f in findings if f.severity == "problem"),
        cautions=sum(1 for f in findings if f.severity == "caution"),
        advice=sum(1 for f in findings if f.severity == "advice"),
    )

    return CheckReport(
        check_version=CHECK_VERSION,
        grade=grade_from_counts(counts),
        counts=counts,
        findings=tuple(findings),
        sections=count_sections(handover),
    )


#: The upper bound on ``notes`` in a ``quality.capture`` payload, in Unicode
#: code points, the unit every length bound in this format is counted in. See
#: :func:`~soil_handover.sections.text_length` and ``spec/value-domain.md``.
#:
#: ``notes`` is short, non-evaluative context: what the producer wants a
#: reader to know about how the examination was made. It is deliberately too
#: small to become a container for a hidden aggregate, and
#: :func:`check_observation` refuses anything longer rather than truncating a
#: claim in the middle.
CHECK_NOTES_MAX_CHARS = 280

#: The note this module writes when the caller supplies none. It states what
#: kind of examination ran and nothing about how the result compares to
#: anything, because a comparison is a judgement.
CHECK_DEFAULT_NOTES = (
    "Structural examination of the document by the open deterministic"
    " baseline. Section statuses and rule outcomes only."
)


def check_observation(
    handover: Handover,
    report: CheckReport,
    produced_by: str,
    produced_at: str,
    notes: str | None = None,
) -> HandoverObservation:
    """Package a report as a ``quality.capture`` observation, ready to attach
    to the stored handover.

    ``produced_by`` names the tool that ran the check, with a version, e.g.
    ``soil-cli/0.1.0``; ``produced_at`` is when the check ran (ISO 8601);
    ``notes`` is short non-evaluative context, at most
    :data:`CHECK_NOTES_MAX_CHARS` code points, defaulting to
    :data:`CHECK_DEFAULT_NOTES`.

    The payload is a closed field set, documented in ``spec/observations.md``:

        sectionsWithContent, missingSections, blockedSections, findings,
        checkVersion, notes

    and nothing else. In particular no ``grade``, no band, no score, and no
    counts-by-severity roll-up. Those exist in the report, where the reader
    can see who produced them and when; they do not exist on the document,
    where a later reader would meet the verdict without ever meeting the
    producer.

    This does not make the band underivable, and pretending otherwise would
    be its own dishonesty. Anyone holding this payload plus the published
    mapping in ``docs/checking.md`` can count the severities and recompute
    the band exactly. The difference is who makes that derivation, and
    whether the threshold is in front of them when they do.
    """
    resolved_notes = notes if notes is not None else CHECK_DEFAULT_NOTES
    if text_length(resolved_notes) > CHECK_NOTES_MAX_CHARS:
        raise ValueError(
            f"quality.capture notes must be at most {CHECK_NOTES_MAX_CHARS}"
            f" code points, got {text_length(resolved_notes)}"
        )
    sections = handover.get("sections") or {}

    # Section KEYS, not prose labels: ``missingSections`` and
    # ``blockedSections`` are addresses a reader can look up, the same
    # identifiers ``location`` uses.
    def named(status: str) -> list[str]:
        return [
            key
            for key in SECTION_KEYS
            if isinstance(sections.get(key), dict)
            and sections[key].get("status") == status
        ]

    return {
        "kind": "quality.capture",
        "producedBy": produced_by,
        "producedAt": produced_at,
        "data": {
            "checkVersion": report.check_version,
            "sectionsWithContent": report.sections.with_content,
            "missingSections": named("missing"),
            "blockedSections": named("blocked"),
            "findings": [
                {
                    "rule": finding.rule,
                    # JSON-Pointer-ish, the same shape a validation issue
                    # uses. "/" is the document itself, for a rule that is
                    # not about one section.
                    "location": (
                        "/"
                        if finding.section is None
                        else f"/sections/{finding.section}"
                    ),
                    "observed": finding.message,
                    "severity": finding.severity,
                }
                for finding in report.findings
            ],
            "notes": resolved_notes,
        },
    }
