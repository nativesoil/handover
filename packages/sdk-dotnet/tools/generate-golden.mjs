/**
 * Golden generator: captures the TypeScript SDK's exact output bytes so the
 * .NET SDK's tests can assert byte parity without executing Node at test
 * time.
 *
 * Run from the repo root, after `pnpm build`:
 *
 *   node packages/sdk-dotnet/tools/generate-golden.mjs
 *
 * Every input here is fixed (fixed clock, fixed ids), so the files under
 * `packages/sdk-dotnet/SoilHandover.Tests/golden/` are deterministic and are
 * committed. Regenerate them only when the TypeScript SDK's observable
 * output changes on purpose.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const OUT = join(ROOT, "packages/sdk-dotnet/SoilHandover.Tests/golden");

// `pathToFileURL`, because the ESM loader reads a non-relative specifier as a
// URL and a Windows path's drive letter reads as a scheme.
const SDK_DIST = pathToFileURL(
  join(ROOT, "packages/sdk-ts/dist/index.js"),
).href;

const {
  HandoverStore,
  buildRestorePrompt,
  checkHandover,
  checkObservation,
  normalizeHandover,
  renderCheck,
  renderList,
  renderLoaded,
  renderSaved,
  renderValidation,
  validateHandover,
} = await import(SDK_DIST);

const { buildCheckCorpus, CHECK_OBSERVATION_PRODUCER } = await import(
  pathToFileURL(join(ROOT, "scripts/lib/check-corpus.mjs")).href
);

const NOW = new Date("2026-07-22T10:00:00Z");
const A_VALID_ID = "019f7e89-fc00-7000-8000-000000000000";

const example = JSON.parse(
  readFileSync(join(ROOT, "examples/orchard-checkout.json"), "utf8"),
);
const observed = JSON.parse(
  readFileSync(
    join(ROOT, "conformance/fixtures/valid/observations-unknown-kinds.json"),
    "utf8",
  ),
);
const workingStyle = JSON.parse(
  readFileSync(
    join(ROOT, "conformance/fixtures/valid/observation-working-style.json"),
    "utf8",
  ),
);

mkdirSync(OUT, { recursive: true });
const emit = (name, text) => writeFileSync(join(OUT, name), text, "utf8");

// --- restore prompts ---
// A fixed boundary token, because production takes 128 bits from the
// platform's cryptographic source on every render and a golden of a
// per-render value would be a golden of nothing.
const BOUNDARY_TOKEN = "0123456789abcdef0123456789abcdef";
const restore = (doc) =>
  buildRestorePrompt(doc, { boundaryToken: BOUNDARY_TOKEN });
emit("restore-prompt-example.txt", restore(example));
emit("restore-prompt-observations.txt", restore(observed));
// The one golden taken with the optional block asked for. The block is off by
// default, so a golden of the default rendering would say nothing about it.
emit(
  "restore-prompt-working-style.txt",
  buildRestorePrompt(workingStyle, {
    boundaryToken: BOUNDARY_TOKEN,
    workingStyleEvidence: true,
  }),
);
const thin = normalizeHandover({
  projectId: "thin",
  title: "Thin",
  createdAt: "2026-07-22T10:00:00Z",
  sections: { executiveSummary: "Almost nothing happened." },
});
emit("restore-prompt-thin.txt", restore(thin));

// --- rail cards ---
emit("saved-card-example.txt", renderSaved(example, "#001"));
const renderDoc = normalizeHandover({
  handoverId: A_VALID_ID,
  projectId: "render-test",
  title: "A short title",
  createdAt: "2026-07-22T10:00:00Z",
  source: { client: "claude-code", model: "opus-4.8" },
  sections: {
    executiveSummary: "What this is.",
    decisions: "What was decided.",
    architecture: { status: "blocked", summary: "Host names withheld." },
  },
  quality: { missingInputs: ["the deploy logs were not available"] },
  safety: { unsafeOmissions: ["an API key exists in the platform config"] },
});
emit("saved-card-render-test.txt", renderSaved(renderDoc, "#004"));
emit("loaded-card-example.txt", renderLoaded({ ...example, code: "#004" }));
emit(
  "list-card.txt",
  renderList([
    {
      code: "#002",
      projectId: "render-test",
      title: "A very long title that will not fit in the column at all",
      createdAt: "2026-07-22T10:00:00Z",
      sectionsWithContent: 9,
      sectionsCaptured: 9,
      file: "002.json",
    },
    {
      code: "#001",
      projectId: "render-test",
      title: "Short",
      createdAt: "2026-07-22T09:00:00Z",
      sectionsWithContent: 17,
      sectionsCaptured: 17,
      file: "001.json",
    },
  ]),
);
emit("list-card-empty.txt", renderList([]));

// --- validation cards ---
emit(
  "validation-card-valid.txt",
  renderValidation(validateHandover(example), "the document"),
);
emit(
  "validation-card-invalid.txt",
  renderValidation(validateHandover({ soilHandover: "1.0" }), "x"),
);
const secretDoc = normalizeHandover({
  handoverId: A_VALID_ID,
  projectId: "scan",
  title: "Scan",
  createdAt: "2026-07-22T10:00:00Z",
  sections: { architecture: "the key is sk-abc123def456" },
});
emit(
  "validation-card-secret.txt",
  renderValidation(validateHandover(secretDoc), "a save"),
);

// --- normalization output shape (serialized the way the store writes) ---
//
// The provenance list here carries a label that is not one of the eleven, and
// the quality list carries an entry that is not usable prose. Both survive
// normalization on purpose: version one is a closed world, so deleting either
// would make a save accept bytes that a validation refuses.
const loose = normalizeHandover({
  projectId: "loose-shape",
  title: "A reply in the rescue shape",
  createdAt: "2026-07-22T10:00:00Z",
  extractionSections: {
    projectIdentity: "A project that exists only to test the loose shape.",
    decisions: { status: "available", summary: "One decision was made." },
    blockers: { status: "missing", summary: null },
    workflow: {
      status: "available",
      summary: "  padded  ",
      provenance: ["model_reported", "vibe_checked"],
    },
  },
  quality: { missingInputs: ["the logs", "  "] },
  safety: { unsafeOmissions: ["a key exists in the platform config"] },
});
emit("normalized-loose.json", `${JSON.stringify(loose, null, 2)}\n`);

// --- store file bytes ---
const home = mkdtempSync(join(tmpdir(), "soil-golden-"));
try {
  const store = new HandoverStore(home);
  store.save(example);
  const identified = normalizeHandover({
    handoverId: "019f7e89-fc00-7000-8000-00000000abcd",
    projectId: "golden-store",
    title: "Stored with a fixed identity",
    createdAt: "2026-07-22T10:00:00Z",
    sections: { executiveSummary: "Fixed bytes for the store parity test." },
  });
  store.save(identified);
  store.save(observed);
  emit(
    "store-001.json",
    readFileSync(join(home, "handovers", "001.json"), "utf8"),
  );
  emit(
    "store-002.json",
    readFileSync(join(home, "handovers", "002.json"), "utf8"),
  );
  emit(
    "store-003.json",
    readFileSync(join(home, "handovers", "003.json"), "utf8"),
  );
  emit("store-index.json", readFileSync(join(home, "index.json"), "utf8"));
} finally {
  rmSync(home, { recursive: true, force: true });
}

// --- checking and grading ---
//
// The shared corpus from scripts/lib/check-corpus.mjs: the documents, the
// reference's check card, the report JSON and the quality.capture
// observation for each. The same corpus feeds the Go and JVM goldens
// through scripts/generate-check-parity.mjs, so the five implementations
// are held to one set of inputs.
const CHECK_OUT = join(OUT, "check");
mkdirSync(CHECK_OUT, { recursive: true });
for (const { name, document } of buildCheckCorpus(ROOT)) {
  const report = checkHandover(document);
  writeFileSync(
    join(CHECK_OUT, `${name}.json`),
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(CHECK_OUT, `${name}.card.txt`),
    renderCheck(document, report),
    "utf8",
  );
  writeFileSync(
    join(CHECK_OUT, `${name}.report.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(CHECK_OUT, `${name}.observation.json`),
    `${JSON.stringify(checkObservation(document, report, CHECK_OBSERVATION_PRODUCER), null, 2)}\n`,
    "utf8",
  );
}

console.log(`golden files written to ${OUT}`);
