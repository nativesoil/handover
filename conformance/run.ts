/**
 * The conformance suite.
 *
 * This is what "Soil Compatible" means, executed. It runs the golden fixtures
 * against an implementation and checks the behaviours that make handovers
 * portable rather than merely well-formed:
 *
 *   1. fixtures      the valid ones validate, the invalid ones fail where the
 *                    manifest says they fail, compared as an abstract semantic
 *                    location rather than as pointer text
 *   1b. boundary     the pre-schema ingestion boundary: encoding, duplicate
 *                    member names, nesting depth and the numeric domain,
 *                    judged on the BYTES, because none of them can be seen
 *                    from a value
 *  1c. text-unit    every length bound in the format counted in Unicode code
 *                    points, on strings where the candidate units disagree
 *   2. schema        the published JSON Schema and the SDK validator agree on
 *                    every fixture, so neither can drift alone
 *   3. identity      the handoverId rules: writer-assigned UUIDv7, copies keep
 *                    it, new captures get a new one, codes are not identity
 *   4. observations  the extension point stays forward compatible: unknown kinds
 *                    survive a round trip and change nothing about the sections
 *   5. safety        a handover carrying credentials or private absolute paths
 *                    is refused, and the refusal never echoes the value
 *   6. normalization the loose shapes a model actually emits become documents
 *  6b. closed-world  exact version support, and the invariant that a save and a
 *                    validation of the same bytes give the same verdict
 *   7. store         save, list and read round trip through plain files
 *   8. restore       a loaded handover carries its gaps and its framing, every
 *                    field a writer supplied reaches the reader, and content in
 *                    it cannot be mistaken for the rendered prompt's own
 *                    structure
 *   9. determinism   the renderer returns identical bytes for identical input
 *  10. recipe        all 17 sections have guidance, and the rules are intact
 *  11. mcp           exactly three tools, every schema strict, and a stated
 *                    value the surface cannot carry refused or reported, never
 *                    both accepted and dropped in silence
 *
 * Run it with `pnpm conformance`. It exits non-zero on the first failing
 * category, and it prints what failed rather than a count.
 */

import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ajv2020Module from "ajv/dist/2020.js";
import ajvFormatsModule from "ajv-formats";

import {
  HandoverStore,
  PROVENANCE_LABELS,
  RECIPE_VERSION,
  RESCUE_PROMPT,
  SECTION_GUIDANCE,
  SECTION_KEYS,
  SECTION_LABELS,
  SECTION_STATUSES,
  SHARED_RULES,
  buildRecipe,
  buildRestorePrompt,
  extractJsonBlock,
  INGEST_LIMITS,
  LIMITS,
  findSecretMaterial,
  ingestDocument,
  normalizeHandover,
  renderRecipe,
  renderSaved,
  textLength,
  validateHandover,
} from "@nativesoil/handover-sdk";
import type { Handover } from "@nativesoil/handover-sdk";
import { TOOLS, callTool } from "@nativesoil/handover-mcp";

/**
 * ajv ships CommonJS, so under Node's ESM resolution the constructor can arrive
 * either as the module itself or on `.default` depending on the bundler in
 * play. Unwrap once here rather than at every call site.
 */
type SchemaValidator = (value: unknown) => boolean;
interface AjvInstance {
  compile(schema: object): SchemaValidator;
}
type AjvConstructor = new (options?: Record<string, unknown>) => AjvInstance;

function unwrap<T>(mod: T): T {
  const candidate = mod as { default?: T };
  return candidate.default ?? mod;
}

const Ajv2020 = unwrap(ajv2020Module) as unknown as AjvConstructor;
const addFormats = unwrap(ajvFormatsModule) as unknown as (
  ajv: AjvInstance,
) => void;

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo root, whether this runs from source or from `conformance/dist`. */
const ROOT = HERE.endsWith("dist")
  ? resolve(HERE, "../..")
  : resolve(HERE, "..");
const FIXTURES = join(ROOT, "conformance/fixtures");

/**
 * An abstract semantic location: an ordered sequence of object member names
 * and array indices, from the root of the document to the offending value. The
 * empty sequence means the document itself.
 *
 * This is what the harness compares, and it is deliberately not a string. The
 * manifest used to bind exact JSON Pointer text, which made a formatting
 * choice into a conformance requirement the specification never states: an
 * implementation that reports the same place in a different notation was
 * failed by the official suite for being spelled differently. A pointer is
 * still a fine representation, inside an SDK or on the wire; each runner
 * simply parses its own representation into segments before comparing.
 */
type LocationSegment = string | number;

/**
 * The adapter for THIS runner's error representation: the reference SDK
 * reports a JSON Pointer-ish string, so this is the pointer-to-segments half.
 * Another implementation writes its own adapter here and compares the same
 * sequences.
 */
function locationOf(pointer: string): LocationSegment[] {
  if (pointer === "" || pointer === "/") return [];
  return pointer
    .replace(/^\//, "")
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((token) => (/^\d+$/.test(token) ? Number(token) : token));
}

/** Two semantic locations are the same location. */
function sameLocation(
  a: readonly LocationSegment[],
  b: readonly LocationSegment[],
): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

/** A semantic location, for a failure message. Never compared. */
function showLocation(location: readonly LocationSegment[]): string {
  return location.length === 0 ? "the document" : location.join(" > ");
}

interface ManifestValid {
  readonly file: string;
  readonly note: string;
}
interface ManifestInvalid {
  readonly file: string;
  /** Where the issue must be reported, as semantic segments. */
  readonly location: readonly LocationSegment[];
  readonly reason: string;
  /** `safety` for the secret scan, absent for a structural rule. */
  readonly kind?: "safety";
  /**
   * False when the rule cannot be written in JSON Schema. Those fixtures must
   * be ACCEPTED by the schema and REJECTED by the implementation, which is the
   * proof that the schema alone is not a conformant reader.
   */
  readonly schemaExpressible?: boolean;
}
/**
 * One ingestion-boundary fixture. Either a file of bytes, or a byte length the
 * runner materialises, because the size fixtures are a megabyte each.
 */
interface ManifestBoundary {
  readonly name: string;
  readonly file?: string;
  readonly generateBytes?: number;
  /** `accepted`, or the stable ingest error code the boundary must report. */
  readonly ingest: string;
  /** For a rejection: where the issue must be reported, as semantic segments. */
  readonly location?: readonly LocationSegment[];
  /** For an acceptance: what the validator must then say. */
  readonly afterIngest?: "valid" | "refused-by-safety" | "not-a-handover";
  readonly reason: string;
}
/** One adversarial restore-prompt fixture: a valid document, hostile content. */
interface ManifestRestore {
  readonly name: string;
  readonly file: string;
  readonly reason: string;
}
interface Manifest {
  readonly specVersion: string;
  readonly valid: readonly ManifestValid[];
  readonly invalid: readonly ManifestInvalid[];
  readonly restore: readonly ManifestRestore[];
  readonly restoreBoundaryToken: string;
  readonly boundary: readonly ManifestBoundary[];
}

/**
 * The two conformance classes, reported separately and never as one green
 * blob. "Soil Document Conformant" is a claim about DOCUMENTS: the schema,
 * the section semantics, round trips, identity. "Soil Secure Writer
 * Conformant" is a claim about BEHAVIOUR: the safety fixtures that must be
 * refused, with the right category, storing nothing.
 */
export type ConformanceClass = "document" | "secure-writer";

/** Which class a category's checks belong to unless a check says otherwise. */
function classOf(category: string): ConformanceClass {
  return category === "safety" ? "secure-writer" : "document";
}

/** One failed expectation. */
export interface Failure {
  readonly category: string;
  readonly conformanceClass: ConformanceClass;
  readonly detail: string;
}

/**
 * What the suite found, counted per conformance class.
 *
 * `categories` is what the run actually exercised: every category name a check
 * was filed under, and for each one the classes its checks landed in. It is
 * derived, never declared, and it exists so that the category table in
 * README.md can be held to it rather than maintained beside it. That table
 * drifted twice while nothing compared the two.
 */
export interface ConformanceReport {
  readonly checks: number;
  readonly checksByClass: Readonly<Record<ConformanceClass, number>>;
  readonly categories: ReadonlyMap<string, ReadonlySet<ConformanceClass>>;
  readonly failures: readonly Failure[];
}

class Suite {
  checks = 0;
  readonly checksByClass: Record<ConformanceClass, number> = {
    document: 0,
    "secure-writer": 0,
  };
  readonly categories = new Map<string, Set<ConformanceClass>>();
  readonly failures: Failure[] = [];

  check(
    category: string,
    condition: boolean,
    detail: string,
    conformanceClass: ConformanceClass = classOf(category),
  ): void {
    this.checks += 1;
    this.checksByClass[conformanceClass] += 1;
    const classes =
      this.categories.get(category) ?? new Set<ConformanceClass>();
    classes.add(conformanceClass);
    this.categories.set(category, classes);
    if (!condition) {
      this.failures.push({ category, conformanceClass, detail });
    }
  }
}

/**
 * A syntactically valid UUID used where a check needs a document that is
 * complete but is not exercising the writer's assignment path.
 */
const A_VALID_ID = "019f7e89-fc00-7000-8000-000000000000";
/** A capture time, stated by the document. Nothing here reads a clock. */
const A_CAPTURE_TIME = "2026-07-22T10:00:00Z";

/** The exact shape the official writers emit: UUIDv7, RFC 9562 variant. */
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadManifest(): Manifest {
  return readJson(join(FIXTURES, "manifest.json")) as Manifest;
}

/**
 * The fixed boundary token every restore-prompt check injects. Production
 * takes 128 bits from the platform's cryptographic source instead, which is
 * what makes the boundary unforgeable; a fixed token here is what keeps a
 * check on the rendered bytes possible at all.
 */
const RESTORE_TOKEN = loadManifest().restoreBoundaryToken;
const RESTORE_MARK = `soil:${RESTORE_TOKEN}`;

function fixturePath(file: string): string {
  return resolve(FIXTURES, file);
}

/** 1 + 2: the fixtures, and the schema agreeing with the validator. */
function checkFixtures(suite: Suite): void {
  const manifest = loadManifest();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = readJson(join(ROOT, "spec/handover.schema.json"));
  const schemaValidate = ajv.compile(schema as object);

  for (const entry of manifest.valid) {
    const doc = readJson(fixturePath(entry.file));
    const result = validateHandover(doc);
    suite.check(
      "fixtures",
      result.valid,
      `${entry.file} should be valid but the validator reported: ${result.issues
        .map((i) => `${i.path} ${i.message}`)
        .join("; ")}`,
    );
    const bySchema = schemaValidate(doc);
    suite.check(
      "schema",
      bySchema === result.valid,
      `${entry.file}: schema says ${bySchema ? "valid" : "invalid"}, validator says ${
        result.valid ? "valid" : "invalid"
      }`,
    );
  }

  for (const entry of manifest.invalid) {
    const doc = readJson(fixturePath(entry.file));
    const result = validateHandover(doc);
    // Refusing a safety fixture is writer behaviour, so those two checks
    // count toward the Secure Writer class; structural rejections are
    // document checks.
    const entryClass: ConformanceClass =
      entry.kind === "safety" ? "secure-writer" : "document";
    suite.check(
      "fixtures",
      !result.valid,
      `${entry.file} should be rejected (${entry.reason}) but validated`,
      entryClass,
    );
    suite.check(
      "fixtures",
      result.issues.some((issue) =>
        sameLocation(locationOf(issue.path), entry.location),
      ),
      `${entry.file} should report a problem at ${showLocation(entry.location)}, reported: ${
        result.issues.map((i) => showLocation(locationOf(i.path))).join(", ") ||
        "nothing"
      }`,
      entryClass,
    );
    if (entry.kind === "safety") {
      suite.check(
        "safety",
        result.issues.some((issue) => issue.kind === "safety"),
        `${entry.file} should be refused by the secret scan, not merely by shape`,
      );
    }

    const bySchema = schemaValidate(doc);
    if (entry.schemaExpressible === false) {
      suite.check(
        "schema",
        bySchema === true,
        `${entry.file} is rejected by a rule JSON Schema cannot express, so the schema should still accept it; if the schema now rejects it, the manifest is out of date`,
      );
    } else {
      suite.check(
        "schema",
        bySchema === false,
        `${entry.file}: the published schema accepted a document the spec rejects`,
      );
    }
  }
}

/**
 * The pre-schema ingestion boundary: encoding, duplicate member names and
 * nesting depth, all judged on the bytes before a value exists.
 *
 * The category is its own because none of it can be seen from a constructed
 * value, which is exactly why the three defects survived this long. The
 * published JSON Schema and the reference validator as this runner configures
 * it are both handed an already-parsed value, so both are structurally blind
 * here; that is a fact about layers, not a gap in the schema.
 */
function checkIngestionBoundary(suite: Suite): void {
  const manifest = loadManifest();
  for (const entry of manifest.boundary) {
    const bytes = boundaryBytes(entry);
    const result = ingestDocument(bytes);

    if (entry.ingest === "accepted") {
      suite.check(
        "boundary",
        result.ok,
        `${entry.name}: must be accepted, was refused with ${
          result.ok ? "" : result.issue.code
        }`,
      );
      if (!result.ok) continue;

      // An accepted document is never merely accepted. The validator runs on
      // it and must return a result, because the one outcome worse than a
      // rejection is a document that is accepted and never scanned.
      const validation = validateHandover(result.value);
      if (entry.afterIngest === "valid") {
        suite.check(
          "boundary",
          validation.valid,
          `${entry.name}: accepted at the boundary, then rejected by the validator: ${validation.issues
            .map((i) => `${i.path} ${i.message}`)
            .join("; ")}`,
        );
      } else if (entry.afterIngest === "refused-by-safety") {
        suite.check(
          "boundary",
          validation.issues.some((issue) => issue.kind === "safety"),
          `${entry.name}: accepted at the boundary, so the fail-closed secret scan must reach it and refuse it`,
          "secure-writer",
        );
      } else {
        suite.check(
          "boundary",
          !validation.valid,
          `${entry.name}: is not a handover, so the validator must say so rather than accept it`,
        );
      }
      continue;
    }

    suite.check(
      "boundary",
      !result.ok && result.issue.code === entry.ingest,
      `${entry.name}: must be refused with ${entry.ingest}, got ${
        result.ok ? "acceptance" : result.issue.code
      }`,
    );
    if (!result.ok && entry.location !== undefined) {
      suite.check(
        "boundary",
        sameLocation(locationOf(result.issue.path), entry.location),
        `${entry.name}: must report the issue at ${showLocation(entry.location)}, reported ${showLocation(
          locationOf(result.issue.path),
        )}`,
      );
    }
  }

  // The limits are stated once and read from one place, so a surface cannot
  // quietly hold a different ceiling than the fixtures were built for.
  suite.check(
    "boundary",
    INGEST_LIMITS.maxDepth === 32 && INGEST_LIMITS.maxBytes === 1048576,
    `the boundary limits must be 32 levels and 1048576 bytes, found ${INGEST_LIMITS.maxDepth} and ${INGEST_LIMITS.maxBytes}`,
  );
  suite.check(
    "boundary",
    INGEST_LIMITS.maxInteger === 9007199254740991 &&
      INGEST_LIMITS.minInteger === -9007199254740991,
    `the integer domain must run from -9007199254740991 to 9007199254740991, found ${INGEST_LIMITS.minInteger} to ${INGEST_LIMITS.maxInteger}`,
  );
}

/**
 * The text unit, exercised at every individually bounded string in the format.
 *
 * The fixtures pin three of these sites and this pins all five, including the
 * 20000-code-point section summary, which is deliberately not a fixture: at
 * four bytes per astral character it would be an eighty-kilobyte file in a
 * repository whose largest real document is eighteen kilobytes, and a string
 * built here costs nothing and proves the same thing.
 *
 * Everything here is deliberately NOT ASCII. On ASCII the three candidate
 * units — code points, UTF-16 code units and UTF-8 bytes — all give the same
 * answer, so an ASCII test cannot tell a conformant implementation from one
 * counting the wrong thing. The astral cases are twice the UTF-16 count and
 * four times the byte count of their code-point count; the combining cases are
 * twice the grapheme-cluster count.
 */
function checkTextUnit(suite: Suite): void {
  /** One code point, two UTF-16 code units, four UTF-8 bytes. */
  const ASTRAL = String.fromCodePoint(0x1f600);
  /** Two code points, two UTF-16 code units, three UTF-8 bytes, one cluster. */
  const COMBINED = "é";

  const base = (): Record<string, unknown> => ({
    ...(normalizeHandover({
      projectId: "text-unit",
      title: "The text unit",
      createdAt: A_CAPTURE_TIME,
      sections: { executiveSummary: "The text unit, exercised." },
    }) as unknown as Record<string, unknown>),
    handoverId: A_VALID_ID,
  });

  const withSummary = (text: string): Record<string, unknown> => {
    const doc = base();
    const sections = { ...(doc["sections"] as Record<string, unknown>) };
    sections["architecture"] = { status: "available", summary: text };
    return { ...doc, sections };
  };

  const cases: readonly {
    readonly what: string;
    readonly path: string;
    readonly at: Record<string, unknown>;
    readonly over: Record<string, unknown>;
  }[] = [
    {
      what: `title at ${LIMITS.title} code points`,
      path: "/title",
      at: { ...base(), title: ASTRAL.repeat(LIMITS.title) },
      over: { ...base(), title: ASTRAL.repeat(LIMITS.title + 1) },
    },
    {
      what: `title at ${LIMITS.title} code points of combining sequences`,
      path: "/title",
      at: { ...base(), title: COMBINED.repeat(LIMITS.title / 2) },
      over: { ...base(), title: `${COMBINED.repeat(LIMITS.title / 2)}x` },
    },
    {
      what: `section summary at ${LIMITS.sectionSummary} code points`,
      path: "/sections/architecture/summary",
      at: withSummary(ASTRAL.repeat(LIMITS.sectionSummary)),
      over: withSummary(ASTRAL.repeat(LIMITS.sectionSummary + 1)),
    },
    {
      what: `a stated gap at ${LIMITS.listEntry} code points`,
      path: "/quality/missingInputs/0",
      at: {
        ...base(),
        quality: { missingInputs: [COMBINED.repeat(LIMITS.listEntry / 2)] },
      },
      over: {
        ...base(),
        quality: {
          missingInputs: [`${COMBINED.repeat(LIMITS.listEntry / 2)}x`],
        },
      },
    },
    {
      what: `an observation kind at ${LIMITS.observationKind} code points`,
      path: "/observations/0/kind",
      at: {
        ...base(),
        observations: [
          { kind: ASTRAL.repeat(LIMITS.observationKind), data: {} },
        ],
      },
      over: {
        ...base(),
        observations: [
          { kind: ASTRAL.repeat(LIMITS.observationKind + 1), data: {} },
        ],
      },
    },
    {
      // projectId is pattern-restricted to ASCII, so all three candidate units
      // agree on it. It is here for the bound, not for the unit.
      what: `projectId at ${LIMITS.projectId} code points`,
      path: "/projectId",
      at: { ...base(), projectId: "p".repeat(LIMITS.projectId) },
      over: { ...base(), projectId: "p".repeat(LIMITS.projectId + 1) },
    },
  ];

  for (const entry of cases) {
    const at = validateHandover(entry.at);
    suite.check(
      "text-unit",
      at.valid,
      `${entry.what} must be accepted, refused: ${at.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    );
    const over = validateHandover(entry.over);
    suite.check(
      "text-unit",
      !over.valid && over.issues.some((issue) => issue.path === entry.path),
      `one code point over ${entry.what} must be refused at ${entry.path}`,
    );
  }

  // The unit itself, on the three cases that separate the candidates.
  suite.check(
    "text-unit",
    textLength(ASTRAL) === 1 && ASTRAL.length === 2,
    "a character outside the basic plane is one code point and two UTF-16 code units",
  );
  suite.check(
    "text-unit",
    textLength(COMBINED) === 2,
    "one perceived character written as a base plus a combining mark is two code points, not one",
  );
  suite.check(
    "text-unit",
    textLength("café") === 4 && new TextEncoder().encode("café").length === 5,
    "a precomposed accented character is one code point and two UTF-8 bytes",
  );
}

/** Materialise one boundary fixture: bytes on disk, or a padded document. */
function boundaryBytes(entry: ManifestBoundary): Uint8Array {
  if (entry.file !== undefined) return readFileSync(fixturePath(entry.file));
  const total = entry.generateBytes ?? 0;
  return new TextEncoder().encode(`{"pad":"${"x".repeat(total - 10)}"}`);
}

/**
 * The extension point: unknown kinds survive a full round trip, and the sections
 * are read the same with them as without them.
 */
function checkObservations(suite: Suite): void {
  const home = mkdtempSync(join(tmpdir(), "soil-observations-"));
  try {
    const store = new HandoverStore(home);
    const doc = readJson(
      fixturePath("valid/observations-unknown-kinds.json"),
    ) as Parameters<HandoverStore["save"]>[0];

    const entry = store.save(doc);
    const read = store.read(entry.code);
    suite.check(
      "observations",
      read.observations?.length === 3,
      "an unrecognised observation must survive a save and a read, not be dropped",
    );
    suite.check(
      "observations",
      JSON.stringify(read.observations) === JSON.stringify(doc.observations),
      "an unrecognised observation must round trip unchanged",
    );

    const normalized = normalizeHandover(doc);
    suite.check(
      "observations",
      JSON.stringify(normalized.observations) ===
        JSON.stringify(doc.observations),
      "normalization must not interpret, filter or reorder observations",
    );

    const { observations: _attached, ...withoutObservations } = read;
    suite.check(
      "observations",
      buildRestorePrompt(read, { boundaryToken: RESTORE_TOKEN }) ===
        buildRestorePrompt(withoutObservations, {
          boundaryToken: RESTORE_TOKEN,
        }),
      "observations must not change how the 17 sections are read",
    );

    const unknownOnly = validateHandover({
      ...doc,
      observations: [{ kind: "kind.from.the.future", data: { x: 1 } }],
    });
    suite.check(
      "observations",
      unknownOnly.valid,
      "a kind this implementation has never heard of must be accepted, not treated as an error",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Identity: the `handoverId` rules, exercised one by one. The letters match
 * the fixture list in the specification work: (a) a new handover gets a new
 * UUIDv7, (b) a byte-for-byte copy keeps its id, (c) a new capture of the
 * same project gets a new one, (d) local codes may collide across stores
 * without identity collision, (e) the id survives the store's own update
 * path, (f) an invalid or missing id is handled deterministically, and (g)
 * is the same checks run by `run_py.py` over the same fixtures.
 */
function checkIdentity(suite: Suite): void {
  const homeA = mkdtempSync(join(tmpdir(), "soil-identity-a-"));
  const homeB = mkdtempSync(join(tmpdir(), "soil-identity-b-"));
  try {
    const storeA = new HandoverStore(homeA);
    const storeB = new HandoverStore(homeB);
    const fresh = (): Handover =>
      normalizeHandover({
        projectId: "identity",
        title: "Identity",
        createdAt: A_CAPTURE_TIME,
        sections: { executiveSummary: "The identity rules, exercised." },
      });

    // (a) a new handover gets a new UUIDv7, assigned by the writer.
    const first = storeA.save(fresh());
    const firstDoc = storeA.read(first.code);
    suite.check(
      "identity",
      typeof firstDoc.handoverId === "string" &&
        UUID_V7_PATTERN.test(firstDoc.handoverId),
      "(a) a handover stored without an id must be assigned a UUIDv7 by the writer",
    );

    // (c) a new capture, even of the same project, gets a new handoverId.
    const second = storeA.save(fresh());
    const secondDoc = storeA.read(second.code);
    suite.check(
      "identity",
      secondDoc.handoverId !== undefined &&
        secondDoc.handoverId !== firstDoc.handoverId,
      "(c) a new capture of the same project must get a new handoverId",
    );

    // (d) local codes may collide across two stores; identity does not.
    const other = storeB.save(fresh());
    const otherDoc = storeB.read(other.code);
    suite.check(
      "identity",
      other.code === first.code && otherDoc.handoverId !== firstDoc.handoverId,
      "(d) two stores may both hold a #001, and the two documents must still have different handoverIds",
    );

    // (b) a byte-for-byte copy keeps its handoverId, in any store.
    const copy = JSON.parse(JSON.stringify(firstDoc)) as Handover;
    const copyEntry = storeB.save(copy);
    const copyDoc = storeB.read(copyEntry.code);
    suite.check(
      "identity",
      copyDoc.handoverId === firstDoc.handoverId,
      "(b) a byte-for-byte copy must keep its handoverId when stored again",
    );

    // (e) the store's own update path never changes an id. There is no
    // migration tooling yet, so the rule is pinned on reindex: the files are
    // rewritten around, and identity must come out untouched.
    storeA.reindex();
    suite.check(
      "identity",
      storeA.read(first.code).handoverId === firstDoc.handoverId,
      "(e) rebuilding the store's index must leave every handoverId unchanged",
    );

    // (f) an invalid or missing id is handled deterministically on validate:
    // a structure issue at /handoverId, and never a silent replacement.
    const { handoverId: _dropped, ...withoutId } = firstDoc;
    const missing = validateHandover(withoutId);
    suite.check(
      "identity",
      !missing.valid &&
        missing.issues.some(
          (issue) => issue.path === "/handoverId" && issue.kind === "structure",
        ),
      "(f) a document claiming validity without an id must fail with a structure issue at /handoverId",
    );
    const malformed = validateHandover({
      ...firstDoc,
      handoverId: "handover-42",
    });
    suite.check(
      "identity",
      !malformed.valid &&
        malformed.issues.some((issue) => issue.path === "/handoverId"),
      "(f) a malformed id must fail at /handoverId rather than be replaced",
    );
  } finally {
    rmSync(homeA, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
  }
}

/** The fail-closed secret scan, checked on its own terms. */
function checkSecretScan(suite: Suite): void {
  const clean = readJson(join(ROOT, "examples/orchard-checkout.json"));
  suite.check(
    "safety",
    findSecretMaterial(clean).length === 0,
    "the worked example must be free of secret material",
  );

  // One unsafe positive per mandatory class, plus the vendor formats and the
  // precedence case. spec/safety-patterns.md is the normative statement; this
  // table is the minimum an implementation must refuse.
  const cases: readonly { readonly text: string; readonly label: string }[] = [
    { text: "the key is sk-abc123def456", label: "provider_api_key" },
    {
      text: "clone https://ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/o/r.git",
      label: "provider_api_key",
    },
    {
      text: "the runner env holds AKIAIOSFODNN7EXAMPLE",
      label: "provider_api_key",
    },
    {
      text: "the bot posts with xoxb-2314789012-4567890123456-AbCdEfGhIjKlMnOpQrStUvWx",
      label: "provider_api_key",
    },
    {
      text: "maps is keyed with AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
      label: "provider_api_key",
    },
    {
      text: "Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e",
      label: "bearer_token",
    },
    {
      text: "Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1lMTIzNDU2",
      label: "authorization_header",
    },
    {
      text: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln",
      label: "jwt",
    },
    { text: "-----BEGIN PRIVATE KEY-----", label: "private_key_pem" },
    {
      text: 'the app reads client_secret="9f8a7b6c5d4e3f2a1b0c"',
      label: "client_secret",
    },
    {
      text: 'the runner loads {"type": "service_account", "project_id": "x"}',
      label: "google_application_credentials",
    },
    {
      text: "GOOGLE_APPLICATION_CREDENTIALS=/opt/keys/orchard-sa.json",
      label: "google_application_credentials",
    },
    { text: "it lives at /Users/example/code/app", label: "private_path" },
    { text: "it lives at /home/deploy/app", label: "private_path" },
    { text: "it lives at C:\\Users\\example\\app", label: "private_path" },
    {
      text: "postgres://orchard:9f8a7b6c5d4e3f@db.internal:5432/orchard",
      label: "url_credentials",
    },
    {
      text: "The token was redacted: ghp_16C7e42F292c6912E7710c838347Ae178B4a is gone.",
      label: "provider_api_key",
    },
  ];

  for (const { text, label } of cases) {
    const doc = normalizeHandover({
      handoverId: A_VALID_ID,
      projectId: "scan",
      title: "Scan",
      createdAt: A_CAPTURE_TIME,
      sections: { architecture: text },
    });
    const findings = findSecretMaterial(doc);
    suite.check(
      "safety",
      findings.some((finding) => finding.label === label),
      `a section carrying ${label} must be detected`,
    );
    const result = validateHandover(doc);
    suite.check(
      "safety",
      !result.valid,
      `a handover carrying ${label} must be rejected, not merely flagged`,
    );
    for (const issue of result.issues) {
      suite.check(
        "safety",
        !issue.message.includes(text),
        `a ${label} finding must not echo the matched value back`,
      );
    }
  }

  // The safe near-neighbour of every class. Refusing any of these would make
  // the format contradict its own section requirements: `architecture` asks
  // for flag and command names quoted exactly, and `safetySummary` asks for
  // what was withheld and where it is configured.
  const safeCases: readonly string[] = [
    "A provider API key exists and is set in the deployment platform. Its value is not carried here.",
    "The service uses an Authorization header.",
    "GOOGLE_APPLICATION_CREDENTIALS is set outside the handover.",
    "The client_secret value was intentionally omitted.",
    "The endpoint expects bearer credentials; the token is not carried here.",
    "Login returns a JWT; the value is not carried here.",
    "The signing key is a PEM private key held in the platform's secret manager.",
    "Run `soil save --project orchard`; SOIL_HOME selects the store and PORT defaults to 3000.",
    "Send it as `Authorization: Bearer <token>`, or as `Authorization: Bearer $TOKEN`.",
    "The config template ships client_secret=YOUR_CLIENT_SECRET.",
    "Initialised /home/ada/.soil-server, and the container mounts /home/agent/.soil.",
    "The URL is documented as postgres://app:password@db.internal:5432/app.",
    "See src/checkout/window.ts and https://example.com/docs",
  ];

  for (const text of safeCases) {
    const doc = normalizeHandover({
      handoverId: A_VALID_ID,
      projectId: "scan",
      title: "Scan",
      createdAt: A_CAPTURE_TIME,
      sections: { architecture: text },
    });
    const result = validateHandover(doc);
    suite.check(
      "safety",
      result.valid,
      `naming a credential type, header, environment variable, flag or documented placeholder must stay valid, refused: ${result.issues
        .map((issue) => `${issue.path} ${issue.kind}`)
        .join(", ")}`,
    );
  }
}

/** 3: what models actually emit becomes a document. */
function checkNormalization(suite: Suite): void {
  const modelReply = [
    "Sure, here is the save:",
    "",
    "```json",
    JSON.stringify({
      projectId: "loose-shape",
      title: "A reply in the rescue shape",
      createdAt: A_CAPTURE_TIME,
      extractionSections: {
        projectIdentity: "A project that exists only to test the loose shape.",
        decisions: { status: "available", summary: "One decision was made." },
        blockers: { status: "missing", summary: null },
      },
    }),
    "```",
    "",
    "Let me know if you want anything changed.",
  ].join("\n");

  const json = extractJsonBlock(modelReply);
  suite.check(
    "normalization",
    json !== undefined,
    "a fenced JSON block inside prose should be extracted",
  );

  const doc = normalizeHandover(JSON.parse(json ?? "{}"));

  // Normalization is not a writer, so the id is still absent here. The only
  // thing standing between this reply and validity must be the id the writer
  // assigns at store time.
  const beforeId = validateHandover(doc);
  suite.check(
    "normalization",
    !beforeId.valid &&
      beforeId.issues.length === 1 &&
      beforeId.issues[0]?.path === "/handoverId",
    `a normalized reply should be one writer-assigned id away from valid, got: ${beforeId.issues
      .map((i) => `${i.path} ${i.message}`)
      .join("; ")}`,
  );

  const result = validateHandover({ ...doc, handoverId: A_VALID_ID });
  suite.check(
    "normalization",
    result.valid,
    `a normalized rescue-shaped reply should be valid once identified, got: ${result.issues
      .map((i) => `${i.path} ${i.message}`)
      .join("; ")}`,
  );
  suite.check(
    "normalization",
    Object.keys(doc.sections).length === 17,
    "normalization should declare all 17 sections",
  );
  suite.check(
    "normalization",
    doc.sections.projectIdentity.status === "available",
    "a bare string section should become an available section",
  );
  suite.check(
    "normalization",
    doc.sections.workflow.status === "missing",
    "a section the model never wrote should be recorded as missing, not invented",
  );
  suite.check(
    "normalization",
    RESCUE_PROMPT.includes("extractionSections"),
    "the rescue prompt should ask for the shape normalization accepts",
  );

  // An unrecognised status, wrong capitalisation included, must reach
  // `validate` and be refused there. Silently rewriting it to `available`
  // would turn a typo into content that counts as captured.
  for (const wrong of [
    "Available",
    "AVAILABLE",
    "partial",
    "notApplicable",
    "not applicable",
    "NOT_APPLICABLE",
  ]) {
    const written = normalizeHandover({
      handoverId: A_VALID_ID,
      projectId: "status",
      title: "Status",
      createdAt: A_CAPTURE_TIME,
      sections: { decisions: { status: wrong, summary: "One decision." } },
    });
    suite.check(
      "normalization",
      (written.sections.decisions.status as string) === wrong,
      `normalization must keep the unrecognised status "${wrong}" rather than rewrite it`,
    );
    const result = validateHandover(written);
    suite.check(
      "normalization",
      !result.valid &&
        result.issues.some(
          (issue) =>
            issue.path === "/sections/decisions/status" &&
            issue.kind === "structure",
        ),
      `an unrecognised status "${wrong}" must be refused at /sections/decisions/status`,
    );
  }
}

/**
 * The closed-world contract, and the one invariant that follows from it:
 * a save path and a validation of the same bytes give the same verdict.
 *
 * Version one is closed. The top-level field set, the section field set and
 * the eleven provenance labels are fixed, and a reader refuses anything
 * outside them. A normalizing implementation therefore may not delete unknown
 * content to make a document acceptable, because then the same bytes are
 * rejected by `validate` and accepted by `save`. It may not invent the facts a
 * reader depends on either: the capture time, the recipe attribution and the
 * declared version are all claims only their real author is in a position to
 * make.
 */
function checkClosedWorld(suite: Suite): void {
  const canonical = readJson(
    fixturePath("valid/version-exactly-supported.json"),
  ) as Record<string, unknown>;

  // Support is a set of exact versions, not a pattern over the 1.x line.
  suite.check(
    "closed-world",
    validateHandover(canonical).valid,
    "a document at exactly the supported version must validate",
  );
  for (const unsupported of ["0.9", "1.1", "1.10", "2.0", "1", "1.0.0", ""]) {
    const result = validateHandover({
      ...canonical,
      soilHandover: unsupported,
    });
    suite.check(
      "closed-world",
      !result.valid &&
        result.issues.some((issue) => issue.path === "/soilHandover"),
      `an unsupported format version "${unsupported}" must be refused at /soilHandover, never inferred from the shape of the string`,
    );
  }

  // Unknown content survives normalization and is refused by validation, at
  // the path it actually occupies.
  const unknownContent: readonly (readonly [string, unknown, string])[] = [
    ["an unknown top-level field", { ...canonical, grade: 0.92 }, "/grade"],
    [
      "an unknown field on a section",
      {
        ...canonical,
        sections: {
          ...(canonical["sections"] as Record<string, unknown>),
          decisions: { status: "missing", summary: null, confidence: 0.4 },
        },
      },
      "/sections/decisions/confidence",
    ],
    [
      "an unknown section key",
      {
        ...canonical,
        sections: {
          ...(canonical["sections"] as Record<string, unknown>),
          vibes: { status: "available", summary: "Good." },
        },
      },
      "/sections/vibes",
    ],
    [
      "a provenance label outside the eleven",
      {
        ...canonical,
        sections: {
          ...(canonical["sections"] as Record<string, unknown>),
          decisions: {
            status: "available",
            summary: "One.",
            provenance: ["repo_verified", "vibe_checked"],
          },
        },
      },
      "/sections/decisions/provenance/1",
    ],
    [
      "an unknown member of source",
      { ...canonical, source: { client: "a-tool", temperature: 0.7 } },
      "/source/temperature",
    ],
  ];

  for (const [what, document, path] of unknownContent) {
    const direct = validateHandover(document);
    const throughNormalization = validateHandover(normalizeHandover(document));
    suite.check(
      "closed-world",
      !direct.valid && direct.issues.some((issue) => issue.path === path),
      `${what} must be refused at ${path}`,
    );
    suite.check(
      "closed-world",
      !throughNormalization.valid &&
        throughNormalization.issues.some((issue) => issue.path === path),
      `${what} must survive normalization and still be refused at ${path}: a save that strips it and a validation that refuses it are two answers about the same bytes`,
    );
  }

  // Nothing is invented. Each of these was measured being stamped in.
  const bare = normalizeHandover({
    projectId: "invents-nothing",
    title: "Invents nothing",
  }) as unknown as Record<string, unknown>;
  suite.check(
    "closed-world",
    !("createdAt" in bare),
    "normalization must not supply a createdAt the document does not carry: it is the anchor every frontier section is read against",
  );
  suite.check(
    "closed-world",
    validateHandover({ ...bare, handoverId: A_VALID_ID }).issues.some(
      (issue) => issue.path === "/createdAt",
    ),
    "a document with no createdAt must be refused, not completed",
  );
  suite.check(
    "closed-world",
    !("source" in bare),
    "normalization must not attribute its own recipe to a document it did not produce",
  );

  for (const declared of ["1.7", "2.0", "0.9"]) {
    const carried = normalizeHandover({
      ...canonical,
      soilHandover: declared,
    }) as unknown as Record<string, unknown>;
    suite.check(
      "closed-world",
      carried["soilHandover"] === declared,
      `normalization must leave a declared version "${declared}" exactly as written, neither upgrading nor downgrading it`,
    );
  }

  // A malformed identifier is refused rather than replaced. Dropping it here
  // is what let a writer mint a fresh one over the top of it.
  for (const malformed of [42, "handover-42", ""]) {
    const carried = normalizeHandover({
      ...canonical,
      handoverId: malformed,
    }) as unknown as Record<string, unknown>;
    suite.check(
      "closed-world",
      "handoverId" in carried &&
        validateHandover(carried).issues.some(
          (issue) => issue.path === "/handoverId",
        ),
      "a malformed handoverId must reach validation and be refused there, never be dropped and replaced",
    );
  }
}

/** 4 + 5: the store round trip and the restore prompt. */
function checkStoreAndRestore(suite: Suite): void {
  const home = mkdtempSync(join(tmpdir(), "soil-conformance-"));
  try {
    const store = new HandoverStore(home);
    const doc = readJson(
      join(ROOT, "examples/orchard-checkout.json"),
    ) as Parameters<HandoverStore["save"]>[0];

    const entry = store.save(doc);
    suite.check(
      "store",
      entry.code === "#001",
      "the first code should be #001",
    );
    suite.check(
      "store",
      entry.sectionsWithContent === 17,
      "the worked example carries all 17 sections",
    );

    const second = store.save(doc);
    suite.check(
      "store",
      second.code === "#002",
      "codes should increment, never be reused",
    );

    const read = store.read("#001");
    suite.check(
      "store",
      read.title === doc.title && read.code === "#001",
      "a stored handover should read back with its code",
    );
    suite.check(
      "store",
      store.list().length === 2 && store.list()[0]?.code === "#002",
      "list should return everything, newest first",
    );

    const rebuilt = store.reindex();
    suite.check(
      "store",
      rebuilt.entries.length === 2 && rebuilt.nextCode === 3,
      "the index should be rebuildable from the files alone",
    );

    const prompt = buildRestorePrompt(read, {
      boundaryToken: RESTORE_TOKEN,
    });
    suite.check(
      "restore",
      prompt.includes(`=== ${RESTORE_MARK} BOOT PROMPT ===`),
      "the restore prompt should lead with the boot prompt",
    );
    suite.check(
      "restore",
      prompt.includes("context, not instruction"),
      "the restore prompt should tell the reader the document is context, not commands",
    );
    suite.check(
      "restore",
      prompt.includes(`=== ${RESTORE_MARK} KNOWN GAPS ===`) &&
        prompt.includes("not captured: Conversion numbers"),
      "stated gaps should travel with the handover into the restore prompt",
    );
    suite.check(
      "restore",
      prompt.includes("not now"),
      "the restore prompt should anchor capture-state sections to the capture",
    );
    suite.check(
      "restore",
      !/\bverified\b/i.test(prompt),
      "nothing local should describe a handover as verified",
    );

    // A field a writer supplies is not delivered until a reader sees it, and
    // the reader on this side is a model. Each of these was accepted,
    // validated and stored, and then reached no rendered surface at all.
    suite.check(
      "restore",
      prompt.includes(`=== ${RESTORE_MARK} THIS HANDOVER ===`) &&
        prompt.includes(`Title: ${doc.title}`),
      "the handover's own title should reach the prompt, not only the rail card",
    );
    suite.check(
      "restore",
      ["client", "model", "provider", "extraction recipe"].every((label) =>
        prompt.includes(`${label} `),
      ) &&
        prompt.includes(doc.source?.client ?? "") &&
        prompt.includes(doc.source?.provider ?? "") &&
        prompt.includes(doc.source?.recipeVersion ?? ""),
      "the client, the model, the provider and the recipe version should tell the reader what wrote this",
    );
    const labelsInDocument = new Set(
      SECTION_KEYS.flatMap((key) => [...(doc.sections[key].provenance ?? [])]),
    );
    suite.check(
      "restore",
      labelsInDocument.size > 0 &&
        prompt.includes(`=== ${RESTORE_MARK} WHERE THE CLAIMS CAME FROM ===`) &&
        [...labelsInDocument].every((label) => prompt.includes(label)),
      "every provenance label the document carries should reach the reader, because provenance is the format's only trust mechanism",
    );

    // A withheld section and an empty one are two different instructions to
    // the reader, and the prompt reported both as the second.
    const withheldDoc = readJson(
      fixturePath("valid/blocked-and-safe.json"),
    ) as Handover;
    const withheldPrompt = buildRestorePrompt(withheldDoc, {
      boundaryToken: RESTORE_TOKEN,
    });
    const withheldKeys = SECTION_KEYS.filter(
      (key) => withheldDoc.sections[key].status === "blocked",
    );
    const emptyLine =
      withheldPrompt
        .split("\n")
        .find((candidate) =>
          candidate.startsWith("Sections with nothing in them"),
        ) ?? "";
    suite.check(
      "restore",
      withheldKeys.length > 0 &&
        withheldKeys.every(
          (key) =>
            !emptyLine.includes(SECTION_LABELS[key]) &&
            withheldPrompt.includes(`withheld from ${SECTION_LABELS[key]}`),
        ),
      "a withheld section should be named as withheld rather than counted among the empty ones",
    );
    suite.check(
      "restore",
      withheldKeys.every((key) => {
        const note = withheldDoc.sections[key].summary ?? "";
        return note.length === 0 || withheldPrompt.includes(note.slice(0, 40));
      }),
      "the note a writer left on a withheld section should travel to the reader",
    );

    const mcpSave = callTool(
      "soil_save",
      {
        projectId: "mcp-round-trip",
        title: "Saved through the MCP surface",
        sections: { executiveSummary: "A save made by a tool call." },
      },
      store,
      new Date("2026-07-22T12:00:00Z"),
    );
    const savedText = mcpSave.content[0]?.text ?? "";
    suite.check(
      "mcp",
      savedText.includes("#003") && savedText.includes("1 of 17"),
      "soil_save should report the code and the honest section count",
    );

    const mcpLoad = callTool("soil_load", { code: "#003" }, store);
    suite.check(
      "mcp",
      (mcpLoad.content[0]?.text ?? "").includes("mcp-round-trip"),
      "soil_load should return the restore prompt for the requested code",
    );
    suite.check(
      "mcp",
      (callTool("soil_list", {}, store).content[0]?.text ?? "").includes(
        "#003",
      ),
      "soil_list should list what was saved",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * 5b: the restore-prompt boundary, on adversarial documents.
 *
 * Every fixture in the manifest's `restore` list is a VALID handover whose
 * content is written to be mistaken for the rendered prompt's own structure.
 * The rule in spec/restore-prompt.md is that content cannot be mistaken for
 * structure, and it is checked here as three outcomes rather than as a
 * mechanism:
 *
 *   a. every line a reader could take for structure carries this render's
 *      marker, so a forged banner or heading anywhere in the content, or a
 *      line break smuggled through a value interpolated inside a sentence,
 *      shows up as a violation;
 *   b. after the first structural line, a line carrying the marker is either a
 *      structural line or is visibly escaped, so content cannot borrow the
 *      marker even when it names it;
 *   c. the escaping is reversible: removing one leading backslash from each
 *      line of a section's rendered block returns the section's summary, byte
 *      for byte. An escape that mangles some inputs has traded one ambiguity
 *      for another.
 *
 * What is NOT checked, because it is not what the boundary claims: that
 * instruction-shaped text is absent. It travels on purpose.
 */
function checkRestoreBoundary(suite: Suite): void {
  const manifest = loadManifest();
  const token = RESTORE_TOKEN;
  const mark = RESTORE_MARK;
  const bannerLine = new RegExp(`^=== ${mark} .+ ===$`);
  const headingLine = new RegExp(`^## ${mark} .+$`);
  const structureShaped = /^\s*(?:===|##)/;
  const unescapeLine = (line: string): string =>
    line.startsWith("\\") ? line.slice(1) : line;

  for (const entry of manifest.restore) {
    const doc = readJson(fixturePath(entry.file)) as Handover;

    suite.check(
      "restore",
      validateHandover(doc).valid,
      `${entry.name}: an adversarial fixture must be a valid handover, or it is testing the validator instead`,
    );

    const prompt = buildRestorePrompt(doc, { boundaryToken: token });
    const lines = prompt.split("\n");

    const unmarked = lines.filter(
      (line) => structureShaped.test(line) && !line.includes(mark),
    );
    suite.check(
      "restore",
      unmarked.length === 0,
      `${entry.name}: ${unmarked.length} line(s) read as structure without this render's marker, the first being ${JSON.stringify(unmarked[0] ?? "")}`,
    );

    const firstStructural = lines.findIndex((line) => bannerLine.test(line));
    const borrowed = lines
      .slice(firstStructural + 1)
      .filter(
        (line) =>
          line.includes(mark) &&
          !bannerLine.test(line) &&
          !headingLine.test(line) &&
          !line.startsWith("\\"),
      );
    suite.check(
      "restore",
      borrowed.length === 0,
      `${entry.name}: ${borrowed.length} content line(s) carry the marker unescaped, the first being ${JSON.stringify(borrowed[0] ?? "")}`,
    );

    for (const key of SECTION_KEYS) {
      const section = doc.sections[key];
      if (section.status !== "available" || !section.summary) continue;
      const summary = section.summary;
      const anchor =
        key === "restoreInstructions"
          ? lines.indexOf(`=== ${mark} BOOT PROMPT ===`) + 2
          : lines.indexOf(`## ${mark} ${SECTION_LABELS[key]}`) + 1;
      suite.check(
        "restore",
        anchor > 0,
        `${entry.name}: the rendering has no marked heading for ${key}`,
      );
      const block = lines.slice(anchor, anchor + summary.split("\n").length);
      suite.check(
        "restore",
        block.map(unescapeLine).join("\n") === summary,
        `${entry.name}: the rendered block for ${key} does not decode back to the section's summary`,
      );
    }
  }
}

/** 6: identical input, identical bytes. */
function checkDeterminism(suite: Suite): void {
  const doc = readJson(join(ROOT, "examples/orchard-checkout.json")) as never;
  const once = renderSaved(doc, "#001");
  const twice = renderSaved(doc, "#001");
  suite.check(
    "determinism",
    once === twice,
    "the renderer should return identical bytes for identical input",
  );
  suite.check(
    "determinism",
    !/\d+\s*%/.test(once) && !/score/i.test(once),
    "a local save card should report counts, never a score",
  );
}

/**
 * 7: the recipe is complete, its text is byte-identical to the canonical
 * files in `recipes/`, and the recipe version travels with every document
 * the official writers produce.
 */
function checkRecipe(suite: Suite): void {
  const recipeFile = readFileSync(
    join(ROOT, "recipes/handover-recipe-v1.txt"),
    "utf8",
  );
  suite.check(
    "recipe",
    renderRecipe() === recipeFile,
    "the SDK's rendered recipe must be byte-identical to recipes/handover-recipe-v1.txt, the single source of truth",
  );
  const rescueFile = readFileSync(
    join(ROOT, "recipes/rescue-recipe-v1.txt"),
    "utf8",
  );
  suite.check(
    "recipe",
    `${RESCUE_PROMPT}\n` === rescueFile,
    "the SDK's rescue prompt must be byte-identical to recipes/rescue-recipe-v1.txt, the single source of truth",
  );
  suite.check(
    "recipe",
    /^\d+\.\d+\.\d+$/.test(RECIPE_VERSION),
    "the recipe version must be a semver string",
  );

  // The recipe version travels, and it is never invented: an ingestion path is
  // handed a document somebody else wrote, so it may not attribute its own
  // recipe to that document. An input that already states one keeps it, a
  // stored document round-trips it untouched, and a document without one is
  // still valid.
  const unstamped = normalizeHandover({
    projectId: "recipe-version",
    title: "Not stamped",
    createdAt: A_CAPTURE_TIME,
  });
  suite.check(
    "recipe",
    unstamped.source?.recipeVersion === undefined,
    "normalization must not write its own recipeVersion onto a document it did not produce",
  );
  const kept = normalizeHandover({
    projectId: "recipe-version",
    title: "Kept",
    createdAt: A_CAPTURE_TIME,
    source: { recipeVersion: "0.9.9" },
  });
  suite.check(
    "recipe",
    kept.source?.recipeVersion === "0.9.9",
    "an input that already states a recipeVersion must keep it untouched",
  );
  const home = mkdtempSync(join(tmpdir(), "soil-recipe-version-"));
  try {
    const store = new HandoverStore(home);
    const example = readJson(
      join(ROOT, "examples/orchard-checkout.json"),
    ) as Parameters<HandoverStore["save"]>[0];
    const entry = store.save(example);
    suite.check(
      "recipe",
      store.read(entry.code).source?.recipeVersion ===
        example.source?.recipeVersion,
      "a document's recipeVersion must round-trip through the store untouched",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const withoutOne = readJson(
    fixturePath("valid/thin-but-honest.json"),
  ) as Record<string, unknown>;
  suite.check(
    "recipe",
    withoutOne["source"] === undefined && validateHandover(withoutOne).valid,
    "a document without a recipeVersion is still valid: other writers may lack one",
  );

  const recipe = buildRecipe();
  suite.check(
    "recipe",
    SECTION_KEYS.every((key) => (SECTION_GUIDANCE[key]?.length ?? 0) > 200),
    "every one of the 17 sections needs real guidance, not a label",
  );
  suite.check(
    "recipe",
    SHARED_RULES.length === 6,
    "the recipe should carry the opening rule and RULES 1 to 5",
  );
  suite.check(
    "recipe",
    recipe.instructions.length === SHARED_RULES.length + 5,
    "the instruction block should be the rules, the lens, the framing and the close",
  );
  for (const rule of ["RULE 1", "RULE 2", "RULE 3", "RULE 4", "RULE 5"]) {
    suite.check(
      "recipe",
      SHARED_RULES.some((text) => text.startsWith(rule)),
      `${rule} should be present verbatim`,
    );
  }
}

/** 8: the MCP surface is exactly three strict tools. */
function checkMcpSchemas(suite: Suite): void {
  suite.check(
    "mcp",
    TOOLS.length === 3,
    `the local server exposes exactly three tools, found ${TOOLS.length}`,
  );
  const names = TOOLS.map((tool) => tool.name).sort();
  suite.check(
    "mcp",
    names.join(",") === "soil_list,soil_load,soil_save",
    `tool names should be soil_save, soil_load, soil_list, found ${names.join(", ")}`,
  );

  const strict = (schema: unknown, where: string): void => {
    if (typeof schema !== "object" || schema === null) {
      suite.check("mcp", false, `${where}: schema must be an object`);
      return;
    }
    const record = schema as Record<string, unknown>;
    // A union is the loose shape that gets flattened to "no parameters", so
    // it is refused wherever it appears, not only at the top level.
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      suite.check(
        "mcp",
        record[keyword] === undefined,
        `${where}: declares ${keyword}; a union is the shape a client may flatten away`,
      );
    }
    suite.check(
      "mcp",
      !Array.isArray(record["type"]),
      `${where}: declares a list of types, which is a union by another name`,
    );
    // Array items are part of the declared surface: an item schema left open
    // is as flattenable as an open object.
    if (record["items"] !== undefined) strict(record["items"], `${where}[]`);
    if (record["type"] !== "object") return;
    suite.check(
      "mcp",
      record["additionalProperties"] === false,
      `${where}: every object schema needs additionalProperties: false, or a client may flatten it away`,
    );
    suite.check(
      "mcp",
      typeof record["properties"] === "object",
      `${where}: every object schema must declare its properties`,
    );
    const properties = (record["properties"] ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(properties)) {
      strict(value, `${where}.${key}`);
    }
  };

  for (const tool of TOOLS) {
    strict(tool.inputSchema, tool.name);
    suite.check(
      "mcp",
      tool.description.length > 80,
      `${tool.name}: the description is what a model reads before calling it`,
    );
    suite.check(
      "mcp",
      !/\bverif/i.test(tool.description),
      `${tool.name}: a local tool must not claim it checks anything`,
    );
  }

  // The producer surface: what a model can say through the DECLARED schema.
  //
  // The recipe tells a model to mark a section `blocked` when it withheld
  // something for safety, and to label each section's provenance. A tool
  // interface that cannot express either describes a different document than
  // the recipe does, and the interface is the door most callers go through.
  const save = TOOLS.find((tool) => tool.name === "soil_save");
  const saveProperties = (save?.inputSchema["properties"] ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

  for (const group of ["sections", "sectionStatus", "sectionProvenance"]) {
    const declared = Object.keys(
      (saveProperties[group]?.["properties"] ?? {}) as Record<string, unknown>,
    );
    suite.check(
      "mcp",
      SECTION_KEYS.every((key) => declared.includes(key)) &&
        declared.length === SECTION_KEYS.length,
      `soil_save.${group} must declare all 17 section keys, declared ${declared.length}`,
    );
  }

  const statuses = (saveProperties["sectionStatus"]?.["properties"] ??
    {}) as Record<string, { enum?: unknown }>;
  suite.check(
    "mcp",
    SECTION_KEYS.every(
      (key) =>
        JSON.stringify(statuses[key]?.enum) ===
        JSON.stringify([...SECTION_STATUSES]),
    ),
    "soil_save must let a producer set every permitted section status, blocked included",
  );

  const provenance = (saveProperties["sectionProvenance"]?.["properties"] ??
    {}) as Record<string, { items?: { enum?: unknown } }>;
  suite.check(
    "mcp",
    SECTION_KEYS.every(
      (key) =>
        JSON.stringify(provenance[key]?.items?.enum) ===
        JSON.stringify([...PROVENANCE_LABELS]),
    ),
    "soil_save must let a producer set every normative provenance label on every section",
  );

  checkProducerContract(suite, save?.inputSchema);
  checkDeclaredStrictnessIsEnforced(suite);
  checkRequiredMembersArePresent(suite);
  checkStatedValuesAreNotDiscarded(suite);
  checkSectionSummaryNarrowing(suite, save?.inputSchema);
}

/**
 * How each member of the published document schema is said through
 * `soil_save`'s declared input schema.
 *
 * A tool-schema path, dotted, with `[]` for an array's items. `null` means no
 * producer says this member: the writer assigns it, and the reason is on the
 * entry.
 *
 * This map is the one place where the format's members and the producer
 * surface's arguments are put side by side, and the check below holds it to
 * both. It replaced a list of three property names, which was a list of the
 * things somebody had thought to look at: `source.recipeVersion` was reachable
 * through neither tool schema for as long as it existed, while the recipe's own
 * closing instruction ordered every model to emit it and the validator already
 * had a rule for its shape. Three names cannot see a missing fourth. A map that
 * must account for every member can, and a new member cannot enter the format
 * without a visible decision here about how a producer states it.
 */
const EXPRESSED_THROUGH_SOIL_SAVE: Readonly<Record<string, string | null>> = {
  soilHandover: "soilHandover",
  projectId: "projectId",
  title: "title",
  // Assigned by the writer, never taken from a caller. An id a model invents is
  // an id two documents can share, and a load code is the store's address for a
  // document rather than anything about it.
  handoverId: null,
  code: null,
  // Also the writer's. This tool IS the capturing writer: the content is being
  // handed over in the call that is running now, so its own clock is a true
  // statement about when the capture happened, and a caller-stated time would
  // not be. The recipe asks a model for `createdAt` because the recipe is also
  // pasted into the command-line door, where the document is written at a time
  // only the model knows.
  createdAt: null,
  "source/client": "source.client",
  "source/model": "source.model",
  "source/provider": "source.provider",
  "source/recipeVersion": "source.recipeVersion",
  "quality/missingInputs": "quality.missingInputs",
  "quality/contradictions": "quality.contradictions",
  "safety/unsafeOmissions": "safety.unsafeOmissions",
  "observations/kind": "observations[].kind",
  "observations/data": "observations[].data",
  // The attribution is the recording writer's statement about itself, so the
  // schema does not take it from a caller: a producer name a caller supplies is
  // a claim about somebody else that nothing here can check.
  "observations/producedBy": null,
  "observations/producedAt": null,
  // The three parallel objects, keyed by the same 17 section keys, are how one
  // section's three parts are said without a union. Filled in below, one entry
  // per section key, from SECTION_KEYS rather than by hand.
  ...Object.fromEntries(
    SECTION_KEYS.flatMap((key) => [
      [`sections/${key}/summary`, `sections.${key}`],
      [`sections/${key}/status`, `sectionStatus.${key}`],
      [`sections/${key}/provenance`, `sectionProvenance.${key}`],
    ]),
  ),
};

/**
 * The `soil_save` arguments that are not document members: the ones this surface
 * translates into one. Named here so the check below can hold the OTHER
 * direction too, which the map alone cannot see.
 *
 * The map above asks whether every member of the format can be said. This asks
 * whether everything the tool lets a caller say goes anywhere. An argument that
 * is neither a document member nor a translation is an argument a caller can
 * fill and a store will never hold, which is the same silent loss read from the
 * other end.
 */
const TRANSLATED_SAVE_ARGUMENTS = Object.freeze([
  "sections",
  "sectionStatus",
  "sectionProvenance",
  "observations",
  "workingStyle",
]);

/** The members above that no producer states, so the writer must supply them. */
const WRITER_ASSIGNED = Object.freeze([
  "code",
  "createdAt",
  "handoverId",
  "observations/producedAt",
  "observations/producedBy",
]);

/**
 * Every content-carrying member of the published document schema, as a path.
 *
 * Containers are structure rather than content, so `source`, `sections`,
 * `sections/<key>`, `quality`, `safety` and `observations` are walked through
 * and not emitted: what a producer has to be able to state is what they hold.
 * `$ref` is resolved against `$defs`, which is the only reference form the
 * published schema uses.
 */
function documentMemberPaths(schema: unknown): string[] {
  const root = schema as {
    properties?: Record<string, unknown>;
    $defs?: Record<string, unknown>;
  };
  const defs = root.$defs ?? {};

  const resolve = (node: unknown): Record<string, unknown> => {
    let current = node as Record<string, unknown>;
    let hops = 0;
    while (typeof current?.["$ref"] === "string" && hops < 8) {
      const ref = current["$ref"] as string;
      const name = ref.replace("#/$defs/", "");
      current = (defs[name] ?? {}) as Record<string, unknown>;
      hops += 1;
    }
    return current ?? {};
  };

  const paths: string[] = [];
  const walk = (node: unknown, at: string): void => {
    const here = resolve(node);
    const properties = here["properties"];
    if (
      here["type"] === "object" &&
      typeof properties === "object" &&
      properties !== null
    ) {
      for (const [key, child] of Object.entries(
        properties as Record<string, unknown>,
      )) {
        walk(child, at === "" ? key : `${at}/${key}`);
      }
      return;
    }
    // An array whose entries are objects is a container too: `observations` is
    // structure and an observation's members are the content. An array of
    // scalars, such as a note list or a provenance list, is the content.
    if (here["type"] === "array") {
      const items = resolve(here["items"]);
      if (items["type"] === "object" && items["properties"] !== undefined) {
        walk(items, at);
        return;
      }
    }
    paths.push(at);
  };

  walk({ type: "object", properties: root.properties ?? {} }, "");
  return paths.sort();
}

/** Resolve a dotted tool-schema path, or `undefined` when it is undeclared. */
function declaredInToolSchema(schema: unknown, path: string): unknown {
  let node: unknown = schema;
  for (const step of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    const record = node as Record<string, unknown>;
    const wantsItems = step.endsWith("[]");
    const name = wantsItems ? step.slice(0, -2) : step;
    const properties = record["properties"];
    if (typeof properties !== "object" || properties === null) return undefined;
    const bag = properties as Record<string, unknown>;
    if (!Object.hasOwn(bag, name)) return undefined;
    node = bag[name];
    if (wantsItems) {
      if (typeof node !== "object" || node === null) return undefined;
      node = (node as Record<string, unknown>)["items"];
    }
  }
  return node;
}

/**
 * The field names the recipe's closing instruction orders a model to write.
 *
 * Read out of the recipe text rather than copied from it, so a recipe that
 * starts asking for a new field is a failing check until the producer surface
 * can express it. The span is bounded by two phrases in the instruction because
 * the recipe also contains a fenced code marker, and a run of three backticks
 * makes a naive scan of the whole file pair the wrong delimiters.
 */
function recipeInstructedFields(recipe: string): string[] {
  const open = "top-level keys and no others";
  const close = "THE STATUS WORDS";
  const from = recipe.indexOf(open);
  const to = recipe.indexOf(close, from);
  if (from < 0 || to <= from) return [];
  const span = recipe.slice(from + open.length, to);
  const tick = String.fromCharCode(96);
  const names = [
    ...span.matchAll(new RegExp(`${tick}([A-Za-z][A-Za-z0-9]*)${tick}`, "g")),
  ].map((match) => match[1] as string);
  return [...new Set(names)].sort();
}

/**
 * The producer contract: the whole document the recipe asks a model to write is
 * sayable through the tool schema, and nothing in the format has been left
 * without a way to say it.
 *
 * Three assertions, in the order a gap would appear. The format's members must
 * all be accounted for; each accounted member must actually resolve in the tool
 * schema; and the fields the recipe names must all be accounted for too. Any one
 * of the three failing means the recipe and the interface describe different
 * documents, and the interface is the door most callers go through.
 */
function checkProducerContract(suite: Suite, saveSchema: unknown): void {
  const declared = documentMemberPaths(
    readJson(join(ROOT, "spec/handover.schema.json")),
  );
  const accounted = Object.keys(EXPRESSED_THROUGH_SOIL_SAVE).sort();
  const unaccounted = declared.filter((path) => !accounted.includes(path));
  const stale = accounted.filter((path) => !declared.includes(path));
  suite.check(
    "mcp",
    unaccounted.length === 0,
    `every member of the published document schema needs a stated way for a producer to say it; unaccounted: ${
      unaccounted.join(", ") || "none"
    }`,
  );
  suite.check(
    "mcp",
    stale.length === 0,
    `the producer map must not name members the format does not have; stale: ${
      stale.join(", ") || "none"
    }`,
  );

  for (const [member, path] of Object.entries(EXPRESSED_THROUGH_SOIL_SAVE)) {
    if (path === null) continue;
    suite.check(
      "mcp",
      declaredInToolSchema(saveSchema, path) !== undefined,
      `soil_save must declare ${path} so a producer can state /${member}: the producer path has to express the whole document the recipe asks for`,
    );
  }

  suite.check(
    "mcp",
    Object.entries(EXPRESSED_THROUGH_SOIL_SAVE)
      .filter(([, path]) => path === null)
      .map(([member]) => member)
      .sort()
      .join(",") === [...WRITER_ASSIGNED].sort().join(","),
    "only the writer-assigned members may lack a producer path, so a missing argument cannot be discharged by declaring nobody states it",
  );

  // The other direction: every root argument the tool offers a caller has to go
  // somewhere. A document member reaches the store, a translated argument is
  // turned into one, and anything else is a field a caller can fill for nothing.
  const documentRoots = Object.keys(
    (
      readJson(join(ROOT, "spec/handover.schema.json")) as {
        properties: Record<string, unknown>;
      }
    ).properties,
  );
  const saveArguments = Object.keys(
    ((saveSchema as { properties?: Record<string, unknown> })?.properties ??
      {}) as Record<string, unknown>,
  );
  const goNowhere = saveArguments.filter(
    (name) =>
      !documentRoots.includes(name) &&
      !TRANSLATED_SAVE_ARGUMENTS.includes(name),
  );
  suite.check(
    "mcp",
    goNowhere.length === 0,
    `every soil_save argument must reach the document or be translated into one; goes nowhere: ${
      goNowhere.join(", ") || "none"
    }`,
  );

  const instructed = recipeInstructedFields(
    readFileSync(join(ROOT, "recipes/handover-recipe-v1.txt"), "utf8"),
  );
  suite.check(
    "mcp",
    instructed.length >= 8,
    `the recipe's closing instruction must be readable, found ${instructed.length} field names; if it was reworded, the phrases this reads it by have to move with it`,
  );
  // Every segment, not only the last one: the recipe names the containers as
  // well as what they hold, and `source` is a field the recipe instructs a model
  // to write just as much as `source.recipeVersion` is. A name the format has
  // nowhere is a name the map has not accounted for, and the two checks above
  // then carry it the rest of the way to the tool schema.
  const namesInFormat = new Set(
    accounted.flatMap((member) => member.split("/")),
  );
  const unaccountedByRecipe = instructed.filter(
    (field) => !namesInFormat.has(field),
  );
  suite.check(
    "mcp",
    unaccountedByRecipe.length === 0,
    `every field the recipe instructs a model to write must be accounted for above; unaccounted: ${
      unaccountedByRecipe.join(", ") || "none"
    }`,
  );
}

/**
 * `additionalProperties: false` is enforced, not merely advertised.
 *
 * The schema in `tools/list` is a promise about what this surface accepts, and
 * for a while only one side kept it: a member outside the schema was accepted,
 * dropped, and answered with a load code, so a model that guessed a field name
 * lost its content and was told it succeeded. A caller sending junk being
 * refused is the point; the check is that it is refused AT ALL, with the path it
 * stated, and that nothing is stored.
 *
 * The same content through the command-line door has always been refused this
 * way. Two doors giving two answers about the same content is what made this
 * worth a conformance category rather than a bug fix.
 */
function checkDeclaredStrictnessIsEnforced(suite: Suite): void {
  const home = mkdtempSync(join(tmpdir(), "soil-conformance-strict-"));
  try {
    const store = new HandoverStore(home);
    const legal = {
      projectId: "strictness",
      title: "A legal save",
      sections: { executiveSummary: "A project." },
    };

    const cases: [string, Record<string, unknown>, string][] = [
      [
        "an undeclared root argument",
        { ...legal, totallyUndeclared: "content the caller stated" },
        "/totallyUndeclared",
      ],
      [
        "an undeclared member inside a declared object",
        { ...legal, sections: { ...legal.sections, notASection: "prose" } },
        "/sections/notASection",
      ],
      [
        "an undeclared member inside an array entry",
        {
          ...legal,
          observations: [
            {
              kind: "quality.capture",
              data: [{ name: "note", value: "v" }],
              producedBy: "somebody else",
            },
          ],
        },
        "/observations/0/producedBy",
      ],
    ];

    for (const [what, args, path] of cases) {
      const result = callTool("soil_save", args, store, new Date());
      const body = result.content[0]?.text ?? "";
      suite.check(
        "mcp",
        result.isError === true,
        `soil_save must refuse ${what} rather than drop it and report success`,
      );
      suite.check(
        "mcp",
        body.includes(`${path} is not a field of this object`),
        `the refusal of ${what} must name ${path}, in the same words the command-line door uses`,
      );
    }

    suite.check(
      "mcp",
      store.list().length === 0,
      "a refused call must store nothing at all",
    );

    // The other half of the same rule, in a store of its own so that its verdict
    // does not depend on the cases above: a member the schema DOES declare
    // survives all the way into the stored document. A door that refused
    // everything would pass the checks above and be useless.
    const clean = new HandoverStore(join(home, "clean"));
    const saved = callTool(
      "soil_save",
      {
        ...legal,
        source: {
          client: "conformance",
          model: "none",
          provider: "none",
          recipeVersion: "1.4.2",
        },
      },
      clean,
      new Date(),
    );
    suite.check(
      "mcp",
      saved.isError !== true,
      "a save stating only declared members must succeed",
    );
    const entries = clean.list();
    const stored = entries.length > 0 ? clean.read(entries[0]!.code) : null;
    suite.check(
      "mcp",
      stored?.source?.recipeVersion === "1.4.2",
      "a recipeVersion stated through the declared schema must reach the stored document",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Every path a tool schema's `required` lists, as a slash path with `0` for the
 * first entry of an array.
 *
 * Read off the schema rather than written down, so a member added to a `required`
 * list arrives here on its own and the check below has to account for it. The
 * paths come out in the shape a refusal states them in, which is what lets the
 * two be compared without either side translating.
 */
function requiredPathsInToolSchema(schema: unknown, at: string): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const record = schema as Record<string, unknown>;
  const paths: string[] = [];
  const required = record["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string") {
        paths.push(at === "" ? key : `${at}/${key}`);
      }
    }
  }
  const properties = record["properties"];
  if (typeof properties === "object" && properties !== null) {
    for (const [key, child] of Object.entries(
      properties as Record<string, unknown>,
    )) {
      const here = at === "" ? key : `${at}/${key}`;
      paths.push(...requiredPathsInToolSchema(child, here));
      if (typeof child === "object" && child !== null) {
        const node = child as Record<string, unknown>;
        if (node["type"] === "array") {
          paths.push(...requiredPathsInToolSchema(node["items"], `${here}/0`));
        }
      }
    }
  }
  return paths;
}

/**
 * An otherwise legal call to each tool, with exactly one required member left
 * out, keyed by the path that member would have occupied.
 *
 * One entry per required path, and the check below holds the table to the schema
 * in both directions: a required member with no case here is a member whose
 * absence nobody measured, and a case here for a member the schema does not
 * require is a case about nothing.
 */
function callsMissingOneRequiredMember(): Map<
  string,
  { tool: string; args: Record<string, unknown> }
> {
  const legal = {
    projectId: "requiredness",
    title: "A legal save",
    sections: { executiveSummary: "A project." },
  };
  const withObservation = (data: unknown) => ({
    ...legal,
    observations: [{ kind: "quality.capture", data }],
  });
  const cases = new Map<
    string,
    { tool: string; args: Record<string, unknown> }
  >();
  cases.set("projectId", {
    tool: "soil_save",
    args: { title: legal.title, sections: legal.sections },
  });
  cases.set("title", {
    tool: "soil_save",
    args: { projectId: legal.projectId, sections: legal.sections },
  });
  cases.set("sections", {
    tool: "soil_save",
    args: { projectId: legal.projectId, title: legal.title },
  });
  cases.set("observations/0/kind", {
    tool: "soil_save",
    args: { ...legal, observations: [{ data: [{ name: "n", value: "v" }] }] },
  });
  cases.set("observations/0/data", {
    tool: "soil_save",
    args: { ...legal, observations: [{ kind: "quality.capture" }] },
  });
  cases.set("observations/0/data/0/name", {
    tool: "soil_save",
    args: withObservation([{ value: "v" }]),
  });
  cases.set("observations/0/data/0/value", {
    tool: "soil_save",
    args: withObservation([{ name: "n" }]),
  });
  return cases;
}

/**
 * A member the schema declares as required must be present.
 *
 * The mirror of the rule above, and for a while only one half of it held. The
 * schema said `required` and nobody read it: `soil_save` with no `sections` at all
 * stored a document with every one of the 17 a gap and answered with a load code,
 * which is what a client that flattened this schema sends. `required` in
 * `tools/list` is the same kind of promise as `additionalProperties: false`, and a
 * promise only one party keeps is not one.
 *
 * WHICH DOOR ANSWERS IS NOT PART OF THE CLAIM. A required member that travels
 * into the document is refused by the validator at its own path; one this surface
 * reads and turns into something else is refused by the surface, because nothing
 * downstream can see it. What the contract says is that the absence is refused,
 * with the path named and nothing stored, so the check asks that of every required
 * path the schema publishes and lets each be answered wherever it is answered.
 *
 * The other half is checked with it, and it is the half that keeps the first one
 * honest. A required container stated and EMPTY is a caller saying it had nothing,
 * which this format is built to store and pins in a fixture of its own. If
 * refusing an absence ever started refusing an empty statement too, the rule would
 * have become a rule against saying you had nothing, and that is what teaches a
 * model to pad.
 */
function checkRequiredMembersArePresent(suite: Suite): void {
  const declared = new Set(
    TOOLS.flatMap((tool) => requiredPathsInToolSchema(tool.inputSchema, "")),
  );
  const cases = callsMissingOneRequiredMember();
  const unmeasured = [...declared].filter((path) => !cases.has(path)).sort();
  const stale = [...cases.keys()].filter((path) => !declared.has(path)).sort();
  suite.check(
    "mcp",
    unmeasured.length === 0,
    `every required member of a tool schema needs a case that leaves it out; unmeasured: ${
      unmeasured.join(", ") || "none"
    }`,
  );
  suite.check(
    "mcp",
    stale.length === 0,
    `a case must name a member the schema actually requires; stale: ${
      stale.join(", ") || "none"
    }`,
  );

  const home = mkdtempSync(join(tmpdir(), "soil-conformance-required-"));
  try {
    let index = 0;
    for (const [path, { tool, args }] of cases) {
      // One store per case, so no verdict rests on another's leftovers.
      const store = new HandoverStore(join(home, `absent-${index}`));
      index += 1;
      const result = callTool(tool, args, store, new Date());
      const body = result.content[0]?.text ?? "";
      suite.check(
        "mcp",
        result.isError === true,
        `${tool} must refuse a call that leaves out the required /${path} rather than filling it in and reporting success`,
      );
      suite.check(
        "mcp",
        body.includes(`/${path} is required`),
        `the refusal must name /${path} as required, so the caller learns which member to state`,
      );
      suite.check(
        "mcp",
        store.list().length === 0,
        `a call refused for the absent /${path} must store nothing at all`,
      );
    }

    // The other half. An empty statement is not an absence, and both of the
    // required members this surface answers for itself can be stated empty.
    const legal = {
      projectId: "requiredness",
      title: "A legal save",
      sections: { executiveSummary: "A project." },
    };
    const empty: [string, Record<string, unknown>][] = [
      ["sections", { ...legal, sections: {} }],
      [
        "observations/0/data",
        {
          ...legal,
          observations: [{ kind: "quality.capture", data: [] }],
        },
      ],
    ];
    empty.forEach(([path, args], position) => {
      const store = new HandoverStore(join(home, `empty-${position}`));
      const result = callTool("soil_save", args, store, new Date());
      suite.check(
        "mcp",
        result.isError !== true && store.list().length === 1,
        `stating /${path} empty is a statement and must be stored: refusing it would make the rule above a rule against saying you had nothing`,
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * A stated value the surface cannot carry is refused, or reported, and never
 * both accepted and dropped in silence.
 *
 * Membership was the first half of the rule and this is the second. Declaring a
 * member and then discarding what a caller put in it is the same loss as
 * accepting an undeclared one, read one step further in, and it is worse where
 * the argument is one the surface READS rather than carries: those never reach
 * the validator, so nothing downstream can catch them. A whole capture stated as
 * one string became seventeen empty sections and a load code. An observation
 * entry that was not an object vanished; a payload field whose name was not text
 * vanished from inside an entry that was still stored, which reads to every later
 * reader as an observation its producer wrote empty. A load code that was not
 * text became "last", so a caller asking for one document was handed another.
 *
 * Which answer each case gets is part of the contract, not an implementation
 * choice, so both are checked. Content that cannot be carried is REFUSED, with
 * the path the caller stated and an empty store. An optional extra that was
 * dropped by a documented fail-soft rule is REPORTED: the save succeeds, and the
 * receipt names the path that did not travel, because a save that stored none of
 * what was sent and said nothing is the one answer this surface must never give.
 */
function checkStatedValuesAreNotDiscarded(suite: Suite): void {
  const home = mkdtempSync(join(tmpdir(), "soil-conformance-discard-"));
  try {
    const legal = {
      projectId: "discarded",
      title: "A legal save",
      sections: { executiveSummary: "A project." },
    };

    // Refused: the caller stated content this surface reads itself and cannot
    // store in that shape. Each gets its own store, so one verdict cannot rest
    // on another's leftovers.
    const refused: [string, Record<string, unknown>, string][] = [
      [
        "a whole capture stated as one string instead of the section object",
        { ...legal, sections: "Everything I know about this project." },
        "/sections",
      ],
      [
        "a section status object stated as a bare word",
        { ...legal, sectionStatus: "available" },
        "/sectionStatus",
      ],
      [
        "an observation entry that is not an object",
        { ...legal, observations: ["a note as a bare string"] },
        "/observations/0",
      ],
      [
        "a payload field name that is not text",
        {
          ...legal,
          observations: [
            { kind: "quality.capture", data: [{ name: 7, value: "a value" }] },
          ],
        },
        "/observations/0/data/0/name",
      ],
      [
        "two payload fields stated under one name",
        {
          ...legal,
          observations: [
            {
              kind: "quality.capture",
              data: [
                { name: "note", value: "the first value" },
                { name: "note", value: "the second value" },
              ],
            },
          ],
        },
        "/observations/0/data/1/name",
      ],
    ];

    refused.forEach(([what, args, path], index) => {
      const store = new HandoverStore(join(home, `refused-${index}`));
      const result = callTool("soil_save", args, store, new Date());
      const body = result.content[0]?.text ?? "";
      suite.check(
        "mcp",
        result.isError === true,
        `soil_save must refuse ${what} rather than discard it and report success`,
      );
      suite.check(
        "mcp",
        body.includes(path),
        `the refusal of ${what} must name ${path}, the path the caller stated it under`,
      );
      suite.check(
        "mcp",
        store.list().length === 0,
        `a save refused for ${what} must store nothing at all`,
      );
    });

    // Refused on the read side too, and this one has no store to check: the
    // damage is answering with a document nobody asked for.
    const reading = new HandoverStore(join(home, "reading"));
    for (const title of ["The older handover", "The newer handover"]) {
      callTool(
        "soil_save",
        { ...legal, title, sections: { executiveSummary: `About ${title}.` } },
        reading,
        new Date(),
      );
    }
    const badCode = callTool("soil_load", { code: 1 }, reading, new Date());
    const badCodeBody = badCode.content[0]?.text ?? "";
    suite.check(
      "mcp",
      badCode.isError === true && badCodeBody.includes("/code"),
      "soil_load must refuse a stated code that is not text, at /code, rather than reading it as a request for the newest handover",
    );
    suite.check(
      "mcp",
      !badCodeBody.includes("The newer handover"),
      "a refused soil_load must not answer with a handover the caller did not ask for",
    );
    const noCode = callTool("soil_load", {}, reading, new Date());
    suite.check(
      "mcp",
      noCode.isError !== true &&
        (noCode.content[0]?.text ?? "").includes("The newer handover"),
      "an ABSENT code still means the most recent handover: refusing a malformed value must not take the documented default with it",
    );

    // Reported: an optional extra dropped by a documented fail-soft rule. The
    // save succeeds and the receipt names what did not travel. Dropping rather
    // than shortening is the right call, and saying nothing about it was not.
    const soft = new HandoverStore(join(home, "reported"));
    const reported = callTool(
      "soil_save",
      { ...legal, workingStyle: { blocker: "x".repeat(4000) } },
      soft,
      new Date(),
    );
    const reportedBody = reported.content[0]?.text ?? "";
    suite.check(
      "mcp",
      reported.isError !== true && soft.list().length === 1,
      "a working-style answer that cannot be recorded must not cost the caller the save: it is optional and documented fail-soft",
    );
    suite.check(
      "mcp",
      reportedBody.includes("/workingStyle/blocker"),
      "a save that dropped a stated working-style answer must name it at the path the caller stated it under",
    );
    // The store is read only if the save reached it. An implementation that
    // refused this call has already failed the check above, and this suite
    // reports what failed rather than stopping on the first one, so it must not
    // fall over reading a document that was never written.
    const softEntry = soft.list()[0];
    const stored =
      softEntry === undefined ? undefined : soft.read(softEntry.code);
    suite.check(
      "mcp",
      stored !== undefined && stored.observations === undefined,
      "a dropped working-style answer must be dropped rather than shortened: a cut recorded instance would be a different statement",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * The one place the document schema and the tool schema deliberately disagree,
 * recorded here rather than left for somebody to find.
 *
 * A section summary is a string OR null in the published document schema, and a
 * string in the tool schema. The narrowing is kept on purpose: the only way to
 * widen it in a tool schema is `type: ["string", "null"]` or an `anyOf`, and both
 * are refused a few checks above, because a union is the shape a client may
 * flatten into "no parameters" and take a whole save's content with it. A
 * producer loses nothing by it, because the two ways of saying a section holds
 * nothing reach the store as the same document, and that equivalence is what
 * makes the narrowing safe rather than merely convenient. So the check holds all
 * three facts at once: the format admits null, the tool narrows it to a string,
 * and the two spellings agree in the store. If any one of them stops being true,
 * the narrowing has become a loss and this fails.
 */
function checkSectionSummaryNarrowing(suite: Suite, saveSchema: unknown): void {
  const documentSummary = (
    readJson(join(ROOT, "spec/handover.schema.json")) as {
      $defs: Record<string, { properties: Record<string, { type: unknown }> }>;
    }
  ).$defs["section"]?.properties["summary"]?.type;
  suite.check(
    "mcp",
    JSON.stringify(documentSummary) === JSON.stringify(["string", "null"]),
    `the document schema's section summary should admit a string or null, found ${JSON.stringify(
      documentSummary,
    )}`,
  );

  const toolSummary = declaredInToolSchema(
    saveSchema,
    `sections.${SECTION_KEYS[0]}`,
  ) as { type?: unknown } | undefined;
  suite.check(
    "mcp",
    toolSummary?.type === "string",
    `soil_save narrows a section summary to a string, because a union is the shape a client may flatten away, found ${JSON.stringify(
      toolSummary?.type,
    )}`,
  );

  const home = mkdtempSync(join(tmpdir(), "soil-conformance-null-"));
  try {
    const legal = {
      projectId: "narrowing",
      title: "A legal save",
      sections: { executiveSummary: "A project." },
    };
    const spelt: unknown[] = [];
    // One store per spelling, so both documents are #001 and nothing but the
    // spelling differs.
    [
      { ...legal, sections: { ...legal.sections, decisions: null } },
      legal,
    ].forEach((args, index) => {
      const store = new HandoverStore(join(home, `spelling-${index}`));
      const result = callTool("soil_save", args, store, new Date());
      suite.check(
        "mcp",
        result.isError !== true,
        `stating a section as null must be accepted through soil_save, spelling ${index}`,
      );
      // Read only what was written. A refused save has already failed the check
      // above, and this suite reports every failure rather than stopping on the
      // first, so an absent document becomes a value that cannot match.
      const entry = store.list()[0];
      spelt.push(
        entry === undefined
          ? `nothing was stored for spelling ${index}`
          : store.read(entry.code).sections["decisions"],
      );
    });
    suite.check(
      "mcp",
      JSON.stringify(spelt[0]) === JSON.stringify(spelt[1]),
      `an explicit null summary and an omitted key must reach the store as the same section, found ${JSON.stringify(
        spelt[0],
      )} and ${JSON.stringify(spelt[1])}`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Run every check. */
export function runConformance(): ConformanceReport {
  const suite = new Suite();
  checkFixtures(suite);
  checkIngestionBoundary(suite);
  checkTextUnit(suite);
  checkIdentity(suite);
  checkObservations(suite);
  checkSecretScan(suite);
  checkNormalization(suite);
  checkClosedWorld(suite);
  checkStoreAndRestore(suite);
  checkRestoreBoundary(suite);
  checkDeterminism(suite);
  checkRecipe(suite);
  checkMcpSchemas(suite);
  return {
    checks: suite.checks,
    checksByClass: suite.checksByClass,
    categories: suite.categories,
    failures: suite.failures,
  };
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)
  );
}

if (isEntryPoint()) {
  const report = runConformance();
  // The two classes are reported separately, always. A single green blob
  // would let a writer claim the safety behaviour it never proved.
  process.stdout.write("soil conformance (typescript, spec 1.0)\n");
  process.stdout.write(
    `Soil Document Conformant       ${report.checksByClass.document} checks\n`,
  );
  process.stdout.write(
    `Soil Secure Writer Conformant  ${report.checksByClass["secure-writer"]} checks\n`,
  );
  if (report.failures.length > 0) {
    process.stdout.write(
      `\n${report.failures.length} of ${report.checks} checks failed\n\n`,
    );
    for (const failure of report.failures) {
      process.stdout.write(
        `  [${failure.conformanceClass}/${failure.category}] ${failure.detail}\n`,
      );
    }
    process.stdout.write("\n");
    process.exitCode = 1;
  }
}
