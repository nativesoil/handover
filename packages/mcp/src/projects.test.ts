/**
 * Projects on the local stdio path.
 *
 * A project here is a shared container of handovers: `projects/<name>` inside
 * the one store root, in exactly the layout the self-hosted server serves for
 * a shared project (the byte identity itself is held in
 * `store-identity.test.ts`). These tests hold the semantics: the `project`
 * argument on all three tools, the `@` reference grammar, the refusal of an
 * unknown project, and the standing rule that a save with no reference is
 * personal and is never filed anywhere else.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHECK_GRADES,
  HandoverStore,
  checkHandover,
} from "@nativesoil/handover-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleMessage } from "./index.js";
import { TOOLS, callTool } from "./tools.js";

const NOW = new Date("2026-07-22T10:00:00Z");

let home: string;
let store: HandoverStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "soil-mcp-projects-"));
  store = new HandoverStore(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** What `soil project add acme` leaves behind: the container's directories. */
function addProject(name: string): void {
  new HandoverStore(join(home, "projects", name)).init();
}

const SAVE_ARGS = {
  projectId: "billing-rework",
  title: "Billing rework, midpoint",
  sections: {
    projectIdentity: "Ship the billing rework without breaking invoicing.",
    decisions: "Postgres stays; the queue moves to the outbox pattern.",
  },
};

function toolText(result: ReturnType<typeof callTool>): {
  text: string;
  isError: boolean;
} {
  return {
    text: result.content[0]?.text ?? "",
    isError: result.isError === true,
  };
}

describe("the project argument on the stdio tools", () => {
  it("declares project on all three tools, in a strict schema", () => {
    for (const tool of TOOLS) {
      const properties = tool.inputSchema["properties"] as Record<
        string,
        unknown
      >;
      expect(properties["project"], tool.name).toBeDefined();
      expect(tool.inputSchema["additionalProperties"]).toBe(false);
    }
  });

  it("round trips a project handover over the stdio protocol itself", () => {
    addProject("acme");
    const saved = handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "soil_save",
          arguments: { ...SAVE_ARGS, project: "@acme" },
        },
      },
      store,
      NOW,
    );
    const savedText = (saved?.result as { content: { text: string }[] })
      .content[0]?.text as string;
    expect(savedText).toContain("Saved locally into project acme as #001");
    expect(savedText).toContain("soil load @acme #001");

    const loaded = handleMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "soil_load",
          arguments: { code: "#001", project: "@acme" },
        },
      },
      store,
      NOW,
    );
    const loadedText = (loaded?.result as { content: { text: string }[] })
      .content[0]?.text as string;
    expect(loadedText).toContain("outbox pattern");

    // The document landed in the container, not in the personal store.
    expect(
      new HandoverStore(join(home, "projects", "acme")).list(),
    ).toHaveLength(1);
    expect(store.list()).toHaveLength(0);
  });

  it("reads @acme and acme as the same reference", () => {
    addProject("acme");
    const first = toolText(
      callTool("soil_save", { ...SAVE_ARGS, project: "@acme" }, store, NOW),
    );
    const second = toolText(
      callTool("soil_save", { ...SAVE_ARGS, project: "acme" }, store, NOW),
    );
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(
      new HandoverStore(join(home, "projects", "acme")).list(),
    ).toHaveLength(2);
  });

  it("refuses an unknown project, stores nothing, and names the exact command", () => {
    const out = toolText(
      callTool("soil_save", { ...SAVE_ARGS, project: "@ghost" }, store, NOW),
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain("The handover was not saved");
    expect(out.text).toContain("no project named ghost");
    expect(out.text).toContain("soil project add ghost");
    expect(out.text).toContain("never falls back to your personal store");
    expect(store.list()).toHaveLength(0);

    for (const name of ["soil_load", "soil_list"]) {
      const refused = toolText(
        callTool(name, { project: "ghost" }, store, NOW),
      );
      expect(refused.isError, name).toBe(true);
      expect(refused.text, name).toContain("soil project add ghost");
    }
  });

  it("keeps an ABSENT project meaning the personal store", () => {
    addProject("acme");
    const out = toolText(callTool("soil_save", SAVE_ARGS, store, NOW));
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Saved locally as #001");
    expect(store.list()).toHaveLength(1);
    expect(
      new HandoverStore(join(home, "projects", "acme")).list(),
    ).toHaveLength(0);
  });

  it("refuses a bare @ rather than reading it as personal", () => {
    const out = toolText(
      callTool("soil_save", { ...SAVE_ARGS, project: "@" }, store, NOW),
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain("/project must be");
    expect(store.list()).toHaveLength(0);
  });

  it("lists a project's handovers, and everything without a reference", () => {
    addProject("acme");
    callTool("soil_save", SAVE_ARGS, store, NOW);
    callTool(
      "soil_save",
      { ...SAVE_ARGS, title: "In the container", project: "@acme" },
      store,
      NOW,
    );

    const scoped = toolText(callTool("soil_list", { project: "@acme" }, store));
    expect(scoped.isError).toBe(false);
    expect(scoped.text).toContain("project acme");
    expect(scoped.text).toContain("In the container");
    expect(scoped.text).not.toContain("Billing rework, midpoint  (billing");

    const everything = toolText(callTool("soil_list", {}, store));
    expect(everything.text).toContain("Billing rework, midpoint");
    expect(everything.text).toContain("(project acme");
  });
});

describe("check at save", () => {
  it("reports the deterministic grade and finding counts on every save", () => {
    const out = toolText(callTool("soil_save", SAVE_ARGS, store, NOW));
    expect(out.isError).toBe(false);
    const report = checkHandover(store.read("#001"));
    expect(out.text).toContain(`Checked at save: ${report.grade}`);
    expect(out.text).toMatch(
      /Checked at save: (strong|adequate|thin|failing) · \d+ problems? · \d+ cautions? · \d+ advice\./,
    );
    expect(out.text).toContain("never blocks a save");
    expect(CHECK_GRADES).toContain(report.grade);
  });

  it("never refuses a save on a low grade", () => {
    // A one-line capture grades poorly on the open rules; the save stores it
    // anyway and says so. An honest gap never blocks a save.
    const out = toolText(
      callTool(
        "soil_save",
        {
          projectId: "thin",
          title: "A thin capture",
          sections: { executiveSummary: "Some work happened." },
        },
        store,
        NOW,
      ),
    );
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Saved locally as #001");
    const report = checkHandover(store.read("#001"));
    expect(["thin", "failing"]).toContain(report.grade);
    expect(out.text).toContain(`Checked at save: ${report.grade}`);
  });

  it("keeps the grade out of the stored document and out of the load", () => {
    callTool("soil_save", SAVE_ARGS, store, NOW);
    const stored = store.read("#001") as unknown as Record<string, unknown>;
    expect(stored["grade"]).toBeUndefined();
    expect(stored["check"]).toBeUndefined();
    const loaded = toolText(callTool("soil_load", {}, store));
    expect(loaded.text).not.toMatch(/grade|score/i);
  });
});
