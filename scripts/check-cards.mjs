#!/usr/bin/env node
/**
 * Card check: every rail card printed in the documentation is either produced
 * by a real command, or says out loud that it is not.
 *
 * A card is evidence, not decoration. The README sells visible omissions as a
 * property of the format, so a README card that quietly drops the omission
 * panel is the claim contradicting itself in the same screenful. This check
 * makes that impossible to do by accident.
 *
 * Every fenced block in a committed markdown file whose contents carry the
 * card masthead (`┌─ SOIL ·`) must be immediately preceded by one of:
 *
 *   <!-- card: bound <id> -->
 *     The block must equal, byte for byte, what the command behind <id>
 *     prints. The ids and their commands live in CARDS below.
 *
 *   <!-- card: illustration -->
 *     The block is invented. A visible sentence containing the word
 *     "illustration" must sit immediately above it, in the prose, where a
 *     reader meets it before the card and not in a comment they never see.
 *
 * An unmarked card fails. So does a bound card whose bytes have drifted.
 *
 *   node scripts/check-cards.mjs           verify, exit 1 on any problem
 *   node scripts/check-cards.mjs --write   rewrite bound cards from real output
 *
 * Run it from the repo root, after `pnpm build`.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".git", "dist", "build", "bin", "obj"]);

const SDK_DIST = join(ROOT, "packages/sdk-ts/dist/index.js");
if (!existsSync(SDK_DIST)) {
  console.error(
    "check-cards: the TypeScript SDK is not built. Run `pnpm build` first.",
  );
  process.exit(2);
}

// `pathToFileURL`, because a filesystem path is not a module specifier. The
// ESM loader takes anything non-relative as a URL, and a Windows path opens
// with a drive letter, which reads as a scheme: `D:\...` is rejected as
// protocol "d:". A POSIX path begins with a separator and is accepted, which
// is why passing the path itself worked on two of the three platforms.
//
// The unbuilt-SDK check above is now a file test rather than a catch on the
// import, because a catch cannot tell "not built" from "built and failed to
// load" and reported both as the first. That is how this defect announced
// itself on Windows as a missing build.
const sdk = await import(pathToFileURL(SDK_DIST).href);

const readJson = (relativePath) =>
  JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));

/**
 * The bound cards, each with the command a reader can run to reproduce it and
 * the call that produces the same bytes here. `command` is printed in the
 * failure message so a stale card tells you how to regenerate it.
 */
const CARDS = {
  "saved-orchard": {
    command: "soil save examples/orchard-checkout.json",
    render: () =>
      sdk.renderSaved(readJson("examples/orchard-checkout.json"), "#001"),
  },
  "refused-secret": {
    command:
      "soil validate conformance/fixtures/invalid/secret-provider-key.json",
    render: () => {
      const path = "conformance/fixtures/invalid/secret-provider-key.json";
      return sdk.renderValidation(sdk.validateHandover(readJson(path)), path);
    },
  },
  // The two receipts in docs/switch-clients.md. Each document is the one its
  // session actually stored, committed beside the page, so the receipt a
  // reader sees is the receipt the saving model saw, held to the file.
  "switch-saved-claude-code": {
    command:
      "soil save docs/switch-clients/saved-by-claude-code.json  (first save into a fresh store)",
    render: () =>
      sdk.renderSaved(
        readJson("docs/switch-clients/saved-by-claude-code.json"),
        "#001",
      ),
  },
  "switch-saved-codex": {
    command:
      "soil save docs/switch-clients/saved-by-codex.json  (second save into the same store)",
    render: () =>
      sdk.renderSaved(
        readJson("docs/switch-clients/saved-by-codex.json"),
        "#002",
      ),
  },
};

function markdownFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...markdownFiles(full));
    else if (name.endsWith(".md")) found.push(full);
  }
  return found.sort();
}

/** Every fenced block carrying a card masthead, with its line span. */
function cardBlocks(lines) {
  const blocks = [];
  let open = null;
  lines.forEach((line, i) => {
    if (!line.startsWith("```")) return;
    if (open === null) {
      open = i;
      return;
    }
    const body = lines.slice(open + 1, i);
    if (body.some((text) => text.includes("┌─ SOIL ·"))) {
      blocks.push({ fenceOpen: open, fenceClose: i, body });
    }
    open = null;
  });
  return blocks;
}

/** The marker comment directly above a fenced block, blank lines allowed. */
function markerAbove(lines, fenceOpen) {
  for (let i = fenceOpen - 1; i >= 0 && fenceOpen - i <= 3; i--) {
    const text = lines[i].trim();
    if (text === "") continue;
    const bound = /^<!--\s*card:\s*bound\s+([a-z0-9-]+)\s*-->$/.exec(text);
    if (bound) return { kind: "bound", id: bound[1], line: i };
    if (/^<!--\s*card:\s*illustration\s*-->$/.test(text)) {
      return { kind: "illustration", line: i };
    }
    return undefined;
  }
  return undefined;
}

/**
 * The paragraph of visible prose immediately above the marker: the last
 * unbroken run of non-blank lines that is not a comment. That is what a
 * reader meets on the way down to the card.
 */
function visibleParagraphAbove(lines, markerLine) {
  let i = markerLine - 1;
  while (
    i >= 0 &&
    (lines[i].trim() === "" || lines[i].trim().startsWith("<!--"))
  )
    i -= 1;
  const paragraph = [];
  while (i >= 0 && lines[i].trim() !== "") {
    paragraph.unshift(lines[i].trim());
    i -= 1;
  }
  return paragraph.join(" ");
}

const write = process.argv.includes("--write");
const problems = [];
let rewritten = 0;
let checked = 0;

for (const file of markdownFiles(ROOT)) {
  const where = relative(ROOT, file);
  const original = readFileSync(file, "utf8");
  let lines = original.split("\n");
  // Walk backwards so a rewrite never shifts the spans still to be handled.
  for (const block of cardBlocks(lines).reverse()) {
    checked += 1;
    const marker = markerAbove(lines, block.fenceOpen);
    if (marker === undefined) {
      problems.push(
        `${where}:${block.fenceOpen + 1}: a card with no marker. Add ` +
          `"<!-- card: bound <id> -->" above it, or mark it as an ` +
          `illustration. Known ids: ${Object.keys(CARDS).join(", ")}.`,
      );
      continue;
    }
    if (marker.kind === "illustration") {
      const sentence = visibleParagraphAbove(lines, marker.line);
      if (!/illustration/i.test(sentence)) {
        problems.push(
          `${where}:${block.fenceOpen + 1}: an illustrative card must say so ` +
            `in visible prose immediately above it, not only in a comment.`,
        );
      }
      continue;
    }
    const card = CARDS[marker.id];
    if (card === undefined) {
      problems.push(
        `${where}:${marker.line + 1}: unknown card id "${marker.id}". ` +
          `Known ids: ${Object.keys(CARDS).join(", ")}.`,
      );
      continue;
    }
    const expected = card.render().split("\n");
    if (expected.join("\n") === block.body.join("\n")) continue;
    if (write) {
      lines = [
        ...lines.slice(0, block.fenceOpen + 1),
        ...expected,
        ...lines.slice(block.fenceClose),
      ];
      rewritten += 1;
      continue;
    }
    problems.push(
      `${where}:${block.fenceOpen + 1}: the card bound to "${marker.id}" is ` +
        `not what \`${card.command}\` prints. Run: node ` +
        `scripts/check-cards.mjs --write`,
    );
  }
  const next = lines.join("\n");
  if (write && next !== original) writeFileSync(file, next, "utf8");
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`\ncheck-cards: ${problems.length} problem(s).`);
  process.exit(1);
}
console.log(
  write
    ? `check-cards: ${checked} card(s) checked, ${rewritten} rewritten`
    : `check-cards: ${checked} card(s) checked, all bound or marked`,
);
