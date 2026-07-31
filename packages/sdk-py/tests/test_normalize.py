import pytest

from soil_handover import (
    SECTION_KEYS,
    extract_json_block,
    normalize_handover,
    validate_handover,
)

AN_ID = "019f7e89-fc00-7000-8000-000000000000"
AT = "2026-07-22T10:00:00Z"


class TestNormalizeHandover:
    def test_declares_all_17_sections_even_from_an_empty_object(self):
        doc = normalize_handover({})
        assert list(doc["sections"].keys()) == list(SECTION_KEYS)
        assert doc["sections"]["decisions"] == {
            "status": "missing",
            "summary": None,
        }

    def test_accepts_the_loose_extraction_sections_key(self):
        doc = normalize_handover(
            {
                "projectId": "loose",
                "title": "Loose",
                "extractionSections": {"decisions": "We picked Postgres."},
            })
        assert doc["sections"]["decisions"] == {
            "status": "available",
            "summary": "We picked Postgres.",
        }

    def test_turns_a_bare_string_into_an_available_section(self):
        doc = normalize_handover(
            {"sections": {"workflow": "  Review before merge.  "}})
        assert doc["sections"]["workflow"] == {
            "status": "available",
            "summary": "Review before merge.",
        }

    def test_treats_an_empty_string_as_a_gap_rather_than_as_content(self):
        doc = normalize_handover({"sections": {"workflow": "   "}})
        assert doc["sections"]["workflow"]["status"] == "missing"

    def test_infers_available_when_an_object_has_a_summary_but_no_status(self):
        doc = normalize_handover(
            {"sections": {"blockers": {"summary": "The sandbox is down."}}})
        assert doc["sections"]["blockers"]["status"] == "available"

    @pytest.mark.parametrize(
        "wrong", ["Available", "AVAILABLE", "partial", "done"]
    )
    def test_keeps_an_unrecognised_status_so_validation_refuses_it(
        self, wrong
    ):
        # Wrong capitalisation is the common case. Rewriting it to
        # `available` would let a typo become content that counts as
        # captured, and the author would never be told.
        doc = normalize_handover(
            {
                "handoverId": AN_ID,
                "projectId": "status-test",
                "title": "Status",
                "createdAt": AT,
                "sections": {
                    "decisions": {
                        "status": wrong,
                        "summary": "One decision.",
                    }
                },
            })
        assert doc["sections"]["decisions"]["status"] == wrong
        result = validate_handover(doc)
        assert result.valid is False
        assert any(
            issue.path == "/sections/decisions/status"
            and issue.kind == "structure"
            for issue in result.issues
        )

    def test_keeps_an_explicit_blocked_status_and_its_note(self):
        doc = normalize_handover(
            {
                "sections": {
                    "architecture": {
                        "status": "blocked",
                        "summary": "Host names withheld.",
                    }
                }
            })
        assert doc["sections"]["architecture"] == {
            "status": "blocked",
            "summary": "Host names withheld.",
        }

    def test_does_not_invent_a_project_id_so_validation_can_say_so(self):
        doc = normalize_handover({"title": "No slug"})
        assert doc["projectId"] == ""
        assert validate_handover(doc).valid is False

    def test_keeps_an_existing_handover_id_and_never_mints_one(self):
        kept = normalize_handover(
            {
                "handoverId": "019f7e89-fc00-7000-8000-000000000000",
                "projectId": "identified",
                "title": "Identified",
            })
        assert kept["handoverId"] == "019f7e89-fc00-7000-8000-000000000000"
        fresh = normalize_handover(
            {"projectId": "unidentified", "title": "Unidentified"})
        assert "handoverId" not in fresh



class TestClosedWorld:
    """Version one has no room for an unknown field, and normalization is
    not allowed to make room by deleting one.

    Each of these used to be dropped silently, which meant `soil validate`
    rejected a document and `soil save` stored it, from the same bytes.
    """

    @staticmethod
    def base(**overrides):
        document = {
            "soilHandover": "1.0",
            "handoverId": AN_ID,
            "projectId": "closed-world",
            "title": "Closed world",
            "createdAt": AT,
        }
        document.update(overrides)
        return document

    def test_keeps_an_unknown_top_level_field(self):
        doc = normalize_handover(self.base(grade=0.92))
        assert doc["grade"] == 0.92
        result = validate_handover(doc)
        assert result.valid is False
        assert "/grade" in [issue.path for issue in result.issues]

    def test_keeps_an_unknown_field_on_a_section(self):
        doc = normalize_handover(
            self.base(
                sections={
                    "decisions": {
                        "status": "available",
                        "summary": "One.",
                        "confidence": 0.4,
                    }
                }
            )
        )
        paths = [issue.path for issue in validate_handover(doc).issues]
        assert "/sections/decisions/confidence" in paths

    def test_keeps_an_unknown_section_key(self):
        doc = normalize_handover(
            self.base(
                sections={"vibes": {"status": "available", "summary": "Good."}}
            )
        )
        paths = [issue.path for issue in validate_handover(doc).issues]
        assert "/sections/vibes" in paths

    def test_keeps_a_provenance_label_it_does_not_recognise(self):
        # The eleven labels are frozen for the whole of version one, because
        # provenance is the format's only trust mechanism. Quietly deleting a
        # twelfth would leave a section looking better sourced than it is.
        doc = normalize_handover(
            self.base(
                sections={
                    "decisions": {
                        "status": "available",
                        "summary": "one",
                        "provenance": ["model_reported", "vibe_checked"],
                    }
                }
            )
        )
        assert doc["sections"]["decisions"]["provenance"] == [
            "model_reported",
            "vibe_checked",
        ]
        paths = [issue.path for issue in validate_handover(doc).issues]
        assert "/sections/decisions/provenance/1" in paths

    def test_keeps_an_unknown_member_of_source_quality_and_safety(self):
        doc = normalize_handover(
            self.base(
                source={"client": "some-tool", "temperature": 0.7},
                quality={"missingInputs": ["the logs"], "score": 3},
                safety={"unsafeOmissions": ["a key exists"], "redacted": True},
            )
        )
        paths = [issue.path for issue in validate_handover(doc).issues]
        assert "/source/temperature" in paths
        assert "/quality/score" in paths
        assert "/safety/redacted" in paths

    def test_keeps_a_section_value_it_cannot_reshape(self):
        doc = normalize_handover(self.base(sections={"decisions": 42}))
        paths = [issue.path for issue in validate_handover(doc).issues]
        assert "/sections/decisions" in paths

    @pytest.mark.parametrize("declared", ["1.7", "2.0", "0.9"])
    def test_does_not_upgrade_or_downgrade_a_declared_version(self, declared):
        doc = normalize_handover(self.base(soilHandover=declared))
        assert doc["soilHandover"] == declared
        assert validate_handover(doc).valid is False


class TestInventsNothing:
    def test_does_not_stamp_a_created_at_the_document_never_carried(self):
        # The anchor every frontier section is read against. A wall clock read
        # at save time is indistinguishable, to a consumer, from a time the
        # session actually reported.
        doc = normalize_handover({"projectId": "no-time", "title": "No time"})
        assert "createdAt" not in doc
        result = validate_handover({**doc, "handoverId": AN_ID})
        assert result.valid is False
        assert "/createdAt" in [issue.path for issue in result.issues]

    def test_keeps_a_created_at_it_cannot_parse_instead_of_replacing_it(self):
        doc = normalize_handover(
            {
                "projectId": "bad-time",
                "title": "Bad time",
                "createdAt": "last Tuesday",
            }
        )
        assert doc["createdAt"] == "last Tuesday"

    def test_does_not_stamp_a_recipe_version_onto_another_writers_document(
        self,
    ):
        doc = normalize_handover({"projectId": "recipe", "title": "Recipe"})
        assert "source" not in doc

    def test_keeps_a_recipe_version_the_input_states(self):
        doc = normalize_handover(
            {
                "projectId": "recipe",
                "title": "Recipe",
                "source": {"recipeVersion": "0.9.9"},
            }
        )
        assert doc["source"]["recipeVersion"] == "0.9.9"

    @pytest.mark.parametrize("malformed", [42, "handover-42", "", None])
    def test_keeps_a_malformed_handover_id_rather_than_letting_a_writer_replace_it(
        self, malformed
    ):
        # Dropping it is what makes the replacement possible: the writer then
        # sees a document with no id and mints one, and nobody is ever told
        # the id the document arrived with was wrong.
        doc = normalize_handover(
            {
                "soilHandover": "1.0",
                "handoverId": malformed,
                "projectId": "identity",
                "title": "Identity",
                "createdAt": AT,
            }
        )
        assert "handoverId" in doc
        result = validate_handover(doc)
        assert result.valid is False
        assert "/handoverId" in [issue.path for issue in result.issues]

    def test_leaves_a_complete_reply_one_writer_assigned_id_from_valid(self):
        doc = normalize_handover(
            {
                "projectId": "rescue-test",
                "title": "Rescued from a full thread",
                "createdAt": AT,
                "extractionSections": {
                    "projectIdentity": "A test project.",
                    "decisions": {
                        "status": "available",
                        "summary": "One decision.",
                    },
                    "blockers": {"status": "missing", "summary": None},
                },
            }
        )
        result = validate_handover(doc)
        assert result.valid is False
        assert [issue.path for issue in result.issues] == ["/handoverId"]
        assert validate_handover({**doc, "handoverId": AN_ID}).valid is True

    def test_keeps_a_quality_entry_it_cannot_use_rather_than_deleting_it(self):
        doc = normalize_handover(
            {
                "projectId": "notes",
                "title": "Notes",
                "createdAt": AT,
                "quality": {"missingInputs": ["the logs", "  ", 7]},
                "safety": {
                    "unsafeOmissions": ["  a key exists in the config  "]
                },
            }
        )
        assert doc["quality"]["missingInputs"] == ["the logs", "  ", 7]
        assert doc["safety"]["unsafeOmissions"] == ["a key exists in the config"]
        paths = [
            issue.path
            for issue in validate_handover({**doc, "handoverId": AN_ID}).issues
        ]
        assert "/quality/missingInputs/1" in paths
        assert "/quality/missingInputs/2" in paths


class TestExtractJsonBlock:
    def test_pulls_json_out_of_a_fenced_block_wrapped_in_prose(self):
        text = 'Sure!\n\n```json\n{"a":1}\n```\n\nAnything else?'
        assert extract_json_block(text) == '{"a":1}'

    def test_handles_a_fence_with_no_language_tag(self):
        assert extract_json_block('```\n{"a":1}\n```') == '{"a":1}'

    def test_falls_back_to_the_outermost_braces(self):
        assert (
            extract_json_block('here you go: {"a":{"b":2}} done')
            == '{"a":{"b":2}}'
        )

    def test_returns_none_when_there_is_no_json_at_all(self):
        assert extract_json_block("I could not do that") is None
