import json
from datetime import datetime, timezone

import pytest

from soil_handover import (
    SectionCounts,
    HandoverNotFoundError,
    HandoverStore,
    count_sections,
    format_code,
    normalize_handover,
    parse_code,
    resolve_store_home,
)

AT = "2026-07-22T10:00:00Z"


def handover(title, sections=None):
    return normalize_handover(
        {
            "projectId": "store-test",
            "title": title,
            "createdAt": AT,
            "sections": sections or {},
        }
    )


class TestCodes:
    def test_pads_to_three_digits(self):
        assert format_code(1) == "#001"
        assert format_code(42) == "#042"
        assert format_code(1234) == "#1234"

    def test_parses_the_shapes_a_person_actually_types(self):
        assert parse_code("#004") == 4
        assert parse_code("004") == 4
        assert parse_code(" 4 ") == 4
        assert parse_code("#abc") is None
        assert parse_code("#000") is None


class TestResolveStoreHome:
    def test_prefers_soil_home(self):
        assert (
            resolve_store_home({"SOIL_HOME": "/tmp/elsewhere"})
            == "/tmp/elsewhere"
        )

    def test_falls_back_to_a_soil_directory_in_the_home_directory(self):
        assert resolve_store_home({}).endswith(".soil")


class TestCountSections:
    def test_counts_by_status_and_never_scores(self):
        doc = normalize_handover(
            {
                "sections": {
                    "decisions": "one",
                    "workflow": "two",
                    "architecture": {
                        "status": "blocked",
                        "summary": "withheld",
                    },
                }
            })
        assert count_sections(doc) == SectionCounts(
            with_content=2, missing=14, blocked=1, not_applicable=0, total=17
        )

    def test_counts_a_section_that_does_not_apply_on_its_own(self):
        doc = normalize_handover(
            {
                "sections": {
                    "decisions": "one",
                    "architecture": {
                        "status": "not_applicable",
                        "summary": "A manuscript has no system to describe.",
                    },
                    "safetySummary": {
                        "status": "not_applicable",
                        "summary": "Nothing here holds a value to withhold.",
                    },
                }
            })
        assert count_sections(doc) == SectionCounts(
            with_content=1, missing=14, blocked=0, not_applicable=2, total=17
        )


class TestHandoverStore:
    @pytest.fixture
    def store(self, tmp_path):
        return HandoverStore(str(tmp_path / "soil"))

    def test_starts_empty(self, store):
        assert store.list() == []

    def test_hands_out_codes_in_order_and_never_reuses_one(self, store):
        assert store.save(handover("first"))["code"] == "#001"
        assert store.save(handover("second"))["code"] == "#002"
        assert store.save(handover("third"))["code"] == "#003"

    def test_writes_one_readable_json_file_per_handover(self, store):
        store.save(handover("readable", {"decisions": "We chose files."}))
        raw = (store.handovers_dir / "001.json").read_text(encoding="utf-8")
        parsed = json.loads(raw)
        assert parsed["code"] == "#001"
        assert parsed["sections"]["decisions"]["status"] == "available"

    def test_reads_back_by_code_by_bare_number_and_by_last(self, store):
        store.save(handover("first"))
        store.save(handover("second"))
        assert store.read("#001")["title"] == "first"
        assert store.read("1")["title"] == "first"
        assert store.read("last")["title"] == "second"

    def test_lists_newest_first_with_the_section_count(self, store):
        store.save(handover("first", {"decisions": "one"}))
        store.save(handover("second"))
        entries = store.list()
        assert [entry["code"] for entry in entries] == ["#002", "#001"]
        assert entries[1]["sectionsWithContent"] == 1

    def test_assigns_a_uuidv7_at_save_time_and_keeps_an_existing_id(
        self, store
    ):
        import re

        assigned = store.save(handover("fresh"))
        stored = store.read(assigned["code"])
        assert re.match(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}"
            r"-[0-9a-f]{12}$",
            stored["handoverId"],
        )
        copied = store.save(stored)
        assert (
            store.read(copied["code"])["handoverId"] == stored["handoverId"]
        )

    def test_refuses_to_store_an_invalid_document(self, store):
        with pytest.raises(Exception, match="not a valid Soil handover"):
            store.save({"title": "nope"})

    def test_says_so_when_a_code_does_not_exist(self, store):
        with pytest.raises(HandoverNotFoundError):
            store.read("#404")
        with pytest.raises(HandoverNotFoundError):
            store.read("last")

    def test_rebuilds_the_index_because_the_files_are_the_truth(self, store):
        store.save(handover("first"))
        store.save(handover("second"))
        store.index_path.write_text(
            json.dumps({"indexVersion": 1, "nextCode": 1, "entries": []}),
            encoding="utf-8",
        )
        rebuilt = store.reindex()
        assert [entry["code"] for entry in rebuilt["entries"]] == [
            "#001",
            "#002",
        ]
        assert rebuilt["nextCode"] == 3

    def test_skips_unreadable_files_when_rebuilding(self, store):
        store.save(handover("good"))
        (store.handovers_dir / "099.json").write_text(
            '{"not":"a handover"}', encoding="utf-8"
        )
        assert len(store.reindex()["entries"]) == 1
