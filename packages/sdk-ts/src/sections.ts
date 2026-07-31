/**
 * The 17 sections of the Soil Handover Specification v1, their tiers, and the
 * provenance label set.
 *
 * The key list and the label list are the format's contract: an implementation
 * that renames, reorders, drops or adds a key is not producing a Soil handover.
 * Both are locked for the whole v1 line (see `spec/versioning.md`).
 */

/**
 * The 17 section keys, in canonical order.
 *
 * Tier A (durable project truth) carries what stays true across sessions.
 * Tier B (this session's frontier) carries what was true at capture.
 * Tier C (handover meta) carries the boot prompt and the honesty record.
 */
export const SECTION_KEYS = Object.freeze([
  // Tier A — the project (durable).
  "projectIdentity",
  "decisions",
  "workflow",
  "architecture",
  "constraints",
  "rejectedPaths",
  // Tier B — the latest (this session's frontier).
  "executiveSummary",
  "currentTask",
  "latestUserIntent",
  "sessionDelta",
  "blockers",
  "nextSteps",
  "openQuestions",
  // Tier C — handover meta.
  "sessionActivity",
  "restoreInstructions",
  "provenanceMap",
  "safetySummary",
] as const);

/** A valid section key. */
export type SectionKey = (typeof SECTION_KEYS)[number];

/** The tier a section belongs to. */
export type SectionTier = "durable" | "frontier" | "meta";

/** Which tier each section key belongs to. */
export const SECTION_TIERS: Readonly<Record<SectionKey, SectionTier>> =
  Object.freeze({
    projectIdentity: "durable",
    decisions: "durable",
    workflow: "durable",
    architecture: "durable",
    constraints: "durable",
    rejectedPaths: "durable",
    executiveSummary: "frontier",
    currentTask: "frontier",
    latestUserIntent: "frontier",
    sessionDelta: "frontier",
    blockers: "frontier",
    nextSteps: "frontier",
    openQuestions: "frontier",
    sessionActivity: "meta",
    restoreInstructions: "meta",
    provenanceMap: "meta",
    safetySummary: "meta",
  } satisfies Record<SectionKey, SectionTier>);

/** Short human labels used by the renderer and the CLI. */
export const SECTION_LABELS: Readonly<Record<SectionKey, string>> =
  Object.freeze({
    projectIdentity: "project identity",
    decisions: "decisions",
    workflow: "workflow",
    architecture: "architecture",
    constraints: "constraints",
    rejectedPaths: "rejected paths",
    executiveSummary: "executive summary",
    currentTask: "current task",
    latestUserIntent: "latest user intent",
    sessionDelta: "session delta",
    blockers: "blockers",
    nextSteps: "next steps",
    openQuestions: "open questions",
    sessionActivity: "session activity",
    restoreInstructions: "restore instructions",
    provenanceMap: "provenance map",
    safetySummary: "safety summary",
  } satisfies Record<SectionKey, string>);

/**
 * The four statuses a section may carry.
 *
 * `available` carries content. The other three are the kinds of nothing, and
 * they are not interchangeable: `missing` says the extractor could not see it
 * and the next session should look, `blocked` says it exists and was withheld
 * so the next session should ask elsewhere, and `not_applicable` says the
 * project has no such thing so the next session should stop looking.
 * `not_applicable` carries a required reason, because it is the one status that
 * tells a reader to stop.
 */
export const SECTION_STATUSES = Object.freeze([
  "available",
  "missing",
  "blocked",
  "not_applicable",
] as const);

/** A valid section status. */
export type SectionStatus = (typeof SECTION_STATUSES)[number];

/**
 * The provenance labels a section may carry, so a cold reader can tell what was
 * checked from what was merely reported or guessed.
 *
 * The set is fixed so that a label means the same thing in every implementation
 * and a handover written by one tool reads the same in another. Labels are
 * additive facts about a claim's origin; they are not a grade, and nothing here
 * scores them.
 */
export const PROVENANCE_LABELS = Object.freeze([
  /** Checked against the project's own source of truth by the extractor. */
  "repo_verified",
  /** Observed by a Soil component rather than reported by the model. */
  "soil_observed",
  /** Taken from the standing instructions or system prompt in force. */
  "prompt_report",
  /** The user stated it and locked it explicitly. */
  "user_locked_memory",
  /** The model is reporting it from the conversation. */
  "model_reported",
  /** The model concluded it; nobody stated it. */
  "inferred",
  /** The project owner observed it directly. */
  "owner_observed",
  /** Confirmed against a running system. */
  "live_verified",
  /** Confirmed against a local or emulated system. */
  "emulator_verified",
  /** Intended but not built yet. */
  "planned_only",
  /** Withheld for safety; the fact exists, the value does not travel. */
  "blocked",
] as const);

/** A valid provenance label. */
export type ProvenanceLabel = (typeof PROVENANCE_LABELS)[number];

/**
 * The unit every length bound in this format is counted in: the number of
 * Unicode code points in the string.
 *
 * Why this and not `String.prototype.length`. A JavaScript string's `length`
 * is its count of UTF-16 code units, so an emoji costs two and a Deseret
 * letter costs two, while the same string is one code point per character in
 * Python and one to four bytes per character in Go. Three languages, three
 * answers, one document: the bound then means something different depending on
 * who is reading, which is the failure this format exists to prevent. The
 * published JSON Schema's `maxLength` is already defined in code points (JSON
 * Schema validation, section 6.3.1, on top of RFC 8259), so this is the unit
 * the normative artefact has always stated, and four of the five official
 * implementations were the ones out of step.
 *
 * Code points cost no Unicode table. Counting them is a property of the
 * encoding: in UTF-16 it is the count of units that are not low surrogates, in
 * UTF-8 the count of bytes that are not continuation bytes. Neither changes
 * when a new Unicode version ships, which is exactly what a grapheme-cluster
 * count could not promise.
 *
 * The normative statement is `spec/value-domain.md`.
 */
export function textLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    // A low surrogate continues the code point its high surrogate began, so
    // it is not counted. A lone surrogate of either kind counts as one, which
    // is what every other surface does with the same input.
    if (unit >= 0xdc00 && unit <= 0xdfff && i > 0) {
      const previous = text.charCodeAt(i - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) continue;
    }
    count += 1;
  }
  return count;
}

/**
 * Length and count bounds. A handover is a document, never a dump.
 *
 * Every bound named "code points" here is counted with {@link textLength}, and
 * `spec/value-domain.md` states which strings that unit applies to and which
 * it does not.
 */
export const LIMITS = Object.freeze({
  /** Max code points in `title`. */
  title: 200,
  /** Max code points in `projectId`. */
  projectId: 120,
  /** Max code points in a section `summary`. */
  sectionSummary: 20000,
  /** Max provenance labels on one section. */
  provenanceLabels: 11,
  /** Max entries in a `quality` or `safety` list. */
  listEntries: 200,
  /** Max code points in one `quality` or `safety` list entry. */
  listEntry: 1000,
  /** Max attached observations. */
  observations: 100,
  /** Max code points in an observation `kind`. */
  observationKind: 200,
} as const);
