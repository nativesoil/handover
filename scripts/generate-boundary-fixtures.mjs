/**
 * Generate the ingestion-boundary fixture corpus.
 *
 * These fixtures are BYTES under test. Several of them are not valid UTF-8 at
 * all, and the depth fixtures are too repetitive to hand-write without
 * miscounting, so they are generated from one place and committed. Rerun with:
 *
 *   node scripts/generate-boundary-fixtures.mjs
 *
 * The size-limit fixtures are deliberately NOT generated here: at a megabyte
 * each they do not belong in a repository, so the conformance manifest carries
 * a `generate` descriptor and every runner materialises them at run time.
 *
 * `.gitattributes` exempts this directory from line-ending normalisation and
 * `.prettierignore` exempts it from formatting: a fixture whose whole point is
 * its exact bytes must survive a checkout and a format pass untouched.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "conformance/fixtures/boundary");
mkdirSync(OUT, { recursive: true });

/** A small, unambiguous JSON document used by the encoding fixtures. */
const SMALL = '{"soilHandover":"1.0"}\n';

function write(name, bytes) {
  writeFileSync(join(OUT, name), bytes);
  process.stdout.write(`  ${name}  ${bytes.length} bytes\n`);
}

function encode(text, encoding) {
  const units = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) throw new Error("fixture text stays in the BMP");
    units.push(code);
  }
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    const out = Buffer.alloc(units.length * 2);
    units.forEach((unit, i) => {
      if (encoding === "utf-16le") out.writeUInt16LE(unit, i * 2);
      else out.writeUInt16BE(unit, i * 2);
    });
    return out;
  }
  const out = Buffer.alloc(units.length * 4);
  units.forEach((unit, i) => {
    if (encoding === "utf-32le") out.writeUInt32LE(unit, i * 4);
    else out.writeUInt32BE(unit, i * 4);
  });
  return out;
}

process.stdout.write("encoding fixtures\n");

// A byte order mark, in the encoding the format actually requires. The most
// common real case: an editor or a Windows tool wrote the document.
write(
  "encoding-utf8-bom.bin",
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SMALL, "utf8")]),
);

// A UTF-16LE document that also announces itself with a mark.
write(
  "encoding-utf16le-bom.bin",
  Buffer.concat([Buffer.from([0xff, 0xfe]), encode(SMALL, "utf-16le")]),
);

// The same document with no mark at all: nothing but the NUL padding says
// what it is, which is what the RFC 4627 first-four-bytes rule is for.
write("encoding-utf16le.bin", encode(SMALL, "utf-16le"));
write("encoding-utf16be.bin", encode(SMALL, "utf-16be"));
write("encoding-utf32le.bin", encode(SMALL, "utf-32le"));

// Latin-1: `café` in a title. Valid text in its own encoding, and byte 0xE9 is
// not a legal UTF-8 start byte, so this is the everyday transcoding accident.
write(
  "encoding-latin1.bin",
  Buffer.concat([
    Buffer.from('{"title":"caf', "utf8"),
    Buffer.from([0xe9]),
    Buffer.from('"}\n', "utf8"),
  ]),
);

// A three-byte UTF-8 sequence cut short. Well-formed UTF-8 up to the point it
// stops being UTF-8, which is what a truncated write or a bad splice produces.
write(
  "encoding-truncated-utf8.bin",
  Buffer.concat([
    Buffer.from('{"title":"', "utf8"),
    Buffer.from([0xe2, 0x82]),
    Buffer.from('"}\n', "utf8"),
  ]),
);

// The positive control. Valid UTF-8, multibyte throughout, no mark: this one
// must be ACCEPTED, or the rule has been implemented as "reject non-ASCII".
write(
  "encoding-utf8-multibyte.json",
  Buffer.from('{"title":"café · 引き継ぎ · ✅"}\n', "utf8"),
);

process.stdout.write("duplicate member fixtures\n");

// One duplicate each, at the root, one level down, and inside the free-form
// observation payload. Each file holds exactly one, so the reported location
// is unambiguous on every surface.
write(
  "duplicate-member-root.json",
  Buffer.from(
    '{\n  "soilHandover": "1.0",\n  "projectId": "orchard",\n  "title": "Two names, one object",\n  "projectId": "orchard-shadow"\n}\n',
    "utf8",
  ),
);
write(
  "duplicate-member-nested.json",
  Buffer.from(
    '{\n  "soilHandover": "1.0",\n  "sections": {\n    "decisions": { "status": "available", "summary": "The retry policy is settled." },\n    "workflow": { "status": "missing", "summary": null },\n    "decisions": { "status": "missing", "summary": null }\n  }\n}\n',
    "utf8",
  ),
);
write(
  "duplicate-member-in-observation.json",
  Buffer.from(
    '{\n  "soilHandover": "1.0",\n  "observations": [\n    {\n      "kind": "com.example.note",\n      "data": {\n        "note": "the deploy is green",\n        "note": "the deploy is red"\n      }\n    }\n  ]\n}\n',
    "utf8",
  ),
);

// The near miss that must stay ACCEPTED: the same name in two DIFFERENT
// objects is ordinary JSON, and an implementation that rejects it has
// implemented "this name appears twice in the file" instead of the rule.
write(
  "duplicate-member-absent.json",
  Buffer.from(
    '{\n  "soilHandover": "1.0",\n  "sections": {\n    "decisions": { "status": "missing", "summary": null },\n    "workflow": { "status": "missing", "summary": null }\n  }\n}\n',
    "utf8",
  ),
);

// Accepted by the boundary and not a handover at all: the root is an array,
// so the validator refuses it on shape. The fail-closed secret scan must
// still reach the string inside. A document that is accepted and never
// scanned is the worst outcome of all, and "it was going to be rejected
// anyway" is not the same thing as "it was scanned".
write(
  "accepted-non-object-root-with-secret.json",
  Buffer.from('["the key is sk-boundaryfixture0123456789"]\n', "utf8"),
);

process.stdout.write("syntax fixtures\n");

// `NaN` is not a JSON value. One of the five runtimes accepts it by default,
// so without this fixture the five would silently disagree about what counts
// as a well-formed JSON document. This is a SYNTAX rule, not the numeric
// domain: what a handover may hold once a token is a number is decided
// elsewhere.
write(
  "syntax-not-a-number.json",
  Buffer.from(
    '{"soilHandover": "1.0", "observations": [{"kind": "com.example.n", "data": {"value": NaN}}]}\n',
    "utf8",
  ),
);

process.stdout.write("depth fixtures\n");

const SECTION_KEYS = [
  "projectIdentity",
  "decisions",
  "workflow",
  "architecture",
  "constraints",
  "rejectedPaths",
  "executiveSummary",
  "currentTask",
  "latestUserIntent",
  "sessionDelta",
  "blockers",
  "nextSteps",
  "openQuestions",
  "sessionActivity",
  "restoreInstructions",
  "provenanceMap",
  "safetySummary",
];

/** A nest of `levels` objects, with `leaf` at the bottom. */
function nest(levels, leaf) {
  let value = leaf;
  for (let i = 0; i < levels; i += 1) value = { level: value };
  return value;
}

/**
 * A real handover whose observation payload nests to exactly `depth` levels
 * counted from the document root. Root is level 1, `observations` is 2 and
 * entry 0 is 3, so the value at `data` must itself be `depth - 3` levels deep;
 * the leaf `{ "floor": ... }` is one of them.
 */
function handoverAtDepth(depth, leafText) {
  const sections = {};
  for (const key of SECTION_KEYS) {
    sections[key] = { status: "missing", summary: null };
  }
  sections.projectIdentity = {
    status: "available",
    summary: `A handover whose attached observation nests to exactly ${depth} levels. The ingestion boundary decides whether it is read at all.`,
  };
  return {
    soilHandover: "1.0",
    handoverId: "019f7e89-fc00-7e76-92a3-f4671b02fd51",
    projectId: "boundary-depth",
    title: `Nesting exactly ${depth} levels deep`,
    createdAt: "2026-07-24T09:00:00Z",
    sections,
    observations: [
      {
        kind: "com.example.deep",
        data: nest(depth - 4, { floor: leafText }),
      },
    ],
  };
}

function writeJson(name, value) {
  write(name, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

/** A complete, valid handover carrying `data` as its one observation payload. */
function handoverWithPayload(title, summary, data) {
  const sections = {};
  for (const key of SECTION_KEYS) {
    sections[key] = { status: "missing", summary: null };
  }
  sections.projectIdentity = { status: "available", summary };
  return {
    soilHandover: "1.0",
    handoverId: "019f7e89-fc00-7e76-92a3-f4671b02fd52",
    projectId: "boundary-numbers",
    title,
    createdAt: "2026-07-26T09:00:00Z",
    sections,
    observations: [{ kind: "com.example.numbers", data }],
  };
}

writeJson(
  "depth-31.json",
  handoverAtDepth(31, "the floor, one level under the ceiling"),
);
writeJson(
  "depth-32.json",
  handoverAtDepth(32, "the floor, exactly at the ceiling"),
);
writeJson(
  "depth-33.json",
  handoverAtDepth(33, "the floor, one level over the ceiling"),
);

// Accepted at exactly the ceiling AND carrying credential-shaped material at
// the very bottom. This is the fixture that proves the fail-closed safety scan
// is reached at the deepest document the boundary lets through: a document
// that is accepted but never scanned would be the worst outcome of all.
writeJson(
  "depth-32-secret-at-the-floor.json",
  handoverAtDepth(32, "the key is sk-boundaryfixture0123456789"),
);

process.stdout.write("numeric domain fixtures\n");

/**
 * The numeric fixtures are written as TEXT, never through `JSON.stringify`.
 *
 * That is not a style choice, it is the whole subject. `JSON.stringify` can
 * only emit what a JavaScript number can hold, so it cannot write
 * `9007199254740993` (rounds to ...92), cannot write a forty-digit integer,
 * turns `-0` into `0` and turns `1e2` into `100`. Every one of those is a
 * fixture here, so each literal is placed as text and substituted in.
 */
function withLiterals(value, literals) {
  let text = `${JSON.stringify(value, null, 2)}\n`;
  for (const [placeholder, literal] of Object.entries(literals)) {
    text = text.replace(`"${placeholder}"`, literal);
  }
  return text;
}

function writeLiteral(name, value, literals) {
  write(name, Buffer.from(withLiterals(value, literals), "utf8"));
}

// Accepted: the integer domain, from both sides of both ends. One under the
// positive ceiling, exactly at it, exactly at the negative floor, one under
// that in magnitude, plus zero, negative zero and an ordinary small integer.
writeLiteral(
  "number-integers-in-range.json",
  handoverWithPayload(
    "Integers at and inside the safe range",
    "A handover whose observation payload carries the integer domain at both of its ends. Every one of these values must survive the boundary and reach the validator unchanged.",
    {
      safeMax: "@@safeMax@@",
      oneUnderSafeMax: "@@oneUnderSafeMax@@",
      safeMin: "@@safeMin@@",
      oneInsideSafeMin: "@@oneInsideSafeMin@@",
      zero: "@@zero@@",
      negativeZero: "@@negativeZero@@",
      ordinary: "@@ordinary@@",
    },
  ),
  {
    "@@safeMax@@": "9007199254740991",
    "@@oneUnderSafeMax@@": "9007199254740990",
    "@@safeMin@@": "-9007199254740991",
    "@@oneInsideSafeMin@@": "-9007199254740990",
    "@@zero@@": "0",
    "@@negativeZero@@": "-0",
    "@@ordinary@@": "42",
  },
);

// One over the positive ceiling. This is the value a JavaScript parser can
// still hold exactly (it is 2^53) but cannot distinguish from 2^53 + 1, which
// is why the check reads the token text and not the parsed value.
write(
  "number-above-safe-max.json",
  Buffer.from(
    '{\n  "soilHandover": "1.0",\n  "observations": [\n    {\n      "kind": "com.example.numbers",\n      "data": { "count": 9007199254740992 }\n    }\n  ]\n}\n',
    "utf8",
  ),
);

// One below the negative floor.
write(
  "number-below-safe-min.json",
  Buffer.from(
    '{\n  "soilHandover": "1.0",\n  "observations": [\n    {\n      "kind": "com.example.numbers",\n      "data": { "count": -9007199254740992 }\n    }\n  ]\n}\n',
    "utf8",
  ),
);

// Far out of range: forty digits. Two of the five runtimes parse this to a
// double and lose every digit after the seventeenth; one parses it to an
// exact arbitrary-precision integer and notices nothing wrong. The token text
// is the only thing all five see the same way.
write(
  "number-far-above-safe-max.json",
  Buffer.from(
    '{\n  "soilHandover": "1.0",\n  "observations": [\n    {\n      "kind": "com.example.numbers",\n      "data": { "count": 1234567890123456789012345678901234567890 }\n    }\n  ]\n}\n',
    "utf8",
  ),
);

// An integer mathematically, written with a decimal point. Refused: deciding
// integrality of an arbitrary decimal needs arithmetic the five runtimes do
// not share, so the required form is the integer form.
write(
  "number-integer-with-decimal-point.json",
  Buffer.from(
    '{\n  "soilHandover": "1.0",\n  "observations": [\n    {\n      "kind": "com.example.numbers",\n      "data": { "count": 100.0 }\n    }\n  ]\n}\n',
    "utf8",
  ),
);

// An integer mathematically, written in exponent form. Same refusal, and this
// is the spelling a serializer is most likely to produce on its own.
write(
  "number-integer-in-exponent-form.json",
  Buffer.from(
    '{\n  "soilHandover": "1.0",\n  "observations": [\n    {\n      "kind": "com.example.numbers",\n      "data": { "count": 1e2 }\n    }\n  ]\n}\n',
    "utf8",
  ),
);

// A fraction. Not an integer by any reading, and the shape a score arrives in.
write(
  "number-fraction.json",
  Buffer.from(
    '{\n  "soilHandover": "1.0",\n  "observations": [\n    {\n      "kind": "com.example.numbers",\n      "data": { "confidence": 0.92 }\n    }\n  ]\n}\n',
    "utf8",
  ),
);

// A number that is neither out of range nor fractional but sits nowhere near
// an object member: the rule is about every number in the document, so an
// array element is refused at its index.
write(
  "number-in-an-array.json",
  Buffer.from(
    '{\n  "soilHandover": "1.0",\n  "observations": [\n    {\n      "kind": "com.example.numbers",\n      "data": { "counts": [1, 2, 9007199254740992] }\n    }\n  ]\n}\n',
    "utf8",
  ),
);

process.stdout.write("done\n");
