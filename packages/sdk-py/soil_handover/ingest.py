"""The pre-schema ingestion boundary.

Everything else in this package receives a value. This module is the one
place that receives BYTES, and it is the only place where the rules that
cannot be seen from a constructed value are enforced:

1. **size** — the byte count is bounded before anything decodes, and it is
   unrecoverable once a value exists.
2. **encoding** — the bytes must be UTF-8, with no byte order mark, and
   nothing is ever repaired or transcoded.
3. **duplicates** — a member name repeated inside one object refuses the
   document, before any object is built from it.
4. **depth** — nesting is bounded before anything walks the value, so a deep
   document is refused rather than crashing the walker.
5. **numbers** — a number is judged from its token text, because a parser
   rounds an oversized integer in silence.

Why a boundary rather than the same checks scattered about. A JSON parser is
lossy on exactly these points: by the time you hold a ``dict``, the second
``"a"`` has overwritten the first, the byte order mark has been stripped or
turned into a stray character, the recursion that would have blown the stack
has already run, and the length of what arrived is gone — whitespace, escapes
and member order are not recoverable from a value. The safety scan and the
validator both walk a constructed value, so neither can see any of it.

The security argument for the duplicate rule is the decisive one. With
last-wins, the fail-closed secret scan sees one value for ``/sections/x`` and
a consumer parsing the same bytes with a different parser sees another. The
document that gets scanned is then not the document that gets read.

The depth ceiling is derived, not observed. The deepest structure a handover
needs without custom observation data is 4 levels; the deepest fixture in
this repository is 6; the lowest hard parser ceiling among the five official
implementations is 64. 32 sits at half of that.

**Mechanism note for this surface.** Duplicate detection uses the standard
library's own hook, ``json.loads(..., object_pairs_hook=...)``: it is handed
the member list before the ``dict`` is built, so it sees the repetition the
``dict`` is about to lose. The hook knows its own members but not where it
sits in the document, so the location is recovered on the way back up — each
object reports upward, and the parent that owns it prefixes its member name.
No dependency is added; this package has none and gains none.

The depth check is a separate, non-recursive scan over the text, run BEFORE
``json.loads``. It has to be: ``json``'s scanner recurses, the safety scan
recurses and the validator recurses, so a ceiling enforced anywhere inside
them is a ceiling enforced too late.

The order of the checks is normative and identical on every surface: size,
encoding, depth, syntax, duplicate member names, numeric domain. The first
five are ``spec/ingestion.md``; the sixth is ``spec/value-domain.md``. This is
the surface least able to see why that sixth check exists, because a Python
``int`` is exact at any size and ``json.loads`` reports nothing unusual about
a forty-digit token; a reader with 64-bit floats has already lost it.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Final

__all__ = [
    "INGEST_ERROR_CODES",
    "IngestError",
    "IngestIssue",
    "IngestLimits",
    "INGEST_LIMITS",
    "ingest_document",
    "ingest_document_or_raise",
    "ingest_text",
    "ingest_text_or_raise",
]


@dataclass(frozen=True)
class IngestLimits:
    """The bounds this boundary enforces."""

    max_depth: int
    max_bytes: int
    #: The largest integer a handover may hold, and its negative counterpart:
    #: the ends of the safe-integer range, 2**53 - 1. Beyond them a double can
    #: no longer tell two neighbouring integers apart, so a document carrying
    #: such a value means one thing to a reader with 64-bit floats and another
    #: to a reader with arbitrary-precision integers.
    max_integer: int
    min_integer: int


#: Max nesting of containers (root container counts as level 1), max bytes in
#: one serialized handover, and the ends of the integer domain.
INGEST_LIMITS: Final = IngestLimits(
    max_depth=32,
    max_bytes=1048576,
    max_integer=9007199254740991,
    min_integer=-9007199254740991,
)

#: The decimal digits of :attr:`IngestLimits.max_integer`.
#:
#: The range check compares digit strings rather than converting, because on
#: four of the five surfaces the conversion is what loses the answer. Python is
#: the exception — its ``int`` is exact at any size — and that is precisely
#: why the comparison is written the same way here: a surface that reaches the
#: same verdict by a different route is a surface that can drift.
_MAX_INTEGER_DIGITS: Final = "9007199254740991"

#: A JSON number token in the integer form: no fraction part, no exponent.
_INTEGER_TOKEN: Final = re.compile(r"^-?(?:0|[1-9][0-9]*)$")

#: The stable error codes. Identical strings on every surface.
INGEST_ERROR_CODES: Final[tuple[str, ...]] = (
    "document.too_large",
    "encoding.byte_order_mark",
    "encoding.unsupported_encoding",
    "encoding.invalid_utf8",
    "structure.depth_exceeded",
    "syntax.invalid_json",
    "structure.duplicate_member",
    "number.not_an_integer",
    "number.out_of_range",
)


@dataclass(frozen=True)
class IngestIssue:
    """One refusal. Carries a class and a location, never document content."""

    code: str
    path: str
    message: str


class IngestError(Exception):
    """Raised by the ``*_or_raise`` entry points."""

    def __init__(self, issue: IngestIssue) -> None:
        super().__init__(issue.message)
        self.issue = issue


# --------------------------------------------------------------------------
# Stage 1: the bytes
# --------------------------------------------------------------------------

_BYTE_ORDER_MARKS: Final[tuple[tuple[str, bytes], ...]] = (
    # The four-byte marks come first: a UTF-32LE mark begins with the two
    # bytes of a UTF-16LE mark, so testing the short one first would misname
    # it.
    ("UTF-32LE", b"\xff\xfe\x00\x00"),
    ("UTF-32BE", b"\x00\x00\xfe\xff"),
    ("UTF-8", b"\xef\xbb\xbf"),
    ("UTF-16LE", b"\xff\xfe"),
    ("UTF-16BE", b"\xfe\xff"),
)


def _sniff_unit_width(data: bytes) -> str | None:
    """The encoding the first four bytes imply.

    Follows the detection rule in RFC 4627 section 3: the first token of a
    JSON text is always ASCII, so the position of the NUL padding names the
    encoding without decoding anything. ``None`` means the bytes are
    consistent with UTF-8.
    """
    if len(data) < 4:
        return None
    a, b, c, d = data[0], data[1], data[2], data[3]
    if a == 0 and b == 0 and c == 0 and d != 0:
        return "UTF-32BE"
    if a != 0 and b == 0 and c == 0 and d == 0:
        return "UTF-32LE"
    if a == 0 and b != 0 and c == 0 and d != 0:
        return "UTF-16BE"
    if a != 0 and b == 0 and c != 0 and d == 0:
        return "UTF-16LE"
    return None


# --------------------------------------------------------------------------
# Stage 2: the depth scan
# --------------------------------------------------------------------------


def _scan_depth(text: str) -> IngestIssue | None:
    """Bound the nesting without recursing and without building a value.

    String-aware, because a brace inside a string is content. It reports
    nothing but depth: the text may still be malformed at this point, and the
    parser is the authority on syntax.

    The numeric domain is NOT checked here. This walk runs before the parser,
    on text that may be malformed, so a run of characters is not yet a number.
    It is judged through ``parse_int`` and ``parse_float`` instead, which the
    standard library hands the token's literal text.
    """
    depth = 0
    i = 0
    length = len(text)
    while i < length:
        ch = text[i]
        if ch == '"':
            i += 1
            while i < length:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == '"':
                    break
                i += 1
            i += 1
            continue
        if ch in "{[":
            depth += 1
            if depth > INGEST_LIMITS.max_depth:
                return IngestIssue(
                    "structure.depth_exceeded",
                    "",
                    "a serialized handover must nest at most "
                    f"{INGEST_LIMITS.max_depth} levels, found {depth}",
                )
        elif ch in "}]":
            depth -= 1
        i += 1
    return None


# --------------------------------------------------------------------------
# Stage 3: the parse, with the standard library's duplicate hook
# --------------------------------------------------------------------------


class _DuplicateWatcher:
    """Collects duplicate member names and recovers where each one sat.

    ``object_pairs_hook`` fires bottom-up and is told nothing about the
    document position of the object it is building. So each object that finds
    a repetition records it against its own identity, and every parent, as it
    is built, prefixes its member name onto whatever its children reported.
    The root closes the pointer.

    Arrays have no hook in the standard library, so an array is walked when
    its owning object is built. That walk is bounded: the depth scan has
    already refused anything deeper than the ceiling.
    """

    def __init__(self) -> None:
        self._pending: dict[int, list[tuple[list[str], str]]] = {}
        # The built containers are kept alive so their ``id`` stays valid for
        # the whole parse; CPython reuses the ids of collected objects.
        self._keep: list[Any] = []

    def hook(self, pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        built: dict[str, Any] = {}
        found: list[tuple[list[str], str]] = []
        for name, value in pairs:
            if name in built:
                found.append(([], name))
            built[name] = value
            found.extend(
                ([name, *segments], leaf)
                for segments, leaf in self._drain(value)
            )
        if found:
            self._pending[id(built)] = found
        self._keep.append(built)
        return built

    def _drain(self, value: Any) -> list[tuple[list[str], str]]:
        """Everything reported from inside one member's value."""
        if isinstance(value, dict):
            return self._pending.pop(id(value), [])
        if isinstance(value, list):
            out: list[tuple[list[str], str]] = []
            for index, item in enumerate(value):
                out.extend(
                    ([str(index), *segments], leaf)
                    for segments, leaf in self._drain(item)
                )
            return out
        return []

    def first(self, root: Any) -> IngestIssue | None:
        """The duplicate to report, or ``None``.

        A document may carry several; the fixtures carry exactly one each, so
        which of several is reported is deliberately not specified.
        """
        reported = self._drain(root) if not isinstance(root, dict) else self._pending.get(id(root), [])
        if not reported:
            return None
        segments, leaf = reported[0]
        pointer = "/" + "/".join(
            _escape_pointer_segment(s) for s in [*segments, leaf]
        )
        return IngestIssue(
            "structure.duplicate_member",
            pointer,
            "a serialized handover must not repeat a member name inside one "
            "object: with a repeated name, two readers of the same bytes can "
            "hold different documents",
        )


def _escape_pointer_segment(segment: str) -> str:
    """RFC 6901: ``~`` becomes ``~0`` and ``/`` becomes ``~1``."""
    return segment.replace("~", "~0").replace("/", "~1")


# --------------------------------------------------------------------------
# Stage 4: the numeric domain
# --------------------------------------------------------------------------


def _judge_number_token(token: str) -> str | None:
    """Judge one JSON number token against the integer domain, from its TEXT.

    ``None`` means the token is inside the domain. The two refusals are
    separate codes because they are separate mistakes: a fraction or an
    exponent is a producer writing a value the format does not carry, while a
    twenty-digit integer is a producer writing a value no reader can carry
    back.
    """
    if _INTEGER_TOKEN.match(token) is None:
        return "number.not_an_integer"
    digits = token[1:] if token.startswith("-") else token
    if len(digits) > len(_MAX_INTEGER_DIGITS):
        return "number.out_of_range"
    if len(digits) == len(_MAX_INTEGER_DIGITS) and digits > _MAX_INTEGER_DIGITS:
        return "number.out_of_range"
    return None


def _number_message(code: str) -> str:
    """The message for one numeric refusal. Names a class, never a value."""
    if code == "number.not_an_integer":
        return (
            "a number in a handover must be written as an integer, with no "
            "fraction part and no exponent"
        )
    return (
        "a number in a handover must lie between "
        f"{INGEST_LIMITS.min_integer} and {INGEST_LIMITS.max_integer}"
    )


class _OutsideDomain:
    """A number token the domain refuses, standing where its value would be.

    ``json.loads`` calls ``parse_int`` and ``parse_float`` with the token's
    literal TEXT, before any conversion, which is the only representation the
    five surfaces read the same way. It does not say where the token sat, so
    the refusal is parked in the tree in the value's place and located by one
    walk afterwards. The tree is walked, never the text: the depth ceiling has
    already bounded it, and a second scanner would be a second thing to keep
    in step with the first.
    """

    __slots__ = ("code",)

    def __init__(self, code: str) -> None:
        self.code = code


def _parse_int(token: str) -> Any:
    code = _judge_number_token(token)
    return int(token) if code is None else _OutsideDomain(code)


def _parse_float(token: str) -> Any:
    # Every token that reaches ``parse_float`` carries a fraction part or an
    # exponent, so it is outside the integer domain whatever its value is.
    # 1e2 is 100 and is refused: deciding integrality of an arbitrary decimal
    # needs exact decimal arithmetic the five runtimes do not share, and a
    # rule the five cannot execute identically is not a rule.
    return _OutsideDomain(_judge_number_token(token) or "number.not_an_integer")


def _find_outside_domain(
    value: Any, segments: list[str]
) -> IngestIssue | None:
    """The first refused number in the tree, with the pointer to where it sat."""
    if isinstance(value, _OutsideDomain):
        pointer = "/" + "/".join(
            _escape_pointer_segment(s) for s in segments
        ) if segments else ""
        return IngestIssue(value.code, pointer, _number_message(value.code))
    if isinstance(value, dict):
        for name, item in value.items():
            found = _find_outside_domain(item, [*segments, name])
            if found is not None:
                return found
        return None
    if isinstance(value, list):
        for index, item in enumerate(value):
            found = _find_outside_domain(item, [*segments, str(index)])
            if found is not None:
                return found
    return None


# --------------------------------------------------------------------------
# The door
# --------------------------------------------------------------------------


def ingest_document(data: bytes) -> tuple[Any, IngestIssue | None]:
    """Ingest one serialized handover from bytes.

    Returns ``(value, None)`` when the document passes, and
    ``(None, issue)`` when it does not. Nothing is ever repaired.
    """
    if len(data) > INGEST_LIMITS.max_bytes:
        return None, IngestIssue(
            "document.too_large",
            "",
            "a serialized handover must be at most "
            f"{INGEST_LIMITS.max_bytes} bytes, got {len(data)}",
        )

    for encoding, mark in _BYTE_ORDER_MARKS:
        if data.startswith(mark):
            return None, IngestIssue(
                "encoding.byte_order_mark",
                "",
                "a serialized handover must not begin with a byte order "
                f"mark; these bytes open with a {encoding} mark. A producer "
                "must not write one, and a reader must not strip one.",
            )

    sniffed = _sniff_unit_width(data)
    if sniffed is not None:
        return None, IngestIssue(
            "encoding.unsupported_encoding",
            "",
            f"a serialized handover must be UTF-8; these bytes are {sniffed}. "
            "Other encodings are invalid and are never converted.",
        )

    try:
        # ``strict`` is the default and is the point: ``errors="replace"``
        # would substitute U+FFFD and hand on a document nobody wrote.
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None, IngestIssue(
            "encoding.invalid_utf8",
            "",
            "a serialized handover must be valid UTF-8; these bytes are not, "
            "and malformed UTF-8 is refused rather than repaired",
        )

    return ingest_text(text)


def ingest_text(text: str) -> tuple[Any, IngestIssue | None]:
    """Ingest a serialized handover that has already been decoded to text.

    The encoding rules that survive decoding still apply: a leading U+FEFF is
    a byte order mark whether it arrived as three bytes or as one character.
    """
    size = len(text.encode("utf-8"))
    if size > INGEST_LIMITS.max_bytes:
        return None, IngestIssue(
            "document.too_large",
            "",
            "a serialized handover must be at most "
            f"{INGEST_LIMITS.max_bytes} bytes, got {size}",
        )
    if text.startswith("﻿"):
        return None, IngestIssue(
            "encoding.byte_order_mark",
            "",
            "a serialized handover must not begin with a byte order mark; "
            "this text opens with a UTF-8 mark. A producer must not write "
            "one, and a reader must not strip one.",
        )

    # Depth first, and before anything recurses.
    deep = _scan_depth(text)
    if deep is not None:
        return None, deep

    watcher = _DuplicateWatcher()
    try:
        value = json.loads(
            text,
            object_pairs_hook=watcher.hook,
            parse_constant=_reject_constant,
            parse_int=_parse_int,
            parse_float=_parse_float,
        )
    except (ValueError, RecursionError):
        return None, IngestIssue(
            "syntax.invalid_json",
            "",
            "the input is not a single well-formed JSON document",
        )

    duplicate = watcher.first(value)
    if duplicate is not None:
        return None, duplicate

    # The numeric domain last. It needs a well-formed document to be talking
    # about numbers at all.
    outside = _find_outside_domain(value, [])
    if outside is not None:
        return None, outside
    return value, None


def _reject_constant(name: str) -> Any:
    """``NaN``, ``Infinity`` and ``-Infinity`` are not JSON.

    Python accepts them by default, which no other surface here does. This
    keeps the five parsers agreeing on what a JSON document is; the numeric
    DOMAIN (what a handover may hold once it is a number) is the second half
    of this work package and is deliberately not decided here.
    """
    raise ValueError(f"{name} is not a JSON value")


def ingest_document_or_raise(data: bytes) -> Any:
    """Ingest bytes, or raise :class:`IngestError`."""
    value, issue = ingest_document(data)
    if issue is not None:
        raise IngestError(issue)
    return value


def ingest_text_or_raise(text: str) -> Any:
    """Ingest decoded text, or raise :class:`IngestError`."""
    value, issue = ingest_text(text)
    if issue is not None:
        raise IngestError(issue)
    return value
