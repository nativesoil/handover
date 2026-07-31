#!/usr/bin/env node
/**
 * Check-parity goldens: the corpus documents and the TypeScript reference's
 * exact output bytes for them, written into the Go, JVM and Python test
 * trees. The .NET goldens for the same corpus are emitted by that SDK's own
 * generator, `packages/sdk-dotnet/tools/generate-golden.mjs`, which reads
 * the same corpus module.
 *
 * Run from the repo root, after `pnpm build`:
 *
 *   node scripts/generate-check-parity.mjs
 *
 * Every input is fixed, so the emitted files are deterministic and are
 * committed. Regenerate them only when the reference's observable output
 * changes on purpose. The goldens are never edited by hand: a golden can
 * only ever say what the built reference says.
 *
 * Beyond emitting bytes, this generator holds the corpus to its own design:
 * every document must validate, and every document's grade and severity
 * counts must equal the ones stated in EXPECTED below. A corpus document
 * that drifts away from the edge it was built to sit on fails the run.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildCheckCorpus,
  CHECK_OBSERVATION_PRODUCER,
} from "./lib/check-corpus.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SDK_DIST = pathToFileURL(
  join(ROOT, "packages/sdk-ts/dist/index.js"),
).href;
const { checkHandover, checkObservation, renderCheck, validateHandover } =
  await import(SDK_DIST);

/**
 * What each corpus document is FOR: the band it must land in and the exact
 * severity counts that put it there. `null` counts mean the document's
 * counts are free to be whatever the reference computes (the three carried
 * repository documents), but the band is still pinned.
 */
const EXPECTED = {
  orchard: { grade: "adequate", counts: null },
  "thin-but-honest": { grade: "thin", counts: null },
  "blocked-and-safe": { grade: "thin", counts: null },
  "every-rule-a": {
    grade: "thin",
    counts: { problems: 2, cautions: 10, advice: 1 },
  },
  "every-rule-b": {
    grade: "thin",
    counts: { problems: 2, cautions: 12, advice: 4 },
  },
  "clean-strong": {
    grade: "strong",
    counts: { problems: 0, cautions: 0, advice: 0 },
  },
  "advice-only-strong": {
    grade: "strong",
    counts: { problems: 0, cautions: 0, advice: 2 },
  },
  "edge-adequate-5-cautions": {
    grade: "adequate",
    counts: { problems: 0, cautions: 5, advice: 0 },
  },
  "edge-thin-6-cautions": {
    grade: "thin",
    counts: { problems: 0, cautions: 6, advice: 0 },
  },
  "edge-thin-1-problem": {
    grade: "thin",
    counts: { problems: 1, cautions: 0, advice: 0 },
  },
  "edge-thin-2-problems": {
    grade: "thin",
    counts: { problems: 2, cautions: 0, advice: 0 },
  },
  "edge-failing-3-problems": {
    grade: "failing",
    counts: { problems: 3, cautions: 0, advice: 0 },
  },
  "unicode-attack": { grade: "thin", counts: null },
  "restore-floor-under": {
    grade: "thin",
    counts: { problems: 1, cautions: 0, advice: 0 },
  },
  "restore-floor-exact": {
    grade: "strong",
    counts: { problems: 0, cautions: 0, advice: 0 },
  },
  "restore-floor-not-applied": {
    grade: "strong",
    counts: { problems: 0, cautions: 0, advice: 0 },
  },
  "one-liner-median-edge": {
    grade: "strong",
    counts: { problems: 0, cautions: 0, advice: 1 },
  },
  "one-liner-median-under": {
    grade: "strong",
    counts: { problems: 0, cautions: 0, advice: 0 },
  },
};

const TARGETS = [
  {
    dir: join(ROOT, "packages/sdk-go/testdata/check"),
    card: (name) => `${name}.card.golden`,
    withDocuments: true,
  },
  {
    dir: join(ROOT, "packages/sdk-jvm/src/test/resources/parity/check"),
    card: (name) => `${name}.card.txt`,
    withDocuments: true,
  },
  {
    // The Python parity test runs the reference live, so it needs only the
    // corpus documents, not the reference's output.
    dir: join(ROOT, "packages/sdk-py/tests/check_corpus"),
    card: null,
    withDocuments: true,
  },
];

const corpus = buildCheckCorpus(ROOT);
const names = new Set(corpus.map((entry) => entry.name));
for (const name of Object.keys(EXPECTED)) {
  if (!names.has(name)) {
    throw new Error(`EXPECTED names a document the corpus lacks: ${name}`);
  }
}

for (const target of TARGETS) {
  mkdirSync(target.dir, { recursive: true });
}

let emitted = 0;
for (const { name, document } of corpus) {
  const expected = EXPECTED[name];
  if (expected === undefined) {
    throw new Error(`corpus document ${name} has no EXPECTED entry`);
  }

  const validation = validateHandover(document);
  if (!validation.valid) {
    const details = validation.issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("\n  ");
    throw new Error(`corpus document ${name} does not validate:\n  ${details}`);
  }

  const report = checkHandover(document);
  if (report.grade !== expected.grade) {
    throw new Error(
      `corpus document ${name} grades ${report.grade}, built for ${expected.grade}`,
    );
  }
  if (expected.counts !== null) {
    for (const key of ["problems", "cautions", "advice"]) {
      if (report.counts[key] !== expected.counts[key]) {
        throw new Error(
          `corpus document ${name} counts ${key}=${report.counts[key]}, built for ${expected.counts[key]}`,
        );
      }
    }
  }

  const card = renderCheck(document, report);
  const observation = checkObservation(
    document,
    report,
    CHECK_OBSERVATION_PRODUCER,
  );

  for (const target of TARGETS) {
    if (target.withDocuments) {
      writeFileSync(
        join(target.dir, `${name}.json`),
        `${JSON.stringify(document, null, 2)}\n`,
        "utf8",
      );
    }
    if (target.card !== null) {
      writeFileSync(join(target.dir, target.card(name)), card, "utf8");
      writeFileSync(
        join(target.dir, `${name}.report.json`),
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
      );
      writeFileSync(
        join(target.dir, `${name}.observation.json`),
        `${JSON.stringify(observation, null, 2)}\n`,
        "utf8",
      );
    }
  }
  emitted += 1;
}

process.stdout.write(
  `check-parity goldens: ${emitted} documents into ${TARGETS.length} trees\n`,
);
