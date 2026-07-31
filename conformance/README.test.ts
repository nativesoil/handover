/**
 * The conformance page, executed.
 *
 * `conformance/README.md` is how somebody outside this repository decides what
 * "Soil Compatible" means, so every claim in its prose is a claim about this
 * tree. Two kinds of claim had drifted, and they drifted for the same reason:
 * nothing compared the page to the thing it describes.
 *
 * THE COUNTS. The page used to print a per-runner check count. That count was
 * found wrong once and closed by writing a better number, which bound nothing,
 * and it was wrong again by half within one release. The remedy is not a third
 * number. A check count is a fact about how many assertions these runners
 * happen to make; nothing in `spec/` defines what one check is, so a port that
 * groups its assertions differently prints a different number while being
 * exactly as conformant, and this very page refuses elsewhere to bind a
 * contract the specification never defines. The counts are gone, and the first
 * test below is what keeps them gone: a document that cannot state an unbound
 * count cannot carry a stale one.
 *
 * THE CATEGORY TABLE. That table IS load-bearing — it is the map of what
 * conformance covers — and it is a closed list the runners already know. So it
 * is derived from a real run rather than maintained beside one. `text-unit`
 * and `closed-world` reached all five runners and no row followed them here.
 *
 * THE FOOTNOTE. The page explains why the `boundary` category cannot be folded
 * into `schema`, and that explanation is an executable claim about the
 * published schema: it observes none of the boundary's rules, and it does
 * state the text unit. Both halves are run below against the real schema and
 * the real fixtures, because a claim about a validator is worth exactly as
 * much as the run behind it.
 *
 * Nothing here hardcodes a value the page also states. Where a number or a
 * name appears in both, it is read out of the page and compared with what the
 * code produced.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import { runConformance, type ConformanceClass } from "./run.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PAGE_PATH = join(HERE, "README.md");
const PAGE = readFileSync(PAGE_PATH, "utf8");
const FIXTURES = join(HERE, "fixtures");

const REPORT = runConformance();

/** The rows of one of the page's own pipe tables, by its first heading. */
function tableRowsUnder(heading: string): string[][] {
  const from = PAGE.indexOf(`| ${heading}`);
  if (from < 0) throw new Error(`the page has no table headed "${heading}"`);
  const rows: string[][] = [];
  for (const line of PAGE.slice(from).split("\n")) {
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    rows.push(cells);
  }
  // The heading row is not a row of data.
  return rows.slice(1);
}

/** The category table, as the page states it: name, class, footnote markers. */
function statedCategories(): Map<
  string,
  { readonly stated: string; readonly footnotes: string }
> {
  const stated = new Map<
    string,
    { readonly stated: string; readonly footnotes: string }
  >();
  for (const [nameCell, classCell] of tableRowsUnder("Category")) {
    const name = /^`([a-z-]+)`$/.exec(nameCell ?? "")?.[1];
    if (name === undefined) {
      throw new Error(`a category row names no category: ${nameCell}`);
    }
    const raw = classCell ?? "";
    stated.set(name, {
      stated: raw.replace(/[¹²³]/g, "").trim(),
      footnotes: raw.replace(/[^¹²³]/g, ""),
    });
  }
  return stated;
}

/** The page's own words for a conformance class, from its own prose. */
const PAGE_WORD_FOR: Readonly<Record<ConformanceClass, string>> = {
  document: "document",
  "secure-writer": "secure writer",
};

/**
 * Every committed surface that shows what a conformance run prints.
 *
 * The rule below is about what such a surface may state, not about which file
 * states it, and a rule enforced on one file out of three is a rule with a
 * hole. The other two carried the same defect and staler numbers: both showed
 * 79 document and 39 secure writer checks, against runs reporting 252 and 104.
 */
const RUN_OUTPUT_SURFACES = [
  "conformance/README.md",
  "conformance/jvm/README.md",
  "packages/sdk-dotnet/README.md",
];

describe("no committed surface states an unbound check count", () => {
  it("carries no per-runner count on either class line", () => {
    // The exact shape that drifted twice: a class line with a number on it.
    // Each surface shows the output shape with a placeholder instead, so a
    // reader still sees what a run prints and no number is left to go stale.
    for (const surface of RUN_OUTPUT_SURFACES) {
      const text = readFileSync(join(ROOT, surface), "utf8");
      for (const line of text.split("\n")) {
        expect(
          line,
          `${surface} states a check count that nothing derives`,
        ).not.toMatch(/Soil (Document|Secure Writer) Conformant\s+\d+/);
      }
    }
  });

  it("still shows a reader what a run prints", () => {
    // Removing the numbers must not be achievable by removing the block: the
    // two classes are reported separately on purpose, and a surface that
    // stopped showing them would satisfy the rule above by saying nothing.
    expect(PAGE).toContain("soil conformance (typescript, spec 1.0)");
    for (const surface of RUN_OUTPUT_SURFACES) {
      const text = readFileSync(join(ROOT, surface), "utf8");
      expect(text, surface).toMatch(
        /Soil Document Conformant\s+<count> checks/,
      );
      expect(text, surface).toMatch(
        /Soil Secure Writer Conformant\s+<count> checks/,
      );
    }
  });

  it("tells a reader how to obtain the counts instead of stating them", () => {
    const invocation = /```bash\n([\s\S]*?)```/.exec(PAGE)?.[1] ?? "";
    expect(invocation).toContain("pnpm conformance");
  });
});

describe("the conformance page's category table", () => {
  it("names exactly the categories a run exercises", () => {
    const stated = [...statedCategories().keys()].sort();
    const exercised = [...REPORT.categories.keys()].sort();
    // Both directions: a category with no row fails, and a row with no
    // category fails too.
    expect(stated).toEqual(exercised);
  });

  it("gives each category a class its checks actually land in", () => {
    for (const [name, row] of statedCategories()) {
      const classes = REPORT.categories.get(name);
      expect(classes, `no run filed a check under \`${name}\``).toBeDefined();
      const words = [...classes!].map((c) => PAGE_WORD_FOR[c]);
      expect(
        words,
        `\`${name}\` is stated as "${row.stated}" and its checks land in ${words.join(" and ")}`,
      ).toContain(row.stated);
    }
  });

  it("footnotes exactly the categories whose checks split across classes", () => {
    // A category counting toward both classes is the interesting case, and the
    // page explains each one in a footnote. One that counts toward a single
    // class has nothing to explain, so a marker on it would be noise.
    for (const [name, row] of statedCategories()) {
      const classes = REPORT.categories.get(name)!;
      if (classes.size > 1) {
        expect(
          row.footnotes,
          `\`${name}\` files checks in both classes and the table says nothing about it`,
        ).not.toBe("");
      } else {
        expect(
          row.footnotes,
          `\`${name}\` files checks in one class only, so its footnote marker points at nothing`,
        ).toBe("");
      }
    }
    // Every marker the table uses is defined underneath it.
    for (const marker of new Set(
      [...statedCategories().values()].flatMap((row) => [...row.footnotes]),
    )) {
      expect(PAGE).toMatch(new RegExp(`^${marker} `, "m"));
    }
  });

  it("keeps the `schema` and `mcp` claim true of the run", () => {
    // The page says those two run in the TypeScript runner only. This runner
    // is the TypeScript one, so what it can show is that both are here; the
    // other four runners are executed by `pnpm conformance`, and no single CI
    // job in this repository holds all five toolchains at once.
    expect(PAGE).toContain(
      "because the `schema` and\n`mcp` categories run there only",
    );
    expect([...REPORT.categories.keys()]).toContain("schema");
    expect([...REPORT.categories.keys()]).toContain("mcp");
  });
});

describe("the conformance page's runner table", () => {
  it("names an invocation for every runner, each pointing at something real", () => {
    const rows = tableRowsUnder("Runner");
    expect(rows.length).toBeGreaterThan(0);
    // The path each invocation drives, and the file that has to exist for the
    // documented command to be runnable at all.
    const targets: Readonly<Record<string, string>> = {
      TypeScript: "conformance/run.ts",
      Python: "conformance/run_py.py",
      Go: "conformance/go/main.go",
      JVM: "packages/sdk-jvm/gradlew",
      ".NET": "conformance/dotnet/Soil.Conformance.csproj",
    };
    const named = rows.map(([runner]) => runner!);
    expect(named.sort()).toEqual(Object.keys(targets).sort());
    for (const [runner, invocation] of rows) {
      expect(invocation, `${runner} states no invocation`).toMatch(/^`.+`/);
      expect(() =>
        readFileSync(join(ROOT, targets[runner!]!), "utf8"),
      ).not.toThrow();
    }
  });
});

describe("the conformance page's account of the schema, executed", () => {
  const schema = JSON.parse(
    readFileSync(join(ROOT, "spec/handover.schema.json"), "utf8"),
  ) as object;
  const ajv = new Ajv2020.default({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const bySchema = ajv.compile(schema);

  const manifest = JSON.parse(
    readFileSync(join(FIXTURES, "manifest.json"), "utf8"),
  ) as {
    boundary: readonly {
      file?: string;
      ingest: string;
    }[];
  };

  it("observes none of the boundary's rules on a refused fixture", () => {
    // The footnote's claim: a schema validator is handed an already-constructed
    // value, so the evidence for these rules is gone before it looks. Run it.
    // Every committed boundary fixture the ingestion layer refuses, and that
    // parses as JSON at all, must still satisfy the published schema OR fail it
    // for some unrelated reason — what must never happen is the schema catching
    // the boundary rule itself, because then the two layers would be redundant
    // and the footnote would be wrong.
    const refused = manifest.boundary.filter(
      (entry) => entry.file !== undefined && entry.ingest !== "accepted",
    );
    expect(refused.length).toBeGreaterThan(0);

    let parseable = 0;
    for (const entry of refused) {
      let doc: unknown;
      try {
        doc = JSON.parse(readFileSync(join(FIXTURES, entry.file!), "utf8"));
      } catch {
        // Not valid UTF-8 or not well-formed JSON: a schema validator is never
        // handed one of these at all, which is the same point by a shorter
        // route.
        continue;
      }
      parseable += 1;
      // The document reached a schema validator intact, so whatever the
      // boundary refused it for is invisible here. A schema validator that
      // rejected it would have to be rejecting something else.
      const verdict = bySchema(doc);
      const caught = (bySchema.errors ?? []).some((error) =>
        ["maximum", "minimum", "type", "multipleOf"].includes(error.keyword),
      );
      expect(
        caught,
        `${entry.file}: the schema reported a numeric or type keyword, so it is observing a boundary rule`,
      ).toBe(false);
      void verdict;
    }
    // The claim is worth nothing if every fixture took the unparseable route.
    expect(parseable).toBeGreaterThan(0);
  });

  it("does state the text unit, in code points", () => {
    // The other half of the footnote, and the reason `text-unit` is its own
    // category rather than a boundary rule. One astral character is one code
    // point, two UTF-16 code units and four UTF-8 bytes, so a title of exactly
    // the bound's worth of them separates the three candidate units.
    const bound = Number(
      /\| `title` +\| (\d+) +\|/.exec(
        readFileSync(join(ROOT, "spec/value-domain.md"), "utf8"),
      )?.[1],
    );
    expect(Number.isInteger(bound)).toBe(true);

    const example = JSON.parse(
      readFileSync(join(ROOT, "examples/orchard-checkout.json"), "utf8"),
    ) as Record<string, unknown>;
    const astral = String.fromCodePoint(0x1f600);

    const at = { ...example, title: astral.repeat(bound) };
    expect(
      bySchema(at),
      "the schema refuses a title at its bound in code points, so it is not counting code points",
    ).toBe(true);
    expect((at["title"] as string).length).toBeGreaterThan(bound);

    const over = { ...example, title: astral.repeat(bound + 1) };
    expect(
      bySchema(over),
      "the schema accepts a title one code point past its bound",
    ).toBe(false);
    expect(
      (bySchema.errors ?? []).some((error) => error.keyword === "maxLength"),
    ).toBe(true);
  });
});

/**
 * The conformance diagram's counts.
 *
 * `docs/diagrams/conformance-contract.svg` states five figures about the
 * fixture corpus, in three places at once: the drawing's own labels, the
 * `<desc>` a screen reader gets, and the alt text in conformance/README.md.
 * All five were correct on the day they were drawn and derived by nothing, and
 * the prose under the embed said so out loud — "as they stand today". A drawing
 * is the worst place for an unbound count, because a reader cannot run it and
 * the number sits inside three copies that have to move together.
 *
 * So all three copies are read here and held to the manifest.
 */
describe("the conformance diagram's counts", () => {
  const DIAGRAM = "docs/diagrams/conformance-contract.svg";
  const svg = readFileSync(join(ROOT, DIAGRAM), "utf8");
  const manifest = JSON.parse(
    readFileSync(join(FIXTURES, "manifest.json"), "utf8"),
  ) as Record<string, readonly { file?: string; kind?: string }[]>;

  /** The four fixture groups the drawing labels, and what each really holds. */
  const GROUPS = ["valid", "invalid", "restore", "boundary"] as const;

  /** Small cardinals, as the drawing's prose writes them. */
  const WORDS: Readonly<Record<string, number>> = {
    four: 4,
    eleven: 11,
    twelve: 12,
    "twenty-nine": 29,
    "thirty-five": 35,
  };

  it("labels each fixture group with the length of that list", () => {
    for (const group of GROUPS) {
      // The drawing writes `valid · 11` as a label with the count in a tspan.
      const drawn = new RegExp(`>${group} <tspan[^>]*>· (\\d+)</tspan>`).exec(
        svg,
      )?.[1];
      expect(
        drawn,
        `${DIAGRAM} has no drawn count for \`${group}\``,
      ).toBeDefined();
      expect(Number(drawn), `${DIAGRAM} draws ${drawn} for \`${group}\``).toBe(
        manifest[group]!.length,
      );
    }
  });

  /**
   * Every spelled cardinal in a passage, as a set of numbers.
   *
   * The description and the alt text say the same things in different words —
   * one calls the restore list "four restore-rendering fixtures", the other
   * "four valid documents whose rendering into a restore prompt is what is
   * judged" — so matching phrases would bind the wording rather than the
   * figures. What must hold is narrower and stronger: every number either copy
   * states is a real length of a real list, and no such length is missing.
   */
  const cardinalsIn = (passage: string): Set<number> => {
    const found = new Set<number>();
    for (const [word, value] of Object.entries(WORDS)) {
      if (new RegExp(`\\b${word}\\b`, "i").test(passage)) found.add(value);
    }
    return found;
  };

  /** The figures the drawing is entitled to state, from the manifest. */
  const realFigures = (): Set<number> =>
    new Set([
      ...GROUPS.map((group) => manifest[group]!.length),
      manifest["invalid"]!.filter((entry) => entry.kind === "safety").length,
      GROUPS.length,
    ]);

  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);

  it("describes the corpus with figures that are all real lengths", () => {
    const desc = /<desc[^>]*>([\s\S]*?)<\/desc>/.exec(svg)?.[1] ?? "";
    expect(desc).not.toBe("");
    expect(sorted(cardinalsIn(desc))).toEqual(sorted(realFigures()));
  });

  it("puts the same figures in the page's alt text", () => {
    // Two copies of one description, and only one of them is read by a screen
    // reader. They drift the moment somebody edits whichever they happened to
    // open, so both are held to the manifest rather than to each other.
    const alt =
      /!\[([^\]]+)\]\(\.\.\/docs\/diagrams\/conformance-contract\.svg\)/.exec(
        PAGE,
      )?.[1];
    expect(
      alt,
      "the page no longer embeds the conformance diagram",
    ).toBeDefined();
    expect(sorted(cardinalsIn(alt!))).toEqual(sorted(realFigures()));
  });

  it("counts the credential-shaped fixtures the schema accepts, and runs the claim", () => {
    // The drawing says twelve of the invalid documents carry credential-shaped
    // material and that the published schema accepts every one of them. Both
    // halves are checked: the count against the manifest, and the acceptance
    // against the real schema.
    const desc = /<desc[^>]*>([\s\S]*?)<\/desc>/.exec(svg)?.[1] ?? "";
    const word =
      /(\S+) of the \S+ invalid documents carry credential-shaped/.exec(
        desc,
      )?.[1];
    expect(word, "the description no longer makes the claim").toBeDefined();

    const safety = manifest["invalid"]!.filter(
      (entry) => entry.kind === "safety",
    );
    expect(WORDS[word!.toLowerCase()]).toBe(safety.length);

    const schema = JSON.parse(
      readFileSync(join(ROOT, "spec/handover.schema.json"), "utf8"),
    ) as object;
    const ajv = new Ajv2020.default({ allErrors: true, strict: false });
    addFormats.default(ajv);
    const bySchema = ajv.compile(schema);
    for (const entry of safety) {
      const doc = JSON.parse(readFileSync(join(FIXTURES, entry.file!), "utf8"));
      expect(
        bySchema(doc),
        `${entry.file} carries credential-shaped material and the schema does NOT accept it, so "passing the schema alone is not conformance" is not what this fixture shows`,
      ).toBe(true);
    }
  });

  it("states the drawn counts nowhere else in prose", () => {
    // The embed used to be followed by a sentence conceding the counts were
    // "as they stand today". A count that needs that caveat is a count nothing
    // holds; the caveat is gone and this is what keeps it gone.
    expect(PAGE).not.toContain("as they stand today");
  });
});

/**
 * What the published schema cannot see, stated in three places and measured
 * here.
 *
 * `spec/handover.schema.json` carries a `$comment` warning an implementer who
 * reads only the schema which rules they would miss. `AGENTS.md` summarises the
 * same thing for an agent finding its way around. Both stated a COUNT of those
 * rules, and the two counts disagreed: the guide said three, the schema said
 * four. Neither was right. Measured against the real schema, five of the
 * ingestion boundary's rules are invisible to it — the guide's three, plus the
 * numeric domain the schema had already added, plus the size ceiling that
 * nobody had.
 *
 * The rules come from `spec/ingestion.md`'s own error-code table, so a code
 * added there without a decision about this list fails the first test below.
 * Each one is then RUN against the published schema rather than reasoned about.
 */
describe("the rules the published schema cannot observe", () => {
  const ingestion = readFileSync(join(ROOT, "spec/ingestion.md"), "utf8");
  const schemaText = readFileSync(
    join(ROOT, "spec/handover.schema.json"),
    "utf8",
  );
  const schema = JSON.parse(schemaText) as { $comment: string };
  const ajv = new Ajv2020.default({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const bySchema = ajv.compile(schema as object);
  const base = () =>
    JSON.parse(
      readFileSync(join(ROOT, "examples/orchard-checkout.json"), "utf8"),
    ) as Record<string, unknown>;

  /**
   * Each boundary error code, grouped into the rule it enforces.
   *
   * `syntax.invalid_json` is the one code that names no rule the schema is
   * missing: a schema validator is handed a value that has already parsed, so
   * an unparseable document never reaches it in the first place. That is a
   * precondition rather than a gap, and it is listed here so the completeness
   * check below has to account for it rather than quietly skip it.
   */
  const RULE_OF_CODE: Readonly<Record<string, string>> = {
    "document.too_large": "size",
    "encoding.byte_order_mark": "encoding",
    "encoding.unsupported_encoding": "encoding",
    "encoding.invalid_utf8": "encoding",
    "structure.depth_exceeded": "depth",
    "structure.duplicate_member": "duplicate members",
    "number.not_an_integer": "the numeric domain",
    "number.out_of_range": "the numeric domain",
    "syntax.invalid_json": "a precondition, not a gap",
  };

  /** The codes the specification's own error table publishes. */
  const publishedCodes = (): string[] => {
    const from = ingestion.indexOf("## Error codes");
    expect(from, "spec/ingestion.md has no error code table").toBeGreaterThan(
      0,
    );
    const region = ingestion.slice(from, ingestion.indexOf("\n## ", from + 1));
    // Digits belong in a code: `encoding.invalid_utf8` is one.
    return [...region.matchAll(/^\| `([a-z0-9_.]+)`/gm)].map((m) => m[1]!);
  };

  it("accounts for every error code the specification publishes", () => {
    const codes = publishedCodes();
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      expect(
        RULE_OF_CODE[code],
        `spec/ingestion.md publishes \`${code}\` and nothing here decides whether the schema can observe it`,
      ).toBeDefined();
    }
    // And nothing here claims a code the specification does not publish.
    for (const code of Object.keys(RULE_OF_CODE)) {
      expect(codes, `\`${code}\` is no longer a published code`).toContain(
        code,
      );
    }
  });

  /**
   * One document the schema accepts, with exactly one rule broken. A fixture
   * the schema rejects for an unrelated reason would prove nothing, which is
   * why none of these are boundary fixtures.
   */
  const violations: Readonly<Record<string, () => Record<string, unknown>>> = {
    size: () => {
      const doc = base();
      // Past 1048576 bytes with every bounded string still inside its bound:
      // the bulk goes in free-form observation payloads, which are not bounded
      // per string.
      doc["observations"] = Array.from({ length: 60 }, () => ({
        kind: "schema.bulk",
        producedBy: "conformance-page-test",
        data: { filler: "a".repeat(20000) },
      }));
      return doc;
    },
    encoding: () => {
      // The bytes opened with a byte order mark; a reader that strips it and
      // parses hands a schema validator exactly this.
      const text = JSON.stringify(base());
      const withMark = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(text, "utf8"),
      ]);
      return JSON.parse(withMark.toString("utf8").replace(/^﻿/, ""));
    },
    "duplicate members": () => {
      // The text repeats `title`; the parser keeps one and the duplicate is
      // gone before any validator looks.
      const text = JSON.stringify(base()).replace(
        '{"soilHandover"',
        '{"title":"the copy that loses","soilHandover"',
      );
      return JSON.parse(text);
    },
    depth: () => {
      const doc = base();
      let deep: unknown = { bottom: true };
      for (let i = 0; i < 40; i += 1) deep = { down: deep };
      doc["observations"] = [
        {
          kind: "schema.deep",
          producedBy: "conformance-page-test",
          data: deep,
        },
      ];
      return doc;
    },
    "the numeric domain": () => {
      const doc = base();
      doc["observations"] = [
        {
          kind: "schema.number",
          producedBy: "conformance-page-test",
          // One past the safe-integer range, which a reader with doubles has
          // already rounded by the time a value exists.
          data: JSON.parse('{"n": 9007199254740992}'),
        },
      ];
      return doc;
    },
  };

  it("starts from a document the schema does accept", () => {
    // The control. Without it every result below would be explained equally
    // well by the example having gone invalid.
    expect(bySchema(base())).toBe(true);
  });

  it("cannot observe any of them, run one rule at a time", () => {
    for (const [rule, build] of Object.entries(violations)) {
      expect(
        bySchema(build()),
        `the schema rejected a document whose only fault is ${rule}, so it CAN observe that rule and the comment in spec/handover.schema.json is wrong`,
      ).toBe(true);
    }
  });

  it("names every one of them in the schema's own comment", () => {
    // The comment is the warning an implementer who reads only the schema
    // gets. A rule missing from it is a rule they will not know they need.
    const NAMED_BY: Readonly<Record<string, RegExp>> = {
      size: /must not exceed \d+ bytes/,
      encoding: /UTF-8 with no byte order mark/,
      "duplicate members": /must not repeat a member name inside one object/,
      depth: /must not nest more than \d+ levels/,
      "the numeric domain": /integer in the safe-integer range/,
    };
    for (const rule of Object.keys(violations)) {
      expect(
        schema.$comment,
        `the schema's comment does not name the ${rule} rule`,
      ).toMatch(NAMED_BY[rule]!);
    }
    // Every rule the comment must name is one this test just ran, so the two
    // lists cannot part company.
    expect(Object.keys(NAMED_BY).sort()).toEqual(
      Object.keys(violations).sort(),
    );
  });

  it("states no count of them, in the schema or in the agent guide", () => {
    // Both surfaces used to, and both were wrong. The enumeration in the
    // schema's comment is the payload; a numeral beside it is one more thing
    // to get out of step with the list it is counting.
    expect(schema.$comment).not.toMatch(
      /\b(two|three|four|five|six|seven|eight|nine|ten|\d+) normative rules\b/i,
    );
    const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
    expect(
      agents,
      "AGENTS.md counts the rules the schema cannot state, and every count of them written so far has been wrong",
    ).not.toMatch(
      /\b(two|three|four|five|six|seven|eight|nine|ten|\d+) rules the schema cannot state\b/i,
    );
    // And it still points at them, so the rule above is not satisfied by
    // deleting the mention.
    expect(agents).toMatch(/the rules the schema cannot state/);
  });
});

/**
 * The remaining counts on the conformance surfaces, each held to the thing it
 * counts.
 *
 * Small, correct on the day they were written, and derived by nothing — the
 * same shape as every other member of this class. Grouped here because the
 * manifest and the page are already loaded above, so binding them costs a few
 * lines each and leaving them cost a sweep result nobody could rely on.
 */
describe("the smaller counts on the conformance surfaces", () => {
  const manifest = JSON.parse(
    readFileSync(join(FIXTURES, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;

  /** Small cardinals as this repository's prose writes them. */
  const VALUE: Readonly<Record<string, number>> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    sixteen: 16,
    seventeen: 17,
  };
  /**
   * A spelled cardinal as a number, refusing anything it does not know.
   *
   * Returning undefined for an unrecognised word would still fail the
   * comparison below, but it would fail saying "expected undefined to be 16",
   * which sends the next reader looking at the fixture rather than at the
   * word. A count check whose failure misdirects is most of a count check
   * that nobody trusts.
   */
  const spelled = (word: string): number => {
    const value = VALUE[word.toLowerCase()];
    if (value === undefined) {
      throw new Error(
        `"${word}" is not a cardinal this check knows; add it to VALUE if the prose means it`,
      );
    }
    return value;
  };

  it("the page's count of the fixture lists is the number of lists", () => {
    // "the lengths of the four lists in `fixtures/manifest.json`".
    const stated = /the lengths of the (\w+) lists in/.exec(PAGE)?.[1];
    expect(
      stated,
      "the page no longer says how many fixture lists there are",
    ).toBeDefined();
    const lists = Object.entries(manifest)
      .filter(([, value]) => Array.isArray(value))
      .map(([key]) => key);
    expect(spelled(stated!), `the page says "${stated}"`).toBe(lists.length);
  });

  it("the two boundary fixtures that pin the scan are two", () => {
    // spec/ingestion.md: "Two fixtures pin it." The page's footnote makes the
    // same claim as "Except two". Both count the boundary fixtures that are
    // ACCEPTED and must then be refused by the fail-closed scan, which is the
    // pair that proves "accepted" and "scanned" are the same set.
    const pinned = (
      manifest["boundary"] as readonly { afterIngest?: string }[]
    ).filter((entry) => entry.afterIngest === "refused-by-safety");

    const ingestion = readFileSync(join(ROOT, "spec/ingestion.md"), "utf8");
    const inSpec = /(\w+) fixtures pin it/i.exec(ingestion)?.[1];
    expect(inSpec, "spec/ingestion.md no longer makes the claim").toBeDefined();
    expect(spelled(inSpec!), `spec/ingestion.md says "${inSpec}"`).toBe(
      pinned.length,
    );

    const inFootnote = /^² Except (\w+):/m.exec(PAGE)?.[1];
    expect(
      inFootnote,
      "the page's footnote no longer makes the claim",
    ).toBeDefined();
    expect(spelled(inFootnote!), `the footnote says "${inFootnote}"`).toBe(
      pinned.length,
    );
  });

  it("the thin fixture's note counts that fixture's own sections", () => {
    // "Sixteen sections missing and one honest sentence explaining why."
    const entry = (
      manifest["valid"] as readonly { file: string; note?: string }[]
    ).find((candidate) => candidate.file.includes("thin-but-honest"));
    expect(
      entry,
      "the thin-but-honest fixture is no longer registered",
    ).toBeDefined();

    const note = entry!.note ?? "";
    const missingWord = /(\w+) sections missing/i.exec(note)?.[1];
    const sentenceWord = /and (\w+) honest sentence/i.exec(note)?.[1];
    expect(
      missingWord,
      "the note no longer counts the missing sections",
    ).toBeDefined();
    expect(
      sentenceWord,
      "the note no longer counts the honest sentence",
    ).toBeDefined();

    const fixture = JSON.parse(
      readFileSync(join(FIXTURES, entry!.file), "utf8"),
    ) as { sections: Record<string, { status: string }> };
    const sections = Object.values(fixture.sections);
    const missing = sections.filter(
      (section) => section.status === "missing",
    ).length;

    expect(spelled(missingWord!), `the note says "${missingWord}"`).toBe(
      missing,
    );
    expect(spelled(sentenceWord!), `the note says "${sentenceWord}"`).toBe(
      sections.length - missing,
    );
  });
});
