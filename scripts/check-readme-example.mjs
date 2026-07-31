#!/usr/bin/env node
/**
 * The README's JSON example is a subset of a document that really validates.
 *
 * The README shows a handful of fields from a handover so a reader sees the
 * shape before the argument. A hand-typed excerpt is a picture of a document,
 * and pictures drift: a field gets renamed in the schema and the front page
 * keeps showing the old name. So the excerpt is bound the way the rail cards
 * are bound by check-cards.mjs: the full document lives in
 * docs/examples/readme-example.json, this check validates it with the real
 * validator on every run, and the fenced block in README.md must equal, byte
 * for byte, the subset this script derives from that file. The README copy
 * cannot say anything the validating document does not.
 *
 * The block must be immediately preceded by the marker comment
 * `<!-- example: bound readme-example -->`.
 *
 *   node scripts/check-readme-example.mjs           verify, exit 1 on drift
 *   node scripts/check-readme-example.mjs --write   rewrite the block
 *
 * Run it from the repo root, after `pnpm build`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = "docs/examples/readme-example.json";
const README = join(ROOT, "README.md");
const MARKER = "<!-- example: bound readme-example -->";

/** The fields the README shows. A subset, and the caption beside it says so. */
const TOP_FIELDS = ["soilHandover", "projectId", "title"];
const SECTIONS = ["decisions", "constraints", "currentTask", "rejectedPaths"];

const SDK_DIST = join(ROOT, "packages/sdk-ts/dist/index.js");
if (!existsSync(SDK_DIST)) {
  console.error(
    "check-readme-example: the TypeScript SDK is not built. Run `pnpm build` first.",
  );
  process.exit(2);
}
const sdk = await import(pathToFileURL(SDK_DIST).href);

const document = JSON.parse(readFileSync(join(ROOT, EXAMPLE), "utf8"));

// The whole point: the document behind the excerpt passes the real validator.
const result = sdk.validateHandover(document);
if (!result.valid) {
  for (const issue of result.issues) {
    console.error(`${EXAMPLE}: ${issue.path}: ${issue.message}`);
  }
  console.error(
    `\ncheck-readme-example: ${EXAMPLE} does not validate, so the README ` +
      `excerpt has nothing real to stand on.`,
  );
  process.exit(1);
}

const subset = {};
for (const field of TOP_FIELDS) subset[field] = document[field];
subset.sections = {};
for (const key of SECTIONS) {
  if (document.sections[key] === undefined) {
    console.error(
      `check-readme-example: ${EXAMPLE} has no section "${key}"; the subset ` +
        `list in this script names sections the document must carry.`,
    );
    process.exit(1);
  }
  subset.sections[key] = document.sections[key];
}
const expected = JSON.stringify(subset, null, 2);

const original = readFileSync(README, "utf8");
const lines = original.split("\n");
const markerAt = lines.findIndex((line) => line.trim() === MARKER);
if (markerAt === -1) {
  console.error(`check-readme-example: README.md is missing "${MARKER}".`);
  process.exit(1);
}
let open = markerAt + 1;
while (open < lines.length && lines[open].trim() === "") open += 1;
if (lines[open] !== "```json") {
  console.error(
    `check-readme-example: the marker must be followed by a \`\`\`json block.`,
  );
  process.exit(1);
}
let close = open + 1;
while (close < lines.length && !lines[close].startsWith("```")) close += 1;
if (close === lines.length) {
  console.error("check-readme-example: the example block is never closed.");
  process.exit(1);
}

const actual = lines.slice(open + 1, close).join("\n");
if (actual === expected) {
  console.log(
    `check-readme-example: the README excerpt matches ${EXAMPLE}, which validates.`,
  );
  process.exit(0);
}

if (process.argv.includes("--write")) {
  const next = [
    ...lines.slice(0, open + 1),
    ...expected.split("\n"),
    ...lines.slice(close),
  ].join("\n");
  writeFileSync(README, next, "utf8");
  console.log(
    `check-readme-example: README excerpt rewritten from ${EXAMPLE}.`,
  );
  process.exit(0);
}

console.error(
  `check-readme-example: the README excerpt has drifted from ${EXAMPLE}. ` +
    `Run: node scripts/check-readme-example.mjs --write`,
);
process.exit(1);
