#!/usr/bin/env node
/**
 * The format's closed sets, counted in prose, held to the schema and the
 * server.
 *
 * WHY THIS EXISTS, WHEN THE OTHER CHECKS DELIBERATELY SKIPPED IT
 *
 * Every sweep in this repository set these numbers aside — 17 sections, four
 * statuses, eleven provenance labels, three tools — on the reasoning that
 * spec/versioning.md makes a change to one a version bump rather than silent
 * drift. That reasoning was half right, and the wrong half cost a defect: the
 * change is loud in the schema and perfectly silent in the prose. A fourth
 * section status was added, the schema and ten shipped mentions moved with it,
 * and one comment was left saying there are three. Nothing was looking,
 * because the category had been agreed to be safe.
 *
 * A frozen constant is only frozen until a version bump. When one moves, the
 * prose that stated it does not move with it. So the numbers are derived —
 * the sections, statuses and labels from the published schema, the tool count
 * from the server's own tool list — and every mention in the tree is held to
 * them.
 *
 * WHAT IS NOT CHECKED, AND SAID OUT LOUD
 *
 * A cardinal beside one of these nouns is often counting a SUBSET: "the three
 * gap statuses" is the three that are not `available`, "sixteen sections
 * missing" describes one thin fixture, "9 sections" is one document's tally.
 * Those are marked as subsets and reported rather than checked, with a count
 * printed at the end of every run. A self-enumerating phrase — one that lists
 * its own members in the same breath — is left alone for the same reason and
 * counted the same way. The point of printing them is that a category nobody
 * counts is a category nobody looks at, which is how this family got here.
 *
 * Run it from the repository root:  node scripts/check-format-constants.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CARDINAL,
  flatten,
  isHistory,
  ROOT,
  trackedText,
  valueOf,
} from "./lib/prose.mjs";

/* ------------------------------------------------------------------ */
/* The numbers, derived                                               */
/* ------------------------------------------------------------------ */

const schema = JSON.parse(
  readFileSync(join(ROOT, "spec/handover.schema.json"), "utf8"),
);
const defs = schema["$defs"];

/**
 * The tool count comes from the server rather than from any list of names,
 * because the claim in the prose is about what a caller is offered. Asking the
 * server is the only way to count what it actually answers with.
 */
function toolsTheServerOffers() {
  const request =
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "check-format-constants", version: "0" },
      },
    }) +
    "\n" +
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) +
    "\n";
  const out = execFileSync(
    process.execPath,
    [join(ROOT, "packages/mcp/bin/soil-mcp.js")],
    { input: request, encoding: "utf8", timeout: 60_000 },
  );
  const names = new Set();
  for (const line of out.split("\n")) {
    for (const m of line.matchAll(/"name":"(soil_[a-z_]+)"/g)) names.add(m[1]);
  }
  return names;
}

const tools = toolsTheServerOffers();

/**
 * The ingestion boundary's rules, counted from the specification's own error
 * code table rather than from any list kept beside it.
 *
 * The codes group into rules: three encoding codes are one rule, two number
 * codes are one rule. `syntax.invalid_json` names no rule the layers above are
 * missing — a schema validator is handed a value that has already parsed, so
 * an unparseable document never reaches it — and it is subtracted here rather
 * than quietly skipped, so that a new code added to the table without a
 * decision about this grouping fails the check.
 *
 * This is the count that was wrong in five files at once. Every SDK's
 * ingestion module said four, enumerated four, and enforced five: the size
 * ceiling was missing from the list while being the first thing each of them
 * checks. Byte length is exactly as unrecoverable from a constructed value as
 * a stripped byte order mark or a collapsed duplicate member, which is the
 * whole membership test for this set.
 */
function boundaryRules() {
  const ingestion = readFileSync(join(ROOT, "spec/ingestion.md"), "utf8");
  const from = ingestion.indexOf("## Error codes");
  if (from < 0) {
    throw new Error("spec/ingestion.md no longer carries an error code table");
  }
  const table = ingestion.slice(from, ingestion.indexOf("\n## ", from + 1));
  // Digits belong in a code: `encoding.invalid_utf8` is one.
  const codes = [...table.matchAll(/^\| `([a-z0-9_.]+)`/gm)].map((m) => m[1]);
  if (codes.length === 0) {
    throw new Error("spec/ingestion.md's error code table parsed to nothing");
  }
  const families = new Set();
  for (const code of codes) {
    if (code === "syntax.invalid_json") continue;
    families.add(
      code.split(".")[0] === "structure" ? code : code.split(".")[0],
    );
  }
  return families.size;
}

const CONSTANTS = [
  {
    name: "boundary rules",
    value: boundaryRules(),
    from: "the error code table in spec/ingestion.md",
    // Narrow on purpose. "rules" is one of the commonest nouns in this
    // repository's prose — "two rules bind that path", "four rules make it
    // safe to rely on" — and almost none of those mean this set. The
    // qualifier is what makes the phrase a claim about the boundary, so the
    // qualifier is part of what is matched.
    noun: "rules that cannot be seen(?: from a constructed value)?",
  },
  {
    name: "sections",
    value: Object.keys(defs.sections.properties).length,
    from: "the schema's sections object",
    noun: "(?:handover |declared )?(?:sections|section keys|keys)",
    // Unlike the other three, a cardinal beside "sections" is usually
    // counting SOME of them: how many a fixture leaves missing, how many a
    // tier holds, how many the guide's test document fills in. So a mention
    // is read as a claim about the whole set only when a totalising word
    // introduces it. That trades mentions for certainty and loses no
    // detection power: if the section count ever moves, the dozens of
    // determined mentions all fail at once, which is louder than enough.
    totalisingOnly: true,
  },
  {
    name: "statuses",
    value: defs.section.properties.status.enum.length,
    from: "the schema's status enum",
    noun: "(?:section )?statuses",
  },
  {
    name: "provenance labels",
    value: defs.provenanceLabel.enum.length,
    from: "the schema's provenanceLabel enum",
    noun: "(?:provenance |closed )?labels",
  },
  {
    name: "tools",
    value: tools.size,
    from: "the server's own tools/list answer",
    noun: "(?:named |strict )?tools",
  },
];

/* ------------------------------------------------------------------ */
/* Which mentions are claims about the whole set                      */
/* ------------------------------------------------------------------ */

/**
 * Words that mark the phrase as counting some of the set rather than all of
 * it. "the other two gap statuses" and "sixteen sections missing" are both
 * true and neither is the total.
 */
const SUBSET_BEFORE = /\b(other|only|just|remaining|first|last|those)\s+$/i;
const SUBSET_AFTER =
  /^\s*(missing|declared|carrying|carry|carries|blocked|available|not_applicable|with content|of them|listings|are catalogued|catalogued)\b/i;
/** "gap statuses" is the three that are not `available`, never the four. */
const SUBSET_NOUN = /\bgap\b/i;

/**
 * A word that introduces the whole set rather than some of it. Used only for
 * the constants marked `totalisingOnly`.
 */
const TOTALISING = /\b(all|every|each|the|same|both)\s+(?:of\s+the\s+)?$/i;

/** This file quotes the phrases it hunts for. A checker is not a claim. */
const SELF = new Set([
  "scripts/check-format-constants.mjs",
  "packages/cli/src/format-constants.test.ts",
]);

/* ------------------------------------------------------------------ */

/**
 * A phrase that lists its own members in the same breath — "three fixtures:
 * just under it, exactly at it, and just over it", "the four kinds of text".
 * The reader counts the list, so the number cannot drift away from what it
 * counts without the sentence visibly breaking.
 *
 * These are deliberately left alone, and deliberately COUNTED, because
 * self-enumeration is now the category this repository has agreed is safe —
 * and the last category agreed to be safe was the frozen constants, which is
 * why this file exists. A category nobody counts is a category nobody looks
 * at. If this tally starts growing, somebody should look at it.
 */
const SELF_ENUMERATING =
  /^[^.]{0,12}(?::|—)\s*[^.]{0,160}?(?:,[^.]{0,80}?\band\b|\band\b)/i;
const COUNTABLE_NOUN =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,3})\s+([a-z][a-z-]{2,}s)\b/gi;

const problems = [];
let checked = 0;
let subsets = 0;
let selfEnumerating = 0;

for (const file of trackedText()) {
  if (isHistory(file) || SELF.has(file)) continue;
  let text;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue;
  }
  const flat = flatten(text);

  // The tally of phrases that carry their own enumeration, over every
  // countable noun rather than only this file's four constants: the point is
  // to keep the size of the set-aside category in view.
  COUNTABLE_NOUN.lastIndex = 0;
  for (const m of flat.matchAll(COUNTABLE_NOUN)) {
    if (SELF_ENUMERATING.test(flat.slice(m.index + m[0].length))) {
      selfEnumerating += 1;
    }
  }

  for (const constant of CONSTANTS) {
    const re = new RegExp(`\\b(${CARDINAL})\\s+(${constant.noun})\\b`, "gi");
    for (const m of flat.matchAll(re)) {
      const phrase = m[0].replace(/\s+/g, " ");
      const before = flat.slice(Math.max(0, m.index - 40), m.index);
      const after = flat.slice(m.index + m[0].length);

      if (
        SUBSET_BEFORE.test(before) ||
        SUBSET_AFTER.test(after) ||
        SUBSET_NOUN.test(m[2]) ||
        (constant.totalisingOnly && !TOTALISING.test(before))
      ) {
        subsets += 1;
        continue;
      }

      checked += 1;
      let stated;
      try {
        stated = valueOf(m[1]);
      } catch (error) {
        problems.push(`${file}: ${String(error.message)}`);
        continue;
      }
      if (stated !== constant.value) {
        problems.push(
          `${file}: "${phrase}" says ${stated}; ${constant.from} has ` +
            `${constant.value} ${constant.name}`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`\ncheck-format-constants: ${problems.length} problem(s).`);
  process.exit(1);
}

console.log(
  `check-format-constants: ${checked} mention(s) checked against ` +
    CONSTANTS.map((c) => `${c.value} ${c.name}`).join(", "),
);
console.log(
  `  not checked: ${subsets} mention(s) counting a subset rather than the whole set`,
);
console.log(
  `  not checked: ${selfEnumerating} phrase(s) that list their own members in the same breath`,
);
