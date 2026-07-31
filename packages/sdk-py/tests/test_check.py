"""The open save-time baseline, tested rule by rule and held to the
TypeScript reference byte for byte.

The corpus under ``tests/check_corpus/`` is shared across the ports and was
designed to attack this one: every rule firing and none, counts on each
grade-band edge, thresholds met and missed by one unit, content outside the
Basic Multilingual Plane, and a decisions section whose entry order punishes
a wrong sort. The corpus documents are emitted by
``scripts/generate-check-parity.mjs``; this module hands the same documents
to the built TypeScript SDK live, the way ``test_parity.py`` does, so the
expected bytes always come from the reference and never from a copy.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from soil_handover import (
    CHECK_DEFAULT_NOTES,
    CHECK_GRADES,
    CHECK_NOTES_MAX_CHARS,
    CHECK_RULES,
    CHECK_SEVERITIES,
    CheckCounts,
    HandoverStore,
    check_handover,
    check_observation,
    grade_from_counts,
    normalize_handover,
    render_check,
    split_entries,
    text_length,
    validate_handover,
)

ROOT = Path(__file__).resolve().parents[3]
DIST = ROOT / "packages" / "sdk-ts" / "dist" / "index.js"
CORPUS = Path(__file__).resolve().parent / "check_corpus"

PRODUCED_BY = "soil-cli/0.1.0"
PRODUCED_AT = "2026-07-22T10:00:00Z"

ID = "019f7e89-fc00-7000-8000-000000000000"


def _corpus_names() -> list[str]:
    return sorted(path.stem for path in CORPUS.glob("*.json"))


def _corpus_document(name: str) -> dict:
    return json.loads((CORPUS / f"{name}.json").read_text(encoding="utf-8"))


def _doc(sections: dict, **rest) -> dict:
    return normalize_handover(
        {
            "handoverId": ID,
            "projectId": "check-test",
            "title": "Check test",
            "sections": sections,
            **rest,
        }
    )


def _example() -> dict:
    return json.loads(
        (ROOT / "examples" / "orchard-checkout.json").read_text(
            encoding="utf-8"
        )
    )


def _findings_for(report, rule: str, section: str | None = None):
    return [
        finding
        for finding in report.findings
        if finding.rule == rule
        and (section is None or finding.section == section)
    ]


def _filler(seed: str) -> str:
    """Prose long enough to count as substantial without saying anything
    odd."""
    return (f"{seed} " * 40).strip()


_DUMP = f"""
import {{ checkHandover, checkObservation, renderCheck }}
  from {json.dumps(DIST.as_uri())};
import {{ readFileSync, readdirSync }} from "node:fs";
import {{ join }} from "node:path";
const corpusDir = {json.dumps(str(CORPUS))};
const out = {{}};
for (const name of readdirSync(corpusDir).filter((f) => f.endsWith(".json"))) {{
  const document = JSON.parse(readFileSync(join(corpusDir, name), "utf8"));
  const report = checkHandover(document);
  out[name.replace(/\\.json$/, "")] = {{
    card: renderCheck(document, report),
    report: JSON.stringify(report, null, 2),
    observation: JSON.stringify(
      checkObservation(document, report, {{
        producedBy: {json.dumps(PRODUCED_BY)},
        producedAt: {json.dumps(PRODUCED_AT)},
      }}),
      null,
      2,
    ),
  }};
}}
console.log(JSON.stringify(out));
"""


@pytest.fixture(scope="module")
def ts():
    if not DIST.exists():
        pytest.fail(
            "the TypeScript SDK is not built; run `pnpm build` at the repo"
            " root, then run pytest again"
        )
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", _DUMP],
        capture_output=True,
        encoding="utf-8",
        check=True,
    )
    return json.loads(completed.stdout)


class TestCorpusParity:
    def test_the_corpus_is_present_and_whole(self):
        # A deleted corpus directory must fail loudly rather than pass an
        # empty loop.
        assert len(_corpus_names()) == 18

    @pytest.mark.parametrize("name", _corpus_names())
    def test_the_check_card_is_byte_identical(self, ts, name):
        document = _corpus_document(name)
        report = check_handover(document)
        assert render_check(document, report) == ts[name]["card"]

    @pytest.mark.parametrize("name", _corpus_names())
    def test_the_report_is_byte_identical(self, ts, name):
        document = _corpus_document(name)
        report = check_handover(document)
        as_json = json.dumps(
            {
                "checkVersion": report.check_version,
                "grade": report.grade,
                "counts": {
                    "problems": report.counts.problems,
                    "cautions": report.counts.cautions,
                    "advice": report.counts.advice,
                },
                "findings": [
                    {
                        "rule": finding.rule,
                        "severity": finding.severity,
                        **(
                            {"section": finding.section}
                            if finding.section is not None
                            else {}
                        ),
                        "message": finding.message,
                    }
                    for finding in report.findings
                ],
                "sections": {
                    "withContent": report.sections.with_content,
                    "missing": report.sections.missing,
                    "blocked": report.sections.blocked,
                    "notApplicable": report.sections.not_applicable,
                    "total": report.sections.total,
                },
            },
            indent=2,
            ensure_ascii=False,
        )
        assert as_json == ts[name]["report"]

    @pytest.mark.parametrize("name", _corpus_names())
    def test_the_observation_is_byte_identical(self, ts, name):
        document = _corpus_document(name)
        report = check_handover(document)
        observation = check_observation(
            document, report, PRODUCED_BY, PRODUCED_AT
        )
        assert (
            json.dumps(observation, indent=2, ensure_ascii=False)
            == ts[name]["observation"]
        )


class TestCheckHandover:
    def test_deterministic_and_non_mutating(self):
        example = _example()
        before = json.dumps(example, ensure_ascii=False)
        first = check_handover(example)
        second = check_handover(example)
        assert first == second
        assert json.dumps(example, ensure_ascii=False) == before

    def test_grades_the_worked_example_with_no_problems(self):
        report = check_handover(_example())
        assert report.grade in ("strong", "adequate")
        assert report.counts.problems == 0

    def test_every_finding_carries_a_documented_rule_id(self):
        report = check_handover(_doc({}))
        assert report.findings
        for finding in report.findings:
            assert finding.rule in CHECK_RULES
            assert finding.message
            assert finding.severity in CHECK_SEVERITIES


class TestRules:
    def test_missing_without_reason_flags_an_unexplained_gap(self):
        report = check_handover(_doc({"decisions": "One."}))
        assert _findings_for(
            report, "completeness.missing-without-reason", "workflow"
        )

    def test_missing_with_a_note_or_a_stated_input_stays_quiet(self):
        with_note = _doc(
            {
                "decisions": "One.",
                "workflow": {
                    "status": "missing",
                    "summary": "The thread held no workflow discussion.",
                },
            }
        )
        assert not _findings_for(
            check_handover(with_note),
            "completeness.missing-without-reason",
            "workflow",
        )
        with_inputs = _doc(
            {"decisions": "One."},
            quality={
                "missingInputs": ["The thread began at the save request."]
            },
        )
        assert not _findings_for(
            check_handover(with_inputs),
            "completeness.missing-without-reason",
        )

    def test_blocked_without_omission_note(self):
        silent = _doc(
            {
                "decisions": "One.",
                "architecture": {"status": "blocked", "summary": None},
            }
        )
        found = _findings_for(
            check_handover(silent),
            "gaps.blocked-without-omission-note",
            "architecture",
        )
        assert len(found) == 1
        named = _doc(
            {
                "decisions": "One.",
                "architecture": {"status": "blocked", "summary": None},
            },
            safety={
                "unsafeOmissions": [
                    "Provider credentials exist in the deployment platform."
                ]
            },
        )
        assert not _findings_for(
            check_handover(named), "gaps.blocked-without-omission-note"
        )

    def test_no_durable_truth_is_a_problem(self):
        report = check_handover(
            _doc({"executiveSummary": "Only the moment survived."})
        )
        found = _findings_for(report, "completeness.no-durable-truth")
        assert len(found) == 1
        assert found[0].severity == "problem"
        assert found[0].section is None
        quiet = check_handover(
            _doc(
                {
                    "executiveSummary": "The moment.",
                    "decisions": "We chose files because they outlive"
                    " databases.",
                }
            )
        )
        assert not _findings_for(quiet, "completeness.no-durable-truth")

    def test_fetch_pointer_is_a_caution_and_a_problem_in_restore(self):
        report = check_handover(
            _doc({"architecture": "For the full schema, see the repo."})
        )
        found = _findings_for(
            report, "self-containment.fetch-pointer", "architecture"
        )
        assert len(found) == 1
        assert found[0].severity == "caution"

        in_restore = check_handover(
            _doc(
                {
                    "decisions": "One.",
                    "restoreInstructions": "Start by reading the setup,"
                    " see the docs.",
                }
            )
        )
        found = _findings_for(
            in_restore,
            "self-containment.fetch-pointer",
            "restoreInstructions",
        )
        assert len(found) == 1
        assert found[0].severity == "problem"

    def test_a_url_stated_as_a_fact_is_left_alone(self):
        report = check_handover(
            _doc(
                {
                    "architecture": "The service runs at"
                    " https://api.example.com behind a proxy."
                }
            )
        )
        assert not _findings_for(report, "self-containment.fetch-pointer")

    def test_time_unanchored_polices_only_frontier_sections(self):
        report = check_handover(
            _doc({"currentTask": "We are deploying the fix now."})
        )
        assert _findings_for(report, "time.unanchored", "currentTask")

        anchored = check_handover(
            _doc(
                {
                    "currentTask": "At capture, the fix was mid-deploy and"
                    " unconfirmed."
                }
            )
        )
        assert not _findings_for(anchored, "time.unanchored")

        durable = check_handover(
            _doc(
                {
                    "decisions": "We currently prefer files because they"
                    " last."
                }
            )
        )
        assert not _findings_for(durable, "time.unanchored")

    def test_decision_entries_without_reasons(self):
        report = check_handover(
            _doc(
                {
                    "decisions": "1. We chose Postgres.\n\n2. We chose Redis"
                    " because reads dominate."
                }
            )
        )
        found = _findings_for(report, "decisions.entry-without-reason")
        assert len(found) == 1
        assert "entry 1" in found[0].message

        inability = check_handover(
            _doc(
                {
                    "decisions": "Copy ships in its own commits. Locked by"
                    " the founder, who cannot review a string buried in a"
                    " logic diff."
                }
            )
        )
        assert not _findings_for(inability, "decisions.entry-without-reason")

    def test_anchors_no_exact_values_is_advice(self):
        report = check_handover(
            _doc(
                {
                    "architecture": "The service reads its configuration"
                    " from the environment and honours a request timeout."
                }
            )
        )
        found = _findings_for(
            report, "anchors.no-exact-values", "architecture"
        )
        assert len(found) == 1
        assert found[0].severity == "advice"

        pinned = check_handover(
            _doc(
                {
                    "architecture": "The service reads its configuration"
                    " from the environment: port 3000, timeout 30s, Node"
                    " pinned at 20."
                }
            )
        )
        assert not _findings_for(pinned, "anchors.no-exact-values")

    def test_restore_rules(self):
        absent = check_handover(
            _doc({"decisions": "We chose files because they last."})
        )
        found = _findings_for(absent, "restore.absent")
        assert len(found) == 1
        assert found[0].severity == "problem"

        thin = check_handover(
            _doc(
                {
                    "decisions": _filler(
                        "We chose files because they last."
                    ),
                    "architecture": _filler(
                        "A worker pool feeds a queue that a scheduler"
                        " drains."
                    ),
                    "restoreInstructions": "Continue the work as before.",
                }
            )
        )
        assert _findings_for(thin, "restore.thin")

        small = check_handover(
            _doc(
                {
                    "decisions": "We chose files because they last.",
                    "restoreInstructions": "Continue: split the parser"
                    " next.",
                }
            )
        )
        assert not _findings_for(small, "restore.thin")
        assert not _findings_for(small, "restore.absent")

    def test_one_liner_needs_an_otherwise_rich_document(self):
        rich = _filler("Substantial prose that carries real content.")
        report = check_handover(
            _doc(
                {
                    "projectIdentity": rich,
                    "decisions": rich,
                    "architecture": rich,
                    "workflow": rich,
                    "restoreInstructions": rich,
                    "blockers": "None known.",
                }
            )
        )
        found = _findings_for(report, "size.one-liner", "blockers")
        assert len(found) == 1
        assert found[0].severity == "advice"

        short = check_handover(
            _doc(
                {
                    "projectIdentity": "A small tool.",
                    "decisions": "Files, because they last.",
                    "workflow": "Trunk-based.",
                    "blockers": "None known.",
                    "nextSteps": "Split the parser.",
                }
            )
        )
        assert not _findings_for(short, "size.one-liner")


class TestGradeMapping:
    def test_maps_counts_to_bands_exactly_as_documented(self):
        assert grade_from_counts(CheckCounts(0, 0, 0)) == "strong"
        assert grade_from_counts(CheckCounts(0, 0, 9)) == "strong"
        assert grade_from_counts(CheckCounts(0, 1, 0)) == "adequate"
        assert grade_from_counts(CheckCounts(0, 5, 0)) == "adequate"
        assert grade_from_counts(CheckCounts(0, 6, 0)) == "thin"
        assert grade_from_counts(CheckCounts(1, 0, 0)) == "thin"
        assert grade_from_counts(CheckCounts(2, 9, 0)) == "thin"
        assert grade_from_counts(CheckCounts(3, 0, 0)) == "failing"


class TestSplitEntries:
    def test_splits_numbered_items_bullets_and_paragraphs(self):
        assert split_entries(
            "Intro line:\n\n1. First.\n2. Second\ncontinued.\n- Third."
        ) == ["Intro line:", "1. First.", "2. Second continued.", "- Third."]


class TestCheckObservation:
    def test_packages_a_valid_quality_capture_observation(self):
        example = _example()
        report = check_handover(example)
        observation = check_observation(
            example, report, PRODUCED_BY, PRODUCED_AT
        )
        assert observation["kind"] == "quality.capture"
        assert observation["producedBy"] == PRODUCED_BY
        assert observation["producedAt"] == PRODUCED_AT
        assert observation["data"]["sectionsWithContent"] == 17
        assert observation["data"]["missingSections"] == []
        assert observation["data"]["blockedSections"] == []
        attached = {
            **example,
            "observations": [*example.get("observations", []), observation],
        }
        assert validate_handover(attached).valid

    def test_writes_exactly_the_documented_closed_field_set(self):
        example = _example()
        observation = check_observation(
            example, check_handover(example), PRODUCED_BY, PRODUCED_AT
        )
        assert sorted(observation["data"].keys()) == [
            "blockedSections",
            "checkVersion",
            "findings",
            "missingSections",
            "notes",
            "sectionsWithContent",
        ]

    def test_carries_no_grade_band_or_aggregate(self):
        example = _example()
        observation = check_observation(
            example, check_handover(example), PRODUCED_BY, PRODUCED_AT
        )
        serialized = json.dumps(observation, ensure_ascii=False)
        for band in CHECK_GRADES:
            assert f'"{band}"' not in serialized

    def test_every_finding_carries_the_four_documented_fields(self):
        thin = _doc({"executiveSummary": "One line."})
        observation = check_observation(
            thin, check_handover(thin), PRODUCED_BY, PRODUCED_AT
        )
        findings = observation["data"]["findings"]
        assert findings
        for finding in findings:
            assert sorted(finding.keys()) == [
                "location",
                "observed",
                "rule",
                "severity",
            ]
            assert finding["severity"] in CHECK_SEVERITIES
            assert str(finding["location"]).startswith("/")

    def test_notes_are_bounded_in_code_points_and_refused_not_truncated(
        self,
    ):
        example = _example()
        report = check_handover(example)
        assert text_length(CHECK_DEFAULT_NOTES) <= CHECK_NOTES_MAX_CHARS
        assert (
            check_observation(
                example, report, PRODUCED_BY, PRODUCED_AT, "Ran offline."
            )["data"]["notes"]
            == "Ran offline."
        )
        with pytest.raises(ValueError, match="at most 280 code points"):
            check_observation(
                example,
                report,
                PRODUCED_BY,
                PRODUCED_AT,
                "x" * (CHECK_NOTES_MAX_CHARS + 1),
            )
        # The bound is code points, so a note of astral characters is
        # refused at the same count and not at half of it.
        check_observation(
            example,
            report,
            PRODUCED_BY,
            PRODUCED_AT,
            chr(0x1F600) * CHECK_NOTES_MAX_CHARS,
        )
        with pytest.raises(ValueError, match="at most 280 code points"):
            check_observation(
                example,
                report,
                PRODUCED_BY,
                PRODUCED_AT,
                chr(0x1F600) * (CHECK_NOTES_MAX_CHARS + 1),
            )


class TestRenderCheck:
    def test_prints_the_grade_the_rules_and_the_boundary(self):
        example = _example()
        report = check_handover(example)
        card = render_check(example, report)
        assert "handover checked" in card
        assert report.grade in card
        for finding in report.findings:
            assert finding.rule in card
        assert "only a real load" in card

    def test_says_so_when_every_rule_passes(self):
        clean = _doc(
            {
                "decisions": "We chose files because they last.",
                "restoreInstructions": "Continue: split the parser next.",
            },
            quality={
                "missingInputs": [
                    "A short thread; most sections had no material."
                ]
            },
        )
        report = check_handover(clean)
        assert report.grade == "strong"
        assert "every rule passed" in render_check(clean, report)


class TestStoreUpdate:
    def test_update_attaches_and_keeps_id_and_code(self, tmp_path):
        store = HandoverStore(str(tmp_path))
        entry = store.save(_example())
        stored = store.read(entry["code"])
        report = check_handover(stored)
        observation = check_observation(
            stored, report, PRODUCED_BY, PRODUCED_AT
        )
        updated = {
            **stored,
            "observations": [
                *stored.get("observations", []),
                observation,
            ],
        }
        row = store.update(entry["code"], updated)
        assert row["code"] == entry["code"]

        read_back = store.read(entry["code"])
        assert read_back["handoverId"] == stored["handoverId"]
        assert read_back["code"] == entry["code"]
        assert len(read_back["observations"]) == 1
        # Checking again after an attach produces the same grade:
        # observations never change how the document is read.
        assert check_handover(read_back).grade == report.grade

    def test_update_refuses_a_changed_handover_id(self, tmp_path):
        store = HandoverStore(str(tmp_path))
        entry = store.save(_example())
        stored = store.read(entry["code"])
        impostor = {
            **stored,
            "handoverId": "019f7e89-fc00-7000-8000-999999999999",
        }
        with pytest.raises(ValueError, match="handoverId never changes"):
            store.update(entry["code"], impostor)

    def test_update_never_changes_the_load_code(self, tmp_path):
        store = HandoverStore(str(tmp_path))
        entry = store.save(_example())
        stored = store.read(entry["code"])
        relabelled = {**stored, "code": "#999"}
        store.update(entry["code"], relabelled)
        assert store.read(entry["code"])["code"] == entry["code"]

    def test_update_validates_before_writing(self, tmp_path):
        store = HandoverStore(str(tmp_path))
        entry = store.save(_example())
        stored = store.read(entry["code"])
        broken = {**stored, "title": ""}
        with pytest.raises(Exception):
            store.update(entry["code"], broken)
        # The stored document is untouched.
        assert store.read(entry["code"])["title"] == stored["title"]
