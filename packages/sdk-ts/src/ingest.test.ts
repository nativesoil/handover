import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { INGEST_LIMITS, ingestDocument, ingestText } from "./ingest.js";
import { HandoverStore } from "./store.js";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The code and location of a refusal, or `"accepted"`. */
function verdict(bytes: Uint8Array): string {
  const result = ingestDocument(bytes);
  return result.ok ? "accepted" : `${result.issue.code} ${result.issue.path}`;
}

describe("encoding", () => {
  it("refuses a byte order mark and names the encoding it found", () => {
    const result = ingestDocument(
      new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("{}")]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.code).toBe("encoding.byte_order_mark");
    expect(result.issue.message).toContain("UTF-8");
  });

  it("names a UTF-32LE mark rather than the UTF-16LE mark it starts with", () => {
    const result = ingestDocument(new Uint8Array([0xff, 0xfe, 0x00, 0x00]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.message).toContain("UTF-32LE");
  });

  it("refuses a leading U+FEFF that arrived as text rather than as bytes", () => {
    const result = ingestText("﻿{}");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("encoding.byte_order_mark");
  });

  it("refuses malformed UTF-8 instead of substituting U+FFFD", () => {
    // A Latin-1 e-acute inside a string. `Buffer.toString("utf8")` would hand
    // back a document with a replacement character in it and call that a read.
    const bytes = new Uint8Array([...utf8('{"t":"caf'), 0xe9, ...utf8('"}')]);
    expect(verdict(bytes)).toBe("encoding.invalid_utf8 ");
  });

  it("accepts valid multibyte UTF-8: the rule is about encodings, not about non-ASCII", () => {
    const result = ingestDocument(utf8('{"t":"café · 引き継ぎ"}'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ t: "café · 引き継ぎ" });
  });
});

describe("duplicate member names", () => {
  it("refuses a repeat and points at the member, not the object", () => {
    expect(verdict(utf8('{"a":1,"a":2}'))).toBe(
      "structure.duplicate_member /a",
    );
  });

  it("reaches through an array index into a free-form payload", () => {
    expect(verdict(utf8('{"o":[{"d":{"n":1,"n":2}}]}'))).toBe(
      "structure.duplicate_member /o/0/d/n",
    );
  });

  it("escapes a member name that looks like a pointer, per RFC 6901", () => {
    expect(verdict(utf8('{"a/b~c":1,"a/b~c":2}'))).toBe(
      "structure.duplicate_member /a~1b~0c",
    );
  });

  it("is not confused by a member name that appears inside a string value", () => {
    expect(verdict(utf8('{"a":"\\"a\\": elsewhere","b":2}'))).toBe("accepted");
  });

  it("accepts the same name in two different objects", () => {
    expect(verdict(utf8('{"x":{"status":1},"y":{"status":2}}'))).toBe(
      "accepted",
    );
  });

  it("never echoes the repeated name in the message", () => {
    const result = ingestDocument(utf8('{"secretish":1,"secretish":2}'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.message).not.toContain("secretish");
  });

  it("reports syntax before duplicates when the document is also malformed", () => {
    expect(verdict(utf8('{"a":1,"a":2'))).toBe("syntax.invalid_json ");
  });
});

describe("nesting depth", () => {
  const nested = (levels: number): string =>
    `${'{"n":'.repeat(levels - 1)}{}${"}".repeat(levels - 1)}`;

  it("accepts exactly the ceiling", () => {
    expect(verdict(utf8(nested(INGEST_LIMITS.maxDepth)))).toBe("accepted");
  });

  it("refuses one level over, with a structured error rather than a stack failure", () => {
    const result = ingestDocument(utf8(nested(INGEST_LIMITS.maxDepth + 1)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.code).toBe("structure.depth_exceeded");
    expect(result.issue.message).toContain("33");
  });

  it("refuses a document deep enough to break a recursive walker, in bounded time", () => {
    // 20000 levels: deep enough that `JSON.parse` itself throws a
    // RangeError on this runtime, and far deeper than the safety scan
    // survives. The boundary must answer with an issue, not an exception.
    const result = ingestDocument(utf8(nested(20000)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("structure.depth_exceeded");
  });

  it("counts containers, not members: a flat object is one level", () => {
    expect(verdict(utf8('{"a":1,"b":2,"c":3}'))).toBe("accepted");
  });

  it("does not count braces inside strings", () => {
    expect(verdict(utf8(`{"a":"${"{".repeat(200)}"}`))).toBe("accepted");
  });
});

describe("size", () => {
  const padded = (total: number): Uint8Array =>
    utf8(`{"pad":"${"x".repeat(total - 10)}"}`);

  it("accepts exactly the ceiling", () => {
    expect(verdict(padded(INGEST_LIMITS.maxBytes))).toBe("accepted");
  });

  it("refuses one byte over, on the byte count alone", () => {
    expect(verdict(padded(INGEST_LIMITS.maxBytes + 1))).toBe(
      "document.too_large ",
    );
  });
});

describe("the store reads through the boundary", () => {
  it("refuses a stored file that was written with a byte order mark", () => {
    const home = mkdtempSync(join(tmpdir(), "soil-ingest-"));
    try {
      const store = new HandoverStore(home);
      store.init();
      writeFileSync(
        join(home, "handovers", "001.json"),
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from('{"soilHandover":"1.0"}'),
        ]),
      );
      expect(() => store.read("#001")).toThrowError(/byte order mark/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
