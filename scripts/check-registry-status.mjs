#!/usr/bin/env node
/**
 * One page owns the argument about package registries.
 *
 * Nothing here is published, so every page that tells a reader how to install
 * something has to say what to do instead, and every one of them is tempted to
 * say the whole of it: that the bare names are unclaimed, that a runner resolves
 * a package name rather than an executable name, and that a one-liner built on
 * either would point somebody's machine at a package this project does not
 * control. Said in three places it is three things to keep true, and the reader
 * who has met it twice already skips it the third time.
 *
 * So the argument has an owner, and the other pages state the status in a line
 * and link to it.
 *
 * WHAT IS CHECKED
 *
 * A page carries the argument when one sentence of it holds both a registry
 * term and a piece of the reasoning. Only pages in scope are read: markdown
 * under `docs/` or `spec/`, and the package READMEs. Exactly one of them may
 * carry it, and it must be the page named in OWNER, so losing the argument
 * altogether fails as loudly as duplicating it.
 *
 * WHAT IS NOT CHECKED, AND WHY
 *
 *   - The status itself. "Nothing here is on a package registry yet" is a fact
 *     any page may state, and several should: a reader about to type `pnpm
 *     install` needs it where they are standing. It is the reasoning that has
 *     one home, not the fact.
 *
 *   - Whether a page that states the status links to the owner. A link is the
 *     right thing to write and the wrong thing to bind: the pages that state
 *     the status include a roadmap row and two one-line SDK notes, and
 *     obliging each of those to carry a link would add three references nobody
 *     follows.
 *
 *   - The root briefing, the front-door README, changelogs and release notes.
 *     A briefing an agent reads to install something must be answerable from
 *     itself without opening a second file, which is the opposite of what this
 *     check asks for, and a changelog records what was true at a release.
 *
 * Run it from the repository root:  node scripts/check-registry-status.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { flatten, isHistory, ROOT, trackedText } from "./lib/prose.mjs";

/** The page that owns the argument. */
const OWNER = "docs/install-with-an-agent.md";

/** The pages held to one owner. */
const inScope = (file) =>
  file.endsWith(".md") &&
  !isHistory(file) &&
  (file.startsWith("docs/") ||
    file.startsWith("spec/") ||
    /^packages\/[^/]+\/README\.md$/.test(file));

/** Words that put a sentence in a package-registry context. */
const CONTEXT =
  /\b(registry|registries|npmjs|npx|pypi|maven|nuget|package name)\b/i;

/** The pieces of reasoning that belong to one page. */
const REASONING =
  /\b(unclaimed|do not write|do not invent|do not run it|belongs to nobody|does not control|resolves a package name)\b/i;

const carriers = [];
for (const file of trackedText()) {
  if (!inScope(file)) continue;
  let text;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue;
  }
  const sentences = flatten(text).split(/(?<=[.!?])\s+/);
  const found = sentences.filter(
    (sentence) => CONTEXT.test(sentence) && REASONING.test(sentence),
  );
  if (found.length > 0) carriers.push({ file, found });
}

const problems = [];
const owner = carriers.find((carrier) => carrier.file === OWNER);
if (owner === undefined) {
  problems.push(
    `${OWNER} owns the package-registry argument and no longer states it; ` +
      "move the reasoning back or name a different owner",
  );
}
for (const { file, found } of carriers) {
  if (file === OWNER) continue;
  problems.push(
    `${file} restates the package-registry argument in ${found.length} ` +
      `sentence(s); state the status in a line and link to ${OWNER}`,
  );
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`\ncheck-registry-status: ${problems.length} problem(s).`);
  process.exit(1);
}

console.log(
  `check-registry-status: the package-registry argument is stated on ${OWNER} ` +
    "and nowhere else under docs/, spec/ or the package READMEs " +
    `(${owner.found.length} sentence(s) there)`,
);
console.log(
  "  not checked: the status itself, which any page may state, and the root " +
    "briefing, the README, the changelogs and the release notes",
);
