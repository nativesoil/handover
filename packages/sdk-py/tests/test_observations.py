"""The extension point, tested from the angle that matters: a reader meeting
a producer it has never heard of."""

from datetime import datetime, timezone

from soil_handover import (
    build_restore_prompt,
    find_secret_material,
    normalize_handover,
    validate_handover,
)

AT = "2026-07-22T10:00:00Z"


def with_observations(observations):
    return normalize_handover(
        {
            "handoverId": "019f7e89-fc00-7000-8000-000000000000",
            "projectId": "extension-test",
            "title": "Extension point",
            "createdAt": AT,
            "sections": {"executiveSummary": "A project."},
            "observations": observations,
        })


class TestObservations:
    def test_are_optional_a_handover_without_any_is_complete(self):
        doc = normalize_handover(
            {
                "handoverId": "019f7e89-fc00-7000-8000-000000000000",
                "projectId": "none",
                "title": "None",
                "createdAt": AT,
                "sections": {"decisions": "one"},
            })
        assert "observations" not in doc
        assert validate_handover(doc).valid is True

    def test_accept_a_kind_this_implementation_has_never_heard_of(self):
        doc = with_observations(
            [
                {
                    "kind": "com.example.kind.from.the.future",
                    "data": {"anything": [1, 2]},
                }
            ]
        )
        assert validate_handover(doc).valid is True

    def test_carry_unknown_entries_through_normalization_unchanged(self):
        entries = [
            {
                "kind": "com.example.measurement",
                "producedBy": "example-service 3.2",
                "producedAt": "2026-07-20T09:00:00Z",
                "data": {"nested": {"deeply": {"value": 4}}},
            },
            {"kind": "dev.example.annotation", "data": {}},
        ]
        doc = with_observations(entries)
        assert doc["observations"] == entries

    def test_do_not_change_how_the_sections_are_read(self):
        base = normalize_handover(
            {
                "projectId": "extension-test",
                "title": "Extension point",
                "createdAt": "2026-07-22T10:00:00Z",
                "sections": {
                    "executiveSummary": "A project.",
                    "decisions": "One decision.",
                },
            })
        observed = {
            **base,
            "observations": [
                {"kind": "com.example.anything", "data": {"score": 11}}
            ],
        }
        # A fixed boundary token, because production takes a fresh one from
        # the platform's cryptographic source on every render and the point
        # here is the sections, not the boundary.
        token = "0123456789abcdef0123456789abcdef"
        assert build_restore_prompt(observed, token) == build_restore_prompt(
            base, token
        )

    def test_reject_an_entry_with_a_key_outside_the_envelope(self):
        result = validate_handover(
            with_observations([{"kind": "a.kind", "data": {}, "extra": "no"}])
        )
        assert result.issues[0].path == "/observations/0/extra"

    def test_reject_an_entry_with_no_kind_or_no_data(self):
        assert (
            validate_handover(with_observations([{"data": {}}])).issues[0].path
            == "/observations/0/kind"
        )
        assert (
            validate_handover(with_observations([{"kind": "a.kind"}]))
            .issues[0]
            .path
            == "/observations/0/data"
        )

    def test_reject_a_produced_at_that_is_not_a_timestamp(self):
        result = validate_handover(
            with_observations(
                [{"kind": "a.kind", "producedAt": "recently", "data": {}}]
            )
        )
        assert result.issues[0].path == "/observations/0/producedAt"

    def test_reject_observations_that_are_not_an_array(self):
        assert (
            validate_handover(
                with_observations({"kind": "a.kind", "data": {}})
            ).valid
            is False
        )

    def test_are_covered_by_the_secret_scan_however_deep(self):
        doc = with_observations(
            [
                {
                    "kind": "com.example.measurement",
                    "data": {
                        "call": {
                            "header": (
                                "Authorization: Bearer"
                                " 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e"
                            )
                        }
                    },
                }
            ]
        )
        assert (
            find_secret_material(doc)[0].path
            == "/observations/0/data/call/header"
        )
        result = validate_handover(doc)
        assert result.valid is False
        assert result.issues[0].kind == "safety"
