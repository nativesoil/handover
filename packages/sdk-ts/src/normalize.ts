/**
 * Normalization: turn what a model actually emitted into a spec-shaped
 * document.
 *
 * Models write JSON by hand under pressure. They use the loose
 * `extractionSections` key, they write a section as a bare string, they skip
 * sections they had nothing for, they forget `soilHandover`. None of that is
 * interesting, and none of it should cost a user their capture.
 *
 * One rule governs the whole file, and it is the rule that makes a save and a
 * validation of the same bytes agree:
 *
 *   Every member present in the input is present in the output. A member is
 *   rewritten only in the ways `spec/normalization-profile.md` enumerates, a
 *   value that cannot be rewritten is carried through verbatim, and nothing is
 *   invented.
 *
 * So an unknown top-level field, an unknown field on a section, an unknown
 * section key and an unrecognised provenance label all survive this function
 * and are refused by `validate`, at the path they actually occupy. Version one
 * is a closed world (`spec/versioning.md`): none of those is an extension
 * point, and deleting them here would mean the same bytes were rejected by
 * `validate` and accepted by `save`.
 *
 * Three things this deliberately does NOT do, each of which it used to:
 *
 *   - It does not stamp a `createdAt`. A document that does not say when it was
 *     captured is refused by `validate`, not completed here. That field is the
 *     anchor every frontier section is read against, and a wall clock read at
 *     save time is indistinguishable, to the consumer, from a time the session
 *     actually reported.
 *   - It does not stamp `source.recipeVersion`. This function is handed a
 *     document somebody else wrote, so attributing its own recipe to that
 *     document destroys the field's only use: telling recipe-produced output
 *     from anything else.
 *   - It does not drop a `handoverId` it cannot use. A malformed id reaches
 *     `validate` and is refused there, rather than being dropped here and
 *     replaced, over the top, with a freshly minted one by the writer.
 *
 * The result is not guaranteed valid: run `validateHandover` on it. Input that
 * has to come through here is not itself a valid handover, which is why this
 * profile is optional and lives outside the conformance requirements.
 */

import { SECTION_KEYS } from "./sections.js";
import { SPEC_VERSION, type Handover, type HandoverSection } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** The members a section may carry. Everything else is carried through. */
const SECTION_FIELDS = ["status", "summary", "provenance"] as const;
/** The members `source` may carry. Everything else is carried through. */
const SOURCE_FIELDS = ["client", "model", "provider", "recipeVersion"] as const;
/** The members `quality` may carry. */
const QUALITY_FIELDS = ["missingInputs", "contradictions"] as const;
/** The members `safety` may carry. */
const SAFETY_FIELDS = ["unsafeOmissions"] as const;
/** The members the root may carry, in canonical order. */
const ROOT_FIELDS = [
  "soilHandover",
  "handoverId",
  "projectId",
  "title",
  "createdAt",
  "source",
  "sections",
  "quality",
  "safety",
  "observations",
  "code",
] as const;

/**
 * Copy the members of `record` that are neither known nor consumed, in input
 * order. This is the carry-through that keeps `validate` able to see what the
 * model actually wrote. It never inspects the values.
 */
function carryUnknown(
  record: Record<string, unknown>,
  known: readonly string[],
  consumed: readonly string[] = [],
): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (known.includes(key) || consumed.includes(key)) continue;
    rest[key] = value;
  }
  return rest;
}

const MISSING_SECTION: HandoverSection = Object.freeze({
  status: "missing",
  summary: null,
});

/**
 * Normalize one section value.
 *
 * A bare non-empty string becomes an available section. `null` and an absent
 * key both become a declared gap, because "nothing here" is exactly what
 * `missing` states. An object is kept, with its status inferred when absent and
 * its unknown members carried through. Anything else — a number, an array, a
 * boolean — is carried through untouched, so `validate` reports it at
 * `/sections/<key>` instead of this function quietly recording a gap where the
 * model wrote something.
 */
function normalizeSection(value: unknown): unknown {
  const text = asTrimmedString(value);
  if (text !== undefined) {
    return { status: "available", summary: text };
  }
  // A string with nothing in it, `null`, and an absent key all say the same
  // thing, and `missing` is how the format says it.
  if (value === null || value === undefined || typeof value === "string") {
    return MISSING_SECTION;
  }
  if (!isRecord(value)) {
    return value;
  }

  const summary = asTrimmedString(value["summary"]);
  const rawSummary = value["summary"];
  const rawStatus = asTrimmedString(value["status"]);
  // A status the model actually wrote is kept exactly as written, even when
  // it is not one of the three. `validate` then refuses it at
  // `/sections/<key>/status`. Rewriting `Available` to `available` would be
  // normalization inventing a claim: the section would count as carrying
  // content and would vanish from the list of what is not captured, and the
  // author would never learn the word was wrong.
  const status =
    rawStatus ??
    ("status" in value
      ? value["status"]
      : summary !== undefined
        ? "available"
        : "missing");

  const normalized: Record<string, unknown> = {
    status,
    summary:
      summary ??
      (typeof rawSummary === "string" ||
      rawSummary === null ||
      rawSummary === undefined
        ? null
        : rawSummary),
  };
  // Provenance is carried verbatim whenever it is there at all. Filtering out
  // a label this implementation does not know would delete the one thing that
  // lets a cold reader tell a check from a guess, and the label set is closed
  // for the whole of version one: an unrecognised label is an error, not noise.
  if ("provenance" in value) {
    normalized["provenance"] = value["provenance"];
  }
  return { ...normalized, ...carryUnknown(value, SECTION_FIELDS) };
}

/**
 * Trim a list of prose. Returns undefined when any entry is not usable prose,
 * so the caller leaves the list exactly as written and `validate` reports the
 * entry that is wrong rather than this function deleting it.
 */
function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.some((entry) => asTrimmedString(entry) === undefined)) {
    return undefined;
  }
  return value.map((entry) => (entry as string).trim());
}

/**
 * Trim the string members this object is known to carry, and leave everything
 * else — unknown members, and known members holding something other than
 * usable text — exactly where it was.
 */
function normalizeNamedObject(
  value: unknown,
  known: readonly string[],
): unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = known.includes(key) ? (asTrimmedString(entry) ?? entry) : entry;
  }
  return out;
}

/** The same, for the two objects whose members are lists of prose. */
function normalizeListObject(
  value: unknown,
  known: readonly string[],
): unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = known.includes(key)
      ? (normalizeStringList(entry) ?? entry)
      : entry;
  }
  return out;
}

/** All 17 keys declared, in canonical order, then whatever else was written. */
function normalizeSections(raw: Record<string, unknown>): unknown {
  const sections: Record<string, unknown> = {};
  for (const key of SECTION_KEYS) {
    sections[key] = normalizeSection(raw[key]);
  }
  return { ...sections, ...carryUnknown(raw, SECTION_KEYS) };
}

/**
 * Normalize a parsed JSON value into a spec-shaped document.
 *
 * The result is not guaranteed valid, and the declared return type is a
 * convenience for callers rather than a promise: a document normalized out of
 * loose input can still be missing a required field, and it can still carry a
 * member no reader recognises. Run {@link validateHandover} on it. What is
 * guaranteed is that nothing the input carried was thrown away, and that when
 * the input's `sections` is an object or absent, all 17 section keys are
 * declared.
 *
 * Observations pass through byte for byte. Nothing here interprets them,
 * reorders them, filters them by `kind`, rewrites `data`, or repairs a
 * malformed entry. An entry whose `kind` this implementation has never heard of
 * is the exact case the extension point exists for, so dropping or rewriting it
 * would make the format lossy in the one place it promises not to be; and
 * unlike the 17 sections, observations are produced by tools rather than by a
 * model writing JSON by hand under pressure, so a tool that emits a malformed
 * envelope should be told so by `validate`, not quietly patched here.
 */
export function normalizeHandover(input: unknown): Handover {
  if (input === undefined) {
    return normalizeHandover({});
  }
  if (!isRecord(input)) {
    // Not an object at all. There is nothing to reshape, and building a
    // document around it would replace the value rather than report it, so it
    // goes to `validate` as it arrived: the fail-closed secret scan reaches a
    // non-object root, and a repair here would hide what it found.
    return input as Handover;
  }
  const root = input;

  const out: Record<string, unknown> = {};
  const consumed: string[] = [];

  // The declared version of this document. An input that states one keeps it,
  // whatever it says: normalization never upgrades a document and never
  // downgrades one. An input that states none is declared 1.0, which is a claim
  // about the shape this function just produced, not a claim about where the
  // content came from.
  out["soilHandover"] =
    "soilHandover" in root
      ? (asTrimmedString(root["soilHandover"]) ?? root["soilHandover"])
      : SPEC_VERSION;

  // An id that is already there is kept, whatever shape it is in: a copy keeps
  // its identity, and an id that is present but malformed is a validation error
  // rather than something to drop. Dropping it would hand the writer a document
  // with no id, and the writer would mint a fresh one over the top of the
  // malformed one nobody was ever told about. A missing id stays missing,
  // because assigning it is the writer's job and normalization is not a writer.
  if ("handoverId" in root) {
    out["handoverId"] =
      asTrimmedString(root["handoverId"]) ?? root["handoverId"];
  }

  out["projectId"] =
    "projectId" in root
      ? (asTrimmedString(root["projectId"]) ?? root["projectId"])
      : "";
  out["title"] =
    "title" in root ? (asTrimmedString(root["title"]) ?? root["title"]) : "";

  // No wall clock. A document that does not carry a capture time is refused by
  // `validate`, not completed here.
  if ("createdAt" in root) {
    out["createdAt"] = asTrimmedString(root["createdAt"]) ?? root["createdAt"];
  }

  // No recipe version is stamped: this function did not write the content, so
  // it is in no position to say which recipe did. `source` appears in the
  // output only when the input carried one.
  if ("source" in root) {
    out["source"] = normalizeNamedObject(root["source"], SOURCE_FIELDS);
  }

  const rawSections = root["sections"];
  if (isRecord(rawSections)) {
    out["sections"] = normalizeSections(rawSections);
  } else if ("sections" in root) {
    out["sections"] = rawSections;
  } else if (isRecord(root["extractionSections"])) {
    // The loose key the rescue prompt asks for. It is consumed only when it is
    // actually the source of `sections`; a document carrying both is carrying
    // content under a key nothing read, which is `validate`'s to report.
    out["sections"] = normalizeSections(root["extractionSections"]);
    consumed.push("extractionSections");
  } else {
    out["sections"] = normalizeSections({});
  }

  if ("quality" in root) {
    out["quality"] = normalizeListObject(root["quality"], QUALITY_FIELDS);
  }
  if ("safety" in root) {
    out["safety"] = normalizeListObject(root["safety"], SAFETY_FIELDS);
  }
  if ("observations" in root) {
    out["observations"] = root["observations"];
  }
  if ("code" in root) {
    out["code"] = asTrimmedString(root["code"]) ?? root["code"];
  }

  return {
    ...out,
    ...carryUnknown(root, ROOT_FIELDS, consumed),
  } as unknown as Handover;
}

/**
 * Pull the first fenced JSON block out of a model's reply, or fall back to the
 * first `{...}` span. Returns the raw text, not a parsed value.
 *
 * Models wrap JSON in prose no matter how firmly the prompt says not to, and a
 * user pasting a reply should not have to clean it up by hand.
 */
export function extractJsonBlock(text: string): string | undefined {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  if (fenced?.[1] !== undefined) {
    return fenced[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1).trim();
  }
  return undefined;
}
