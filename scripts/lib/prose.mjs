/**
 * Reading numbers out of this repository's prose, the way the checks that read
 * them have had to learn to.
 *
 * Two lessons live here rather than in any one check, because a check that has
 * to remember them is a check that will eventually forget.
 *
 * FLATTEN BEFORE MATCHING. Prose wraps, and a wrapped phrase is split across
 * two lines. Measured on the shipped files: a line-by-line sweep found 1102
 * distinct cardinal-and-noun phrases and a flattened one found 1192, so 92 of
 * them — about eight per cent — are invisible to any check that reads a line
 * at a time. That is not a rounding error, and it is not theoretical: "the
 * five official implementations" is one phrase in a source comment and two
 * lines on disk, and two hand searches during this work returned nothing and
 * nearly recorded a phrase as absent.
 *
 * SAY WHAT YOU DID NOT CHECK. Every check built on this module reports the
 * mentions it deliberately left alone, and says why. A clean result whose
 * scope is unstated gets read as a clean result, and that is how a category
 * dismissed as safe becomes a category nobody looks at.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Small cardinals as this repository's prose writes them. */
export const WORD_VALUE = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
});

/** Every cardinal these checks can read, spelled or in digits. */
export const CARDINAL = `${Object.keys(WORD_VALUE).join("|")}|\\d{1,4}`;

/**
 * A cardinal as a number, refusing anything it does not know.
 *
 * Refusing rather than returning undefined: a comparison against undefined
 * fails with a message that sends the next reader to the wrong place, and a
 * count check whose failure misdirects is most of a count check nobody trusts.
 */
export function valueOf(word) {
  const known = WORD_VALUE[String(word).toLowerCase()];
  if (known !== undefined) return known;
  const digits = Number(word);
  if (Number.isInteger(digits)) return digits;
  throw new Error(
    `"${word}" is not a cardinal these checks know; widen WORD_VALUE deliberately`,
  );
}

/**
 * One string per file, with line breaks and comment markers taken out, so a
 * phrase split by wrapping is one phrase again.
 */
export function flatten(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\/\/\/?|\*|#|--)?\s*/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

/**
 * The text files git is tracking, which is the same choice the link check
 * makes and for the same reason: the question is about the repository, and an
 * untracked scratch file's prose is nobody's claim. Tracking also keeps these
 * checks free of the release tooling, which the published artefact does not
 * carry — a shipped file that reached for it would be a check the artefact
 * cannot run.
 */
export function trackedText() {
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "*.md",
      "*.json",
      "*.ts",
      "*.mjs",
      "*.js",
      "*.py",
      "*.go",
      "*.kt",
      "*.cs",
      "*.java",
      "*.yaml",
      "*.yml",
      "*.svg",
      "*.txt",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  return out.split("\0").filter((path) => path !== "");
}

/**
 * A changelog or a release note records what was true at a release. It is not
 * maintained and must not be: a figure recording a state the tree no longer
 * has is evidence, and updating it to match the tree destroys the evidence.
 */
export const isHistory = (file) =>
  /CHANGELOG\.md$/.test(file) || file.startsWith("docs/release-notes/");

/**
 * Report a run in the terms a reader can act on: what was held to the tree,
 * and what was deliberately left alone. The second half is the point.
 */
export function report(name, { checked, skipped }) {
  console.log(
    `${name}: ${checked} mention(s) checked against the tree, all agree`,
  );
  for (const [why, count] of Object.entries(skipped)) {
    if (count > 0) console.log(`  not checked: ${count} ${why}`);
  }
}
