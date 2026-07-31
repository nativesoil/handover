/**
 * Save-time checking and grading: the open baseline.
 *
 * `checkHandover` is deterministic, lint-style analysis of the handover
 * document itself. Every rule has an id, a severity and a plain-language
 * explanation, all documented openly in `docs/checking.md`. Same input, same
 * report, byte for byte. Nothing here calls a model, reaches the network, or
 * measures anything outside the document.
 *
 * The boundary, stated plainly: the baseline checker is deterministic analysis
 * of the document itself. Whether a handover actually restores a session is a
 * different question, answered only by a real load.
 *
 * The grade band belongs to the report and stops there. It is printed on the
 * card, present in `--json`, and it decides the exit code. It is NOT written
 * into the document: the `quality.capture` observation this module builds
 * carries counts, names and findings, and no band, no score and no aggregate
 * of any kind. A judgement made by a producer the reader never met has no
 * business travelling inside the thing it judges.
 */

import {
  SECTION_KEYS,
  SECTION_TIERS,
  textLength,
  type SectionKey,
} from "./sections.js";
import { countSections } from "./store.js";
import type { Handover, HandoverObservation, SectionCounts } from "./types.js";

/**
 * The version of this rule set. It moves when a rule is added or tuned, so a
 * report always says which rules produced it.
 */
export const CHECK_VERSION = "1.0.0";

/** The grade bands, best first. */
export const CHECK_GRADES = ["strong", "adequate", "thin", "failing"] as const;

/** A grade band. */
export type CheckGrade = (typeof CHECK_GRADES)[number];

/**
 * How much one rule outcome matters, decided by the rule that produced it. A
 * `problem` undermines the document's ability to restore anything. A `caution`
 * is a concrete weakness worth fixing. `advice` is a soft signal that never
 * lowers the grade.
 *
 * Severity classifies the individual rule outcome. It is never a judgement of
 * the handover, and summing severities into one word is the report's business,
 * not the document's.
 */
export const CHECK_SEVERITIES = ["problem", "caution", "advice"] as const;

/** A finding severity. */
export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];

/**
 * Every rule in the baseline, with its one-line explanation. The full
 * rationale for each lives in `docs/checking.md`; this record is what the CLI
 * prints next to a finding.
 */
export const CHECK_RULES = Object.freeze({
  "completeness.missing-without-reason":
    "a section is declared missing with no reason stated anywhere",
  "completeness.no-durable-truth":
    "no durable-tier section carries content, so nothing outlives the session",
  "self-containment.fetch-pointer":
    "the text sends the reader somewhere else instead of carrying the content",
  "time.unanchored":
    "a frontier section uses time words with no capture-time anchor",
  "decisions.entry-without-reason":
    "a decision is stated with no recorded reason, which invites relitigation",
  "anchors.no-exact-values":
    "the section talks about configuration but carries no exact values",
  "gaps.blocked-without-omission-note":
    "a section was withheld but the safety record does not say what or where",
  "restore.absent":
    "content was captured but there are no restore instructions to boot it",
  "restore.thin":
    "the restore instructions are far shorter than the content they must boot",
  "size.one-liner":
    "a one-line section in an otherwise rich document reads as thinness",
} as const);

/** A rule id from {@link CHECK_RULES}. */
export type CheckRuleId = keyof typeof CHECK_RULES;

/** One finding from one rule. */
export interface CheckFinding {
  /** The rule that produced this finding. */
  readonly rule: CheckRuleId;
  readonly severity: CheckSeverity;
  /** The section it points at, or absent for a document-level finding. */
  readonly section?: SectionKey;
  /** What was found, in plain language. */
  readonly message: string;
}

/** Findings counted by severity. */
export interface CheckCounts {
  readonly problems: number;
  readonly cautions: number;
  readonly advice: number;
}

/** The whole report. Ephemeral output: nothing in it is part of the document. */
export interface CheckReport {
  /** The rule-set version that produced this report. */
  readonly checkVersion: string;
  /** The band. Report only: it is never written onto a handover. */
  readonly grade: CheckGrade;
  readonly counts: CheckCounts;
  readonly findings: readonly CheckFinding[];
  /** Section counts, as `countSections` reports them. */
  readonly sections: SectionCounts;
}

/**
 * The grade mapping, documented in `docs/checking.md` and applied nowhere
 * else. Counts in, band out, no judgement calls:
 *
 *   failing   3 or more problems
 *   thin      1 or 2 problems, or 6 or more cautions
 *   adequate  no problems, 1 to 5 cautions
 *   strong    no problems, no cautions; advice never lowers the grade
 */
export function gradeFromCounts(counts: CheckCounts): CheckGrade {
  if (counts.problems >= 3) return "failing";
  if (counts.problems >= 1 || counts.cautions >= 6) return "thin";
  if (counts.cautions >= 1) return "adequate";
  return "strong";
}

/**
 * Phrases that point away from the document. A handover assumes its reader
 * has nothing else, so "see the repo" is content that failed to travel. Each
 * pattern is a heuristic: deterministic, documented, and tuned to phrases
 * that present somewhere else as where the content lives.
 */
const FETCH_POINTERS: readonly RegExp[] = [
  /\bsee (?:the )?(?:repo|repository|docs|documentation|readme|wiki|codebase|source|thread|conversation|chat)\b/i,
  /\bin the (?:docs|documentation|readme|wiki)\b/i,
  /\bconsult\b/i,
  /\brefer to\b/i,
  /\b(?:see|check|visit|read|browse)\s+https?:\/\//i,
  /\b(?:described|documented|explained|detailed|available|found)\s+(?:at|in)\s+https?:\/\//i,
];

/** Words that are true only at one moment. */
const VOLATILE_TERMS =
  /\b(?:currently|right now|now|today|tonight|yesterday|tomorrow|this week|last week|this morning|this afternoon|at the moment|just now|recently)\b/i;

/** Phrases that pin volatile words to the capture. */
const CAPTURE_ANCHORS =
  /\b(?:at capture|at the capture|as of (?:this|the) capture|at the time of capture|when this was (?:captured|written)|at save time|as of \d{4}-\d{2}-\d{2})\b/i;

/** Verbs that state a decision. Scoped to the decisions section only. */
const DECISION_VERBS =
  /\b(?:decided|decision|locked|chose|chosen|agreed|settled|adopted|picked|selected|went with|opted|will use|use[sd]?|switched to|migrated to|standardi[sz]ed)\b/i;

/**
 * Markers that a reason was recorded. `cannot` and `could not` count because
 * a stated inability is a stated reason.
 */
const REASON_MARKERS =
  /\b(?:because|since|due to|so that|reason|why|after|caused|led to|avoid|avoids|avoided|prevent|prevents|prevented|otherwise|rather than|instead of|cannot|could not)\b/i;

/** Terms that say the section is talking about configuration. */
const CONFIG_TERMS =
  /\b(?:config|configuration|configured|environment variable|env var|port|version|pinned|flag|timeout|limit|ceiling|budget|quota|threshold)\b/i;

/** The floor parameters for the restore-instructions length rule. */
const RESTORE_MIN_CHARS = 300;
const RESTORE_FRACTION = 0.05;
const RESTORE_APPLIES_FROM = 1000;

/** The parameters for the one-liner rule. */
const ONE_LINER_MAX_CHARS = 40;
const ONE_LINER_MIN_SECTIONS = 5;
const ONE_LINER_MIN_MEDIAN = 200;

function availableSummary(
  handover: Handover,
  key: SectionKey,
): string | undefined {
  const section = handover.sections[key];
  return section?.status === "available" &&
    typeof section.summary === "string" &&
    section.summary.trim().length > 0
    ? section.summary
    : undefined;
}

function firstMatch(
  text: string,
  patterns: readonly RegExp[],
): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return undefined;
}

/**
 * Split a section's prose into entries: numbered items, bulleted items, and
 * blank-line-separated paragraphs. Deterministic, no interpretation.
 */
export function splitEntries(text: string): string[] {
  const entries: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) entries.push(current.join(" "));
    current = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      flush();
      continue;
    }
    if (/^(?:\d+[.)]\s+|[-*•▸]\s+)/.test(line)) {
      flush();
    }
    current.push(line);
  }
  flush();
  return entries;
}

/** The lower median of a list of numbers. */
function lowerMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

function preview(text: string, max: number = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Check a handover: run every rule, count the findings, map the counts to a
 * grade band. The input is assumed structurally valid; run `validateHandover`
 * first, the way the CLI does.
 *
 * Pure and deterministic on purpose. No I/O, no clock, no randomness, no
 * model. The report is honest exactly because every finding can be traced to
 * a documented rule and re-produced by anyone from the same bytes.
 */
export function checkHandover(handover: Handover): CheckReport {
  const findings: CheckFinding[] = [];
  const add = (
    rule: CheckRuleId,
    severity: CheckSeverity,
    message: string,
    section?: SectionKey,
  ): void => {
    findings.push({
      rule,
      severity,
      ...(section !== undefined ? { section } : {}),
      message,
    });
  };

  const missingInputs = handover.quality?.missingInputs ?? [];
  const unsafeOmissions = handover.safety?.unsafeOmissions ?? [];

  // completeness.missing-without-reason: a gap is fine, an unexplained gap is
  // not. A reason can live in the section's own note or in the document-level
  // quality.missingInputs list.
  if (missingInputs.length === 0) {
    for (const key of SECTION_KEYS) {
      const section = handover.sections[key];
      if (
        section?.status === "missing" &&
        (section.summary === null || section.summary.trim().length === 0)
      ) {
        add(
          "completeness.missing-without-reason",
          "caution",
          "declared missing, with no note here and nothing in quality.missingInputs saying why",
          key,
        );
      }
    }
  }

  // gaps.blocked-without-omission-note: blocked means withheld for safety, and
  // the safety record is where the withheld fact is supposed to be named.
  for (const key of SECTION_KEYS) {
    const section = handover.sections[key];
    if (section?.status === "blocked" && unsafeOmissions.length === 0) {
      add(
        "gaps.blocked-without-omission-note",
        "caution",
        "withheld for safety, but safety.unsafeOmissions does not name what exists or where it is configured",
        key,
      );
    }
  }

  // completeness.no-durable-truth: with zero durable sections, nothing in the
  // document outlives the session it came from.
  const durableAvailable = SECTION_KEYS.filter(
    (key) =>
      SECTION_TIERS[key] === "durable" &&
      availableSummary(handover, key) !== undefined,
  );
  if (durableAvailable.length === 0) {
    add(
      "completeness.no-durable-truth",
      "problem",
      "none of the six durable-tier sections carries content, so the project's lasting truth did not travel",
    );
  }

  // self-containment.fetch-pointer: per section. A pointer inside the restore
  // instructions is a problem, because the boot prompt must stand alone; in
  // any other section it is a caution.
  for (const key of SECTION_KEYS) {
    const text = availableSummary(handover, key);
    if (text === undefined) continue;
    const match = firstMatch(text, FETCH_POINTERS);
    if (match !== undefined) {
      add(
        "self-containment.fetch-pointer",
        key === "restoreInstructions" ? "problem" : "caution",
        `sends the reader elsewhere ("${preview(match, 40)}"), but a handover reader has no repo, no docs and no earlier thread`,
        key,
      );
    }
  }

  // time.unanchored: frontier sections describe a moment. Time words with no
  // capture anchor in the same section will read as the present to a reader
  // arriving later.
  for (const key of SECTION_KEYS) {
    if (SECTION_TIERS[key] !== "frontier") continue;
    const text = availableSummary(handover, key);
    if (text === undefined) continue;
    const volatile = VOLATILE_TERMS.exec(text);
    if (volatile && !CAPTURE_ANCHORS.test(text)) {
      add(
        "time.unanchored",
        "caution",
        `uses "${volatile[0]}" with no capture-time anchor, so a later reader cannot tell when it was true`,
        key,
      );
    }
  }

  // decisions.entry-without-reason: a decision with no recorded reason is the
  // exact thing a later session relitigates.
  const decisionsText = availableSummary(handover, "decisions");
  if (decisionsText !== undefined) {
    splitEntries(decisionsText).forEach((entry, i) => {
      if (DECISION_VERBS.test(entry) && !REASON_MARKERS.test(entry)) {
        add(
          "decisions.entry-without-reason",
          "caution",
          `entry ${i + 1} states a decision with no recorded reason ("${preview(entry)}")`,
          "decisions",
        );
      }
    });
  }

  // anchors.no-exact-values: architecture and constraints that mention
  // configuration but carry no digits have probably lost their pins.
  for (const key of ["architecture", "constraints"] as const) {
    const text = availableSummary(handover, key);
    if (text !== undefined && CONFIG_TERMS.test(text) && !/\d/.test(text)) {
      add(
        "anchors.no-exact-values",
        "advice",
        "mentions configuration but holds no numbers, versions or pins; exact values are what survive a move",
        key,
      );
    }
  }

  // restore.absent and restore.thin: the restore instructions are the boot
  // prompt. Captured content with no boot prompt, or a boot prompt far
  // smaller than the content, will not bring a cold session back.
  const restoreText = availableSummary(handover, "restoreInstructions");
  const otherAvailableChars = SECTION_KEYS.filter(
    (key) => key !== "restoreInstructions",
  )
    .map((key) => availableSummary(handover, key)?.length ?? 0)
    .reduce((a, b) => a + b, 0);
  if (restoreText === undefined && otherAvailableChars > 0) {
    add(
      "restore.absent",
      "problem",
      "content was captured but restoreInstructions is empty, so nothing tells the next session how to begin",
      "restoreInstructions",
    );
  }
  if (
    restoreText !== undefined &&
    otherAvailableChars >= RESTORE_APPLIES_FROM
  ) {
    const floor = Math.max(
      RESTORE_MIN_CHARS,
      Math.floor(otherAvailableChars * RESTORE_FRACTION),
    );
    if (restoreText.length < floor) {
      add(
        "restore.thin",
        "problem",
        `the restore instructions are ${restoreText.length} characters against ${otherAvailableChars} of captured content, below the documented floor of ${floor}`,
        "restoreInstructions",
      );
    }
  }

  // size.one-liner: in a document whose sections are otherwise substantial, a
  // near-empty available section is a thinness signal, not an error.
  const availableLengths = SECTION_KEYS.map(
    (key) => availableSummary(handover, key)?.length,
  ).filter((length): length is number => length !== undefined);
  if (
    availableLengths.length >= ONE_LINER_MIN_SECTIONS &&
    lowerMedian(availableLengths) >= ONE_LINER_MIN_MEDIAN
  ) {
    for (const key of SECTION_KEYS) {
      const text = availableSummary(handover, key);
      if (text !== undefined && text.length < ONE_LINER_MAX_CHARS) {
        add(
          "size.one-liner",
          "advice",
          `carries ${text.length} characters in a document whose sections are otherwise substantial`,
          key,
        );
      }
    }
  }

  // Deterministic order: document-level findings first, then sections in
  // canonical order, then rule id, then message.
  const sectionIndex = (key?: SectionKey): number =>
    key === undefined ? -1 : SECTION_KEYS.indexOf(key);
  findings.sort(
    (a, b) =>
      sectionIndex(a.section) - sectionIndex(b.section) ||
      a.rule.localeCompare(b.rule) ||
      a.message.localeCompare(b.message),
  );

  const counts: CheckCounts = {
    problems: findings.filter((f) => f.severity === "problem").length,
    cautions: findings.filter((f) => f.severity === "caution").length,
    advice: findings.filter((f) => f.severity === "advice").length,
  };

  return {
    checkVersion: CHECK_VERSION,
    grade: gradeFromCounts(counts),
    counts,
    findings,
    sections: countSections(handover),
  };
}

/**
 * The upper bound on `notes` in a `quality.capture` payload, in Unicode code
 * points, the unit every length bound in this format is counted in. See
 * {@link textLength} and `spec/value-domain.md`.
 *
 * `notes` is short, non-evaluative context: what the producer wants a reader
 * to know about how the examination was made. It is deliberately too small to
 * become a container for a hidden aggregate, and {@link checkObservation}
 * refuses anything longer rather than truncating a claim in the middle.
 */
export const CHECK_NOTES_MAX_CHARS = 280;

/**
 * The note this module writes when the caller supplies none. It states what
 * kind of examination ran and nothing about how the result compares to
 * anything, because a comparison is a judgement.
 */
export const CHECK_DEFAULT_NOTES =
  "Structural examination of the document by the open deterministic baseline. Section statuses and rule outcomes only.";

/** What {@link checkObservation} needs beyond the report itself. */
export interface CheckObservationOptions {
  /** The tool that ran the check, with a version, e.g. `soil-cli/0.1.0`. */
  readonly producedBy: string;
  /** When the check ran (ISO 8601). */
  readonly producedAt: string;
  /**
   * Short non-evaluative context, at most {@link CHECK_NOTES_MAX_CHARS} code
   * points. Defaults to {@link CHECK_DEFAULT_NOTES}.
   */
  readonly notes?: string;
}

/**
 * Package a report as a `quality.capture` observation, ready to attach to the
 * stored handover.
 *
 * The payload is a closed field set, documented in `spec/observations.md`:
 *
 *   sectionsWithContent · missingSections · blockedSections ·
 *   findings · checkVersion · notes
 *
 * and nothing else. In particular no `grade`, no band, no score, and no
 * counts-by-severity roll-up. Those exist in the report, where the reader can
 * see who produced them and when; they do not exist on the document, where a
 * later reader would meet the verdict without ever meeting the producer.
 *
 * This does not make the band underivable, and pretending otherwise would be
 * its own dishonesty. Anyone holding this payload plus the published mapping
 * in `docs/checking.md` can count the severities and recompute the band
 * exactly. The difference is who makes that derivation, and whether the
 * threshold is in front of them when they do.
 */
export function checkObservation(
  handover: Handover,
  report: CheckReport,
  options: CheckObservationOptions,
): HandoverObservation {
  const notes = options.notes ?? CHECK_DEFAULT_NOTES;
  if (textLength(notes) > CHECK_NOTES_MAX_CHARS) {
    throw new Error(
      `quality.capture notes must be at most ${CHECK_NOTES_MAX_CHARS} code points, got ${textLength(notes)}`,
    );
  }
  // Section KEYS, not prose labels: `missingSections` and `blockedSections`
  // are addresses a reader can look up, the same identifiers `location` uses.
  const named = (status: "missing" | "blocked"): string[] =>
    SECTION_KEYS.filter((key) => handover.sections[key]?.status === status);
  return {
    kind: "quality.capture",
    producedBy: options.producedBy,
    producedAt: options.producedAt,
    data: {
      checkVersion: report.checkVersion,
      sectionsWithContent: report.sections.withContent,
      missingSections: named("missing"),
      blockedSections: named("blocked"),
      findings: report.findings.map((finding) => ({
        rule: finding.rule,
        // JSON-Pointer-ish, the same shape a validation issue uses. "/" is the
        // document itself, for a rule that is not about one section.
        location:
          finding.section === undefined ? "/" : `/sections/${finding.section}`,
        observed: finding.message,
        severity: finding.severity,
      })),
      notes,
    },
  };
}
