#!/usr/bin/env node
/**
 * Link check: every relative link and image reference in the repository's
 * markdown points at a file that is actually there.
 *
 * The defect this catches has got out twice. One page linked a document that
 * the published release does not carry, so the link went into empty space;
 * that one was caught by somebody reading. An image reference in a related
 * repository pointed at a file that had moved, and it was caught by a person
 * opening the page on a phone while every check that ran stayed green.
 * Neither failure is subtle. Both survived because nothing looked.
 *
 * A dead link costs a reader their first impression, on the one visit where
 * they have not yet decided to trust the work. It is also the cheapest class
 * of defect there is to check for, which is the whole argument for doing it
 * mechanically rather than by sweep.
 *
 * WHAT IS CHECKED
 *
 *   - inline links and images, `[text](target)` and `![alt](target)`,
 *     including a bracketed `(<target>)` and a trailing `"title"`
 *   - reference definitions, `[label]: target`
 *   - raw HTML `href=` and `src=` attributes, which markdown files use for
 *     images that need sizing
 *
 * A target fails when the path it resolves to does not exist, or when it
 * resolves outside the repository. Both are the same defect from a reader's
 * side: they followed something and arrived nowhere.
 *
 * WHAT IS NOT CHECKED, DELIBERATELY
 *
 *   - Absolute URLs (`https:`, `mailto:` and friends). Reaching the network
 *     would make a local check depend on somebody else's uptime, and a check
 *     that fails for reasons the tree cannot fix is a check people learn to
 *     ignore.
 *   - Fragments. `#a-heading` is stripped before the path is resolved, and
 *     an anchor that does not match a heading is not reported. Heading
 *     anchors are the renderer's business and every renderer slugs them
 *     slightly differently.
 *   - Anything inside a fenced code block, because a fence is where this
 *     repository writes examples of markdown rather than markdown.
 *
 * WHERE THIS DOES NOT BELONG
 *
 * Not in the release sweep the maintainers run before publishing. That sweep
 * already covers the case where a shipped file names a path the release holds
 * back, by name, with its own failure message; a second copy of the rule
 * there would be two things to keep in agreement and no new coverage. This
 * check is the other half: a target nobody is holding back and that is not
 * there either. The two together are the whole question, and each is stated
 * once, in one place.
 *
 *   node scripts/check-links.mjs        report every problem, exit 1 on any
 *
 * Run it from the repository root.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The markdown files git is tracking. Tracked, rather than a walk of the
 * directory tree, because the question is about the repository: an untracked
 * scratch file's links are nobody's problem, and a walk would have to carry
 * its own list of build directories to avoid.
 */
function trackedMarkdown() {
  const out = execFileSync("git", ["ls-files", "-z", "*.md"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter((path) => path !== "");
}

/**
 * The lines of a file with fenced code blocks blanked out.
 *
 * Blanked rather than removed, so a reported line number still matches what
 * an editor shows. A fence opens on ``` or ~~~ and closes on the next fence
 * of the same character; the opening and closing lines are blanked too.
 */
function withoutFences(text) {
  const lines = text.split("\n");
  let fence;
  return lines.map((line) => {
    const opener = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === undefined) {
      if (opener) {
        fence = opener[1][0];
        return "";
      }
      return line;
    }
    if (opener && opener[1][0] === fence) fence = undefined;
    return "";
  });
}

/**
 * Every link target in one line, with the column it starts at.
 *
 * Three separate patterns rather than one, because the three forms have
 * nothing in common but the word "link": an inline destination is delimited
 * by parentheses and may carry a title, a reference definition runs to the
 * end of the line, and an HTML attribute is quoted.
 */
const INLINE =
  /!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+("[^"]*"|'[^']*'))?\s*\)/g;
const DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;
const ATTRIBUTE = /\b(?:href|src)\s*=\s*"([^"]*)"/g;

function targetsIn(line) {
  const found = [];
  for (const match of line.matchAll(INLINE)) {
    found.push({ raw: match[1], column: match.index + 1 });
  }
  const definition = DEFINITION.exec(line);
  if (definition) {
    found.push({ raw: definition[1], column: definition.index + 1 });
  }
  for (const match of line.matchAll(ATTRIBUTE)) {
    found.push({ raw: match[1], column: match.index + 1 });
  }
  return found.map((entry) => ({
    ...entry,
    raw: entry.raw.startsWith("<") ? entry.raw.slice(1, -1) : entry.raw,
  }));
}

/** True for a target this check does not resolve on disk. */
function isExternal(target) {
  if (target === "") return true;
  if (target.startsWith("#")) return true;
  // A scheme per RFC 3986, plus the protocol-relative form.
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return true;
  if (target.startsWith("//")) return true;
  return false;
}

/**
 * The path a target names, or `undefined` when it names none. The fragment
 * is dropped and percent-escapes are decoded, because `%20` on the page is a
 * space on the disk.
 */
function pathOf(target) {
  const withoutFragment = target.split("#")[0];
  if (withoutFragment === "") return undefined;
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

const problems = [];
let checked = 0;

for (const file of trackedMarkdown()) {
  const absolute = join(ROOT, file);
  const lines = withoutFences(readFileSync(absolute, "utf8"));
  lines.forEach((line, index) => {
    for (const { raw, column } of targetsIn(line)) {
      if (isExternal(raw)) continue;
      const wanted = pathOf(raw);
      if (wanted === undefined) continue;
      checked += 1;
      // A leading slash is repository-root-relative, which is how a forge
      // renders it. Everything else resolves beside the file that wrote it.
      const target = wanted.startsWith("/")
        ? resolve(ROOT, `.${wanted}`)
        : resolve(dirname(absolute), wanted);
      const where = `${file}:${index + 1}:${column}`;
      const inside = relative(ROOT, target);
      if (inside.startsWith(`..${sep}`) || inside === "..") {
        problems.push(
          `${where}: "${raw}" resolves outside the repository, to ${target}`,
        );
        continue;
      }
      if (!existsSync(target)) {
        problems.push(
          `${where}: "${raw}" points at ${inside}, which is not there`,
        );
      }
    }
  });
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`\ncheck-links: ${problems.length} dead link(s).`);
  process.exit(1);
}
console.log(`check-links: ${checked} relative link(s) checked, all resolve`);
