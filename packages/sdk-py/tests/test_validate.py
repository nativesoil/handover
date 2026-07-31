import pytest

from soil_handover import (
    HandoverValidationError,
    SECTION_KEYS,
    assert_handover,
    validate_handover,
)


def sections(overrides=None):
    base = {key: {"status": "missing", "summary": None} for key in SECTION_KEYS}
    return {**base, **(overrides or {})}


def handover(overrides=None):
    return {
        "soilHandover": "1.0",
        "handoverId": "019f7e89-fc00-7000-8000-000000000000",
        "projectId": "test-project",
        "title": "A handover",
        "createdAt": "2026-07-20T08:00:00Z",
        "sections": sections(),
        **(overrides or {}),
    }


class TestValidateHandover:
    def test_accepts_a_handover_where_every_section_is_missing(self):
        assert validate_handover(handover()).valid is True

    def test_accepts_an_offset_timestamp_not_only_z(self):
        assert (
            validate_handover(
                handover({"createdAt": "2026-07-20T08:00:00+02:00"})
            ).valid
            is True
        )

    def test_reports_every_problem_at_once_not_just_the_first(self):
        result = validate_handover(
            {
                "soilHandover": "1.0",
                "handoverId": "019f7e89-fc00-7000-8000-000000000000",
                "title": "",
                "createdAt": "yesterday",
                "sections": sections(),
            }
        )
        assert result.valid is False
        assert sorted(issue.path for issue in result.issues) == [
            "/createdAt",
            "/projectId",
            "/title",
        ]

    def test_rejects_a_dropped_section_because_a_gap_is_stated_not_omitted(self):
        doc = handover()
        del doc["sections"]["decisions"]
        result = validate_handover(doc)
        assert result.valid is False
        assert result.issues[0].path == "/sections/decisions"

    def test_rejects_a_section_key_nobody_has_heard_of(self):
        result = validate_handover(
            handover(
                {
                    "sections": sections(
                        {"vibes": {"status": "missing", "summary": None}}
                    )
                }
            )
        )
        assert "/sections/vibes" in [issue.path for issue in result.issues]

    def test_rejects_available_with_no_content(self):
        result = validate_handover(
            handover(
                {
                    "sections": sections(
                        {"decisions": {"status": "available", "summary": "  "}}
                    )
                }
            )
        )
        assert result.issues[0].path == "/sections/decisions/summary"

    def test_rejects_a_status_outside_the_four_word_vocabulary(self):
        result = validate_handover(
            handover(
                {
                    "sections": sections(
                        {"decisions": {"status": "partial", "summary": "half"}}
                    )
                }
            )
        )
        assert result.issues[0].path == "/sections/decisions/status"

    def test_accepts_a_section_that_does_not_apply_when_it_says_why(self):
        result = validate_handover(
            handover(
                {
                    "sections": sections(
                        {
                            "architecture": {
                                "status": "not_applicable",
                                "summary": (
                                    "A one-author manuscript has no system"
                                    " to describe."
                                ),
                            }
                        }
                    )
                }
            )
        )
        assert result.valid

    def test_rejects_a_section_that_does_not_apply_without_a_reason(self):
        for summary in (None, "", "   "):
            result = validate_handover(
                handover(
                    {
                        "sections": sections(
                            {
                                "architecture": {
                                    "status": "not_applicable",
                                    "summary": summary,
                                }
                            }
                        )
                    }
                )
            )
            assert not result.valid
            assert result.issues[0].path == "/sections/architecture/summary"

    def test_refuses_a_near_neighbour_of_the_fourth_status(self):
        for status in ("notApplicable", "not applicable", "NOT_APPLICABLE"):
            result = validate_handover(
                handover(
                    {
                        "sections": sections(
                            {
                                "architecture": {
                                    "status": status,
                                    "summary": "There is no system here.",
                                }
                            }
                        )
                    }
                )
            )
            assert not result.valid
            assert result.issues[0].path == "/sections/architecture/status"

    def test_rejects_an_unknown_provenance_label(self):
        result = validate_handover(
            handover(
                {
                    "sections": sections(
                        {
                            "decisions": {
                                "status": "available",
                                "summary": "one",
                                "provenance": [
                                    "model_reported",
                                    "vibes_based",
                                ],
                            }
                        }
                    )
                }
            )
        )
        assert result.issues[0].path == "/sections/decisions/provenance/1"

    def test_rejects_a_duplicated_provenance_label(self):
        result = validate_handover(
            handover(
                {
                    "sections": sections(
                        {
                            "decisions": {
                                "status": "available",
                                "summary": "one",
                                "provenance": ["inferred", "inferred"],
                            }
                        }
                    )
                }
            )
        )
        assert "duplicate" in result.issues[0].message

    def test_rejects_an_unknown_top_level_field_including_a_grade(self):
        result = validate_handover(handover({"grade": "A"}))
        assert "/grade" in [issue.path for issue in result.issues]

    def test_supports_exact_versions_and_refuses_everything_else(self):
        # Support is a set, not a pattern. A reader that accepts 1.4 because
        # the string starts with "1." is claiming to implement a version
        # nobody has written, and version one is a closed world: whatever
        # that minor allowed would arrive here unrecognised.
        assert validate_handover(handover({"soilHandover": "1.0"})).valid is True
        for unsupported in ["0.9", "1.1", "1.4", "1.10", "2.0", "1", "1.0.0", ""]:
            result = validate_handover(handover({"soilHandover": unsupported}))
            assert result.valid is False, unsupported
            assert "/soilHandover" in [issue.path for issue in result.issues]

    def test_requires_a_handover_id_on_a_document_claiming_validity(self):
        doc = handover()
        del doc["handoverId"]
        result = validate_handover(doc)
        assert result.valid is False
        assert result.issues[0].path == "/handoverId"
        assert result.issues[0].kind == "structure"

    def test_rejects_a_handover_id_that_is_not_a_uuid(self):
        result = validate_handover(handover({"handoverId": "handover-42"}))
        assert result.valid is False
        assert result.issues[0].path == "/handoverId"

    def test_rejects_a_project_id_with_spaces(self):
        result = validate_handover(handover({"projectId": "two words"}))
        assert result.issues[0].path == "/projectId"

    def test_accepts_a_store_assigned_code_and_rejects_a_malformed_one(self):
        assert validate_handover(handover({"code": "#004"})).valid is True
        assert validate_handover(handover({"code": "4"})).valid is False

    def test_accepts_stated_gaps_and_safety_omissions(self):
        result = validate_handover(
            handover(
                {
                    "quality": {
                        "missingInputs": ["the deploy logs"],
                        "contradictions": [],
                    },
                    "safety": {
                        "unsafeOmissions": [
                            "an API key exists in the platform config"
                        ]
                    },
                }
            )
        )
        assert result.valid is True

    def test_rejects_a_note_that_is_not_text(self):
        result = validate_handover(handover({"quality": {"missingInputs": [7]}}))
        assert result.issues[0].path == "/quality/missingInputs/0"

    def test_rejects_something_that_is_not_an_object_at_all(self):
        assert validate_handover("a handover, honest").valid is False
        assert validate_handover(None).valid is False


class TestAssertHandover:
    def test_passes_a_valid_document(self):
        doc = handover()
        assert_handover(doc)
        assert doc["projectId"] == "test-project"

    def test_raises_with_every_issue_attached(self):
        with pytest.raises(HandoverValidationError) as excinfo:
            assert_handover({"soilHandover": "1.0"})
        assert len(excinfo.value.issues) > 1
