/**
 * The agent install guide, executed.
 *
 * `docs/install-with-an-agent.md` is normative for an agent installing Soil on
 * someone's machine, and it says out loud that anything other than the stated
 * expected outcome is a failure. That makes every number in its prose a claim
 * about behaviour, and an unchecked claim drifts: the guide told readers to
 * expect `3 / 17 sections carrying content` from a document whose four
 * sections carry content, so an agent following it reported a false failure on
 * a healthy install.
 *
 * This test removes the possibility. It reads the guide, takes the test
 * document out of the guide's own fenced block rather than a copy, takes the
 * commands out of the guide's own fenced blocks, runs them against a scratch
 * store through the real CLI binary, and asserts each step's stated expected
 * outcome against the real output and the real exit code.
 *
 * Nothing here is hardcoded that the guide also states. The section count is
 * read out of the prose, checked against the document the prose describes, and
 * checked again against what the CLI prints, so all three have to agree.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const GUIDE_PATH = join(ROOT, "docs/install-with-an-agent.md");
const GUIDE = readFileSync(GUIDE_PATH, "utf8");
const AGENTS = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
const CLI = join(ROOT, "packages/cli/bin/soil.js");
const MCP = join(ROOT, "packages/mcp/bin/soil-mcp.js");

/** The guide's own test document, from the guide's own fenced block. */
function testDocumentFromGuide(): string {
  const blocks = [...GUIDE.matchAll(/```json\n([\s\S]*?)```/g)].map(
    (match) => match[1] ?? "",
  );
  const document = blocks.find((block) => block.includes('"soilHandover"'));
  if (document === undefined) {
    throw new Error("the guide no longer carries a handover document");
  }
  return document;
}

/** The shell commands a document gives for one numbered smoke-test step. */
function commandsForStepIn(text: string, step: number): string[] {
  const from = text.indexOf(`**Step ${step}:`);
  if (from < 0) throw new Error(`the document has no step ${step}`);
  const to = text.indexOf(`**Step ${step + 1}:`);
  const region = text.slice(from, to < 0 ? undefined : to);
  const fence = /```bash\n([\s\S]*?)```/.exec(region);
  if (fence === null) throw new Error(`step ${step} has no bash block`);
  return (fence[1] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** The prose a document states as the expected outcome of one step. */
function expectedForStepIn(text: string, step: number): string {
  const from = text.indexOf(`**Step ${step}:`);
  const to = text.indexOf(`**Step ${step + 1}:`);
  const region = text.slice(from, to < 0 ? undefined : to);
  const stated = /Expected:([\s\S]*?)\n\n/.exec(region);
  if (stated === null) throw new Error(`step ${step} states no expectation`);
  return (stated[1] ?? "").replace(/\s+/g, " ").trim();
}

const commandsForStep = (step: number): string[] =>
  commandsForStepIn(GUIDE, step);
const expectedForStep = (step: number): string =>
  expectedForStepIn(GUIDE, step);

interface Ran {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

/**
 * A path in the spelling a documented shell command uses.
 *
 * Committed prose writes `packages/mcp/bin/soil-mcp.js` on every platform, and
 * a path this test derives from the host has to be put back into that spelling
 * before it is compared against the prose or substituted into a command. Two
 * different failures on Windows came from skipping that: a comparison looking
 * for backslashes in a document that has none, and a checkout path whose
 * separators the shell read as escape characters.
 */
const toPosix = (anyPath: string): string => anyPath.split(sep).join("/");

let home = "";
let shim = "";

/**
 * Run a documented command with `soil` on the PATH and a scratch store.
 *
 * The guide's commands are POSIX shell — `$SOIL_HOME`, single-quoted `'#001'`,
 * `rm -rf` — so a POSIX shell is what has to run them, and that is not a
 * platform choice. The shell is named, not located: `sh` is resolved on the
 * PATH, where every platform this suite claims puts one. `/bin/sh` was an
 * absolute POSIX filesystem path, which is a claim about layout rather than
 * about the shell, and on Windows it resolves against the current drive root
 * and finds nothing, so `spawnSync` returned no status and every assertion on
 * an exit code saw the `-1` this function substitutes.
 *
 * The PATH is joined with `path.delimiter` for the same reason: the separator
 * is a property of the host, `:` is only its POSIX spelling, and hardcoding it
 * puts the shim directory and the inherited PATH into one unusable entry on a
 * host that separates with `;`.
 */
function runIn(where: string, store: string, path: string, command: string) {
  const result = spawnSync("sh", ["-c", command], {
    encoding: "utf8",
    cwd: where,
    env: {
      ...process.env,
      SOIL_HOME: store,
      PATH: `${path}${delimiter}${process.env["PATH"] ?? ""}`,
    },
  });
  return {
    command,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  } satisfies Ran;
}

/**
 * A scratch store with the guide's own alias on the PATH as a shim. The guide
 * offers `alias soil="node .../soil.js"` and then writes `soil`, so a shim is
 * that alias in the form a non-interactive shell honours.
 */
function scratchWithSoilOnPath(label: string): {
  store: string;
  path: string;
} {
  const store = mkdtempSync(join(tmpdir(), label));
  const path = join(store, ".bin");
  mkdirSync(path);
  const alias = join(path, "soil");
  writeFileSync(alias, `#!/bin/sh\nexec node ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(alias, 0o755);
  return { store, path };
}

/** Run one of the guide's commands the way the guide runs it. */
function runDocumented(command: string): Ran {
  return runIn(home, home, shim, command);
}

describe("the agent install guide's smoke test", () => {
  beforeAll(() => {
    // The guide's own `export SOIL_HOME=$(mktemp -d)`, done here so the test
    // owns the cleanup.
    expect(GUIDE).toContain("export SOIL_HOME=$(mktemp -d)");
    home = mkdtempSync(join(tmpdir(), "soil-install-guide-"));
    shim = join(home, ".bin");
    mkdirSync(shim);
    // The guide says `soil` means the CLI you installed, and offers an alias
    // for exactly this. A shim on the PATH is that alias, in a form a
    // non-interactive shell honours.
    const alias = join(shim, "soil");
    writeFileSync(alias, `#!/bin/sh\nexec node ${JSON.stringify(CLI)} "$@"\n`);
    chmodSync(alias, 0o755);
    // Step 2 of the guide: write its document, byte for byte, where it says.
    writeFileSync(
      join(home, "soil-install-test.json"),
      testDocumentFromGuide(),
      "utf8",
    );
  });

  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("step 1: the store answers with the scratch directory", () => {
    expect(commandsForStep(1)).toEqual(["soil where"]);
    expect(expectedForStep(1)).toBe(
      "prints the scratch directory path, exit 0.",
    );
    const ran = runDocumented("soil where");
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toBe(home);
  });

  it("step 2: the document in the guide is the document the guide describes", () => {
    const document = JSON.parse(testDocumentFromGuide()) as {
      sections: Record<string, { status: string; summary: string | null }>;
    };
    const withContent = Object.values(document.sections).filter(
      (section) => section.status === "available" && section.summary,
    ).length;
    // The number the guide's prose states for step 4, read out of the prose.
    const stated = /`(\d+) \/ 17 sections carrying\ncontent`/.exec(GUIDE);
    expect(stated).not.toBeNull();
    expect(Number(stated?.[1])).toBe(withContent);
  });

  it("step 3: validate prints the valid-handover card", () => {
    const [command] = commandsForStep(3);
    expect(command).toBe('soil validate "$SOIL_HOME/soil-install-test.json"');
    expect(expectedForStep(3)).toBe('a "valid handover" card, exit 0.');
    const ran = runDocumented(command!);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("valid handover");
  });

  it("step 4: save reports the section count and the load code the guide states", () => {
    const [command] = commandsForStep(4);
    expect(command).toBe('soil save "$SOIL_HOME/soil-install-test.json"');
    const stated = expectedForStep(4);
    const count = /`(\d+) \/ 17 sections carrying content`/.exec(stated)?.[1];
    const code = /\(`(#\d+)` in a fresh scratch store\)/.exec(stated)?.[1];
    expect(count).toBeDefined();
    expect(code).toBeDefined();

    const ran = runDocumented(command!);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("handover saved");
    expect(ran.stdout).toContain(`${count} / 17 sections carrying content`);
    expect(ran.stdout).toContain(code!);
  });

  it("step 5: check reports the grade and the problem count the guide states", () => {
    const [command] = commandsForStep(5);
    expect(command).toBe("soil check '#001'");
    const stated = expectedForStep(5);
    const grade = /grade `([a-z]+)`/.exec(stated)?.[1];
    const problems = /`(\d+) problems`/.exec(stated)?.[1];
    expect(grade).toBeDefined();
    expect(problems).toBeDefined();

    const ran = runDocumented(command!);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("handover checked");
    expect(ran.stdout).toContain(grade!);
    expect(ran.stdout).toContain(`${problems} problems`);
  });

  it("step 6: load prints the card and then the restore prompt", () => {
    const [command] = commandsForStep(6);
    expect(command).toBe("soil load '#001'");
    expect(expectedForStep(6)).toContain(
      'a "handover loaded" card followed by the restore prompt, exit 0.',
    );
    const ran = runDocumented(command!);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("handover loaded");
    // The restore prompt's structure carries a boundary generated per render,
    // so the assertion is on its shape rather than on a fixed delimiter.
    expect(ran.stdout).toMatch(/^=== soil:[0-9a-f]{32} BOOT PROMPT ===$/m);
    expect(ran.stdout.indexOf("handover loaded")).toBeLessThan(
      ran.stdout.indexOf("=== soil:"),
    );
  });

  it("cleanup: the guide's teardown removes the scratch store and nothing else", () => {
    expect(GUIDE).toContain('rm -rf "$SOIL_HOME"');
    expect(GUIDE).toContain("unset SOIL_HOME");
  });
});

/**
 * Every committed surface that tells somebody how to install this. AGENTS.md
 * joined the list when it grew its own install section: the two rules below
 * are about what an install instruction may say, not about which file says
 * it, and a rule enforced on four files out of five is a rule with a hole.
 */
const INSTALL_SURFACES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  "docs/install-with-an-agent.md",
  "docs/quickstart.md",
  "docs/server.md",
  "packages/server/README.md",
  "README.md",
];

describe("the agent install guide's install instructions", () => {
  it("never tells a reader to fetch a package by a bare name", () => {
    // Resolution is by package name, so a bare-name runner line is wrong even
    // after publication, and today those names are unclaimed.
    for (const surface of INSTALL_SURFACES) {
      const text = readFileSync(join(ROOT, surface), "utf8");
      for (const line of text.split("\n")) {
        expect(line).not.toMatch(
          /^\s*\$?\s*(npx|pnpm dlx|yarn dlx)\s+(-y\s+)?soil[-\w]*\b/,
        );
      }
    }
  });

  it("does not send a reader to a clone URL that has nothing behind it", () => {
    // The public release repository is populated by the release process, so
    // until it is, a documented `git clone` of it is a first command that
    // fails. The from-source paths run from the checkout the reader has.
    for (const surface of INSTALL_SURFACES) {
      const text = readFileSync(join(ROOT, surface), "utf8");
      expect(text).not.toContain("git clone https://github.com/nativesoil/");
    }
  });
});

/**
 * AGENTS.md, executed.
 *
 * The root briefing carries its own smoke test, because an agent installing
 * Soil for somebody should not have to open a second file to do it. That puts
 * the same claim in AGENTS.md that `docs/install-with-an-agent.md` makes: run
 * this, and expect exactly that. The remedy is the same one, applied to the
 * new document rather than copied out of the old one. The commands come out
 * of AGENTS.md's own fenced blocks, the expected outcomes out of its own
 * prose, and both meet the real CLI and the real exit code.
 *
 * Nothing below hardcodes a value AGENTS.md also states. Where the document
 * names a count, a code or a grade, that string is read from the prose and
 * compared against what the command printed, so the two cannot part company.
 */
describe("the root agent briefing's smoke test", () => {
  let store = "";
  let path = "";

  /**
   * AGENTS.md runs its sequence from the checkout, not from the store.
   *
   * `<checkout>` is substituted in its POSIX spelling, because it lands
   * unquoted inside a shell command and a backslash there is an escape
   * character, not a separator: a Windows checkout path spliced in raw came
   * out with its separators eaten, so `node` was handed a path to nothing and
   * the step failed on an exit code rather than on the tools it listed. A
   * reader typing this into the shell it is written for types the same forward
   * slashes, and every platform's `node` accepts them.
   *
   * The working directory keeps the host's own spelling: that one is handed to
   * the operating system, not to a shell.
   */
  const run = (command: string): Ran =>
    runIn(ROOT, store, path, command.replaceAll("<checkout>", toPosix(ROOT)));

  beforeAll(() => {
    expect(AGENTS).toContain("export SOIL_HOME=$(mktemp -d)");
    ({ store, path } = scratchWithSoilOnPath("soil-agents-briefing-"));
  });

  afterAll(() => {
    if (store) rmSync(store, { recursive: true, force: true });
  });

  it("step 1: the store answers with the scratch directory", () => {
    expect(commandsForStepIn(AGENTS, 1)).toEqual(["soil where"]);
    expect(expectedForStepIn(AGENTS, 1)).toBe(
      "prints the scratch directory path, exit 0.",
    );
    const ran = run("soil where");
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toBe(store);
  });

  it("step 2: the document the briefing names validates", () => {
    const [command] = commandsForStepIn(AGENTS, 2);
    expect(command).toBe("soil validate examples/orchard-checkout.json");
    expect(expectedForStepIn(AGENTS, 2)).toBe(
      'a "valid handover" card, exit 0.',
    );
    const ran = run(command!);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("valid handover");
  });

  it("step 3: save reports the section count and the code the briefing states", () => {
    const [command] = commandsForStepIn(AGENTS, 3);
    expect(command).toBe("soil save examples/orchard-checkout.json");
    const stated = expectedForStepIn(AGENTS, 3);
    const count = /`(\d+ \/ \d+) sections carrying content`/.exec(stated)?.[1];
    const code = /\(`(#\d+)` in a fresh scratch store\)/.exec(stated)?.[1];
    expect(count).toBeDefined();
    expect(code).toBeDefined();

    const ran = run(command!);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("handover saved");
    expect(ran.stdout).toContain(`${count} sections carrying content`);
    expect(ran.stdout).toContain(code!);
  });

  it("step 4: list carries the code the save handed back", () => {
    const [command] = commandsForStepIn(AGENTS, 4);
    expect(command).toBe("soil list");
    expect(expectedForStepIn(AGENTS, 4)).toBe(
      'a "handovers" card carrying the code from step 3, exit 0.',
    );
    const code = /\(`(#\d+)` in a fresh scratch store\)/.exec(
      expectedForStepIn(AGENTS, 3),
    )?.[1];
    const ran = run(command!);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("SOIL · handovers");
    expect(ran.stdout).toContain(code!);
  });

  it("step 5: check reports the grade and the problem count the briefing states", () => {
    const [command] = commandsForStepIn(AGENTS, 5);
    expect(command).toBe("soil check '#001'");
    const stated = expectedForStepIn(AGENTS, 5);
    const grade = /grade `([a-z]+)`/.exec(stated)?.[1];
    const problems = /`(\d+) problems`/.exec(stated)?.[1];
    expect(grade).toBeDefined();
    expect(problems).toBeDefined();

    const ran = run(command!);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("handover checked");
    expect(ran.stdout).toContain(grade!);
    expect(ran.stdout).toContain(`${problems} problems`);
  });

  it("step 6: load prints the card and then the restore prompt", () => {
    const [command] = commandsForStepIn(AGENTS, 6);
    expect(command).toBe("soil load '#001'");
    expect(expectedForStepIn(AGENTS, 6)).toContain(
      'a "handover loaded" card followed by the restore prompt, exit 0.',
    );
    const ran = run(command!);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("handover loaded");
    expect(ran.stdout).toMatch(/^=== soil:[0-9a-f]{32} BOOT PROMPT ===$/m);
    expect(ran.stdout.indexOf("handover loaded")).toBeLessThan(
      ran.stdout.indexOf("=== soil:"),
    );
  });

  it("step 7: the local server answers with exactly the three named tools", () => {
    const [command] = commandsForStepIn(AGENTS, 7);
    expect(command).toContain('"method":"tools/list"');
    // The briefing writes a shell command, and a path inside one is spelled
    // with forward slashes on every platform. `relative` answers in the host's
    // separator, so on Windows this built `packages\mcp\bin\soil-mcp.js` and
    // asked a correctly written document to contain it. The document is right;
    // the comparison has to be in the document's spelling.
    expect(command).toContain(`<checkout>/${toPosix(relative(ROOT, MCP))}`);
    const stated = expectedForStepIn(AGENTS, 7);
    const named = [...stated.matchAll(/`(soil_[a-z]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);

    const ran = run(command!);
    expect(ran.status).toBe(0);
    const answered = ran.stdout
      .trim()
      .split("\n")
      .map((line) => /"name":"(soil_[a-z]+)"/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    // "exactly", so the set is compared both ways round.
    expect(answered.sort()).toEqual([...named].sort());
  });

  it("cleanup: the briefing's teardown removes the scratch store and nothing else", () => {
    expect(AGENTS).toContain('rm -rf "$SOIL_HOME"');
    expect(AGENTS).toContain("unset SOIL_HOME");
  });
});

/**
 * One briefing, and pointers to it.
 *
 * Two root files that must be kept in step by hand is a drift generator, and
 * the copies did drift: they were byte-identical apart from a heading and a
 * relative path, and every improvement to one had to be remembered twice.
 * AGENTS.md is the document; the other two exist because hosts disagree about
 * which filename they read. This test is what stops them growing back.
 */
describe("the agent briefing has one source", () => {
  const POINTERS = ["CLAUDE.md", ".github/copilot-instructions.md"];

  it("keeps every pointer short and pointed at AGENTS.md", () => {
    for (const pointer of POINTERS) {
      const text = readFileSync(join(ROOT, pointer), "utf8");
      expect(text).toContain("AGENTS.md");
      expect(text.split("\n").length).toBeLessThan(20);
    }
  });

  it("keeps the briefing's own material out of the pointers", () => {
    // Any heading AGENTS.md carries is content, and content in a pointer is
    // the copy coming back. The pointers carry no headings of their own but
    // their title, so comparing headings catches the regrowth early.
    const headings = (text: string) =>
      text.split("\n").filter((line) => /^#{1,6}\s/.test(line));
    expect(headings(AGENTS).length).toBeGreaterThan(1);
    for (const pointer of POINTERS) {
      const text = readFileSync(join(ROOT, pointer), "utf8");
      expect(headings(text)).toHaveLength(1);
      for (const heading of headings(AGENTS).slice(1)) {
        expect(text).not.toContain(heading);
      }
    }
  });
});

/**
 * The briefing's count of the drawings.
 *
 * AGENTS.md warns that Prettier has no SVG parser, so "the four files under
 * `docs/diagrams/`" are skipped silently by both `--write` and `--check`. That
 * is a real warning worth keeping, and the number in it counts a directory
 * that grew by four files in a single commit not long ago. It is the last of a
 * class this repository has been through several times: a figure that was
 * right when written and that nothing derives.
 */
describe("the briefing's count of the diagrams", () => {
  it("is the number of files under docs/diagrams", () => {
    const stated = /the (\w+) files under `docs\/diagrams\/`/.exec(AGENTS)?.[1];
    expect(
      stated,
      "AGENTS.md no longer says how many diagrams Prettier skips",
    ).toBeDefined();
    const VALUE: Readonly<Record<string, number>> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
    };
    const drawings = readdirSync(join(ROOT, "docs/diagrams"));
    expect(VALUE[stated!], `AGENTS.md says "${stated}"`).toBe(drawings.length);
    // The warning is about SVG specifically, so a non-SVG file arriving in
    // that directory would make the sentence wrong in a way a count alone
    // would not show.
    expect(drawings.every((name) => name.endsWith(".svg"))).toBe(true);
  });
});
