"""The document types of the Soil Handover Specification v1.

A handover is interchanged as plain JSON, so in Python the document itself is
a plain ``dict`` all the way through: what ``json.loads`` returns is what this
SDK validates, stores and renders. The ``TypedDict`` classes here name the
shapes for type checkers, mirroring ``spec/handover.schema.json``; the schema
is normative, and the conformance suite asserts that this SDK and the schema
agree on every fixture, so neither can drift alone.

The result and finding types are frozen dataclasses: they are produced by this
SDK, never parsed from JSON.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, TypedDict

# The format version this SDK writes.
SPEC_VERSION = "1.0"

# The format versions this SDK reads, exactly.
#
# Support is a set of versions, not a pattern. A reader that accepts "1.4"
# because the string starts with "1." is claiming to implement a version
# nobody has written yet, and version one is a closed world: whatever a later
# minor allowed, this reader would meet it having never been told what it
# means. Refusing is the honest answer. See spec/versioning.md.
SUPPORTED_SPEC_VERSIONS = ("1.0",)


class HandoverSection(TypedDict, total=False):
    """One of the 17 sections of a handover.

    ``status`` is one of ``available``, ``missing``, ``blocked`` or
    ``not_applicable``. A section is never silently absent: the gap is part of
    the document, and so is which kind of gap it is. ``summary`` is the
    section's prose, required and non-empty when the status is ``available``
    and when it is ``not_applicable`` (where it says why the section does not
    apply), otherwise ``None`` or a short note saying what is gone and why.
    ``provenance`` says where the section's claims came from.
    """

    status: str
    summary: str | None
    provenance: list[str]


class HandoverSource(TypedDict, total=False):
    """Where the handover was written. All fields optional and free-form.

    ``recipeVersion`` is the semver of the extraction recipe that produced
    the document. Only a writer that actually produced the document from that
    recipe sets it; a tool handed a finished document must not stamp its own
    version into it. Documents produced by other writers may lack it. It moves
    independently of the format version.
    """

    client: str
    model: str
    provider: str
    recipeVersion: str


class HandoverQuality(TypedDict, total=False):
    """The extractor's own honesty record. Stated gaps are the point."""

    missingInputs: list[str]
    contradictions: list[str]


class HandoverSafety(TypedDict, total=False):
    """What was deliberately left out so the document is safe to move."""

    unsafeOmissions: list[str]


class HandoverObservation(TypedDict, total=False):
    """An observation: evidence attached to a handover.

    This is the format's one extension point. A reader that does not recognise
    a ``kind`` ignores that entry and carries it forward unchanged.
    Observations never change how the 17 sections are read, and the safety
    rule applies inside ``data`` exactly as it does everywhere else.
    """

    kind: str
    producedBy: str
    producedAt: str
    data: dict[str, Any]


class Handover(TypedDict, total=False):
    """A complete Soil handover document, as parsed JSON."""

    soilHandover: str
    # The globally unique id, a UUID (the official writers emit UUIDv7).
    # Required in a valid document; absent from a freshly extracted one,
    # because the writer assigns it at store time.
    handoverId: str
    projectId: str
    title: str
    createdAt: str
    source: HandoverSource
    sections: dict[str, HandoverSection]
    quality: HandoverQuality
    safety: HandoverSafety
    observations: list[HandoverObservation]
    # Written by a store, never by an extractor; absent in a fresh document.
    code: str


class StoreEntry(TypedDict):
    """A row in the local index. Keys are the on-disk JSON keys."""

    code: str
    projectId: str
    title: str
    createdAt: str
    # How many of the 17 sections have status "available". Structural content
    # presence, never a claim that the capture succeeded.
    sectionsWithContent: int
    # File name inside the store's handovers/ directory.
    file: str


class StoreIndex(TypedDict):
    """The on-disk index document."""

    indexVersion: int
    # The next numeric code the store will hand out.
    nextCode: int
    entries: list[StoreEntry]


@dataclass(frozen=True)
class ValidationIssue:
    """One problem found by ``validate_handover``.

    ``kind`` says what kind of rule the issue broke: ``structure`` is the
    shape of the document, ``safety`` is the fail-closed secret scan, which is
    a spec rule rather than a schema rule because JSON Schema cannot express
    "this string looks like a token". The message never quotes the offending
    value.
    """

    path: str
    message: str
    kind: str = "structure"


@dataclass(frozen=True)
class ValidationResult:
    """The result of validating a candidate handover."""

    valid: bool
    issues: tuple[ValidationIssue, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class SectionCounts:
    """Section counts for a handover. Structural content presence, never a grade.

    The field is ``with_content``, not ``captured``: a section holding two
    characters has content present and nothing more. "Captured" asserts that
    the thing was successfully taken, which a count of non-empty summaries
    cannot know.
    """

    with_content: int
    missing: int
    blocked: int
    not_applicable: int
    # Always 17.
    total: int


#: Deprecated alias kept for one release; use :class:`SectionCounts`.
CaptureCounts = SectionCounts
