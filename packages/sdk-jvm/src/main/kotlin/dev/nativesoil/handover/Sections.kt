/**
 * The 17 sections of the Soil Handover Specification v1, their tiers, and the
 * provenance label set.
 *
 * The key list and the label list are the format's contract: an implementation
 * that renames, reorders, drops or adds a key is not producing a Soil handover.
 * Both are locked for the whole v1 line (see `spec/versioning.md`).
 *
 * Mirrors `packages/sdk-ts/src/sections.ts` value for value.
 */
@file:JvmName("Sections")

package dev.nativesoil.handover

/** The spec version this SDK reads and writes. */
const val SPEC_VERSION: String = "1.0"

/**
 * The format versions this SDK reads, exactly.
 *
 * Support is a set of versions, not a pattern. A reader that accepts `1.4`
 * because the string starts with `1.` is claiming to implement a version
 * nobody has written yet, and version one is a closed world: whatever a later
 * minor allowed, this reader would meet it having never been told what it
 * means. Refusing is the honest answer. See `spec/versioning.md`.
 */
val SUPPORTED_SPEC_VERSIONS: List<String> = listOf("1.0")

/**
 * The 17 section keys, in canonical order.
 *
 * Tier A (durable project truth) carries what stays true across sessions.
 * Tier B (this session's frontier) carries what was true at capture.
 * Tier C (handover meta) carries the boot prompt and the honesty record.
 */
@JvmField
val SECTION_KEYS: List<String> = listOf(
    // Tier A: the project (durable).
    "projectIdentity",
    "decisions",
    "workflow",
    "architecture",
    "constraints",
    "rejectedPaths",
    // Tier B: the latest (this session's frontier).
    "executiveSummary",
    "currentTask",
    "latestUserIntent",
    "sessionDelta",
    "blockers",
    "nextSteps",
    "openQuestions",
    // Tier C: handover meta.
    "sessionActivity",
    "restoreInstructions",
    "provenanceMap",
    "safetySummary",
)

/** The tier a section belongs to. */
enum class SectionTier(val label: String) {
    DURABLE("durable"),
    FRONTIER("frontier"),
    META("meta"),
}

/** Which tier each section key belongs to. */
@JvmField
val SECTION_TIERS: Map<String, SectionTier> = mapOf(
    "projectIdentity" to SectionTier.DURABLE,
    "decisions" to SectionTier.DURABLE,
    "workflow" to SectionTier.DURABLE,
    "architecture" to SectionTier.DURABLE,
    "constraints" to SectionTier.DURABLE,
    "rejectedPaths" to SectionTier.DURABLE,
    "executiveSummary" to SectionTier.FRONTIER,
    "currentTask" to SectionTier.FRONTIER,
    "latestUserIntent" to SectionTier.FRONTIER,
    "sessionDelta" to SectionTier.FRONTIER,
    "blockers" to SectionTier.FRONTIER,
    "nextSteps" to SectionTier.FRONTIER,
    "openQuestions" to SectionTier.FRONTIER,
    "sessionActivity" to SectionTier.META,
    "restoreInstructions" to SectionTier.META,
    "provenanceMap" to SectionTier.META,
    "safetySummary" to SectionTier.META,
)

/** Short human labels used by the renderer and the CLI surfaces. */
@JvmField
val SECTION_LABELS: Map<String, String> = mapOf(
    "projectIdentity" to "project identity",
    "decisions" to "decisions",
    "workflow" to "workflow",
    "architecture" to "architecture",
    "constraints" to "constraints",
    "rejectedPaths" to "rejected paths",
    "executiveSummary" to "executive summary",
    "currentTask" to "current task",
    "latestUserIntent" to "latest user intent",
    "sessionDelta" to "session delta",
    "blockers" to "blockers",
    "nextSteps" to "next steps",
    "openQuestions" to "open questions",
    "sessionActivity" to "session activity",
    "restoreInstructions" to "restore instructions",
    "provenanceMap" to "provenance map",
    "safetySummary" to "safety summary",
)

/**
 * The four statuses a section may carry.
 *
 * `available` carries content. The other three are the kinds of nothing, and
 * they are not interchangeable: `missing` says the extractor could not see it
 * and the next session should look, `blocked` says it exists and was withheld
 * so the next session should ask elsewhere, and `not_applicable` says the
 * project has no such thing so the next session should stop looking.
 * `not_applicable` carries a required reason, because it is the one status
 * that tells a reader to stop.
 */
@JvmField
val SECTION_STATUSES: List<String> =
    listOf("available", "missing", "blocked", "not_applicable")

/**
 * The provenance labels a section may carry, so a cold reader can tell what was
 * checked from what was merely reported or guessed.
 *
 * The set is fixed so that a label means the same thing in every implementation
 * and a handover written by one tool reads the same in another. Labels are
 * additive facts about a claim's origin; they are not a grade, and nothing here
 * scores them.
 */
@JvmField
val PROVENANCE_LABELS: List<String> = listOf(
    "repo_verified",
    "soil_observed",
    "prompt_report",
    "user_locked_memory",
    "model_reported",
    "inferred",
    "owner_observed",
    "live_verified",
    "emulator_verified",
    "planned_only",
    "blocked",
)

/**
 * The unit every length bound in this format is counted in: the number of
 * Unicode code points in the string.
 *
 * Why this and not `String.length`. A Kotlin string on the JVM is a sequence
 * of UTF-16 code units, so an emoji costs two and a Deseret letter costs two,
 * while the same string is one code point per character in Python and one to
 * four bytes per character in Go. Three languages, three answers, one
 * document: the bound then means something different depending on who is
 * reading, which is the failure this format exists to prevent. The published
 * JSON Schema's `maxLength` is already defined in code points (JSON Schema
 * validation, section 6.3.1, on top of RFC 8259), so this is the unit the
 * normative artefact has always stated.
 *
 * Code points cost no Unicode table: the count is a property of the encoding,
 * not of the character database, and it does not change when a new Unicode
 * version ships. The normative statement is `spec/value-domain.md`.
 */
fun textLength(text: String): Int = text.codePointCount(0, text.length)

/**
 * Length and count bounds. A handover is a document, never a dump.
 *
 * Every bound named "code points" is counted with [textLength].
 */
object Limits {
    /** Max code points in `title`. */
    const val TITLE: Int = 200

    /** Max code points in `projectId`. */
    const val PROJECT_ID: Int = 120

    /** Max code points in a section `summary`. */
    const val SECTION_SUMMARY: Int = 20000

    /** Max provenance labels on one section. */
    const val PROVENANCE_LABELS: Int = 11

    /** Max entries in a `quality` or `safety` list. */
    const val LIST_ENTRIES: Int = 200

    /** Max code points in one `quality` or `safety` list entry. */
    const val LIST_ENTRY: Int = 1000

    /** Max attached observations. */
    const val OBSERVATIONS: Int = 100

    /** Max code points in an observation `kind`. */
    const val OBSERVATION_KIND: Int = 200
}
