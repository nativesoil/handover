/**
 * The pre-schema ingestion boundary.
 *
 * Everything else in this SDK receives a value. This module is the one place
 * that receives BYTES, and it is the only place where the rules that cannot
 * be seen from a constructed value are enforced:
 *
 *   1. size        the byte count is bounded before anything decodes, and it
 *                  is unrecoverable once a value exists
 *   2. encoding    the bytes must be UTF-8, with no byte order mark, and
 *                  nothing is ever repaired or transcoded
 *   3. duplicates  a member name repeated inside one object refuses the
 *                  document, before any object is built from it
 *   4. depth       nesting is bounded before anything walks the value, so a
 *                  deep document is refused rather than crashing the walker
 *   5. numbers     a number is judged from its token text, because a parser
 *                  rounds an oversized integer in silence
 *
 * Why a boundary rather than the same checks scattered about. A JSON parser is
 * lossy on exactly these points: by the time you hold an object, the second
 * `"a"` has overwritten the first, the byte order mark has been stripped or
 * turned into a stray character, the recursion that would have blown the stack
 * has already run, and the length of what arrived is gone — whitespace,
 * escapes and member order are not recoverable from a value. The safety scan
 * and the validator both walk a constructed value, so neither can see any of
 * it. So the checks live here, ahead of the parser, and every reader in this
 * SDK goes through this door.
 *
 * The security argument for the duplicate rule is the decisive one. With
 * last-wins, the fail-closed secret scan sees one value for `/sections/x` and
 * a consumer parsing the same bytes with a different parser sees another. The
 * document that gets scanned is then not the document that gets read.
 *
 * The depth ceiling is derived, not observed. The deepest structure a handover
 * needs without custom observation data is 4 levels; the deepest fixture in
 * this repository is 6; the lowest hard parser ceiling among the five official
 * implementations is 64 (`System.Text.Json`'s default reader depth). 32 sits
 * at half of that: far above anything a handover needs, far below the first
 * runtime that would fail on its own terms.
 *
 * Mechanism note for this surface: `JSON.parse` exposes no duplicate-key hook
 * (a reviver is called with an object that has already collapsed them) and no
 * depth control, so this surface uses a scanner. The scanner does not build a
 * value and is not a second JSON parser: it walks tokens to answer "how deep"
 * and "was a member name repeated", and `JSON.parse` remains the only thing
 * that constructs a value or judges syntax.
 *
 * The order of the checks is normative and identical on every surface:
 * size, encoding, depth, syntax, duplicate member names, numeric domain. The
 * first five are `spec/ingestion.md`; the sixth is `spec/value-domain.md`,
 * and it is here rather than in the validator for the same reason as the
 * other five: `JSON.parse` has already folded 9007199254740993 into its
 * neighbour and 1e999 into an infinity by the time a value exists.
 */

/** The bounds this boundary enforces. */
export const INGEST_LIMITS = Object.freeze({
  /** Max nesting of containers. The root container counts as level 1. */
  maxDepth: 32,
  /** Max bytes in one serialized handover. */
  maxBytes: 1048576,
  /**
   * The largest integer a handover may hold, and its negative counterpart.
   *
   * These are the ends of the safe-integer range, 2^53 - 1. Beyond them a
   * double can no longer tell two neighbouring integers apart, so a document
   * carrying such a value means one thing to a reader with 64-bit floats and
   * another to a reader with arbitrary-precision integers. See
   * `spec/value-domain.md`.
   */
  maxInteger: 9007199254740991,
  minInteger: -9007199254740991,
} as const);

/**
 * The decimal digits of {@link INGEST_LIMITS.maxInteger}.
 *
 * The range check compares digit strings rather than parsing, because parsing
 * is the step that loses the answer: `Number("9007199254740993")` is
 * 9007199254740992 on this runtime, and a forty-digit token becomes a double
 * with nothing left of its tail. Equal-length decimal strings compare
 * correctly under ordinary lexicographic order, so digit count plus one string
 * comparison decides the question exactly, with no big-integer type anywhere.
 */
const MAX_INTEGER_DIGITS = "9007199254740991";

/** A JSON number token written in the integer form: no fraction, no exponent. */
const INTEGER_TOKEN = /^-?(?:0|[1-9][0-9]*)$/;

/** The stable error codes. Identical strings on every surface. */
export const INGEST_ERROR_CODES = Object.freeze([
  "document.too_large",
  "encoding.byte_order_mark",
  "encoding.unsupported_encoding",
  "encoding.invalid_utf8",
  "structure.depth_exceeded",
  "syntax.invalid_json",
  "structure.duplicate_member",
  "number.not_an_integer",
  "number.out_of_range",
] as const);

/** One of the stable error codes. */
export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[number];

/** One refusal. Carries a class and a location, never document content. */
export interface IngestIssue {
  /** The stable code, e.g. `structure.duplicate_member`. */
  readonly code: IngestErrorCode;
  /** JSON Pointer to the offending place, or `""` for the whole document. */
  readonly path: string;
  /** A sentence a person can act on. Never echoes a value. */
  readonly message: string;
}

/** What the boundary returns: one controlled canonical parse result. */
export type IngestResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issue: IngestIssue };

/** Thrown by {@link ingestDocumentOrThrow}. */
export class IngestError extends Error {
  readonly issue: IngestIssue;
  constructor(issue: IngestIssue) {
    super(issue.message);
    this.name = "IngestError";
    this.issue = issue;
  }
}

function refuse(
  code: IngestErrorCode,
  path: string,
  message: string,
): IngestResult {
  return { ok: false, issue: { code, path, message } };
}

/* -------------------------------------------------------------------------
 * Stage 1: the bytes
 * ---------------------------------------------------------------------- */

/** A byte order mark this boundary recognises, so it can name what it found. */
interface ByteOrderMark {
  readonly encoding: string;
  readonly bytes: readonly number[];
}

const BYTE_ORDER_MARKS: readonly ByteOrderMark[] = Object.freeze([
  // The four-byte marks come first: a UTF-32LE mark begins with the two
  // bytes of a UTF-16LE mark, so testing the short one first would misname it.
  Object.freeze({ encoding: "UTF-32LE", bytes: [0xff, 0xfe, 0x00, 0x00] }),
  Object.freeze({ encoding: "UTF-32BE", bytes: [0x00, 0x00, 0xfe, 0xff] }),
  Object.freeze({ encoding: "UTF-8", bytes: [0xef, 0xbb, 0xbf] }),
  Object.freeze({ encoding: "UTF-16LE", bytes: [0xff, 0xfe] }),
  Object.freeze({ encoding: "UTF-16BE", bytes: [0xfe, 0xff] }),
]);

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, i) => bytes[i] === byte);
}

/**
 * The encoding a document's first four bytes imply, following the detection
 * rule in RFC 4627 section 3: the first token of a JSON text is always ASCII,
 * so the position of the NUL padding bytes names the encoding without decoding
 * anything. Returns `undefined` when the bytes are consistent with UTF-8.
 */
function sniffUnitWidth(bytes: Uint8Array): string | undefined {
  if (bytes.length < 4) return undefined;
  const [a, b, c, d] = [bytes[0], bytes[1], bytes[2], bytes[3]] as [
    number,
    number,
    number,
    number,
  ];
  if (a === 0 && b === 0 && c === 0 && d !== 0) return "UTF-32BE";
  if (a !== 0 && b === 0 && c === 0 && d === 0) return "UTF-32LE";
  if (a === 0 && b !== 0 && c === 0 && d !== 0) return "UTF-16BE";
  if (a !== 0 && b === 0 && c !== 0 && d === 0) return "UTF-16LE";
  return undefined;
}

/**
 * Decode strictly. Node's `Buffer.toString("utf8")` and a non-fatal
 * `TextDecoder` both replace an undecodable byte with U+FFFD, which is a
 * silent repair: the document that gets scanned is no longer the document that
 * arrived. `fatal: true` is the whole point of this call.
 */
function decodeStrictUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------
 * Stage 2: the scan
 * ---------------------------------------------------------------------- */

type FrameKind = "object" | "array";

interface Frame {
  kind: FrameKind;
  /** Member names already seen in this object. Unused for arrays. */
  readonly names: Set<string>;
  /** True while an object is positioned where a member name may start. */
  expectName: boolean;
  /**
   * The member name or array index this frame is currently inside, or
   * `undefined` for an object that has not read a member name yet.
   */
  cursor: string | undefined;
  /** Array position, used to build the pointer segment. */
  index: number;
}

function pointerOf(frames: readonly Frame[], leaf: string): string {
  const segments: string[] = [];
  for (const frame of frames) {
    if (frame.cursor !== undefined) segments.push(frame.cursor);
  }
  segments.push(leaf);
  return `/${segments.map(escapePointerSegment).join("/")}`;
}

/**
 * The pointer to the value the scanner is currently positioned at: every
 * frame's cursor, in order. An object frame's cursor is the member name it
 * last read, an array frame's is the index it is on, so the joined cursors
 * already address the value. A scalar at the root has no frames and reports
 * the document.
 */
function pointerOfValue(frames: readonly Frame[]): string {
  const segments: string[] = [];
  for (const frame of frames) {
    if (frame.cursor !== undefined) segments.push(frame.cursor);
  }
  if (segments.length === 0) return "";
  return `/${segments.map(escapePointerSegment).join("/")}`;
}

/**
 * Judge one JSON number token against the numeric domain, from its TEXT.
 *
 * `undefined` means the token is inside the domain. The two refusals are
 * separate codes because they are separate mistakes: a fraction or an exponent
 * is a producer writing a value the format does not carry, while a
 * twenty-digit integer is a producer writing a value no reader can carry back.
 *
 * The token text is the input on purpose. By the time `JSON.parse` has run,
 * `9007199254740993` and `9007199254740992` are the same double and `1e999` is
 * `Infinity`: the evidence is destroyed before any validator could look at it,
 * which is the property that puts this check at the ingestion boundary beside
 * the encoding and duplicate rules rather than in the validator.
 */
function judgeNumberToken(token: string): IngestErrorCode | undefined {
  if (!INTEGER_TOKEN.test(token)) return "number.not_an_integer";
  const digits = token.startsWith("-") ? token.slice(1) : token;
  if (digits.length > MAX_INTEGER_DIGITS.length) return "number.out_of_range";
  if (
    digits.length === MAX_INTEGER_DIGITS.length &&
    digits > MAX_INTEGER_DIGITS
  ) {
    return "number.out_of_range";
  }
  return undefined;
}

/** The message for one numeric refusal. It names a class, never a value. */
function numberMessage(code: IngestErrorCode): string {
  return code === "number.not_an_integer"
    ? "a number in a handover must be written as an integer, with no fraction part and no exponent"
    : `a number in a handover must lie between ${INGEST_LIMITS.minInteger} and ${INGEST_LIMITS.maxInteger}`;
}

/** RFC 6901: `~` becomes `~0` and `/` becomes `~1`. */
function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Read a JSON string token that starts at `text[start]` (the opening quote).
 * Returns the decoded content and the index just past the closing quote, or
 * `undefined` when the token does not terminate.
 *
 * A note on where the text-length unit did NOT land. This looked like the
 * place for it, and it is not: a length bound belongs to a named field, and a
 * string token here is just a string. The unit is Unicode code points and it
 * is enforced in the validator, where the field is known. See
 * `spec/value-domain.md`.
 */
function readStringToken(
  text: string,
  start: number,
): { content: string; end: number } | undefined {
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') return { content: out, end: i + 1 };
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const escape = text[i + 1];
    if (escape === undefined) return undefined;
    if (escape === "u") {
      const hex = text.slice(i + 2, i + 6);
      if (hex.length < 4) return undefined;
      const code = Number.parseInt(hex, 16);
      if (Number.isNaN(code)) return undefined;
      out += String.fromCharCode(code);
      i += 6;
      continue;
    }
    const simple: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    out += simple[escape] ?? escape;
    i += 2;
  }
  return undefined;
}

/**
 * Walk the token stream without building a value and without recursing.
 *
 * `checkNames` is what separates the two passes. The depth pass runs before
 * the parser, on text that may be malformed, so it reports nothing but depth.
 * The duplicate pass runs after `JSON.parse` has already agreed the text is
 * well formed, so its frame tracking cannot be thrown off by malformed input.
 *
 * `checkNumbers` is the third pass. It runs last, after the parser has agreed
 * the text is well formed, so every bare run it meets is either one of the
 * three JSON literals or a valid JSON number, and it can judge the number from
 * its literal text before any conversion to a double has happened.
 */
function scan(
  text: string,
  options: {
    readonly checkNames: boolean;
    readonly checkNumbers?: boolean;
  },
): IngestIssue | undefined {
  const frames: Frame[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i] as string;

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }

    if (ch === "{" || ch === "[") {
      if (frames.length + 1 > INGEST_LIMITS.maxDepth) {
        return {
          code: "structure.depth_exceeded",
          path: "",
          message: `a serialized handover must nest at most ${INGEST_LIMITS.maxDepth} levels, found ${frames.length + 1}`,
        };
      }
      frames.push({
        kind: ch === "{" ? "object" : "array",
        names: new Set<string>(),
        expectName: ch === "{",
        cursor: ch === "{" ? undefined : "0",
        index: 0,
      });
      i += 1;
      continue;
    }

    if (ch === "}" || ch === "]") {
      frames.pop();
      i += 1;
      continue;
    }

    if (ch === ",") {
      const top = frames[frames.length - 1];
      if (top !== undefined) {
        if (top.kind === "object") {
          top.expectName = true;
          top.cursor = undefined;
        } else {
          top.index += 1;
          top.cursor = String(top.index);
        }
      }
      i += 1;
      continue;
    }

    if (ch === ":") {
      i += 1;
      continue;
    }

    if (ch === '"') {
      const token = readStringToken(text, i);
      if (token === undefined) {
        // Malformed. The parser is the authority on syntax; stop scanning and
        // let it report, rather than inventing a second syntax error here.
        return undefined;
      }
      const top = frames[frames.length - 1];
      if (top !== undefined && top.kind === "object" && top.expectName) {
        top.expectName = false;
        top.cursor = token.content;
        if (checkNamesFor(options, top, token.content)) {
          return {
            code: "structure.duplicate_member",
            path: pointerOf(frames.slice(0, -1), token.content),
            message:
              "a serialized handover must not repeat a member name inside one object: with a repeated name, two readers of the same bytes can hold different documents",
          };
        }
      }
      i = token.end;
      continue;
    }

    // A number, `true`, `false` or `null`. Consumed as one run of literal
    // characters; the parser judges whether the run is actually valid.
    let j = i;
    while (j < text.length && !',:{}[]" \t\n\r'.includes(text[j] as string)) {
      j += 1;
    }
    const run = text.slice(i, j > i ? j : i + 1);
    if (
      options.checkNumbers === true &&
      run !== "true" &&
      run !== "false" &&
      run !== "null"
    ) {
      const code = judgeNumberToken(run);
      if (code !== undefined) {
        return {
          code,
          path: pointerOfValue(frames),
          message: numberMessage(code),
        };
      }
    }
    i = j > i ? j : i + 1;
  }

  return undefined;
}

function checkNamesFor(
  options: { readonly checkNames: boolean },
  frame: Frame,
  name: string,
): boolean {
  if (!options.checkNames) return false;
  if (frame.names.has(name)) return true;
  frame.names.add(name);
  return false;
}

/* -------------------------------------------------------------------------
 * The door
 * ---------------------------------------------------------------------- */

/**
 * Ingest one serialized handover from bytes. This is the boundary: the value
 * it returns has been checked for encoding, size, depth and duplicate member
 * names, in that order, and nothing has been repaired along the way.
 */
export function ingestDocument(bytes: Uint8Array): IngestResult {
  if (bytes.length > INGEST_LIMITS.maxBytes) {
    return refuse(
      "document.too_large",
      "",
      `a serialized handover must be at most ${INGEST_LIMITS.maxBytes} bytes, got ${bytes.length}`,
    );
  }

  for (const mark of BYTE_ORDER_MARKS) {
    if (startsWith(bytes, mark.bytes)) {
      return refuse(
        "encoding.byte_order_mark",
        "",
        `a serialized handover must not begin with a byte order mark; these bytes open with a ${mark.encoding} mark. A producer must not write one, and a reader must not strip one.`,
      );
    }
  }

  const sniffed = sniffUnitWidth(bytes);
  if (sniffed !== undefined) {
    return refuse(
      "encoding.unsupported_encoding",
      "",
      `a serialized handover must be UTF-8; these bytes are ${sniffed}. Other encodings are invalid and are never converted.`,
    );
  }

  const text = decodeStrictUtf8(bytes);
  if (text === undefined) {
    return refuse(
      "encoding.invalid_utf8",
      "",
      "a serialized handover must be valid UTF-8; these bytes are not, and malformed UTF-8 is refused rather than repaired",
    );
  }

  return ingestText(text);
}

/**
 * Ingest one serialized handover that has already been decoded to text, e.g.
 * a JSON block lifted out of a model's reply. The encoding rules that survive
 * decoding still apply: a leading U+FEFF is a byte order mark whether it
 * arrived as three bytes or as one character.
 */
export function ingestText(text: string): IngestResult {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > INGEST_LIMITS.maxBytes) {
    return refuse(
      "document.too_large",
      "",
      `a serialized handover must be at most ${INGEST_LIMITS.maxBytes} bytes, got ${bytes}`,
    );
  }
  if (text.startsWith("﻿")) {
    return refuse(
      "encoding.byte_order_mark",
      "",
      "a serialized handover must not begin with a byte order mark; this text opens with a UTF-8 mark. A producer must not write one, and a reader must not strip one.",
    );
  }

  // Depth first, and before anything recurses: `JSON.parse` recurses, the
  // safety scan recurses, the validator recurses. A document that would break
  // them is refused here with a structured error instead.
  const deep = scan(text, { checkNames: false });
  if (deep !== undefined) return { ok: false, issue: deep };

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse(
      "syntax.invalid_json",
      "",
      "the input is not a single well-formed JSON document",
    );
  }

  // Duplicates next, on text the parser has already agreed is well formed.
  const duplicate = scan(text, { checkNames: true });
  if (duplicate !== undefined) return { ok: false, issue: duplicate };

  // The numeric domain last. It needs a well-formed document to be talking
  // about numbers at all, and it needs the token TEXT, which `value` no longer
  // has: this runtime has already folded every number into a double.
  const number = scan(text, { checkNames: false, checkNumbers: true });
  if (number !== undefined) return { ok: false, issue: number };

  return { ok: true, value };
}

/** Ingest, or throw {@link IngestError}. */
export function ingestDocumentOrThrow(bytes: Uint8Array): unknown {
  const result = ingestDocument(bytes);
  if (!result.ok) throw new IngestError(result.issue);
  return result.value;
}

/** Ingest decoded text, or throw {@link IngestError}. */
export function ingestTextOrThrow(text: string): unknown {
  const result = ingestText(text);
  if (!result.ok) throw new IngestError(result.issue);
  return result.value;
}
