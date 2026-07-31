import re
from datetime import datetime, timezone

from soil_handover import (
    normalize_handover,
    render_list,
    render_loaded,
    render_saved,
    render_validation,
    validate_handover,
    wrap,
)

NOW = datetime(2026, 7, 22, 10, 0, 0, tzinfo=timezone.utc)

DOC = normalize_handover(
    {
        "handoverId": "019f7e89-fc00-7000-8000-000000000000",
        "projectId": "render-test",
        "title": "A short title",
        "createdAt": "2026-07-22T10:00:00Z",
        "source": {"client": "claude-code", "model": "opus-4.8"},
        "sections": {
            "executiveSummary": "What this is.",
            "decisions": "What was decided.",
            "architecture": {
                "status": "blocked",
                "summary": "Host names withheld.",
            },
        },
        "quality": {"missingInputs": ["the deploy logs were not available"]},
        "safety": {
            "unsafeOmissions": ["an API key exists in the platform config"]
        },
    })


class TestWrap:
    def test_breaks_on_words_and_never_mid_word(self):
        assert wrap("one two three four", 9) == ["one two", "three", "four"]

    def test_keeps_a_word_longer_than_the_width_on_its_own_line(self):
        assert wrap("supercalifragilistic", 5) == ["supercalifragilistic"]


class TestRenderSaved:
    card = render_saved(DOC, "#004")

    def test_leads_with_the_load_code(self):
        assert "#004" in self.card.split("\n")[0]

    def test_reports_counts_and_never_a_score(self):
        assert "2 / 17 sections carrying content" in self.card
        assert re.search(r"\d+\s*%", self.card) is None
        assert re.search(r"score|grade|readiness", self.card, re.I) is None

    def test_names_what_did_not_survive(self):
        assert "no content" in self.card
        assert "held back   architecture" in self.card

    def test_shows_the_stated_gaps_and_the_safety_omissions(self):
        assert "stated gaps" in self.card
        assert "the deploy logs were not available" in self.card
        assert "held back · by design" in self.card

    def test_ends_with_the_command_that_loads_it_back(self):
        assert self.card.rstrip().endswith("❯ soil load #004")

    def test_is_deterministic(self):
        assert render_saved(DOC, "#004") == self.card

    def test_keeps_every_line_inside_the_card_width(self):
        for line in self.card.split("\n"):
            assert len(line) <= 70


class TestRenderLoaded:
    def test_says_which_sections_are_empty_and_how_to_read_the_rest(self):
        card = render_loaded({**DOC, "code": "#004"})
        assert "what this document carries" in card
        assert "no content" in card
        assert "moment of capture" in card


class TestRenderList:
    def test_says_so_when_nothing_is_stored(self):
        assert "nothing saved yet" in render_list([])

    def test_shows_a_code_a_title_and_a_count_per_row(self):
        card = render_list(
            [
                {
                    "code": "#002",
                    "projectId": "render-test",
                    "title": (
                        "A very long title that will not fit in the column"
                        " at all"
                    ),
                    "createdAt": "2026-07-22T10:00:00Z",
                    "sectionsWithContent": 9,
                    "file": "002.json",
                }
            ]
        )
        assert "#002" in card
        assert "…" in card
        assert "9/17" in card


class TestRenderValidation:
    def test_says_structure_only_when_a_document_is_valid(self):
        card = render_validation(validate_handover(DOC), "the document")
        assert "valid handover" in card
        assert "says nothing about how good the content is" in card

    def test_lists_every_problem_when_it_is_not(self):
        card = render_validation(validate_handover({"soilHandover": "1.0"}), "x")
        assert "not a handover" in card
        assert "/projectId" in card
