"""The numeric domain and the text unit.

Both are stated normatively in ``spec/value-domain.md`` and both are pinned
across the five implementations by the conformance corpus. What is here is
what only this runtime can show: that this parser is the one that would have
seen nothing wrong with a forty-digit integer, and that ``len`` on a ``str``
already is the unit the format counts in, which is why Python was the surface
that did not have to change.
"""

from __future__ import annotations

import json

from soil_handover import LIMITS, normalize_handover, text_length
from soil_handover.ingest import ingest_text
from soil_handover.validate import validate_handover

ASTRAL = "\U0001f600"  # 1 code point, 2 UTF-16 code units, 4 UTF-8 bytes
COMBINED = "é"  # 2 code points, 1 grapheme cluster
A_VALID_ID = "019f7e89-fc00-7000-8000-000000000000"


def verdict(text: str) -> str:
    """The code and location of a refusal, or ``"accepted"``."""
    _, issue = ingest_text(text)
    return "accepted" if issue is None else f"{issue.code} {issue.path}"


class TestNumericDomain:
    def test_this_parser_would_have_seen_nothing_wrong(self) -> None:
        # Executed and observed: Python's int is exact at any size, so the
        # value this runtime hands a validator is indistinguishable from a
        # value inside the domain. On a runtime with 64-bit floats the same
        # token has already been rounded. Neither surface can answer the
        # question from the value, and they cannot answer it the same way.
        assert json.loads("9007199254740993") == 9007199254740993
        assert json.loads("1e999") == float("inf")

    def test_accepts_both_ends_of_the_safe_integer_range(self) -> None:
        assert verdict('{"n":9007199254740991}') == "accepted"
        assert verdict('{"n":-9007199254740991}') == "accepted"

    def test_refuses_one_step_beyond_either_end(self) -> None:
        assert verdict('{"n":9007199254740992}') == "number.out_of_range /n"
        assert verdict('{"n":-9007199254740992}') == "number.out_of_range /n"

    def test_refuses_a_magnitude_no_double_could_hold(self) -> None:
        assert verdict('{"n":' + "9" * 40 + "}") == "number.out_of_range /n"

    def test_refuses_an_integer_written_with_a_point_or_an_exponent(
        self,
    ) -> None:
        assert verdict('{"n":100.0}') == "number.not_an_integer /n"
        assert verdict('{"n":1e2}') == "number.not_an_integer /n"
        assert verdict('{"n":-0.0}') == "number.not_an_integer /n"

    def test_refuses_a_fraction(self) -> None:
        assert (
            verdict('{"confidence":0.92}')
            == "number.not_an_integer /confidence"
        )

    def test_accepts_zero_negative_zero_and_ordinary_integers(self) -> None:
        assert verdict('{"a":0,"b":-0,"c":42,"d":-42}') == "accepted"

    def test_locates_a_refusal_in_an_array_and_in_a_nested_object(
        self,
    ) -> None:
        assert verdict('{"a":[1,2,1e2]}') == "number.not_an_integer /a/2"
        assert verdict('{"a":{"b":{"c":0.5}}}') == "number.not_an_integer /a/b/c"

    def test_reports_the_document_for_a_bare_number_at_the_root(self) -> None:
        assert verdict("0.5") == "number.not_an_integer "

    def test_does_not_mistake_the_three_json_literals_for_numbers(
        self,
    ) -> None:
        assert verdict('{"a":true,"b":false,"c":null}') == "accepted"

    def test_does_not_read_digits_inside_a_string_as_a_number(self) -> None:
        assert verdict('{"a":"9007199254740992"}') == "accepted"

    def test_syntax_and_duplicates_outrank_it(self) -> None:
        assert verdict('{"a":1e2,"a":1e2}') == "structure.duplicate_member /a"
        assert verdict('{"a":1e2,}') == "syntax.invalid_json "


def _base() -> dict:
    doc = dict(
        normalize_handover(
            {
                "projectId": "text-unit",
                "title": "The text unit",
                "createdAt": "2026-07-26T10:00:00Z",
                "sections": {"executiveSummary": "The text unit, exercised."},
            }
        )
    )
    doc["handoverId"] = A_VALID_ID
    return doc


class TestTextUnit:
    def test_len_on_a_str_already_is_the_unit(self) -> None:
        title = ASTRAL * LIMITS.title
        assert text_length(title) == 200
        assert len(title.encode("utf-8")) == 800
        assert len(title.encode("utf-16-le")) == 800

    def test_counts_a_combining_sequence_as_its_code_points(self) -> None:
        assert text_length(COMBINED) == 2
        assert text_length("café") == 4

    def test_counts_a_lone_surrogate_as_one_code_point(self) -> None:
        # A JSON document may carry \\uD800 with no pair. Counting it as zero
        # would let a string smuggle unbounded content past a bound.
        assert text_length("\ud800") == 1
        assert text_length("a\ud800b") == 3

    def test_accepts_a_title_of_exactly_the_limit_in_astral_characters(
        self,
    ) -> None:
        doc = _base()
        doc["title"] = ASTRAL * LIMITS.title
        assert validate_handover(doc).issues == ()

    def test_refuses_one_code_point_over_and_names_the_unit(self) -> None:
        doc = _base()
        doc["title"] = ASTRAL * (LIMITS.title + 1)
        result = validate_handover(doc)
        assert not result.valid
        issue = next(i for i in result.issues if i.path == "/title")
        assert issue.message == "must be at most 200 code points"
