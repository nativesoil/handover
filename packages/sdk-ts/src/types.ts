/**
 * The document types of the Soil Handover Specification v1.
 *
 * These types are the TypeScript mirror of `spec/handover.schema.json`. The
 * schema is normative; a conformance test in this repo asserts that the two
 * agree on every fixture, so neither can drift alone.
 */

import type { ProvenanceLabel, SectionKey, SectionStatus } from "./sections.js";

/** The format version this SDK writes. */
export const SPEC_VERSION = "1.0" as const;

/**
 * The format versions this SDK reads, exactly.
 *
 * Support is a set of versions, not a pattern. A reader that accepts `1.4`
 * because the string starts with `1.` is claiming to implement a version
 * nobody has written yet, and version one is a closed world: whatever a later
 * minor allowed, this reader would meet it having never been told what it
 * means. Refusing is the honest answer. See `spec/versioning.md`.
 */
export const SUPPORTED_SPEC_VERSIONS = Object.freeze(["1.0"] as const);

/** One of the 17 sections of a handover. */
export interface HandoverSection {
  /**
   * `available` means the content is here. `missing` means the extractor could
   * not see it. `blocked` means it was withheld for safety. `not_applicable`
   * means the project genuinely has no such thing. A section is never silently
   * absent: the gap is part of the document, and so is which kind of gap it is.
   */
  readonly status: SectionStatus;
  /**
   * The section's prose. Required and non-empty when `status` is `available`,
   * and when `status` is `not_applicable`, where it says why the section does
   * not apply. When `status` is `missing` or `blocked` this is `null`, or a
   * short note saying what is gone and why.
   */
  readonly summary: string | null;
  /** Where this section's claims came from. */
  readonly provenance?: readonly ProvenanceLabel[];
}

/** All 17 sections, keyed. Every key is present; a gap is declared, not omitted. */
export type HandoverSections = {
  readonly [K in SectionKey]: HandoverSection;
};

/** Where the handover was written. All fields optional and free-form. */
export interface HandoverSource {
  /** The tool the extraction ran in, e.g. `claude-code`, `chatgpt`. */
  readonly client?: string;
  /** The model that wrote it, e.g. `opus-4.8`. */
  readonly model?: string;
  /** The provider that served the model, e.g. `anthropic`. */
  readonly provider?: string;
  /**
   * The semver of the extraction recipe that produced this document, e.g.
   * `1.0.0`. The official writers always set it; documents produced by other
   * writers may lack it. Moves independently of the format version.
   */
  readonly recipeVersion?: string;
}

/** The extractor's own honesty record. Stated gaps are the point, not a defect. */
export interface HandoverQuality {
  /** What the extractor knows or suspects it could not capture. */
  readonly missingInputs?: readonly string[];
  /** Statements in the project that conflict and were not resolved. */
  readonly contradictions?: readonly string[];
}

/** What was deliberately left out so the document is safe to keep and to move. */
export interface HandoverSafety {
  /**
   * One line per withheld item: that it exists and where it is configured,
   * never its value.
   */
  readonly unsafeOmissions?: readonly string[];
}

/**
 * An observation: evidence attached to a handover.
 *
 * This is the format's one extension point. It exists so that things learned
 * about a project or about a capture can ride along with the handover without
 * the 17 sections having to grow a new key every time somebody has a new idea.
 *
 * The specification says nothing about how an observation is produced or what
 * it means. A reader that does not recognise a `kind` ignores that entry and
 * carries it forward unchanged. Observations never change how the 17 sections
 * are read, and no implementation needs to emit any to be conformant.
 *
 * The safety rule applies inside `data` exactly as it does everywhere else.
 */
export interface HandoverObservation {
  /** What this observation is. Namespaced strings are encouraged. */
  readonly kind: string;
  /** What produced it. */
  readonly producedBy?: string;
  /** When it was produced (ISO 8601). */
  readonly producedAt?: string;
  /** The payload. Free-form, and opaque to this specification. */
  readonly data: Record<string, unknown>;
}

/** A complete Soil handover document. */
export interface Handover {
  /** The spec version, e.g. `"1.0"`. */
  readonly soilHandover: string;
  /**
   * The handover's globally unique id: a UUID, emitted as a UUIDv7 by the
   * official writers. Required in a valid document; absent from a freshly
   * extracted one, because the writer assigns it at store time and the recipe
   * never asks a model to invent one. Opaque, never derived from content,
   * never reused, and unchanged by migration or by copying.
   */
  readonly handoverId?: string;
  /** A short stable slug for the project, e.g. `billing-rework`. */
  readonly projectId: string;
  /** A short human title for this handover. */
  readonly title: string;
  /** When the handover was written (ISO 8601, UTC). */
  readonly createdAt: string;
  /** Where it was written. */
  readonly source?: HandoverSource;
  /** The 17 sections. */
  readonly sections: HandoverSections;
  /** The extractor's honesty record. */
  readonly quality?: HandoverQuality;
  /** What was withheld for safety. */
  readonly safety?: HandoverSafety;
  /**
   * Optional evidence attached to this handover. Entries with an unrecognised
   * `kind` are ignored and carried forward, never dropped.
   */
  readonly observations?: readonly HandoverObservation[];
  /**
   * The local address a store assigned, e.g. `#004`. Written by the store, not
   * by the extractor; absent in a freshly extracted document.
   */
  readonly code?: string;
}

/** A row in the local index. */
export interface StoreEntry {
  /** The load code, e.g. `#004`. */
  readonly code: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: string;
  /**
   * How many of the 17 sections have `status: "available"`. Structural
   * content presence, never a claim that the capture succeeded.
   */
  readonly sectionsWithContent: number;
  /** File name inside the store's `handovers/` directory. */
  readonly file: string;
}

/** The on-disk index document. */
export interface StoreIndex {
  readonly indexVersion: 1;
  /** The next numeric code the store will hand out. */
  readonly nextCode: number;
  readonly entries: readonly StoreEntry[];
}

/**
 * What kind of rule an issue broke. `structure` is the shape of the document.
 * `safety` is the fail-closed secret scan, which is a spec rule rather than a
 * schema rule because JSON Schema cannot express "this string looks like a
 * token".
 */
export type ValidationIssueKind = "structure" | "safety";

/** One problem found by `validate`. */
export interface ValidationIssue {
  /** JSON Pointer-ish path to the offending value, e.g. `/sections/decisions`. */
  readonly path: string;
  /** What is wrong, in plain language. Never quotes the offending value. */
  readonly message: string;
  /** Which rule was broken. Defaults to `structure` when absent. */
  readonly kind?: ValidationIssueKind;
}

/** The result of validating a candidate handover. */
export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

/**
 * Section counts for a handover. Structural content presence, never a grade.
 *
 * The field is `withContent`, not `captured`: a section holding two characters
 * has content present and nothing more. "Captured" asserts that the thing was
 * successfully taken, which a count of non-empty summaries cannot know.
 */
export interface SectionCounts {
  /** Sections with `status: "available"` and a non-empty summary. */
  readonly withContent: number;
  /** Sections with `status: "missing"`. */
  readonly missing: number;
  /** Sections with `status: "blocked"`. */
  readonly blocked: number;
  /** Sections with `status: "not_applicable"`. */
  readonly notApplicable: number;
  /** Always 17. */
  readonly total: number;
}

/** @deprecated Renamed to {@link SectionCounts}. */
export type CaptureCounts = SectionCounts;
