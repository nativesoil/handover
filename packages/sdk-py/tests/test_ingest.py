"""The pre-schema ingestion boundary.

Parity with the other four surfaces is asserted by the shared fixture corpus
in ``conformance/fixtures/boundary``; these are the cases that corpus does
not carry, plus the store path that has to go through the same door.
"""

from __future__ import annotations

import pytest

from soil_handover import HandoverStore
from soil_handover.ingest import INGEST_LIMITS, ingest_document, ingest_text


def verdict(data: bytes) -> str:
    """The code and location of a refusal, or ``"accepted"``."""
    _, issue = ingest_document(data)
    return "accepted" if issue is None else f"{issue.code} {issue.path}"


class TestEncoding:
    def test_refuses_a_byte_order_mark_and_names_the_encoding(self) -> None:
        _, issue = ingest_document(b"\xef\xbb\xbf{}")
        assert issue is not None
        assert issue.code == "encoding.byte_order_mark"
        assert "UTF-8" in issue.message

    def test_names_utf32le_rather_than_the_utf16le_mark_it_starts_with(
        self,
    ) -> None:
        _, issue = ingest_document(b"\xff\xfe\x00\x00")
        assert issue is not None
        assert "UTF-32LE" in issue.message

    def test_refuses_a_leading_bom_that_arrived_as_text(self) -> None:
        _, issue = ingest_text("﻿{}")
        assert issue is not None
        assert issue.code == "encoding.byte_order_mark"

    def test_refuses_malformed_utf8_instead_of_substituting(self) -> None:
        # `bytes.decode("utf-8", errors="replace")` would hand back a document
        # with U+FFFD in it and call that a read.
        assert verdict(b'{"t":"caf\xe9"}') == "encoding.invalid_utf8 "

    def test_accepts_valid_multibyte_utf8(self) -> None:
        value, issue = ingest_document('{"t":"café · 引き継ぎ"}'.encode())
        assert issue is None
        assert value == {"t": "café · 引き継ぎ"}

    def test_refuses_utf16_that_the_standard_library_would_autodetect(
        self,
    ) -> None:
        # Observed: `json.loads` on these exact bytes returns a document,
        # because it sniffs the encoding and transcodes. That is the silent
        # conversion the rule forbids.
        assert (
            verdict('{"a":1}'.encode("utf-16-le"))
            == "encoding.unsupported_encoding "
        )


class TestDuplicateMemberNames:
    def test_refuses_a_repeat_and_points_at_the_member(self) -> None:
        assert verdict(b'{"a":1,"a":2}') == "structure.duplicate_member /a"

    def test_reaches_through_an_array_index(self) -> None:
        assert (
            verdict(b'{"o":[{"d":{"n":1,"n":2}}]}')
            == "structure.duplicate_member /o/0/d/n"
        )

    def test_escapes_a_pointer_shaped_member_name(self) -> None:
        assert (
            verdict(b'{"a/b~c":1,"a/b~c":2}')
            == "structure.duplicate_member /a~1b~0c"
        )

    def test_accepts_the_same_name_in_two_different_objects(self) -> None:
        assert verdict(b'{"x":{"status":1},"y":{"status":2}}') == "accepted"

    def test_never_echoes_the_repeated_name(self) -> None:
        _, issue = ingest_document(b'{"secretish":1,"secretish":2}')
        assert issue is not None
        assert "secretish" not in issue.message

    def test_reports_syntax_first_when_the_document_is_also_malformed(
        self,
    ) -> None:
        assert verdict(b'{"a":1,"a":2') == "syntax.invalid_json "


class TestNestingDepth:
    @staticmethod
    def nested(levels: int) -> bytes:
        return ('{"n":' * (levels - 1) + "{}" + "}" * (levels - 1)).encode()

    def test_accepts_exactly_the_ceiling(self) -> None:
        assert verdict(self.nested(INGEST_LIMITS.max_depth)) == "accepted"

    def test_refuses_one_level_over_with_a_structured_error(self) -> None:
        _, issue = ingest_document(self.nested(INGEST_LIMITS.max_depth + 1))
        assert issue is not None
        assert issue.code == "structure.depth_exceeded"
        assert "33" in issue.message

    def test_refuses_a_document_deep_enough_to_break_a_recursive_walker(
        self,
    ) -> None:
        # 20000 levels: far past this interpreter's recursion limit, so a
        # walker reaching it would raise RecursionError. The boundary must
        # answer with an issue instead.
        _, issue = ingest_document(self.nested(20000))
        assert issue is not None
        assert issue.code == "structure.depth_exceeded"

    def test_does_not_count_braces_inside_strings(self) -> None:
        assert verdict(b'{"a":"' + b"{" * 200 + b'"}') == "accepted"


class TestSize:
    @staticmethod
    def padded(total: int) -> bytes:
        return ('{"pad":"' + "x" * (total - 10) + '"}').encode()

    def test_accepts_exactly_the_ceiling(self) -> None:
        assert verdict(self.padded(INGEST_LIMITS.max_bytes)) == "accepted"

    def test_refuses_one_byte_over(self) -> None:
        assert verdict(self.padded(INGEST_LIMITS.max_bytes + 1)) == (
            "document.too_large "
        )


class TestSyntax:
    def test_refuses_nan_which_this_runtime_otherwise_accepts(self) -> None:
        # `json.loads` accepts NaN by default and the other four surfaces do
        # not, so without this the five would disagree about what a
        # well-formed JSON document is.
        assert verdict(b'{"a":NaN}') == "syntax.invalid_json "


def test_the_store_reads_through_the_boundary(tmp_path) -> None:
    store = HandoverStore(str(tmp_path))
    store.init()
    (store.handovers_dir / "001.json").write_bytes(
        b'\xef\xbb\xbf{"soilHandover":"1.0"}'
    )
    with pytest.raises(Exception, match="byte order mark"):
        store.read("#001")
