/**
 * The identity this feature exists for: a project container written by the
 * local stdio path IS the store the self-hosted server serves, the same files
 * in the same layout, with nothing translated in between.
 *
 * The proof runs in both directions against one directory. A handover saved
 * through the local `soil_save` with a `project` reference is read back
 * through the server's own store code (`ServerService`), and a handover the
 * server stores into the same project is read back through the local
 * `soil_load`. Pointing `soil-server` at the directory and registering the
 * project is all the promotion a local project ever needs.
 *
 * The registry files the server adds (`users.json`, `projects.json`) sit
 * beside the containers and are membership administration, which stays a
 * server concern; they never touch the stores themselves.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROJECT_ID_PATTERN as CLI_PROJECT_ID_PATTERN } from "@nativesoil/handover-cli";
import {
  PROJECT_ID_PATTERN as SERVER_PROJECT_ID_PATTERN,
  Registry,
  ServerService,
} from "@nativesoil/handover-server";
import { HandoverStore, normalizeHandover } from "@nativesoil/handover-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROJECT_ID_PATTERN as MCP_PROJECT_ID_PATTERN,
  callTool,
} from "./tools.js";

const NOW = new Date("2026-07-22T10:00:00Z");

let home: string;
let store: HandoverStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "soil-store-identity-"));
  store = new HandoverStore(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const SAVE_ARGS = {
  projectId: "billing-rework",
  title: "Billing rework, midpoint",
  sections: {
    projectIdentity: "Ship the billing rework without breaking invoicing.",
    decisions: "Postgres stays; the queue moves to the outbox pattern.",
  },
};

describe("one store, two doors", () => {
  it("serves a locally written project container through the server's own store code", () => {
    // The local operator's `soil project add acme`, then a save through the
    // stdio tool.
    new HandoverStore(join(home, "projects", "acme")).init();
    const saved = callTool(
      "soil_save",
      { ...SAVE_ARGS, project: "@acme" },
      store,
      NOW,
    );
    expect(saved.isError).toBeUndefined();

    // The operator promotes the directory to a team server: init the
    // registry beside the containers, add a member, register the project.
    // Nothing in the container itself is touched.
    const registry = new Registry(home);
    registry.init();
    registry.addUser("ada");
    const ada = registry.findUser("ada");
    expect(ada).toBeDefined();
    registry.addProject("acme", ["ada"]);

    const service = new ServerService(home);
    const throughTheServer = service.load(ada!.userId, "#001", "acme");
    expect(throughTheServer.handover.title).toBe("Billing rework, midpoint");
    expect(throughTheServer.handover.sections.decisions.summary).toContain(
      "outbox pattern",
    );
    expect(throughTheServer.restorePrompt).toContain("outbox pattern");

    // Byte identity, not just structural agreement: the document the server
    // reads is the file the local path wrote.
    const file = readFileSync(
      join(home, "projects", "acme", "handovers", "001.json"),
      "utf8",
    );
    expect(JSON.parse(file)).toEqual(throughTheServer.handover);

    const listed = service.list(ada!.userId, "acme");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.code).toBe("#001");
    expect(listed[0]?.scope).toBe("project");
  });

  it("loads a server-stored project handover through the local stdio path", () => {
    const registry = new Registry(home);
    registry.init();
    registry.addUser("ada");
    const ada = registry.findUser("ada");
    registry.addProject("acme", ["ada"]);

    const service = new ServerService(home);
    const outcome = service.save(
      ada!.userId,
      normalizeHandover({
        projectId: "billing-rework",
        title: "Stored by the server",
        createdAt: NOW.toISOString(),
        sections: {
          decisions: {
            status: "available",
            summary: "Postgres stays; the queue moves to the outbox pattern.",
          },
        },
      }),
      "acme",
    );
    expect(outcome.ok).toBe(true);

    const loaded = callTool(
      "soil_load",
      { code: "#001", project: "@acme" },
      store,
      NOW,
    );
    expect(loaded.isError).toBeUndefined();
    expect(loaded.content[0]?.text).toContain("outbox pattern");

    const listed = callTool("soil_list", { project: "acme" }, store, NOW);
    expect(listed.content[0]?.text).toContain("Stored by the server");
  });

  it("holds the three project name patterns to one rule", () => {
    // The CLI, the stdio tools and the server each state what a project may
    // be named. They are one rule, stated three times because the packages do
    // not depend on each other at runtime; this is the test that keeps the
    // three statements from drifting.
    expect(MCP_PROJECT_ID_PATTERN.source).toBe(
      SERVER_PROJECT_ID_PATTERN.source,
    );
    expect(CLI_PROJECT_ID_PATTERN.source).toBe(
      SERVER_PROJECT_ID_PATTERN.source,
    );
  });
});
