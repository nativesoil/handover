import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { invocationFrom, run, type CliEnvironment } from "./index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const EXAMPLE = join(ROOT, "examples/orchard-checkout.json");

class Recorder {
  out = "";
  err = "";
  stdin = "";
  home: string;

  constructor(home: string) {
    this.home = home;
  }

  get env(): CliEnvironment {
    return {
      stdout: (text) => {
        this.out += text;
      },
      stderr: (text) => {
        this.err += text;
      },
      // Bytes, matching the real CliEnvironment: a raw document reaches the
      // ingestion boundary undecoded, so a test that handed over a string
      // would exercise a path the CLI does not have.
      readStdin: async () => new TextEncoder().encode(this.stdin),
      readFile: (path) => readFileSync(path),
      env: { SOIL_HOME: this.home },
      now: () => new Date("2026-07-22T10:00:00Z"),
    };
  }
}

let home: string;
let io: Recorder;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "soil-cli-test-"));
  io = new Recorder(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("soil", () => {
  it("prints help with no arguments", async () => {
    expect(await run([], io.env)).toBe(0);
    expect(io.out).toContain("save the project state");
    expect(io.out).toContain("soil load");
  });

  it("prints the store location", async () => {
    await run(["where"], io.env);
    expect(io.out.trim()).toBe(home);
  });

  it("rejects an unknown command with the help text", async () => {
    expect(await run(["frobnicate"], io.env)).toBe(2);
    expect(io.err).toContain('unknown command "frobnicate"');
  });
});

describe("soil save", () => {
  it("prints the recipe and how to paste the reply back", async () => {
    expect(await run(["save"], io.env)).toBe(0);
    expect(io.out).toContain("SOIL HANDOVER EXTRACTION");
    expect(io.out).toContain("RULE 1");
    expect(io.out).toContain("restoreInstructions:");
    expect(io.out).toContain("soil save -");
  });

  // Nothing on a from-source checkout puts a bare `soil` on the PATH: the
  // documented install builds the repo and runs `node .../bin/soil.js`, and
  // the alias is offered as something the user may decline. The trailer used
  // to print `soil save -` regardless, which is an instruction that fails for
  // exactly the reader who has just been handed the recipe.
  it("tells the reader to run the command they actually have", async () => {
    const env: CliEnvironment = {
      ...io.env,
      invocation: "node /checkout/packages/cli/bin/soil.js",
    };
    expect(await run(["save"], env)).toBe(0);
    expect(io.out).toContain("node /checkout/packages/cli/bin/soil.js save -");
  });
});

describe("the invocation the CLI echoes back", () => {
  it("is the bare name when an installed bin is on the PATH", () => {
    expect(invocationFrom("/usr/local/bin/soil")).toBe("soil");
    expect(invocationFrom("/repo/node_modules/.bin/soil")).toBe("soil");
  });

  it("is the runnable node form for a script path", () => {
    expect(invocationFrom("/checkout/packages/cli/bin/soil.js")).toBe(
      "node /checkout/packages/cli/bin/soil.js",
    );
  });

  it("falls back to the bare name when there is no script path", () => {
    expect(invocationFrom(undefined)).toBe("soil");
    expect(invocationFrom("")).toBe("soil");
  });

  it("stores a handover from a file and prints the card", async () => {
    expect(await run(["save", EXAMPLE], io.env)).toBe(0);
    expect(io.out).toContain("handover saved");
    expect(io.out).toContain("#001");
    expect(io.out).toContain("17 / 17 sections carrying content");
    expect(io.out).toContain("❯ soil load #001");
  });

  it("prints only the code with --quiet", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    expect(io.out.trim()).toBe("#001");
  });

  it("reads a model reply on stdin, prose and fences included", async () => {
    io.stdin = [
      "Here you go:",
      "```json",
      JSON.stringify({
        projectId: "pasted",
        title: "Pasted from a thread",
        createdAt: "2026-07-22T10:00:00Z",
        extractionSections: { decisions: "We chose plain files." },
      }),
      "```",
    ].join("\n");
    expect(await run(["save", "-"], io.env)).toBe(0);
    expect(io.out).toContain("1 / 17 sections carrying content");
  });

  it("fails closed on a secret, naming the section and the class", async () => {
    io.stdin = JSON.stringify({
      projectId: "leaky",
      title: "Leaky",
      createdAt: "2026-07-22T10:00:00Z",
      extractionSections: { architecture: "The key is sk-abc123def456." },
    });
    expect(await run(["save", "-"], io.env)).toBe(1);
    expect(io.err).toContain("refused · secret material");
    expect(io.err).toContain("nothing was stored");
    expect(io.err).toContain("/sections/architecture/summary");
    expect(io.err).toContain("provider_api_key");
    expect(io.err).not.toContain("sk-abc123def456");
  });

  it("says so when there is no JSON at all", async () => {
    io.stdin = "I would rather not";
    expect(await run(["save", "-"], io.env)).toBe(1);
    expect(io.err).toContain("no JSON found");
  });
});

describe("soil load", () => {
  it("prints the card and then the restore prompt", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    io.out = "";
    expect(await run(["load", "#001"], io.env)).toBe(0);
    expect(io.out).toContain("handover loaded");
    // The boundary is generated per render, so the assertion is on the shape
    // of the marked banner rather than on a fixed delimiter.
    expect(io.out).toMatch(/^=== soil:[0-9a-f]{32} BOOT PROMPT ===$/m);
    expect(io.out).toMatch(/^=== soil:[0-9a-f]{32} KNOWN GAPS ===$/m);
  });

  it("defaults to the most recent handover", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    io.out = "";
    await run(["load"], io.env);
    expect(io.out).toContain("#001");
  });

  it("prints the raw document with --json", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    io.out = "";
    await run(["load", "#001", "--json"], io.env);
    expect(JSON.parse(io.out)).toMatchObject({ code: "#001" });
  });

  it("points at soil list when the code does not exist", async () => {
    expect(await run(["load", "#404"], io.env)).toBe(1);
    expect(io.err).toContain("soil list");
  });
});

describe("soil list", () => {
  it("says the store is empty before anything is saved", async () => {
    await run(["list"], io.env);
    expect(io.out).toContain("nothing saved yet");
  });

  it("lists what is stored, newest first", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    await run(["save", EXAMPLE, "--quiet"], io.env);
    io.out = "";
    await run(["list"], io.env);
    expect(io.out.indexOf("#002")).toBeLessThan(io.out.indexOf("#001"));
  });
});

describe("soil validate", () => {
  it("passes the worked example", async () => {
    expect(await run(["validate", EXAMPLE], io.env)).toBe(0);
    expect(io.out).toContain("valid handover");
  });

  it("fails and lists the problems", async () => {
    io.stdin = JSON.stringify({ soilHandover: "1.0" });
    expect(await run(["validate", "-"], io.env)).toBe(1);
    expect(io.out).toContain("/projectId");
  });

  it("needs an argument", async () => {
    expect(await run(["validate"], io.env)).toBe(2);
  });
});

describe("soil check", () => {
  const THIN = join(ROOT, "conformance/fixtures/valid/thin-but-honest.json");

  it("checks the worked example from a file and exits 0", async () => {
    expect(await run(["check", EXAMPLE], io.env)).toBe(0);
    expect(io.out).toContain("handover checked");
    expect(io.out).toContain("adequate");
    expect(io.out).toContain("only a real load");
  });

  it("checks a stored handover by code", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    io.out = "";
    expect(await run(["check", "#001"], io.env)).toBe(0);
    expect(io.out).toContain("handover checked");
    expect(io.out).toContain("#001");
  });

  it("exits 1 for a thin handover, so a script can gate on it", async () => {
    expect(await run(["check", THIN], io.env)).toBe(1);
    expect(io.out).toContain("thin");
  });

  it("needs an argument", async () => {
    expect(await run(["check"], io.env)).toBe(2);
  });

  it("prints the report as JSON with --json", async () => {
    await run(["check", EXAMPLE, "--json"], io.env);
    const report = JSON.parse(io.out) as {
      grade: string;
      findings: unknown[];
      counts: { problems: number };
    };
    expect(report.grade).toBe("adequate");
    expect(report.counts.problems).toBe(0);
    expect(Array.isArray(report.findings)).toBe(true);
  });

  it("does not touch the stored file without --attach", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    io.out = "";
    await run(["check", "#001"], io.env);
    const raw = JSON.parse(
      readFileSync(join(home, "handovers", "001.json"), "utf8"),
    ) as { observations?: unknown };
    expect(raw.observations).toBeUndefined();
  });

  it("attaches the report as a quality.capture observation with --attach", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    const before = JSON.parse(
      readFileSync(join(home, "handovers", "001.json"), "utf8"),
    ) as { handoverId: string };
    io.out = "";
    expect(await run(["check", "#001", "--attach"], io.env)).toBe(0);
    expect(io.out).toContain("report attached to #001");

    const after = JSON.parse(
      readFileSync(join(home, "handovers", "001.json"), "utf8"),
    ) as {
      handoverId: string;
      code: string;
      observations: {
        kind: string;
        producedBy: string;
        producedAt: string;
        data: Record<string, unknown>;
      }[];
    };
    expect(after.handoverId).toBe(before.handoverId);
    expect(after.code).toBe("#001");
    expect(after.observations).toHaveLength(1);
    expect(after.observations[0]?.kind).toBe("quality.capture");
    expect(after.observations[0]?.producedBy).toBe("soil-cli/0.2.0");
    expect(after.observations[0]?.producedAt).toBe("2026-07-22T10:00:00.000Z");
    // The report keeps its grade; the document never receives one.
    expect(after.observations[0]?.data["grade"]).toBeUndefined();
    expect(after.observations[0]?.data["counts"]).toBeUndefined();
    expect(after.observations[0]?.data["sectionsWithContent"]).toBe(17);
    expect(after.observations[0]?.data["missingSections"]).toEqual([]);
    expect(after.observations[0]?.data["blockedSections"]).toEqual([]);
    expect(Object.keys(after.observations[0]?.data ?? {}).sort()).toEqual([
      "blockedSections",
      "checkVersion",
      "findings",
      "missingSections",
      "notes",
      "sectionsWithContent",
    ]);
  });

  it("round trips: an attached handover still validates, loads and checks", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    await run(["check", "#001", "--attach"], io.env);
    io.out = "";
    expect(await run(["load", "#001"], io.env)).toBe(0);
    expect(io.out).toContain("handover loaded");
    io.out = "";
    expect(await run(["check", "#001"], io.env)).toBe(0);
  });

  it("refuses --attach for a file target, which has no stored identity", async () => {
    expect(await run(["check", EXAMPLE, "--attach"], io.env)).toBe(2);
    expect(io.err).toContain("--attach");
  });

  it("points at soil list when the code does not exist", async () => {
    expect(await run(["check", "#404"], io.env)).toBe(1);
    expect(io.err).toContain("soil list");
  });
});

describe("soil render and soil rescue", () => {
  it("renders a stored handover", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    io.out = "";
    expect(await run(["render", "#001"], io.env)).toBe(0);
    expect(io.out).toContain("handover loaded");
  });

  it("renders a handover from a file", async () => {
    expect(await run(["render", EXAMPLE], io.env)).toBe(0);
    expect(io.out).toContain("17 / 17 sections carrying content");
  });

  it("prints the rescue prompt for a dead thread", async () => {
    expect(await run(["rescue"], io.env)).toBe(0);
    expect(io.out).toContain("Output ONE fenced");
    expect(io.out).toContain("extractionSections");
  });
});

describe("working-style evidence on soil load", () => {
  function documentWith(observations: unknown): string {
    return JSON.stringify({
      projectId: "style-test",
      title: "Carries recorded instances",
      createdAt: "2026-07-22T10:00:00Z",
      sections: {
        decisions: "Plain files, because they move.",
        workflow: "Tests run before anything is trusted.",
      },
      observations,
    });
  }

  const RECORDED = [
    {
      kind: "working.style",
      producedBy: "@nativesoil/handover-mcp 0.1.0",
      producedAt: "2026-07-22T09:00:00Z",
      data: {
        instances: [
          {
            situation: "How the last blocker was handled",
            response:
              "The build broke on a missing export. The thread read the failing file, added the export, and re-ran the build before continuing.",
          },
        ],
      },
    },
  ];

  it("prints the evidence block after the restore prompt, with attribution", async () => {
    io.stdin = documentWith(RECORDED);
    expect(await run(["save", "-", "--quiet"], io.env)).toBe(0);
    io.out = "";
    expect(await run(["load", "#001"], io.env)).toBe(0);
    // The heading carries this render's marker, like every other heading in
    // the prompt, so nothing in the document can spell one.
    expect(io.out).toMatch(
      /^=== soil:[0-9a-f]{32} WORKING STYLE, RECORDED INSTANCES ===$/m,
    );
    expect(io.out).toContain("Evidence from @nativesoil/handover-mcp 0.1.0");
    expect(io.out).toContain("recorded 2026-07-22T09:00:00Z");
    expect(io.out).toContain("the section wins");
    expect(io.out.indexOf("the section wins")).toBeGreaterThan(
      io.out.indexOf("HOW TO START"),
    );
  });

  it("never renders a count, score or grade from observations", async () => {
    io.stdin = documentWith(RECORDED);
    await run(["save", "-", "--quiet"], io.env);
    io.out = "";
    await run(["load", "#001"], io.env);
    expect(io.out).not.toMatch(/\d+\s*(?:of|\/)?\s*\d*\s*instances?/i);
    expect(io.out).not.toMatch(/grade|score/i);
  });

  it("shows a payload in a shape it did not expect, rather than dropping it", async () => {
    // `instances` is the documented shape, and a payload that is not in it is
    // still the document's content. The load carries it under its own key: a
    // reader that silently discards what it cannot file has lost the evidence
    // and said nothing about it.
    io.stdin = documentWith([
      { kind: "working.style", data: { instances: "not an array" } },
    ]);
    await run(["save", "-", "--quiet"], io.env);
    io.out = "";
    expect(await run(["load", "#001"], io.env)).toBe(0);
    expect(io.out).toContain("- instances: not an array");
  });

  it("shows nothing for an observation whose payload carries nothing", async () => {
    io.stdin = documentWith([{ kind: "working.style", data: {} }]);
    await run(["save", "-", "--quiet"], io.env);
    io.out = "";
    expect(await run(["load", "#001"], io.env)).toBe(0);
    expect(io.out).not.toContain("WORKING STYLE");
  });

  it("shows nothing extra for a quality.capture observation", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    await run(["check", "#001", "--attach"], io.env);
    io.out = "";
    await run(["load", "#001"], io.env);
    expect(io.out).not.toContain("WORKING STYLE");
  });
});

/**
 * The defect this suite exists to keep closed: `soil save` and `soil validate`
 * used to give opposite answers about the same bytes.
 *
 * Save normalized before it validated, rebuilt the document from a whitelist,
 * and dropped every unknown top-level field, section field, provenance label
 * and unknown section key on the way. Five documents the validator rejected
 * were stored with success, and the stored document still claimed the higher
 * version number whose content had just been stripped.
 */
describe("soil save and soil validate agree about the same bytes", () => {
  const SECTIONS = Object.fromEntries(
    [
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
    ].map((key) => [key, { status: "missing", summary: null }]),
  );

  function base(): Record<string, unknown> {
    return {
      soilHandover: "1.0",
      handoverId: "019f7ab8-3380-73f2-8ae7-c99b6d964841",
      projectId: "closed-world",
      title: "Closed world",
      createdAt: "2026-07-22T10:00:00Z",
      sections: JSON.parse(JSON.stringify(SECTIONS)) as Record<string, unknown>,
    };
  }

  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ["an unknown top-level field", { ...base(), grade: 0.92 }],
    [
      "an unknown field on a section",
      (() => {
        const doc = base();
        (doc["sections"] as Record<string, Record<string, unknown>>)[
          "decisions"
        ] = { status: "available", summary: "One.", confidence: 0.4 };
        return doc;
      })(),
    ],
    [
      "an unknown provenance label",
      (() => {
        const doc = base();
        (doc["sections"] as Record<string, Record<string, unknown>>)[
          "decisions"
        ] = {
          status: "available",
          summary: "One.",
          provenance: ["repo_verified", "vibe_checked"],
        };
        return doc;
      })(),
    ],
    [
      "an unknown section key",
      (() => {
        const doc = base();
        (doc["sections"] as Record<string, unknown>)["vibes"] = {
          status: "available",
          summary: "Good.",
        };
        return doc;
      })(),
    ],
    [
      "a higher minor version carrying an extension object",
      {
        ...base(),
        soilHandover: "1.7",
        retentionPolicy: { keepUntil: "2027-01-01" },
      },
    ],
  ];

  for (const [what, document] of cases) {
    it(`refuses ${what} from save, exactly as validate does`, async () => {
      io.stdin = JSON.stringify(document);
      expect(await run(["validate", "-"], io.env)).toBe(1);
      io.stdin = JSON.stringify(document);
      expect(await run(["save", "-"], io.env)).toBe(1);
      expect(await run(["list"], io.env)).toBe(0);
      expect(io.out).toContain("nothing saved yet");
    });
  }

  it("refuses a capture with no time rather than stamping the wall clock", async () => {
    // `createdAt` is the anchor every frontier section is read against. A
    // value read from the clock at save time is indistinguishable, to the
    // consumer, from a time the session actually reported.
    const document = base();
    delete document["createdAt"];
    io.stdin = JSON.stringify(document);
    expect(await run(["save", "-"], io.env)).toBe(1);
    expect(io.err).toContain("/createdAt");
  });

  it("never writes its own recipe version onto a document it did not produce", async () => {
    io.stdin = JSON.stringify(base());
    expect(await run(["save", "-", "--quiet"], io.env)).toBe(0);
    const stored = JSON.parse(
      readFileSync(join(home, "handovers/001.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(stored["source"]).toBeUndefined();
  });

  it("keeps a malformed handoverId instead of minting one over the top", async () => {
    io.stdin = JSON.stringify({ ...base(), handoverId: 42 });
    expect(await run(["save", "-"], io.env)).toBe(1);
    expect(io.err).toContain("/handoverId");
  });
});

/**
 * The defect this suite exists to keep closed: every command accepted every
 * option and read none of them.
 *
 * Each command pulled its target out with `args.filter(a => !a.startsWith
 * ("--"))`, which strips anything option-shaped and never looks at it again.
 * A misspelled option and a correct one therefore produced the same success.
 * `soil validate file.json --json` printed the human card and exited 0, so a
 * script asking for machine output got a rail card and a zero exit; `soil
 * list --json` did the same; `soil load '#001' --totally-unknown-flag`
 * succeeded; and `soil <cmd> --help` printed the command's output instead of
 * the help text, which is a 168-line restore prompt for someone who asked
 * what the options were.
 *
 * The table below is the whole option surface, written out here by hand
 * rather than imported from the CLI, so the two statements of it have to
 * agree. Every command meets every option it does not take.
 */
describe("options a command does not take", () => {
  const SURFACE: readonly (readonly [string, readonly string[]])[] = [
    ["save", ["--quiet"]],
    ["load", ["--json"]],
    ["list", []],
    ["ls", []],
    ["validate", []],
    ["check", ["--json", "--attach"]],
    ["render", ["--json"]],
    ["rescue", []],
    ["where", []],
  ];

  const EVERY_OPTION = ["--json", "--quiet", "--attach"] as const;

  for (const [command, allowed] of SURFACE) {
    it(`soil ${command} refuses an option it has never heard of`, async () => {
      expect(await run([command, "--nonsense"], io.env)).toBe(2);
      expect(io.err).toContain(`soil ${command}: unknown option --nonsense`);
      // Nothing ran: a refused invocation prints no card, no recipe and no
      // prompt, so a script reading stdout cannot mistake it for output.
      expect(io.out).toBe("");
    });

    it(`soil ${command} says what it does take`, async () => {
      await run([command, "--nonsense"], io.env);
      if (allowed.length === 0) {
        expect(io.err).toContain(`soil ${command} takes no options`);
      } else {
        expect(io.err).toContain(`soil ${command} takes`);
        for (const option of allowed) expect(io.err).toContain(option);
      }
    });

    const foreign = EVERY_OPTION.filter((o) => !allowed.includes(o));
    it(`soil ${command} refuses ${foreign.join(", ")}, which belong to other commands`, async () => {
      for (const option of foreign) {
        io.out = "";
        io.err = "";
        expect(await run([command, option], io.env)).toBe(2);
        expect(io.err).toContain(`soil ${command}: unknown option ${option}`);
        expect(io.out).toBe("");
      }
    });

    it(`soil ${command} answers --help and --version wherever they are typed`, async () => {
      for (const option of ["-h", "--help"]) {
        io.out = "";
        expect(await run([command, option], io.env)).toBe(0);
        expect(io.out).toContain("USAGE");
      }
      for (const option of ["-v", "--version"]) {
        io.out = "";
        expect(await run([command, option], io.env)).toBe(0);
        expect(io.out).toContain("spec 1.0");
      }
    });
  }

  it("names every unknown option, not just the first", async () => {
    expect(
      await run(
        ["render", "#001", "--attach", "--quiet", "--nonsense"],
        io.env,
      ),
    ).toBe(2);
    expect(io.err).toContain(
      "soil render: unknown options --attach, --quiet and --nonsense",
    );
    expect(io.err).toContain("soil render takes --json");
  });

  it("refuses a one-dash near miss instead of reading it as a target", async () => {
    // `-json` used to survive the filter, become the load code, and come back
    // as "no handover stored as -json", which sends the reader looking in the
    // store for a mistake they made on the command line. `-attach` reached
    // `readFile` and came back as ENOENT on a file nobody named.
    for (const [command, option] of [
      ["load", "-json"],
      ["check", "-attach"],
      ["save", "-quiet"],
      ["render", "-json"],
    ] as const) {
      io.out = "";
      io.err = "";
      expect(await run([command, option], io.env)).toBe(2);
      expect(io.err).toContain(`soil ${command}: unknown option ${option}`);
      expect(io.out).toBe("");
    }
  });

  it("leaves an unknown command its own answer", async () => {
    expect(await run(["frobnicate", "--json"], io.env)).toBe(2);
    expect(io.err).toContain('unknown command "frobnicate"');
  });
});

/**
 * The five invocations measured before the refusal existed, each one now a
 * failure that names what it did not understand.
 */
describe("the invocations that used to succeed silently", () => {
  it("soil validate <file> --json refuses instead of printing the human card", async () => {
    expect(await run(["validate", EXAMPLE, "--json"], io.env)).toBe(2);
    expect(io.err).toBe(
      "soil validate: unknown option --json\nsoil validate takes no options\n",
    );
    expect(io.out).toBe("");
  });

  it("soil list --json refuses instead of printing the human card", async () => {
    expect(await run(["list", "--json"], io.env)).toBe(2);
    expect(io.err).toBe(
      "soil list: unknown option --json\nsoil list takes no options\n",
    );
    expect(io.out).toBe("");
  });

  it("soil load with an invented flag refuses instead of loading", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    io.out = "";
    expect(await run(["load", "#001", "--totally-unknown-flag"], io.env)).toBe(
      2,
    );
    expect(io.err).toBe(
      "soil load: unknown option --totally-unknown-flag\nsoil load takes --json\n",
    );
    expect(io.out).toBe("");
  });

  it("soil load --quiet refuses instead of printing the restore prompt", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    io.out = "";
    expect(await run(["load", "--quiet"], io.env)).toBe(2);
    expect(io.err).toContain("soil load: unknown option --quiet");
    expect(io.out).toBe("");
  });

  it("soil save --attach refuses instead of printing the recipe", async () => {
    expect(await run(["save", "--attach"], io.env)).toBe(2);
    expect(io.err).toContain("soil save: unknown option --attach");
    expect(io.out).toBe("");
  });
});

/**
 * The other half of the same rule: an option a command does take still does
 * exactly what it did, before and after its target, and every documented
 * invocation still runs.
 *
 * A refusal is easy to write too widely. These are the lines a reader has in
 * their history, in `packages/cli/README.md`, in `docs/quickstart.md` and in
 * `docs/checking.md`, so breaking one of them is a regression this suite
 * catches rather than a user reports.
 */
describe("options a command does take", () => {
  it("takes --quiet on save before the file as well as after it", async () => {
    expect(await run(["save", "--quiet", EXAMPLE], io.env)).toBe(0);
    expect(io.out.trim()).toBe("#001");
  });

  it("takes --json on load before the code as well as after it", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    io.out = "";
    expect(await run(["load", "--json", "#001"], io.env)).toBe(0);
    expect(JSON.parse(io.out)).toMatchObject({ code: "#001" });
  });

  it("takes --json on render, printing the raw document", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    io.out = "";
    expect(await run(["render", "#001", "--json"], io.env)).toBe(0);
    expect(JSON.parse(io.out)).toMatchObject({ code: "#001" });
  });

  it("takes --json and --attach together on check", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    io.out = "";
    expect(await run(["check", "#001", "--json", "--attach"], io.env)).toBe(0);
    expect(JSON.parse(io.out)).toMatchObject({ grade: "adequate" });
    const stored = JSON.parse(
      readFileSync(join(home, "handovers", "001.json"), "utf8"),
    ) as { observations: { kind: string }[] };
    expect(stored.observations[0]?.kind).toBe("quality.capture");
  });

  it("still reads the bare - target as stdin, not as an option", async () => {
    io.stdin = readFileSync(EXAMPLE, "utf8");
    expect(await run(["validate", "-"], io.env)).toBe(0);
    expect(io.out).toContain("valid handover");
    io.out = "";
    expect(await run(["check", "-"], io.env)).toBe(0);
    expect(io.out).toContain("handover checked");
    io.out = "";
    expect(await run(["save", "-", "--quiet"], io.env)).toBe(0);
    expect(io.out.trim()).toBe("#001");
  });

  it("still runs every command with no options at all", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    for (const argv of [
      ["save"],
      ["load"],
      ["load", "#001"],
      ["list"],
      ["ls"],
      ["validate", EXAMPLE],
      ["check", EXAMPLE],
      ["check", "#001"],
      ["render", "#001"],
      ["render", EXAMPLE],
      ["rescue"],
      ["where"],
    ]) {
      io.out = "";
      io.err = "";
      expect(await run(argv, io.env), argv.join(" ")).toBe(0);
      expect(io.err, argv.join(" ")).toBe("");
    }
  });
});
