#!/usr/bin/env node
/**
 * How far a reader walks from a heading to the command it promised.
 *
 * A page that exists to get somebody running has one measurable property that
 * decides whether it works: the amount of prose between a heading and the
 * first thing the reader can paste into a shell. Everything in that gap is
 * read before anything is tried, and a reader who came to run something reads
 * it as an obstacle whether it is true or not. This check measures that gap and
 * caps it.
 *
 * WHAT IS MEASURED
 *
 * A page is in scope when it lives under `docs/` or is a package README, and
 * carries at least one fenced block tagged as a shell (`bash`, `sh`, `console`,
 * `shell`, `zsh`). Those are the pages whose job is a command.
 *
 * Within such a page, every heading of level 2 or deeper whose own section
 * opens with a shell block, before any further heading, is measured: the words
 * of prose between the heading line and the opening fence. Prose means lines
 * outside a fenced block, so an intervening JSON or text block adds nothing to
 * the count, and words means whitespace-separated tokens, so a bold step label
 * counts exactly as the reader meets it.
 *
 * WHAT IS NOT MEASURED, AND WHY
 *
 *   - The page title. An `# H1` is followed by the page's statement of what it
 *     is, which is the one place a reader wants prose before a command, and
 *     several package READMEs are one title and one paragraph by design.
 *
 *   - A heading whose section carries no shell block. There is no command to
 *     be far from, so there is no distance to state.
 *
 *   - Pages outside `docs/` and the package READMEs. The specification does not
 *     run, and the root briefing, the contribution guide and the worked
 *     examples answer to different readers with different reasons to arrive.
 *     Every one of them is listed at the end of a run, so the scope is visible
 *     rather than assumed.
 *
 * THE CAP
 *
 * 40 words. It is read off the tree rather than chosen: the sections that
 * already put the command first measure 0 to 30 words, and the value is set
 * above that band so a page written the way those pages are written passes
 * without being trimmed to a target.
 *
 * Run it from the repository root:  node scripts/check-command-distance.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT, trackedText } from "./lib/prose.mjs";

/** The most words that may stand between a heading and its first command. */
const CAP = 40;

/** Fence languages that mean "a reader can paste this into a shell". */
const SHELL = new Set(["bash", "sh", "console", "shell", "zsh"]);

/** The pages whose job is to get somebody running something. */
const inScope = (file) =>
  file.endsWith(".md") &&
  (file.startsWith("docs/") || /^packages\/[^/]+\/README\.md$/.test(file));

/**
 * One pass over a page: its headings, its shell fences, and which lines sit
 * inside a fenced block. Headings and fences are decided in the same pass
 * because a `#` comment inside a shell block is a comment, not a heading.
 */
function structureOf(text) {
  const lines = text.split("\n");
  const headings = [];
  const shellFences = [];
  const inside = new Set();
  let open = false;
  lines.forEach((line, index) => {
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence !== null) {
      inside.add(index);
      if (!open && SHELL.has((fence[1] ?? "").toLowerCase())) {
        shellFences.push(index);
      }
      open = !open;
      return;
    }
    if (open) {
      inside.add(index);
      return;
    }
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading !== null) headings.push({ index, level: heading[1].length });
  });
  return { lines, headings, shellFences, inside };
}

/** The measured distances on one page, longest first. */
function distancesIn(text) {
  const { lines, headings, shellFences, inside } = structureOf(text);
  const measured = [];
  for (const heading of headings) {
    if (heading.level < 2) continue;
    const next =
      headings.find((other) => other.index > heading.index)?.index ??
      lines.length;
    const fence = shellFences.find((at) => at > heading.index);
    if (fence === undefined || fence > next) continue;
    const words = lines
      .slice(heading.index + 1, fence)
      .filter((_, offset) => !inside.has(heading.index + 1 + offset))
      .join(" ")
      .split(/\s+/)
      .filter((word) => word.length > 0).length;
    measured.push({ heading: lines[heading.index].trim(), words });
  }
  return measured.sort((left, right) => right.words - left.words);
}

const pages = [];
const outOfScope = [];
const withoutCommands = [];

for (const file of trackedText()) {
  if (!file.endsWith(".md")) continue;
  if (!inScope(file)) {
    outOfScope.push(file);
    continue;
  }
  let text;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue;
  }
  const measured = distancesIn(text);
  if (measured.length === 0) {
    withoutCommands.push(file);
    continue;
  }
  pages.push({ file, measured });
}

const problems = [];
for (const { file, measured } of pages) {
  for (const { heading, words } of measured) {
    if (words > CAP) {
      problems.push(
        `${file}: "${heading}" puts ${words} words between the heading and its ` +
          `first command, and the cap is ${CAP}`,
      );
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`\ncheck-command-distance: ${problems.length} problem(s).`);
  process.exit(1);
}

const widest = pages
  .flatMap(({ file, measured }) => measured.map((m) => ({ file, ...m })))
  .sort((left, right) => right.words - left.words);

console.log(
  `check-command-distance: ${widest.length} heading(s) on ${pages.length} page(s) ` +
    `reach a command within ${CAP} words; the widest is ${widest[0]?.words ?? 0}`,
);
for (const { file, heading, words } of widest.slice(0, 5)) {
  console.log(`  ${String(words).padStart(3)}  ${file}  ${heading}`);
}
console.log(
  `  not checked: ${withoutCommands.length} in-scope page(s) with no shell block, ` +
    `and ${outOfScope.length} markdown file(s) outside docs/ and the package READMEs`,
);
