#!/usr/bin/env node
/**
 * How many official implementations there are, stated in prose, held to the
 * tree.
 *
 * "Five" appears in shipped files as five implementations, five SDKs, five
 * runners, five runtimes, five languages, five surfaces, five parsers, five
 * writers, five adapters and five toolchains. One count, ten nouns, and
 * nothing derived any of them. That spread is most of why it went unchecked:
 * a sweep for "five implementations" finds a fraction of it, reports a clean
 * result, and the reader believes the clean result.
 *
 * The argument for binding it rather than trusting it is the one this
 * repository has already lost twice. Adding a sixth implementation is a
 * deliberate act, and deliberate acts are supposed to update the prose around
 * them — but adding the value domain was deliberate too, and it still left a
 * whole check category undocumented in five conformance runners and every
 * per-runner count in the conformance page wrong by half.
 *
 * WHAT IS CHECKED
 *
 * A cardinal counting the WHOLE set must equal the number of implementations
 * in the tree. What marks a claim about the whole set is a totalising word in
 * front of it — "all five runners", "the five runtimes", "across five
 * languages" — or the set being named outright, "five official
 * implementations".
 *
 * WHAT IS NOT CHECKED, AND WHY
 *
 *   - A cardinal beside the same noun with no totalising word is talking
 *     about some of them, or about any of them: "two implementations
 *     disagree", "one writer-assigned id", "the OTHER four surfaces". None of
 *     those is this count and binding them would be wrong.
 *
 *   - The elliptical forms, "the five stop agreeing" and "all five, including
 *     the 20000-code-point summary", where the noun is left out. These are
 *     deliberately out of scope: no pattern separates them from every other
 *     elliptical cardinal in English, and one of them in this very tree means
 *     five bounded string sites rather than five implementations. A check that
 *     guessed would either miss them or fire on prose that is correct, and a
 *     stated limit is worth more than a check nobody trusts. Every file
 *     carrying one is listed at the end of a run so the gap is visible.
 *
 *   - Changelogs. An entry records what was true at a release: "the four
 *     implementations" in CHANGELOG.md was four at the time and must stay
 *     four.
 *
 * Prose wraps, and a wrapped phrase splits across two lines, so every file is
 * flattened before matching. Eight of the mentions found here are only
 * visible that way — "the five official\n * implementations" is one phrase in
 * a comment and two lines on disk.
 *
 * Run it from the repository root:  node scripts/check-implementation-count.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Flattening and the tracked-file list live in one place so a check cannot be
// written without them. A line-by-line sweep misses about eight per cent of
// this repository's cardinal-and-noun phrases, and that blind spot is how a
// count hid behind ten different nouns for as long as it did.
import { flatten, ROOT, trackedText, WORD_VALUE } from "./lib/prose.mjs";

/* ------------------------------------------------------------------ */
/* The number, derived twice                                          */
/* ------------------------------------------------------------------ */

/** One directory per official implementation. */
const sdkPackages = readdirSync(join(ROOT, "packages"))
  .filter((entry) => entry.startsWith("sdk-"))
  .sort();

/**
 * The conformance page's runner table, which is the same set counted a second
 * way. Two derivations that must agree: if somebody adds an SDK without a
 * runner, or a runner without an SDK, that is worth stopping for on its own.
 */
const runnerRows = (() => {
  const page = readFileSync(join(ROOT, "conformance/README.md"), "utf8");
  const from = page.indexOf("| Runner ");
  if (from < 0) return null;
  const rows = [];
  for (const line of page.slice(from).split("\n")) {
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    rows.push(cells[0]);
  }
  return rows.slice(1);
})();

const problems = [];

if (runnerRows === null) {
  problems.push(
    "conformance/README.md no longer carries a runner table, so the count cannot be derived a second way",
  );
} else if (runnerRows.length !== sdkPackages.length) {
  problems.push(
    `packages/ holds ${sdkPackages.length} implementation(s) (${sdkPackages.join(", ")}) ` +
      `but conformance/README.md lists ${runnerRows.length} runner(s) (${runnerRows.join(", ")})`,
  );
}

const COUNT = sdkPackages.length;

/* ------------------------------------------------------------------ */
/* The claim                                                          */
/* ------------------------------------------------------------------ */

const CARDINAL = `${Object.keys(WORD_VALUE).join("|")}|\\d{1,3}`;
const NOUN =
  "implementations?|SDKs?|runners?|runtimes?|languages?|surfaces?|" +
  "parsers?|writers?|adapters?|toolchains?";
const ADJ = "official|reference|conformance|language|single-language|writer";

const TOTALISING = new RegExp(
  // "all five runners", "the five runtimes", "across five languages".
  //
  // "the N X that ..." is excluded: a restrictive clause carves a subset out
  // of the whole, and the subset is what the sentence is counting. "the four
  // implementations that keep their manifests outside the root" is four of
  // the five, and correct. "all N X that ..." keeps its "all", so it stays a
  // claim about the whole and stays checked.
  `\\ball\\s+(?!other\\b)(${CARDINAL})\\s+(?:(?:${ADJ})[- ])?(${NOUN})\\b` +
    `|\\b(?:the|across|in|among)\\s+(?!other\\b)(${CARDINAL})\\s+(?:(?:${ADJ})[- ])?(${NOUN})\\b(?!\\s+that\\s)` +
    // "five official implementations"
    `|\\b(${CARDINAL})\\s+(?:official|reference)\\s+(${NOUN})\\b`,
  "gi",
);

/** "the five" / "all five" with the noun left out. Reported, never failed. */
const ELLIPTIC = new RegExp(
  `\\b(?:all|the)\\s+(?:${CARDINAL})\\b(?!-)(?!\\s+(?:(?:${ADJ})[- ])?(?:${NOUN})\\b)`,
  "gi",
);

/**
 * Phrases that use one of those nouns for a deliberately smaller, named set.
 * Each is a real claim about a pair or a trio, not about how many
 * implementations exist, and each is listed with the reason it is not this
 * count. A new one fails the check until somebody writes down which it is,
 * which is the point: the decision is made once, in the open, rather than
 * silently by a regex.
 */
const NOT_THIS_COUNT = [
  ["spec/value-domain.md", "in one language", "any one language, not a count"],
  [
    "spec/versioning.md",
    "in one implementation",
    "any one implementation, not a count",
  ],
  [
    "docs/server.md",
    "the two surfaces",
    "the CLI and the MCP server, a named pair",
  ],
  [
    "packages/server/src/mcp.ts",
    "the two surfaces",
    "the CLI and the MCP server, a named pair",
  ],
  [
    "packages/server/src/mcp.test.ts",
    "the two surfaces",
    "the CLI and the MCP server, a named pair",
  ],
  [
    "packages/sdk-dotnet/SoilHandover/JsonCanon.cs",
    "the two sdks",
    "this SDK and the TypeScript one, sharing a store",
  ],
  [
    "packages/sdk-py/soil_handover/rescue.py",
    "the two sdks",
    "this SDK and the TypeScript one, held to byte parity",
  ],
  [
    "packages/sdk-py/soil_handover/store.py",
    "the two sdks",
    "this SDK and the TypeScript one, sharing a store",
  ],
  [
    "packages/sdk-py/soil_handover/sections.py",
    "the two implementations",
    "this SDK and the TypeScript one, held to one fixture set",
  ],
  [
    "packages/sdk-py/soil_handover/validate.py",
    "the two implementations",
    "this SDK and the TypeScript one, reporting the same issues",
  ],
  [
    "docs/concepts.md",
    "all three surfaces",
    "the two MCP servers' load and the CLI's load, a different set",
  ],
];

const excused = new Set(
  NOT_THIS_COUNT.map(([file, phrase]) => `${file} :: ${phrase}`),
);
const usedExcuses = new Set();

/** A changelog records a past release and must not be rewritten. */
const isChangelog = (file) => /CHANGELOG\.md$/.test(file);

/**
 * This file quotes the phrases it is looking for, as data and as examples, so
 * scanning it would find every one of them and report the quotations as
 * claims. A checker is not a claim about the tree.
 */
const SELF = new Set([
  "scripts/check-implementation-count.mjs",
  "packages/cli/src/implementation-count.test.ts",
]);

let checked = 0;
const elliptical = [];

for (const file of trackedText()) {
  if (isChangelog(file) || SELF.has(file)) continue;
  let text;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue;
  }
  const flat = flatten(text);

  for (const match of flat.matchAll(TOTALISING)) {
    const stated = (match[1] ?? match[3] ?? match[5]).toLowerCase();
    const phrase = match[0].replace(/\s+/g, " ").toLowerCase();
    const key = `${file} :: ${phrase}`;
    if (excused.has(key)) {
      usedExcuses.add(key);
      continue;
    }
    checked += 1;
    const value = WORD_VALUE[stated] ?? Number(stated);
    if (value !== COUNT) {
      problems.push(
        `${file}: "${match[0].replace(/\s+/g, " ")}" says ${value}, ` +
          `and the tree holds ${COUNT} implementation(s): ${sdkPackages.join(", ")}`,
      );
    }
  }

  const ellipses = [...flat.matchAll(ELLIPTIC)].filter(
    (m) => (WORD_VALUE[m[0].split(/\s+/)[1]?.toLowerCase()] ?? 0) === COUNT,
  );
  if (ellipses.length > 0) elliptical.push([file, ellipses.length]);
}

/* An excuse that no longer matches anything is an excuse for nothing. */
for (const [file, phrase, reason] of NOT_THIS_COUNT) {
  const key = `${file} :: ${phrase}`;
  if (!usedExcuses.has(key)) {
    problems.push(
      `stale entry in NOT_THIS_COUNT: ${file} no longer says "${phrase}" (${reason})`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`\ncheck-implementation-count: ${problems.length} problem(s).`);
  process.exit(1);
}

console.log(
  `check-implementation-count: ${checked} totalising mention(s) checked against ` +
    `${COUNT} implementation(s) in the tree, all agree`,
);
console.log(
  `  not checked: ${elliptical.reduce((n, [, c]) => n + c, 0)} elliptical mention(s) ` +
    `in ${elliptical.length} file(s), where the noun is left out`,
);
