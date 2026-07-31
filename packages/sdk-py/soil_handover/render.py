"""The rail card: the ASCII shape Soil prints after a save, a load, or a list.

Design contract, do not break:

- PURE. No I/O, no clock, no randomness. Same input, byte-identical output,
  which is why the tests can pin whole cards. The cards are also
  byte-identical to the TypeScript renderer's for the same input.
- SAFE BY CALLER. The renderer formats already-safe text. It does not scan,
  redact or reconstruct anything.
- COMPUTED LAYOUT. A fixed 2-space gutter, a continuous left rail, and rules
  extended to a fixed inner width. Alignment is computed from content, never
  hardcoded, so the card lands identically in every terminal.

The card reports counts and names: how many sections carry content, which
ones do not, and what was held back on purpose. It never reports a score. A
local save has no opinion about how good your handover is.

The save card and the load card carry the same two head blocks, and they do
so on purpose. A field a writer supplies has not been delivered until a
reader sees it, and a field shown on the way in and dropped on the way out is
the same defect as one never stored: ``written by`` names the tool, the model,
the provider and the extraction recipe behind the document, and ``what this
document carries`` names the withheld sections as withheld rather than as
empty. Which section carries which provenance label is a per-section mapping
and lives in the restore prompt; the card names the kinds of claim present,
which is what fits in a column.

The section count is worded ``sections carrying content`` and never anything
that asserts capture, completeness, readiness or sufficiency, because the
count knows only that a summary string is non-empty. Seventeen sections of
two characters each also read 17 / 17. The fixed wording binds these
reference renderers; the requirement on any other interface is the meaning,
not the English (spec/README.md, normative requirement 13).
"""

from __future__ import annotations

import re

from .check import CheckFinding, CheckReport, _u16_len
from .sections import PROVENANCE_LABELS, SECTION_KEYS, SECTION_LABELS
from .store import count_sections
from .types import Handover, SectionCounts, StoreEntry, ValidationResult

_GUTTER = "  "
_INNER_WIDTH = 52
_RAIL_INDENT = "│   "
_WRAP_WIDTH = 46

_WORDS = re.compile(r"\s+")


def wrap(text: str, width: int = _WRAP_WIDTH) -> list[str]:
    """Wrap prose to ``width`` columns on word boundaries. Never splits a
    word.

    Widths are measured in UTF-16 code units, because the reference renderer
    measures them with JavaScript's ``String.prototype.length`` and a port
    that counted code points would break a line one word earlier whenever a
    word carries a character outside the Basic Multilingual Plane. For the
    plane every card so far has lived in, the two counts are the same number.
    """
    out: list[str] = []
    for paragraph in text.split("\n"):
        line = ""
        for word in (w for w in _WORDS.split(paragraph) if w):
            if len(line) == 0:
                line = word
            elif _u16_len(line) + 1 + _u16_len(word) <= width:
                line = f"{line} {word}"
            else:
                out.append(line)
                line = word
        out.append(line)
    return out


def _masthead(state: str, code: str | None = None) -> str:
    head = f"┌─ SOIL · {state} "
    tail = f" {code} ─" if code else ""
    fill = max(1, _INNER_WIDTH - len(head) - len(tail))
    return f"{_GUTTER}{head}{'─' * fill}{tail}"


def _section_rule(label: str) -> str:
    head = f"├─ {label} "
    fill = max(1, _INNER_WIDTH - len(head))
    return f"{_GUTTER}{head}{'─' * fill}"


def _footer(text: str) -> str:
    return f"{_GUTTER}└─ {text}"


def _blank() -> str:
    return f"{_GUTTER}│"


def _line(text: str) -> str:
    return f"{_GUTTER}{_RAIL_INDENT}{text}"


def _prose(text: str) -> list[str]:
    return [_line(entry) for entry in wrap(text)]


def _section_names(keys: list[str]) -> str:
    return ", ".join(SECTION_LABELS[key] for key in keys)


def _keys_with_status(handover: Handover, status: str) -> list[str]:
    sections = handover.get("sections", {})
    return [
        key
        for key in SECTION_KEYS
        if isinstance(sections.get(key), dict)
        and sections[key].get("status") == status
    ]


# Width of the label column inside the rail, e.g. `sections    `.
_LABEL_WIDTH = 12


def _content_count_line(counts: SectionCounts) -> str:
    # The one count line. Structural presence, stated as such.
    return f"{counts.with_content} / {counts.total} sections carrying content"


def _labelled(label: str, value: str) -> list[str]:
    # A labelled row whose value wraps under itself, keeping the label column
    # clear: the eye should be able to run down the labels without meeting
    # text.
    width = max(_LABEL_WIDTH, len(label) + 2)
    return [
        _line(f"{(label if i == 0 else '').ljust(width)}{text}")
        for i, text in enumerate(wrap(value, _WRAP_WIDTH - width))
    ]


def _source_rows(handover: Handover) -> list[str]:
    """The ``source`` fields, as the rows that show them.

    Labelled rather than joined with separators, because a reader met with
    ``chatgpt · gpt-5 · openai`` has to guess which token is the tool, which
    is the model and which is the provider. The label column says which is
    which, and it is the same block on the save card and the load card, so a
    field a writer supplied is a field the next reader meets. A row is
    omitted when the field is absent; a document with no ``source`` gets no
    block at all.
    """
    source = handover.get("source") or {}
    rows = (
        ("client", source.get("client")),
        ("model", source.get("model")),
        ("provider", source.get("provider")),
        ("recipe", source.get("recipeVersion")),
    )
    out: list[str] = []
    for label, value in rows:
        if not value:
            continue
        out.extend(_labelled(label, value))
    return out


def _written_by_block(handover: Handover) -> list[str]:
    """The ``written by`` block, or nothing when no source is named."""
    rows = _source_rows(handover)
    if not rows:
        return []
    return [_section_rule("written by"), _blank(), *rows, _blank()]


def _provenance_labels_present(handover: Handover) -> list[str]:
    """Every provenance label the sections carry, in the frozen order.

    The card shows which KINDS of claim a document holds. Which section
    carries which label is a mapping, and a mapping belongs where a reader can
    act on it per section, which is the restore prompt.
    """
    sections = handover.get("sections", {})
    seen: set[str] = set()
    for key in SECTION_KEYS:
        section = sections.get(key)
        if not isinstance(section, dict):
            continue
        for label in section.get("provenance") or []:
            if isinstance(label, str):
                seen.add(label)
    return [label for label in PROVENANCE_LABELS if label in seen]


def _provenance_row(handover: Handover) -> list[str]:
    """The one row that says which kinds of claim this document holds."""
    labels = _provenance_labels_present(handover)
    if not labels:
        return []
    return _labelled("provenance", ", ".join(labels))


def _evidence_rows(handover: Handover) -> list[str]:
    """The observations attached to the document, as rows that name them.

    Kinds and producers, never payloads. ``data`` is free-form and opaque to
    the specification, so a renderer cannot know how to lay out a payload it
    has never seen, and a renderer that guessed would be inventing a shape
    the producer did not agree to. What a reader needs from a card is that
    the evidence is there, what kind it is and who is answerable for it; the
    payload is one ``soil load --json`` away, and ``spec/observations.md``
    says how to read it.

    Both lists are deduplicated and joined into one wrapping row each, so a
    hundred entries of one kind cost one row rather than a hundred.
    """
    observations = handover.get("observations") or []
    if not observations:
        return []
    kinds: list[str] = []
    producers: list[str] = []
    for observation in observations:
        if not isinstance(observation, dict):
            continue
        kind = observation.get("kind")
        if isinstance(kind, str) and kind and kind not in kinds:
            kinds.append(kind)
        producer = observation.get("producedBy")
        if isinstance(producer, str) and producer and producer not in producers:
            producers.append(producer)
    out: list[str] = []
    if kinds:
        out.extend(_labelled("evidence", ", ".join(kinds)))
    if producers:
        out.extend(_labelled("recorded", ", ".join(producers)))
    return out


def _bullet_block(entries: list[str]) -> list[str]:
    out: list[str] = []
    for entry in entries:
        for i, text in enumerate(wrap(entry, _WRAP_WIDTH - 2)):
            out.append(_line(f"▸ {text}" if i == 0 else f"  {text}"))
    return out


def render_saved(handover: Handover, code: str) -> str:
    """The card printed after ``soil save``."""
    counts = count_sections(handover)
    missing = _keys_with_status(handover, "missing")
    blocked = _keys_with_status(handover, "blocked")
    not_applicable = _keys_with_status(handover, "not_applicable")

    out: list[str] = []
    out.append(_masthead("handover saved", code))
    out.append(_blank())
    out.extend(_prose(handover["title"]))
    out.append(_line(handover["projectId"]))
    out.append(_blank())
    out.extend(_written_by_block(handover))
    out.append(_section_rule("what this document carries"))
    out.append(_blank())
    out.append(_line(_content_count_line(counts)))
    if missing:
        out.extend(_labelled("no content", _section_names(missing)))
    if blocked:
        out.extend(_labelled("held back", _section_names(blocked)))
    if not_applicable:
        out.extend(_labelled("no subject", _section_names(not_applicable)))
    out.extend(_provenance_row(handover))
    out.extend(_evidence_rows(handover))
    out.append(_blank())

    gaps = (handover.get("quality") or {}).get("missingInputs") or []
    if gaps:
        out.append(_section_rule("stated gaps"))
        out.append(_blank())
        out.extend(_bullet_block(gaps))
        out.append(_blank())

    # The gaps' sibling in ``quality``. It reached the restore prompt and not
    # this card, which left the writer no way to see that what it recorded
    # landed.
    contradictions = (handover.get("quality") or {}).get("contradictions") or []
    if contradictions:
        out.append(_section_rule("unresolved contradictions"))
        out.append(_blank())
        out.extend(_bullet_block(contradictions))
        out.append(_blank())

    omissions = (handover.get("safety") or {}).get("unsafeOmissions") or []
    if omissions:
        out.append(_section_rule("held back · by design"))
        out.append(_blank())
        out.extend(_bullet_block(omissions))
        out.append(_blank())

    out.append(_section_rule("local"))
    out.append(_blank())
    out.extend(_prose("stored on this machine · no account · no network"))
    out.append(_blank())
    out.append(_footer("load it in another thread, model, or tool"))
    out.append("")
    out.append(f"          ❯ soil load {code}")
    return "\n".join(out)


def render_loaded(handover: Handover) -> str:
    """The card printed above the restore prompt on ``soil load``."""
    counts = count_sections(handover)
    missing = _keys_with_status(handover, "missing")
    # A withheld section is not an empty one. The save card said so and this
    # one did not, so a reader of the load door could not tell a section
    # nobody could see from one somebody decided not to move, which is the one
    # distinction that says whether to go looking elsewhere.
    blocked = _keys_with_status(handover, "blocked")
    not_applicable = _keys_with_status(handover, "not_applicable")
    code = handover.get("code") or ""

    out: list[str] = []
    out.append(_masthead("handover loaded", code or None))
    out.append(_blank())
    out.extend(_prose(handover["title"]))
    out.append(_line(f"{handover['projectId']} · saved {handover['createdAt']}"))
    out.append(_blank())
    out.extend(_written_by_block(handover))
    out.append(_section_rule("what this document carries"))
    out.append(_blank())
    out.append(_line(_content_count_line(counts)))
    if missing:
        out.extend(_labelled("no content", _section_names(missing)))
    if blocked:
        out.extend(_labelled("held back", _section_names(blocked)))
    if not_applicable:
        out.extend(_labelled("no subject", _section_names(not_applicable)))
    out.extend(_provenance_row(handover))
    out.extend(_evidence_rows(handover))
    out.append(_blank())
    out.append(_section_rule("read it this way"))
    out.append(_blank())
    out.extend(
        _prose(
            "durable sections still hold · frontier sections describe the"
            " moment of capture, not now · check fast-moving state before"
            " trusting it"
        )
    )
    out.append(_blank())
    out.append(
        _footer("the restore prompt follows · paste it into the new session")
    )
    return "\n".join(out)


def render_list(entries: list[StoreEntry]) -> str:
    """The card printed by ``soil list``."""
    out: list[str] = []
    out.append(_masthead("handovers"))
    out.append(_blank())
    if not entries:
        out.extend(_prose("nothing saved yet · run `soil save` to start"))
        out.append(_blank())
        out.append(_footer("local store · ~/.soil"))
        return "\n".join(out)
    for entry in entries:
        title = (
            f"{entry['title'][:27]}…"
            if len(entry["title"]) > 28
            else entry["title"]
        )
        out.append(
            _line(
                f"▸ {entry['code']}  {title.ljust(28)}"
                f" {str(entry['sectionsWithContent']).rjust(2)}/17"
            )
        )
    out.append(_blank())
    # The ratio is the one number here, so the one number says what it is.
    out.extend(_prose("the ratio counts sections carrying content"))
    out.append(_blank())
    out.append(
        _footer(f"{len(entries)} stored · load one with `soil load #NNN`")
    )
    return "\n".join(out)


def _pluralize(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def render_check(handover: Handover, report: CheckReport) -> str:
    """The card printed by ``soil check``: the grade band, the findings
    grouped by section, and the boundary the checker lives behind.
    Deterministic like every renderer here; the report is already sorted, and
    this only lays it out.
    """
    out: list[str] = []
    out.append(_masthead("handover checked", handover.get("code")))
    out.append(_blank())
    out.extend(_prose(handover["title"]))
    out.append(_line(handover["projectId"]))
    out.append(_blank())
    out.append(_section_rule("grade"))
    out.append(_blank())
    out.append(_line(report.grade))
    out.append(
        _line(
            f"{_pluralize(report.counts.problems, 'problem')}"
            f" · {_pluralize(report.counts.cautions, 'caution')}"
            f" · {report.counts.advice} advice"
        )
    )
    out.append(_blank())
    out.append(_section_rule("findings"))
    out.append(_blank())
    if not report.findings:
        out.extend(_prose("none · every rule passed on this document"))
        out.append(_blank())
    else:
        groups: dict[str, list[CheckFinding]] = {}
        for finding in report.findings:
            label = (
                "the document"
                if finding.section is None
                else SECTION_LABELS[finding.section]
            )
            groups.setdefault(label, []).append(finding)
        for label, group in groups.items():
            out.append(_line(label))
            for finding in group:
                out.append(_line(f"▸ {finding.rule} · {finding.severity}"))
                for text in wrap(finding.message, _WRAP_WIDTH - 2):
                    out.append(_line(f"  {text}"))
            out.append(_blank())
    out.append(
        _footer(
            "checked from the document alone · only a real load proves"
            " restore"
        )
    )
    return "\n".join(out)


def render_validation(result: ValidationResult, label: str) -> str:
    """The card printed for a validation result."""
    unsafe = [issue for issue in result.issues if issue.kind == "safety"]
    out: list[str] = []
    out.append(
        _masthead(
            "valid handover"
            if result.valid
            else "refused · secret material"
            if unsafe
            else "not a handover"
        )
    )
    out.append(_blank())
    out.append(_line(label))
    out.append(_blank())
    if result.valid:
        out.append(_section_rule("shape"))
        out.append(_blank())
        out.extend(_prose("every required field is present and well formed"))
        out.append(_blank())
        out.append(
            _footer(
                "structure only · this says nothing about how good the"
                " content is"
            )
        )
        return "\n".join(out)
    if unsafe:
        out.append(_section_rule("nothing was stored"))
        out.append(_blank())
        for issue in unsafe:
            for i, text in enumerate(
                wrap(f"{issue.path} {issue.message}", _WRAP_WIDTH - 2)
            ):
                out.append(_line(f"✗ {text}" if i == 0 else f"  {text}"))
        out.append(_blank())

    structural = [issue for issue in result.issues if issue.kind != "safety"]
    if structural:
        out.append(_section_rule(f"{len(structural)} problem(s)"))
        out.append(_blank())
        for issue in structural:
            for i, text in enumerate(
                wrap(f"{issue.path or '/'} {issue.message}", _WRAP_WIDTH - 2)
            ):
                out.append(_line(f"✗ {text}" if i == 0 else f"  {text}"))
        out.append(_blank())

    out.append(
        _footer(
            "remove the value, keep the meaning, then save again"
            if unsafe
            else "fix these and validate again"
        )
    )
    return "\n".join(out)
