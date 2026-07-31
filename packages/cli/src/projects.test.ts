/**
 * Projects in the CLI, and the check that runs at save.
 *
 * The grammar is the product's one grammar: `@` says where, `#` says which.
 * A project is a shared container of handovers inside the one store, created
 * and removed by `soil project`, never by a save and never by hand. A save
 * with no reference is personal, always; a stated reference to a project that
 * does not exist is refused with the exact command that creates it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkHandover, HandoverStore } from "@nativesoil/handover-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run, type CliEnvironment } from "./index.js";

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
  home = mkdtempSync(join(tmpdir(), "soil-cli-projects-"));
  io = new Recorder(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("soil project add", () => {
  it("creates the container inside the one store", async () => {
    expect(await run(["project", "add", "acme"], io.env)).toBe(0);
    expect(io.out).toContain("Created project acme");
    expect(io.out).toContain("soil save - @acme");
    expect(existsSync(join(home, "projects", "acme", "handovers"))).toBe(true);
  });

  it("accepts the reference spelling too: @acme names acme", async () => {
    expect(await run(["project", "add", "@acme"], io.env)).toBe(0);
    expect(existsSync(join(home, "projects", "acme"))).toBe(true);
  });

  it("refuses a name outside the pattern, in the server's own words", async () => {
    expect(await run(["project", "add", "Not-Valid"], io.env)).toBe(2);
    expect(io.err).toContain(
      "project ids are 1-64 characters of lowercase letters, digits or hyphen",
    );
  });

  it("refuses a duplicate", async () => {
    await run(["project", "add", "acme"], io.env);
    expect(await run(["project", "add", "acme"], io.env)).toBe(1);
    expect(io.err).toContain("the project acme already exists");
  });
});

describe("saving, listing and loading with @", () => {
  it("round trips a handover through a project container", async () => {
    await run(["project", "add", "acme"], io.env);
    expect(await run(["save", EXAMPLE, "@acme"], io.env)).toBe(0);
    expect(io.out).toContain("saved into project acme");
    expect(io.out).toContain("soil load @acme '#001'");

    io.out = "";
    expect(await run(["list", "@acme"], io.env)).toBe(0);
    expect(io.out).toContain("#001");

    io.out = "";
    expect(await run(["load", "@acme", "#001"], io.env)).toBe(0);
    expect(io.out).toContain("handover loaded");
    expect(io.out).toMatch(/^=== soil:[0-9a-f]{32} BOOT PROMPT ===$/m);

    io.out = "";
    expect(await run(["load", "@acme"], io.env)).toBe(0);
    expect(io.out).toContain("#001");
  });

  it("keeps project and personal codes independent, one counter per store", async () => {
    await run(["project", "add", "acme"], io.env);
    await run(["save", EXAMPLE, "--quiet"], io.env);
    io.out = "";
    await run(["save", EXAMPLE, "@acme", "--quiet"], io.env);
    // The container's first code is #001 regardless of the personal counter,
    // which is the server's numbering: codes are per store, told apart by the
    // reference.
    expect(io.out.trim()).toBe("#001");
    expect(new HandoverStore(home).list()).toHaveLength(1);
    expect(
      new HandoverStore(join(home, "projects", "acme")).list(),
    ).toHaveLength(1);
  });

  it("refuses a save into a project that does not exist, naming the command", async () => {
    expect(await run(["save", EXAMPLE, "@ghost"], io.env)).toBe(1);
    expect(io.err).toContain("no such project: ghost");
    expect(io.err).toContain("soil project add ghost");
    expect(io.err).toContain("never falls back to your personal store");
    // Nothing was stored anywhere, and no container appeared.
    expect(new HandoverStore(home).list()).toHaveLength(0);
    expect(existsSync(join(home, "projects", "ghost"))).toBe(false);
  });

  it("keeps a bare save personal, never filed into a project", async () => {
    await run(["project", "add", "acme"], io.env);
    await run(["save", EXAMPLE, "--quiet"], io.env);
    expect(new HandoverStore(home).list()).toHaveLength(1);
    expect(
      new HandoverStore(join(home, "projects", "acme")).list(),
    ).toHaveLength(0);
  });

  it("names the store's projects on a bare list", async () => {
    await run(["project", "add", "acme"], io.env);
    await run(["save", EXAMPLE, "@acme", "--quiet"], io.env);
    io.out = "";
    await run(["list"], io.env);
    expect(io.out).toContain("projects in this store: @acme (1 handover)");
    expect(io.out).toContain("soil list @acme");
  });

  it("refuses two references at once", async () => {
    expect(await run(["load", "@acme", "@beta"], io.env)).toBe(2);
    expect(io.err).toContain("one project reference at a time");
  });
});

describe("soil project remove", () => {
  it("removes an empty project directly", async () => {
    await run(["project", "add", "acme"], io.env);
    expect(await run(["project", "remove", "acme"], io.env)).toBe(0);
    expect(io.out).toContain("Removed project acme");
    expect(existsSync(join(home, "projects", "acme"))).toBe(false);
  });

  it("refuses while handovers are held, naming the count and the flag", async () => {
    await run(["project", "add", "acme"], io.env);
    await run(["save", EXAMPLE, "@acme", "--quiet"], io.env);
    expect(await run(["project", "remove", "acme"], io.env)).toBe(1);
    expect(io.err).toContain("still holds 1 handover");
    expect(io.err).toContain("soil project remove acme --purge");
    expect(existsSync(join(home, "projects", "acme"))).toBe(true);
  });

  it("deletes the project and its handovers with --purge, leaving personal saves alone", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    await run(["project", "add", "acme"], io.env);
    await run(["save", EXAMPLE, "@acme", "--quiet"], io.env);

    expect(await run(["project", "remove", "acme", "--purge"], io.env)).toBe(0);
    expect(io.out).toContain("deleted the 1 handover it held");
    expect(existsSync(join(home, "projects", "acme"))).toBe(false);

    // Neither the project nor its codes are listed any more.
    io.out = "";
    await run(["list"], io.env);
    expect(io.out).not.toContain("@acme");
    expect(io.out).toContain("#001");

    // The personal save made before is unaffected and still loads.
    io.out = "";
    expect(await run(["load", "#001"], io.env)).toBe(0);
    expect(io.out).toContain("handover loaded");
  });

  it("says no such project for a project that never existed", async () => {
    expect(await run(["project", "remove", "ghost"], io.env)).toBe(1);
    expect(io.err).toContain("no such project: ghost");
  });
});

describe("check at save", () => {
  it("prints the deterministic grade and finding counts after a save", async () => {
    expect(await run(["save", EXAMPLE], io.env)).toBe(0);
    const report = checkHandover(new HandoverStore(home).read("#001"));
    expect(io.out).toContain(`checked at save: ${report.grade}`);
    expect(io.out).toMatch(
      /checked at save: (strong|adequate|thin|failing) · \d+ problems? · \d+ cautions? · \d+ advice/,
    );
    expect(io.out).toContain("soil check '#001'");
    expect(io.out).toContain("never blocks a save");
  });

  it("stores and exits 0 on a document the rules grade poorly", async () => {
    io.stdin = JSON.stringify({
      projectId: "thin",
      title: "A thin capture",
      createdAt: "2026-07-22T10:00:00Z",
      extractionSections: { executiveSummary: "Some work happened." },
    });
    expect(await run(["save", "-"], io.env)).toBe(0);
    const report = checkHandover(new HandoverStore(home).read("#001"));
    expect(["thin", "failing"]).toContain(report.grade);
    expect(io.out).toContain(`checked at save: ${report.grade}`);
    expect(io.out).toContain("#001");
  });

  it("stays out of --quiet, which prints only the code", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    expect(io.out.trim()).toBe("#001");
  });

  it("writes no grade onto the stored document", async () => {
    await run(["save", EXAMPLE, "--quiet"], io.env);
    const stored = new HandoverStore(home).read("#001") as unknown as Record<
      string,
      unknown
    >;
    expect(stored["grade"]).toBeUndefined();
    expect(stored["check"]).toBeUndefined();
  });
});
