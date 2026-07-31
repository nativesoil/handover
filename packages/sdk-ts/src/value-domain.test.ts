/**
 * The numeric domain and the text unit, on this surface.
 *
 * Both are stated normatively in `spec/value-domain.md` and both are pinned
 * across the five implementations by the conformance corpus. What is here is
 * what only this runtime can show: that `JSON.parse` has already destroyed the
 * evidence the numeric rule is about, and that a JavaScript string's `length`
 * is not the unit the format counts in.
 */

import { describe, expect, it } from "vitest";

import { ingestText } from "./ingest.js";
import { LIMITS, textLength } from "./sections.js";
import { validateHandover } from "./validate.js";
import { normalizeHandover } from "./normalize.js";

/** The code and location of a refusal, or `"accepted"`. */
function verdict(text: string): string {
  const result = ingestText(text);
  return result.ok ? "accepted" : `${result.issue.code} ${result.issue.path}`;
}

describe("the numeric domain", () => {
  it("is a rule the parsed value cannot answer, which is why it is at the boundary", () => {
    // Executed and observed: this runtime folds two different integers into
    // one double, and turns an oversized token into Infinity. A validator
    // handed the parsed value has nothing left to judge.
    expect(JSON.parse("9007199254740993")).toBe(9007199254740992);
    expect(JSON.parse("1e999")).toBe(Number.POSITIVE_INFINITY);
  });

  it("accepts both ends of the safe-integer range", () => {
    expect(verdict('{"n":9007199254740991}')).toBe("accepted");
    expect(verdict('{"n":-9007199254740991}')).toBe("accepted");
  });

  it("refuses one step beyond either end", () => {
    expect(verdict('{"n":9007199254740992}')).toBe("number.out_of_range /n");
    expect(verdict('{"n":-9007199254740992}')).toBe("number.out_of_range /n");
  });

  it("refuses a magnitude no double could hold, from the token text", () => {
    expect(verdict(`{"n":${"9".repeat(40)}}`)).toBe("number.out_of_range /n");
  });

  it("refuses an integer written with a decimal point or an exponent", () => {
    expect(verdict('{"n":100.0}')).toBe("number.not_an_integer /n");
    expect(verdict('{"n":1e2}')).toBe("number.not_an_integer /n");
    expect(verdict('{"n":-0.0}')).toBe("number.not_an_integer /n");
  });

  it("refuses a fraction", () => {
    expect(verdict('{"confidence":0.92}')).toBe(
      "number.not_an_integer /confidence",
    );
  });

  it("accepts zero, negative zero and ordinary integers", () => {
    expect(verdict('{"a":0,"b":-0,"c":42,"d":-42}')).toBe("accepted");
  });

  it("locates a refusal inside an array and inside a nested object", () => {
    expect(verdict('{"a":[1,2,1e2]}')).toBe("number.not_an_integer /a/2");
    expect(verdict('{"a":{"b":{"c":0.5}}}')).toBe(
      "number.not_an_integer /a/b/c",
    );
  });

  it("reports the document itself for a bare number at the root", () => {
    expect(verdict("0.5")).toBe("number.not_an_integer ");
  });

  it("does not mistake the three JSON literals for numbers", () => {
    expect(verdict('{"a":true,"b":false,"c":null}')).toBe("accepted");
  });

  it("does not read digits inside a string as a number", () => {
    expect(verdict('{"a":"9007199254740992"}')).toBe("accepted");
  });

  it("leaves syntax and duplicate members ranked above it", () => {
    // Both rules broken at once: the structural refusal is the one reported,
    // so a document is judged the same way whichever surface reads it.
    expect(verdict('{"a":1e2,"a":1e2}')).toBe("structure.duplicate_member /a");
    expect(verdict('{"a":1e2,}')).toBe("syntax.invalid_json ");
  });
});

describe("the text unit", () => {
  /** One code point, two UTF-16 code units, four UTF-8 bytes. */
  const ASTRAL = String.fromCodePoint(0x1f600);
  /** Two code points, two UTF-16 code units, one grapheme cluster. */
  const COMBINED = "é";

  it("is not what a JavaScript string's length reports", () => {
    const title = ASTRAL.repeat(LIMITS.title);
    expect(textLength(title)).toBe(200);
    expect(title.length).toBe(400);
    expect(new TextEncoder().encode(title).length).toBe(800);
  });

  it("counts a combining sequence as its code points, not as one cluster", () => {
    expect(textLength(COMBINED)).toBe(2);
    expect(textLength("café")).toBe(4);
  });

  it("counts a lone surrogate as one code point rather than dropping it", () => {
    // A JSON document may carry \\uD800 with no pair. Counting it as zero
    // would let a string smuggle unbounded content past a bound.
    expect(textLength("\ud800")).toBe(1);
    expect(textLength(`a\ud800b`)).toBe(3);
  });

  const base = (): Record<string, unknown> => ({
    ...(normalizeHandover({
      projectId: "text-unit",
      title: "The text unit",
      createdAt: "2026-07-26T10:00:00Z",
      sections: { executiveSummary: "The text unit, exercised." },
    }) as unknown as Record<string, unknown>),
    handoverId: "019f7e89-fc00-7000-8000-000000000000",
  });

  it("accepts a title of exactly the limit in astral characters", () => {
    const result = validateHandover({
      ...base(),
      title: ASTRAL.repeat(LIMITS.title),
    });
    expect(result.issues).toEqual([]);
  });

  it("refuses one code point over, and says the unit in the message", () => {
    const result = validateHandover({
      ...base(),
      title: ASTRAL.repeat(LIMITS.title + 1),
    });
    expect(result.valid).toBe(false);
    const issue = result.issues.find((entry) => entry.path === "/title");
    expect(issue?.message).toBe("must be at most 200 code points");
  });
});
