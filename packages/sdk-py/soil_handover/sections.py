"""The 17 sections of the Soil Handover Specification v1, their tiers, and the
provenance label set.

The key list and the label list are the format's contract: an implementation
that renames, reorders, drops or adds a key is not producing a Soil handover.
Both are locked for the whole v1 line (see ``spec/versioning.md``), and both
are mirrored from ``packages/sdk-ts/src/sections.ts``; the conformance suite
holds the two implementations to the same fixtures.
"""

from __future__ import annotations

from dataclasses import dataclass

# The 17 section keys, in canonical order.
#
# Tier A (durable project truth) carries what stays true across sessions.
# Tier B (this session's frontier) carries what was true at capture.
# Tier C (handover meta) carries the boot prompt and the honesty record.
SECTION_KEYS: tuple[str, ...] = (
    # Tier A, the project (durable).
    "projectIdentity",
    "decisions",
    "workflow",
    "architecture",
    "constraints",
    "rejectedPaths",
    # Tier B, the latest (this session's frontier).
    "executiveSummary",
    "currentTask",
    "latestUserIntent",
    "sessionDelta",
    "blockers",
    "nextSteps",
    "openQuestions",
    # Tier C, handover meta.
    "sessionActivity",
    "restoreInstructions",
    "provenanceMap",
    "safetySummary",
)

# Which tier each section key belongs to: "durable", "frontier" or "meta".
SECTION_TIERS: dict[str, str] = {
    "projectIdentity": "durable",
    "decisions": "durable",
    "workflow": "durable",
    "architecture": "durable",
    "constraints": "durable",
    "rejectedPaths": "durable",
    "executiveSummary": "frontier",
    "currentTask": "frontier",
    "latestUserIntent": "frontier",
    "sessionDelta": "frontier",
    "blockers": "frontier",
    "nextSteps": "frontier",
    "openQuestions": "frontier",
    "sessionActivity": "meta",
    "restoreInstructions": "meta",
    "provenanceMap": "meta",
    "safetySummary": "meta",
}

# Short human labels used by the renderer.
SECTION_LABELS: dict[str, str] = {
    "projectIdentity": "project identity",
    "decisions": "decisions",
    "workflow": "workflow",
    "architecture": "architecture",
    "constraints": "constraints",
    "rejectedPaths": "rejected paths",
    "executiveSummary": "executive summary",
    "currentTask": "current task",
    "latestUserIntent": "latest user intent",
    "sessionDelta": "session delta",
    "blockers": "blockers",
    "nextSteps": "next steps",
    "openQuestions": "open questions",
    "sessionActivity": "session activity",
    "restoreInstructions": "restore instructions",
    "provenanceMap": "provenance map",
    "safetySummary": "safety summary",
}

# The four statuses a section may carry.
#
# ``available`` carries content. The other three are the kinds of nothing, and
# they are not interchangeable: ``missing`` says the extractor could not see it
# and the next session should look, ``blocked`` says it exists and was withheld
# so the next session should ask elsewhere, and ``not_applicable`` says the
# project has no such thing so the next session should stop looking.
# ``not_applicable`` carries a required reason, because it is the one status
# that tells a reader to stop.
SECTION_STATUSES: tuple[str, ...] = (
    "available",
    "missing",
    "blocked",
    "not_applicable",
)

# The provenance labels a section may carry, so a cold reader can tell what was
# checked from what was merely reported or guessed.
#
# The set is fixed so that a label means the same thing in every implementation
# and a handover written by one tool reads the same in another. Labels are
# additive facts about a claim's origin; they are not a grade, and nothing here
# scores them. The identifiers are format values and are never localised.
PROVENANCE_LABELS: tuple[str, ...] = (
    # Checked against the project's own source of truth by the extractor.
    "repo_verified",
    # Observed by a Soil component rather than reported by the model.
    "soil_observed",
    # Taken from the standing instructions or system prompt in force.
    "prompt_report",
    # The user stated it and locked it explicitly.
    "user_locked_memory",
    # The model is reporting it from the conversation.
    "model_reported",
    # The model concluded it; nobody stated it.
    "inferred",
    # The project owner observed it directly.
    "owner_observed",
    # Confirmed against a running system.
    "live_verified",
    # Confirmed against a local or emulated system.
    "emulator_verified",
    # Intended but not built yet.
    "planned_only",
    # Withheld for safety; the fact exists, the value does not travel.
    "blocked",
)


def text_length(text: str) -> int:
    """The unit every length bound in this format is counted in: the number
    of Unicode code points in the string.

    On this runtime that is exactly ``len``, because a Python ``str`` is a
    sequence of code points. The function exists anyway, and every bound is
    read through it, so the unit is named at the point of use rather than
    inherited from whichever language a reader happens to be in. The same
    bound is a count of UTF-16 code units in JavaScript, Kotlin and C# unless
    it is written deliberately, and a count of bytes in Go: three languages,
    three answers, one document.

    Code points cost no Unicode table. Counting them is a property of the
    encoding, not of the character database, and it does not change when a new
    Unicode version ships. The normative statement is ``spec/value-domain.md``.
    """
    return len(text)


@dataclass(frozen=True)
class Limits:
    """Length and count bounds. A handover is a document, never a dump.

    Every bound named "code points" is counted with :func:`text_length`, and
    ``spec/value-domain.md`` states which strings the unit applies to.
    """

    # Max code points in `title`.
    title: int = 200
    # Max code points in `projectId`.
    project_id: int = 120
    # Max code points in a section `summary`.
    section_summary: int = 20000
    # Max provenance labels on one section.
    provenance_labels: int = 11
    # Max entries in a `quality` or `safety` list.
    list_entries: int = 200
    # Max code points in one `quality` or `safety` list entry.
    list_entry: int = 1000
    # Max attached observations.
    observations: int = 100
    # Max code points in an observation `kind`.
    observation_kind: int = 200


LIMITS = Limits()
