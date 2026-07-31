/**
 * The rail card: the ASCII shape Soil prints after a save, a load, or a list.
 *
 * Design contract, do not break:
 *  - PURE. No I/O, no clock, no randomness. Same input, byte-identical output,
 *    which is why the tests can pin whole cards.
 *  - SAFE BY CALLER. The renderer formats already-safe text. It does not scan,
 *    redact or reconstruct anything.
 *  - COMPUTED LAYOUT. A fixed 2-space gutter, a continuous left rail, and
 *    rules extended to a fixed inner width. Alignment is computed from content,
 *    never hardcoded, so the card lands identically in every terminal.
 *
 * The card reports counts and names: how many sections carry content, which
 * ones do not, and what was held back on purpose. It never reports a score. A
 * local save has no opinion about how good your handover is.
 *
 * The save card and the load card carry the same two head blocks, and they do
 * so on purpose. A field a writer supplies has not been delivered until a
 * reader sees it, and a field shown on the way in and dropped on the way out is
 * the same defect as one never stored: `written by` names the tool, the model,
 * the provider and the extraction recipe behind the document, and `what this
 * document carries` names the withheld sections as withheld rather than as
 * empty. Which section carries which provenance label is a per-section mapping
 * and lives in the restore prompt; the card names the kinds of claim present,
 * which is what fits in a column.
 *
 * The section count is worded `sections carrying content` and never anything
 * that asserts capture, completeness, readiness or sufficiency, because the
 * count knows only that a summary string is non-empty. Seventeen sections of
 * two characters each also read 17 / 17. The fixed wording binds these
 * reference renderers; the requirement on any other interface is the meaning,
 * not the English (spec/README.md, normative requirement 13).
 */

import type { CheckFinding, CheckReport } from "./check.js";
import {
  PROVENANCE_LABELS,
  SECTION_KEYS,
  SECTION_LABELS,
  type ProvenanceLabel,
  type SectionKey,
} from "./sections.js";
import { countSections } from "./store.js";
import type {
  Handover,
  SectionCounts,
  StoreEntry,
  ValidationResult,
} from "./types.js";

const GUTTER = "  ";
const INNER_WIDTH = 52;
const RAIL_INDENT = "│   ";
const WRAP_WIDTH = 46;

/** Wrap prose to `width` columns on word boundaries. Never splits a word. */
export function wrap(text: string, width: number = WRAP_WIDTH): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line.length === 0) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line = `${line} ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

function masthead(state: string, code?: string): string {
  const head = `┌─ SOIL · ${state} `;
  const tail = code ? ` ${code} ─` : "";
  const fill = Math.max(1, INNER_WIDTH - head.length - tail.length);
  return `${GUTTER}${head}${"─".repeat(fill)}${tail}`;
}

function sectionRule(label: string): string {
  const head = `├─ ${label} `;
  const fill = Math.max(1, INNER_WIDTH - head.length);
  return `${GUTTER}${head}${"─".repeat(fill)}`;
}

function footer(text: string): string {
  return `${GUTTER}└─ ${text}`;
}

function blank(): string {
  return `${GUTTER}│`;
}

function line(text: string): string {
  return `${GUTTER}${RAIL_INDENT}${text}`;
}

function prose(text: string): string[] {
  return wrap(text).map((l) => line(l));
}

function sectionNames(keys: readonly SectionKey[]): string {
  return keys.map((key) => SECTION_LABELS[key]).join(", ");
}

function keysWithStatus(
  handover: Handover,
  status: "available" | "missing" | "blocked" | "not_applicable",
): SectionKey[] {
  return SECTION_KEYS.filter(
    (key) => handover.sections[key]?.status === status,
  );
}

/** Width of the label column inside the rail, e.g. `sections    `. */
const LABEL_WIDTH = 12;

/** The one count line. Structural presence, stated as such. */
function contentCountLine(counts: SectionCounts): string {
  return `${counts.withContent} / ${counts.total} sections carrying content`;
}

/**
 * A labelled row whose value wraps under itself, keeping the label column
 * clear: the eye should be able to run down the labels without meeting text.
 */
function labelled(label: string, value: string): string[] {
  const width = Math.max(LABEL_WIDTH, label.length + 2);
  return wrap(value, WRAP_WIDTH - width).map((text, i) =>
    line(`${(i === 0 ? label : "").padEnd(width)}${text}`),
  );
}

/**
 * The `source` fields, as the rows that show them.
 *
 * Labelled rather than joined with separators, because a reader met with
 * `chatgpt · gpt-5 · openai` has to guess which token is the tool, which is
 * the model and which is the provider. The label column says which is which,
 * and it is the same block on the save card and the load card, so a field a
 * writer supplied is a field the next reader meets. A row is omitted when the
 * field is absent; a document with no `source` gets no block at all.
 */
function sourceRows(handover: Handover): string[] {
  const source = handover.source;
  const rows: readonly [string, string | undefined][] = [
    ["client", source?.client],
    ["model", source?.model],
    ["provider", source?.provider],
    ["recipe", source?.recipeVersion],
  ];
  const out: string[] = [];
  for (const [label, value] of rows) {
    if (value === undefined || value.length === 0) continue;
    out.push(...labelled(label, value));
  }
  return out;
}

/** The `written by` block, or nothing when the document names no source. */
function writtenByBlock(handover: Handover): string[] {
  const rows = sourceRows(handover);
  if (rows.length === 0) return [];
  return [sectionRule("written by"), blank(), ...rows, blank()];
}

/**
 * Every provenance label the document's sections carry, in the frozen order of
 * the label set, each label appearing once.
 *
 * The card shows which KINDS of claim a document holds. Which section carries
 * which label is a mapping, and a mapping belongs where a reader can act on it
 * per section, which is the restore prompt.
 */
function provenanceLabelsPresent(handover: Handover): ProvenanceLabel[] {
  const seen = new Set<string>();
  for (const key of SECTION_KEYS) {
    for (const label of handover.sections[key]?.provenance ?? []) {
      seen.add(label);
    }
  }
  return PROVENANCE_LABELS.filter((label) => seen.has(label));
}

/** The one row that says which kinds of claim this document holds. */
function provenanceRow(handover: Handover): string[] {
  const labels = provenanceLabelsPresent(handover);
  if (labels.length === 0) return [];
  return labelled("provenance", labels.join(", "));
}

/**
 * The observations attached to the document, as the rows that name them.
 *
 * Kinds and producers, never payloads. `data` is free-form and opaque to the
 * specification, so a renderer cannot know how to lay out a payload it has never
 * seen, and a renderer that guessed would be inventing a shape the producer did
 * not agree to. What a reader needs from a card is that the evidence is there,
 * what kind it is and who is answerable for it; the payload is one
 * `soil load --json` away, and `spec/observations.md` says how to read it.
 *
 * Both lists are deduplicated and joined into one wrapping row each, so a
 * hundred entries of one kind cost one row rather than a hundred.
 */
function evidenceRows(handover: Handover): string[] {
  const observations = handover.observations ?? [];
  if (observations.length === 0) return [];
  const kinds: string[] = [];
  const producers: string[] = [];
  for (const observation of observations) {
    const kind = observation.kind;
    if (typeof kind === "string" && kind.length > 0 && !kinds.includes(kind)) {
      kinds.push(kind);
    }
    const producer = observation.producedBy;
    if (
      typeof producer === "string" &&
      producer.length > 0 &&
      !producers.includes(producer)
    ) {
      producers.push(producer);
    }
  }
  const out: string[] = [];
  if (kinds.length > 0) out.push(...labelled("evidence", kinds.join(", ")));
  if (producers.length > 0) {
    out.push(...labelled("recorded", producers.join(", ")));
  }
  return out;
}

/** A bulleted list of already-safe entries, wrapped under its own marker. */
function bulleted(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    wrap(entry, WRAP_WIDTH - 2).forEach((text, i) => {
      out.push(line(i === 0 ? `▸ ${text}` : `  ${text}`));
    });
  }
  return out;
}

/** The card printed after `soil save`. */
export function renderSaved(handover: Handover, code: string): string {
  const counts = countSections(handover);
  const missing = keysWithStatus(handover, "missing");
  const blocked = keysWithStatus(handover, "blocked");
  const notApplicable = keysWithStatus(handover, "not_applicable");

  const out: string[] = [];
  out.push(masthead("handover saved", code));
  out.push(blank());
  out.push(...prose(handover.title));
  out.push(line(handover.projectId));
  out.push(blank());
  out.push(...writtenByBlock(handover));
  out.push(sectionRule("what this document carries"));
  out.push(blank());
  out.push(line(contentCountLine(counts)));
  if (missing.length > 0) {
    out.push(...labelled("no content", sectionNames(missing)));
  }
  if (blocked.length > 0) {
    out.push(...labelled("held back", sectionNames(blocked)));
  }
  if (notApplicable.length > 0) {
    out.push(...labelled("no subject", sectionNames(notApplicable)));
  }
  out.push(...provenanceRow(handover));
  out.push(...evidenceRows(handover));
  out.push(blank());

  const gaps = handover.quality?.missingInputs ?? [];
  if (gaps.length > 0) {
    out.push(sectionRule("stated gaps"));
    out.push(blank());
    out.push(...bulleted(gaps));
    out.push(blank());
  }

  // The gaps' sibling in `quality`. It reached the restore prompt and not this
  // card, which left the writer no way to see that what it recorded landed.
  const contradictions = handover.quality?.contradictions ?? [];
  if (contradictions.length > 0) {
    out.push(sectionRule("unresolved contradictions"));
    out.push(blank());
    out.push(...bulleted(contradictions));
    out.push(blank());
  }

  const omissions = handover.safety?.unsafeOmissions ?? [];
  if (omissions.length > 0) {
    out.push(sectionRule("held back · by design"));
    out.push(blank());
    out.push(...bulleted(omissions));
    out.push(blank());
  }

  out.push(sectionRule("local"));
  out.push(blank());
  out.push(...prose("stored on this machine · no account · no network"));
  out.push(blank());
  out.push(footer("load it in another thread, model, or tool"));
  out.push("");
  out.push(`          ❯ soil load ${code}`);
  return out.join("\n");
}

/** The card printed above the restore prompt on `soil load`. */
export function renderLoaded(handover: Handover): string {
  const counts = countSections(handover);
  const missing = keysWithStatus(handover, "missing");
  // A withheld section is not an empty one. The save card said so and this one
  // did not, so a reader of the load door could not tell a section nobody could
  // see from one somebody decided not to move, which is the one distinction
  // that says whether to go looking elsewhere.
  const blocked = keysWithStatus(handover, "blocked");
  const notApplicable = keysWithStatus(handover, "not_applicable");
  const code = handover.code ?? "";

  const out: string[] = [];
  out.push(masthead("handover loaded", code || undefined));
  out.push(blank());
  out.push(...prose(handover.title));
  out.push(line(`${handover.projectId} · saved ${handover.createdAt}`));
  out.push(blank());
  out.push(...writtenByBlock(handover));
  out.push(sectionRule("what this document carries"));
  out.push(blank());
  out.push(line(contentCountLine(counts)));
  if (missing.length > 0) {
    out.push(...labelled("no content", sectionNames(missing)));
  }
  if (blocked.length > 0) {
    out.push(...labelled("held back", sectionNames(blocked)));
  }
  if (notApplicable.length > 0) {
    out.push(...labelled("no subject", sectionNames(notApplicable)));
  }
  out.push(...provenanceRow(handover));
  out.push(...evidenceRows(handover));
  out.push(blank());
  out.push(sectionRule("read it this way"));
  out.push(blank());
  out.push(
    ...prose(
      "durable sections still hold · frontier sections describe the moment of capture, not now · check fast-moving state before trusting it",
    ),
  );
  out.push(blank());
  out.push(
    footer("the restore prompt follows · paste it into the new session"),
  );
  return out.join("\n");
}

/** The card printed by `soil list`. */
export function renderList(entries: readonly StoreEntry[]): string {
  const out: string[] = [];
  out.push(masthead("handovers"));
  out.push(blank());
  if (entries.length === 0) {
    out.push(...prose("nothing saved yet · run `soil save` to start"));
    out.push(blank());
    out.push(footer("local store · ~/.soil"));
    return out.join("\n");
  }
  for (const entry of entries) {
    const title =
      entry.title.length > 28 ? `${entry.title.slice(0, 27)}…` : entry.title;
    out.push(
      line(
        `▸ ${entry.code}  ${title.padEnd(28)} ${String(entry.sectionsWithContent).padStart(2)}/17`,
      ),
    );
  }
  out.push(blank());
  // The ratio is the one number here, so the one number says what it is.
  out.push(...prose("the ratio counts sections carrying content"));
  out.push(blank());
  out.push(
    footer(`${entries.length} stored · load one with \`soil load #NNN\``),
  );
  return out.join("\n");
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The card printed by `soil check`: the grade band, the findings grouped by
 * section, and the boundary the checker lives behind. Deterministic like every
 * renderer here; the report is already sorted, and this only lays it out.
 */
export function renderCheck(handover: Handover, report: CheckReport): string {
  const out: string[] = [];
  out.push(masthead("handover checked", handover.code));
  out.push(blank());
  out.push(...prose(handover.title));
  out.push(line(handover.projectId));
  out.push(blank());
  out.push(sectionRule("grade"));
  out.push(blank());
  out.push(line(report.grade));
  out.push(
    line(
      `${pluralize(report.counts.problems, "problem")} · ${pluralize(report.counts.cautions, "caution")} · ${report.counts.advice} advice`,
    ),
  );
  out.push(blank());
  out.push(sectionRule("findings"));
  out.push(blank());
  if (report.findings.length === 0) {
    out.push(...prose("none · every rule passed on this document"));
    out.push(blank());
  } else {
    const groups = new Map<string, CheckFinding[]>();
    for (const finding of report.findings) {
      const label =
        finding.section === undefined
          ? "the document"
          : SECTION_LABELS[finding.section];
      const group = groups.get(label) ?? [];
      group.push(finding);
      groups.set(label, group);
    }
    for (const [label, group] of groups) {
      out.push(line(label));
      for (const finding of group) {
        out.push(line(`▸ ${finding.rule} · ${finding.severity}`));
        for (const text of wrap(finding.message, WRAP_WIDTH - 2)) {
          out.push(line(`  ${text}`));
        }
      }
      out.push(blank());
    }
  }
  out.push(
    footer("checked from the document alone · only a real load proves restore"),
  );
  return out.join("\n");
}

/** The card printed by `soil validate`. */
export function renderValidation(
  result: ValidationResult,
  label: string,
): string {
  const unsafe = result.issues.filter((issue) => issue.kind === "safety");
  const out: string[] = [];
  out.push(
    masthead(
      result.valid
        ? "valid handover"
        : unsafe.length > 0
          ? "refused · secret material"
          : "not a handover",
    ),
  );
  out.push(blank());
  out.push(line(label));
  out.push(blank());
  if (result.valid) {
    out.push(sectionRule("shape"));
    out.push(blank());
    out.push(...prose("every required field is present and well formed"));
    out.push(blank());
    out.push(
      footer(
        "structure only · this says nothing about how good the content is",
      ),
    );
    return out.join("\n");
  }
  if (unsafe.length > 0) {
    out.push(sectionRule("nothing was stored"));
    out.push(blank());
    for (const issue of unsafe) {
      const wrapped = wrap(`${issue.path} ${issue.message}`, WRAP_WIDTH - 2);
      wrapped.forEach((text, i) => {
        out.push(line(i === 0 ? `✗ ${text}` : `  ${text}`));
      });
    }
    out.push(blank());
  }

  const structural = result.issues.filter((issue) => issue.kind !== "safety");
  if (structural.length > 0) {
    out.push(sectionRule(`${structural.length} problem(s)`));
    out.push(blank());
    for (const issue of structural) {
      const wrapped = wrap(
        `${issue.path || "/"} ${issue.message}`,
        WRAP_WIDTH - 2,
      );
      wrapped.forEach((text, i) => {
        out.push(line(i === 0 ? `✗ ${text}` : `  ${text}`));
      });
    }
    out.push(blank());
  }

  out.push(
    footer(
      unsafe.length > 0
        ? "remove the value, keep the meaning, then save again"
        : "fix these and validate again",
    ),
  );
  return out.join("\n");
}
