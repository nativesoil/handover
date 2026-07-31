import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CLAIM_ID_DOMAIN,
  CLAIM_ID_LENGTH,
  CLAIM_KINDS,
  ClaimIdentityError,
  claimId,
  isClaimKind,
  normalizeClaimStatement,
} from "./claim.js";
import { SECTION_KEYS, SECTION_TIERS } from "./sections.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

interface CorpusSide {
  kind: string;
  statement: string;
  id: string;
}

interface Corpus {
  identity: { hash: string; domain: string; idLength: number };
  kinds: { ranked: string[] };
  sameId: { name: string; kind: string; id: string; statements: string[] }[];
  mustDiffer: { name: string; left: CorpusSide; right: CorpusSide }[];
  refused: { name: string; kind: string; statement: string }[];
}

const corpus: Corpus = JSON.parse(
  readFileSync(join(ROOT, "conformance/fixtures/claims/identity.json"), "utf8"),
);

describe("the claim kinds", () => {
  it("are exactly the durable-tier section keys", () => {
    const durable = SECTION_KEYS.filter(
      (key) => SECTION_TIERS[key] === "durable",
    );
    expect([...CLAIM_KINDS].sort()).toEqual([...durable].sort());
  });

  it("rank constraints and decisions first, then canonical order", () => {
    expect(CLAIM_KINDS.slice(0, 2)).toEqual(["constraints", "decisions"]);
    const rest = CLAIM_KINDS.slice(2);
    const canonical = SECTION_KEYS.filter((key) => rest.includes(key));
    expect(rest).toEqual(canonical);
  });

  it("match the corpus's ranked list exactly, order included", () => {
    expect([...CLAIM_KINDS]).toEqual(corpus.kinds.ranked);
  });

  it("are recognised by isClaimKind, and nothing else is", () => {
    for (const kind of CLAIM_KINDS) expect(isClaimKind(kind)).toBe(true);
    expect(isClaimKind("nextSteps")).toBe(false);
    expect(isClaimKind("vibes")).toBe(false);
    expect(isClaimKind("")).toBe(false);
    expect(isClaimKind(7)).toBe(false);
    expect(isClaimKind(undefined)).toBe(false);
  });
});

describe("the identity corpus", () => {
  it("states the derivation this implementation uses", () => {
    expect(corpus.identity.domain).toBe(CLAIM_ID_DOMAIN);
    expect(corpus.identity.idLength).toBe(CLAIM_ID_LENGTH);
    expect(corpus.identity.hash).toBe("SHA-256");
  });

  it("every sameness row reproduces its group's identifier", () => {
    for (const group of corpus.sameId) {
      for (const statement of group.statements) {
        expect
          .soft(claimId(group.kind, statement), `${group.name}: ${statement}`)
          .toBe(group.id);
      }
    }
  });

  it("every must-differ side reproduces its stated identifier", () => {
    for (const row of corpus.mustDiffer) {
      expect
        .soft(claimId(row.left.kind, row.left.statement), `${row.name} left`)
        .toBe(row.left.id);
      expect
        .soft(claimId(row.right.kind, row.right.statement), `${row.name} right`)
        .toBe(row.right.id);
    }
  });

  it("no must-differ row collides", () => {
    for (const row of corpus.mustDiffer) {
      expect(row.left.id, row.name).not.toBe(row.right.id);
    }
  });

  it("every refused row is refused", () => {
    expect(corpus.refused.length).toBeGreaterThan(0);
    for (const row of corpus.refused) {
      expect(() => claimId(row.kind, row.statement), row.name).toThrow(
        ClaimIdentityError,
      );
    }
  });
});

describe("normalization, rule by rule", () => {
  it("folds A..Z and only A..Z", () => {
    expect(normalizeClaimStatement("MiXeD Case 42!")).toBe("mixed case 42!");
    // U+00C9, U+0130, U+03A3: upper-case letters to a Unicode case map,
    // plain content to these rules.
    expect(normalizeClaimStatement("É İ Σ")).toBe("É İ Σ");
  });

  it("strips only the four whitespace bytes at the edges", () => {
    expect(normalizeClaimStatement(" \t\r\n x \t\r\n ")).toBe("x");
    // A no-break space at either edge is content and stays.
    expect(normalizeClaimStatement(" x ")).toBe(" x ");
  });

  it("collapses interior runs to one space, never to none", () => {
    expect(normalizeClaimStatement("a \t\r\n b")).toBe("a b");
    expect(normalizeClaimStatement("a  b")).not.toBe("ab");
  });

  it("applies no Unicode normalization form", () => {
    const composed = "café";
    const decomposed = "café";
    expect(normalizeClaimStatement(composed)).toBe(composed);
    expect(normalizeClaimStatement(decomposed)).toBe(decomposed);
    expect(normalizeClaimStatement(composed)).not.toBe(
      normalizeClaimStatement(decomposed),
    );
  });

  it("passes astral characters through untouched", () => {
    const statement = "ship \u{1f6a2} weekly";
    expect(normalizeClaimStatement(statement)).toBe(statement);
  });

  it("refuses a statement that is empty once normalized", () => {
    expect(() => claimId("decisions", "")).toThrow(ClaimIdentityError);
    expect(() => claimId("decisions", " \t\r\n ")).toThrow(ClaimIdentityError);
    // A statement of only a no-break space is NOT empty: U+00A0 is content.
    expect(claimId("decisions", " ")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("refuses a statement carrying an unpaired surrogate", () => {
    // This runtime would encode a lone surrogate as U+FFFD; others refuse
    // the encode or keep the surrogate. No identifier is the one answer
    // every implementation can give identically.
    expect(() => claimId("decisions", "broken \ud800 text")).toThrow(
      ClaimIdentityError,
    );
    expect(() => claimId("decisions", "broken \udfff text")).toThrow(
      ClaimIdentityError,
    );
    // A correctly paired surrogate is just an astral character.
    expect(claimId("decisions", "ok 😀 text")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("refuses a kind outside the six", () => {
    expect(() => claimId("nextSteps", "ship it")).toThrow(ClaimIdentityError);
    expect(() => claimId("sessionActivity", "x")).toThrow(ClaimIdentityError);
    expect(() => claimId("vibes", "x")).toThrow(ClaimIdentityError);
  });
});

describe("the identifier", () => {
  it("is 16 lowercase hexadecimal characters", () => {
    for (const kind of CLAIM_KINDS) {
      expect(claimId(kind, "a statement")).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("is stable across calls", () => {
    expect(claimId("decisions", "one queue per tenant")).toBe(
      claimId("decisions", "one queue per tenant"),
    );
  });

  it("differs across kinds for the same statement", () => {
    const ids = CLAIM_KINDS.map((kind) =>
      claimId(kind, "one queue per tenant"),
    );
    expect(new Set(ids).size).toBe(CLAIM_KINDS.length);
  });
});

describe("the property the corpus pins, exercised more widely", () => {
  /** A small deterministic generator, so a failure is reproducible. */
  function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  const POOL = [
    ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;",
    "é",
    "ß",
    "İ",
    "σ",
    " ",
    "世",
    "\u{1f6a2}",
  ];

  function randomStatement(random: () => number): string {
    const length = 1 + Math.floor(random() * 40);
    let out = "";
    for (let i = 0; i < length; i += 1) {
      out += random() < 0.15 ? " " : POOL[Math.floor(random() * POOL.length)];
    }
    return out;
  }

  /** Rewrite the statement in only the ways normalization erases. */
  function erasableMutation(statement: string, random: () => number): string {
    let out = "";
    for (const ch of statement) {
      if (ch === " ") {
        // Grow the run and vary its bytes; a run is one space either way.
        const runes = [" ", "\t", "\r", "\n"];
        const run = 1 + Math.floor(random() * 3);
        for (let i = 0; i < run; i += 1) {
          out += runes[Math.floor(random() * runes.length)];
        }
        continue;
      }
      if (ch >= "a" && ch <= "z" && random() < 0.5) {
        out += ch.toUpperCase();
        continue;
      }
      if (ch >= "A" && ch <= "Z" && random() < 0.5) {
        out += ch.toLowerCase();
        continue;
      }
      out += ch;
    }
    const pad = () => " \t\r\n".slice(0, Math.floor(random() * 4));
    return pad() + out + pad();
  }

  it("erasable rewrites never move the identifier", () => {
    const random = makeRandom(0x50696e73);
    for (let round = 0; round < 250; round += 1) {
      const statement = randomStatement(random);
      const kind = CLAIM_KINDS[Math.floor(random() * CLAIM_KINDS.length)]!;
      let original: string;
      try {
        original = claimId(kind, statement);
      } catch (error) {
        // A generated statement can normalize to empty; that refusal is
        // covered above and is not this property.
        expect(error).toBeInstanceOf(ClaimIdentityError);
        continue;
      }
      const mutated = erasableMutation(statement, random);
      expect(
        claimId(kind, mutated),
        JSON.stringify({ statement, mutated }),
      ).toBe(original);
    }
  });

  it("appending content always moves the identifier", () => {
    const random = makeRandom(0x536f696c);
    for (let round = 0; round < 250; round += 1) {
      const statement = randomStatement(random);
      const kind = CLAIM_KINDS[Math.floor(random() * CLAIM_KINDS.length)]!;
      let original: string;
      try {
        original = claimId(kind, statement);
      } catch {
        continue;
      }
      expect(claimId(kind, `${statement} more`)).not.toBe(original);
    }
  });
});

describe("the forbidden operations", () => {
  it("appear nowhere in the implementation", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "claim.ts"),
      "utf8",
    );
    // Strip comments: the prose names the rules; the code must not use the
    // built-ins the rules forbid.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const forbidden = [
      ".toLowerCase(",
      ".toLocaleLowerCase(",
      ".toUpperCase(",
      ".toLocaleUpperCase(",
      ".normalize(",
      ".trim(",
      ".trimStart(",
      ".trimEnd(",
      ".localeCompare(",
      "Intl.",
      "\\s",
    ];
    for (const marker of forbidden) {
      expect(code, marker).not.toContain(marker);
    }
  });
});
