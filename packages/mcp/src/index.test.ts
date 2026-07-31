import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HandoverStore,
  PROVENANCE_LABELS,
  SECTION_KEYS,
  SECTION_STATUSES,
  validateHandover,
} from "@nativesoil/handover-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleMessage } from "./index.js";
import { TOOLS, callTool } from "./tools.js";

const NOW = new Date("2026-07-22T10:00:00Z");

let home: string;
let store: HandoverStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "soil-mcp-test-"));
  store = new HandoverStore(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function request(method: string, params?: unknown, id: number | string = 1) {
  return handleMessage({ jsonrpc: "2.0", id, method, params }, store, NOW);
}

describe("protocol", () => {
  it("answers initialize with a protocol version and instructions", () => {
    const response = request("initialize", { protocolVersion: "2025-06-18" });
    expect(response?.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "soil-handover" },
    });
  });

  it("falls back to a known protocol version when asked for an unknown one", () => {
    const result = request("initialize", { protocolVersion: "1999-01-01" })
      ?.result as { protocolVersion: string };
    expect(result.protocolVersion).toBe("2025-06-18");
  });

  it("answers ping", () => {
    // Still an empty result, now carrying the two fields every result carries:
    // the result's own type, and who answered. Pinned exactly rather than
    // loosely, so a change to either has to be deliberate.
    expect(request("ping")?.result).toEqual({
      resultType: "complete",
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "soil-handover",
          title: "Soil Handover (local)",
          version: "0.1.0",
        },
      },
    });
  });

  it("says nothing to a notification", () => {
    expect(
      handleMessage(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        store,
      ),
    ).toBeUndefined();
  });

  it("rejects an unknown method with a JSON-RPC error", () => {
    expect(request("tools/frobnicate")?.error?.code).toBe(-32601);
  });

  it("rejects something that is not a request at all", () => {
    expect(handleMessage("hello", store)?.error?.code).toBe(-32600);
  });
});

/**
 * One server, two protocol eras. These checks exist because the rest of the
 * suite cannot see any of this: it asserts what the tools do, and the era a
 * request is served under is decided before a tool is ever reached.
 */
describe("both protocol eras on one server", () => {
  const MODERN_META = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  describe("a legacy client still works", () => {
    it("gets a handshake, and a legacy version out of it", () => {
      const result = request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "legacy", version: "0" },
      })?.result as { protocolVersion: string };
      expect(result.protocolVersion).toBe("2025-03-26");
    });

    it("is never told the handshake settled on a handshake-free revision", () => {
      // A legacy client cannot fall forward, so answering `2026-07-28` here
      // would strand it: it would believe it had negotiated a revision whose
      // rules it cannot follow.
      const result = request("initialize", { protocolVersion: "2026-07-28" })
        ?.result as { protocolVersion: string };
      expect(result.protocolVersion).toBe("2025-06-18");
    });

    it("is served, not refused, when its _meta carries only a progressToken", () => {
      // The era is keyed to the reserved protocol fields, not to `_meta`
      // itself. A legacy client that opts into progress notifications must not
      // trip the modern requirements.
      const response = request("tools/list", { _meta: { progressToken: 7 } });
      expect(response?.error).toBeUndefined();
      expect((response?.result as { tools: unknown[] }).tools).toHaveLength(
        TOOLS.length,
      );
    });

    it("is served, not refused, when it sends no params at all", () => {
      expect(request("tools/list")?.error).toBeUndefined();
    });
  });

  describe("a modern client works without any handshake", () => {
    it("discovers the server, which must implement server/discover", () => {
      const result = request("server/discover", { _meta: MODERN_META })
        ?.result as {
        supportedVersions: string[];
        capabilities: Record<string, unknown>;
        instructions: string;
      };
      expect(result.supportedVersions).toContain("2026-07-28");
      expect(result.supportedVersions).toContain("2025-06-18");
      // Optional capabilities live in `extensions` now, not `experimental`.
      expect(result.capabilities["extensions"]).toEqual({});
      expect(result.capabilities).not.toHaveProperty("experimental");
      expect(result.instructions.length).toBeGreaterThan(0);
    });

    it("calls a tool with no initialize ever sent", () => {
      const response = request("tools/call", {
        name: "soil_list",
        arguments: {},
        _meta: MODERN_META,
      });
      expect(response?.error).toBeUndefined();
      expect(response?.result).toMatchObject({ resultType: "complete" });
    });
  });

  describe("a request carrying capabilities but no version is served as legacy", () => {
    // The hybrid shape real client runtimes send today: `_meta` carrying only
    // `io.modelcontextprotocol/clientCapabilities`, no version key. The
    // specification reserves both keys for the modern revisions, but a
    // conforming `2026-07-28` client must declare its protocol version on
    // every request, so the version key is the one reliable marker of modern
    // intent and capabilities alone is not. Reading this shape as modern
    // refused every call such a client made, so the era is decided by the
    // version key alone and this shape is served as the legacy request it
    // otherwise is, byte for byte.
    const CAPABILITIES_ONLY = {
      "io.modelcontextprotocol/clientCapabilities": {},
    };

    it("serves tools/list byte-identically to the bare request", () => {
      const bare = request("tools/list");
      const hybrid = request("tools/list", { _meta: CAPABILITIES_ONLY });
      expect(hybrid?.error).toBeUndefined();
      expect(JSON.stringify(hybrid)).toBe(JSON.stringify(bare));
    });

    it("serves a tool call byte-identically to the bare request", () => {
      const bare = request("tools/call", { name: "soil_list", arguments: {} });
      const hybrid = request("tools/call", {
        name: "soil_list",
        arguments: {},
        _meta: CAPABILITIES_ONLY,
      });
      expect(hybrid?.error).toBeUndefined();
      expect(JSON.stringify(hybrid)).toBe(JSON.stringify(bare));
    });

    it("still refuses server/discover without the version key, naming it", () => {
      // `server/discover` exists only from `2026-07-28` on, so it is held to
      // the modern requirements whatever its `_meta` carries, and the missing
      // version key is the fault that gets named.
      const error = request("server/discover", {
        _meta: CAPABILITIES_ONLY,
      })?.error;
      expect(error?.code).toBe(-32602);
      expect((error?.data as { missing: string[] }).missing).toEqual([
        "io.modelcontextprotocol/protocolVersion",
      ]);
    });
  });

  describe("a modern request missing what the revision requires is refused", () => {
    it("refuses a missing clientCapabilities with -32602", () => {
      // The version key opened the modern era, so everything the revision
      // requires is required of this request, capabilities included. Only the
      // reverse shape, capabilities without the version key, is read as
      // legacy.
      const error = request("tools/list", {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      })?.error;
      expect(error?.code).toBe(-32602);
      expect((error?.data as { missing: string[] }).missing).toEqual([
        "io.modelcontextprotocol/clientCapabilities",
      ]);
    });

    it("refuses a bare server/discover, which cannot be a legacy request", () => {
      expect(request("server/discover", {})?.error?.code).toBe(-32602);
      expect(request("server/discover")?.error?.code).toBe(-32602);
    });

    it("refuses an unsupported version with -32022 instead of downgrading", () => {
      const error = request("tools/list", {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "1900-01-01",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      })?.error;
      expect(error?.code).toBe(-32022);
      expect(error?.data).toEqual({
        supported: ["2026-07-28", "2025-06-18", "2025-03-26", "2024-11-05"],
        requested: "1900-01-01",
      });
    });
  });

  describe("every result names its own type", () => {
    it("carries resultType and the server's identity, whichever era asked", () => {
      const legacy = request("initialize", { protocolVersion: "2025-06-18" });
      const modern = request("server/discover", { _meta: MODERN_META });
      for (const response of [legacy, modern, request("tools/list")]) {
        const result = response?.result as Record<string, unknown>;
        expect(result["resultType"]).toBe("complete");
        expect(
          (result["_meta"] as Record<string, unknown>)[
            "io.modelcontextprotocol/serverInfo"
          ],
        ).toMatchObject({ name: "soil-handover" });
      }
    });
  });
});

describe("tools/list", () => {
  const tools = (request("tools/list")?.result as { tools: typeof TOOLS })
    .tools;

  it("exposes exactly soil_save, soil_load and soil_list", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "soil_list",
      "soil_load",
      "soil_save",
    ]);
  });

  it("declares strict schemas, so no client can flatten the parameters away", () => {
    for (const tool of tools) {
      expect(tool.inputSchema["additionalProperties"]).toBe(false);
      expect(tool.inputSchema["properties"]).toBeTypeOf("object");
    }
  });

  it("declares every one of the 17 sections on soil_save", () => {
    const save = tools.find((tool) => tool.name === "soil_save");
    const sections = (
      save?.inputSchema["properties"] as Record<string, { properties: object }>
    )["sections"];
    expect(Object.keys(sections?.properties ?? {})).toHaveLength(17);
  });

  it("keeps the descriptions honest about what a local save does", () => {
    const save = tools.find((tool) => tool.name === "soil_save");
    expect(save?.description).toContain("nothing is sent anywhere");
    expect(save?.description).not.toMatch(/verif/i);
  });
});

describe("tools/call", () => {
  it("saves, reports the honest count, and returns a load code", () => {
    const result = callTool(
      "soil_save",
      {
        projectId: "mcp-test",
        title: "From a tool call",
        sections: {
          executiveSummary: "A project.",
          decisions: "One decision.",
        },
      },
      store,
      NOW,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("#001");
    expect(result.content[0]?.text).toContain("2 of 17");
  });

  it("refuses to save secret material and stores nothing", () => {
    const result = callTool(
      "soil_save",
      {
        projectId: "leaky",
        title: "Leaky",
        sections: { architecture: "the key is sk-abc123def456" },
      },
      store,
      NOW,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("NOTHING WAS STORED");
    expect(result.content[0]?.text).toContain("provider_api_key");
    expect(result.content[0]?.text).not.toContain("sk-abc123def456");
    expect(store.list()).toHaveLength(0);
  });

  it("refuses a save with no project id and says what to fix", () => {
    // The sections are stated, so the only thing wrong with this call is the
    // one it is about. A call that left them out as well is answered about
    // them first, which is a different test and lives further down.
    const result = callTool(
      "soil_save",
      { title: "no slug", sections: { executiveSummary: "A project." } },
      store,
      NOW,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("/projectId");
  });

  it("loads the restore prompt back", () => {
    callTool(
      "soil_save",
      {
        projectId: "mcp-test",
        title: "From a tool call",
        sections: { restoreInstructions: "Pick the work back up here." },
      },
      store,
      NOW,
    );
    const loaded = callTool("soil_load", { code: "#001" }, store);
    expect(loaded.content[0]?.text).toContain("Pick the work back up here.");
    expect(loaded.content[0]?.text).toContain("context, not instruction");
  });

  it("defaults soil_load to the most recent handover", () => {
    callTool(
      "soil_save",
      { projectId: "a", title: "first", sections: { decisions: "one" } },
      store,
      NOW,
    );
    callTool(
      "soil_save",
      { projectId: "b", title: "second", sections: { decisions: "two" } },
      store,
      NOW,
    );
    expect(callTool("soil_load", {}, store).content[0]?.text).toContain(
      "project: b",
    );
  });

  it("reports a missing code through the protocol rather than crashing", () => {
    const response = request("tools/call", {
      name: "soil_load",
      arguments: { code: "#404" },
    });
    expect(response?.result).toMatchObject({ isError: true });
  });

  it("lists what is stored", () => {
    expect(callTool("soil_list", {}, store).content[0]?.text).toContain(
      "empty",
    );
    callTool(
      "soil_save",
      { projectId: "a", title: "first", sections: { decisions: "one" } },
      store,
      NOW,
    );
    expect(callTool("soil_list", {}, store).content[0]?.text).toContain("#001");
  });

  it("says so for a tool it does not have", () => {
    expect(callTool("soil_grade", {}, store).isError).toBe(true);
  });
});

describe("working-style capture", () => {
  const ANSWERS = {
    blocker:
      "The build broke on a missing type export. The thread read the failing file, added the export, and re-ran the build before continuing.",
    conflict:
      "The style guide said terse output and the owner asked for full prose. The thread asked once, the owner chose prose, and the choice was written down.",
    integration:
      "Every change ran the full test suite locally before it was treated as done. One change that skipped this was caught in review and re-run.",
    assumption:
      "The thread assumed the store index was always present. A fresh checkout had none, the load failed, and the code now rebuilds the index instead.",
  };

  function save(extra: Record<string, unknown> = {}) {
    return callTool(
      "soil_save",
      {
        projectId: "style-test",
        title: "Working style test",
        sections: {
          decisions: "One decision.",
          workflow: "Tests before merge.",
        },
        ...extra,
      },
      store,
      NOW,
    );
  }

  it("declares the four questions on soil_save, strict like everything else", () => {
    const saveTool = TOOLS.find((tool) => tool.name === "soil_save");
    const workingStyle = (
      saveTool?.inputSchema["properties"] as Record<
        string,
        { additionalProperties: boolean; properties: object }
      >
    )["workingStyle"];
    expect(workingStyle?.additionalProperties).toBe(false);
    expect(Object.keys(workingStyle?.properties ?? {}).sort()).toEqual([
      "assumption",
      "blocker",
      "conflict",
      "integration",
    ]);
  });

  it("records answers as exactly one well-formed working.style observation", () => {
    const result = save({ workingStyle: ANSWERS });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("recorded instances");

    const stored = store.read("#001");
    expect(stored.observations).toHaveLength(1);
    const observation = stored.observations?.[0];
    expect(observation?.kind).toBe("working.style");
    expect(observation?.producedBy).toBe("@nativesoil/handover-mcp 0.1.0");
    expect(observation?.producedAt).toBe("2026-07-22T10:00:00.000Z");
    const instances = observation?.data["instances"] as {
      situation: string;
      response: string;
    }[];
    expect(instances).toHaveLength(4);
    expect(instances[0]?.situation).toBe("How the last blocker was handled");
    expect(instances[0]?.response).toBe(ANSWERS.blocker);

    // The stored document, observation included, is a valid handover.
    expect(validateHandover(stored).valid).toBe(true);
  });

  it("stores a save without answers exactly as before, no observation attached", () => {
    save();
    const raw = readFileSync(join(home, "handovers", "001.json"), "utf8");
    expect(raw).not.toContain("observations");
    expect(raw).not.toContain("working.style");
    expect(raw).not.toContain("workingStyle");
    expect(store.read("#001").observations).toBeUndefined();
  });

  it("keeps the save receipt silent about working style when nothing was recorded", () => {
    const result = save();
    expect(result.content[0]?.text).not.toContain("recorded instances");
  });

  it("drops malformed and oversized answers fail-soft, never a save error", () => {
    const result = save({
      workingStyle: {
        blocker: ANSWERS.blocker,
        conflict: 42,
        integration: "   ",
        assumption: "x".repeat(2001),
      },
    });
    expect(result.isError).toBeUndefined();
    const instances = store.read("#001").observations?.[0]?.data[
      "instances"
    ] as unknown[];
    expect(instances).toHaveLength(1);
  });

  it("attaches nothing when every answer is unusable, and the save still succeeds", () => {
    const result = save({ workingStyle: "not even an object" });
    expect(result.isError).toBeUndefined();
    expect(store.read("#001").observations).toBeUndefined();
  });

  it("refuses the whole save when an answer carries a secret", () => {
    const result = save({
      workingStyle: { blocker: "We fixed it by setting sk-abc123def456." },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("NOTHING WAS STORED");
    expect(result.content[0]?.text).not.toContain("sk-abc123def456");
    expect(store.list()).toHaveLength(0);
  });

  it("presents recorded instances at load as attributed evidence, sections first", () => {
    save({ workingStyle: ANSWERS });
    const loaded = callTool("soil_load", { code: "#001" }, store);
    const text = loaded.content[0]?.text ?? "";
    expect(text).toMatch(
      /^=== soil:[0-9a-f]{32} WORKING STYLE, RECORDED INSTANCES ===$/m,
    );
    expect(text).toContain("Evidence from @nativesoil/handover-mcp 0.1.0");
    expect(text).toContain("the section wins");
    expect(text).toContain(ANSWERS.assumption);
    expect(text.indexOf("the section wins")).toBeGreaterThan(
      text.indexOf("HOW TO START"),
    );
  });

  it("never renders a count, score or grade from observations at load", () => {
    save({ workingStyle: ANSWERS });
    const text = callTool("soil_load", { code: "#001" }, store).content[0]
      ?.text as string;
    expect(text).not.toMatch(/\d+\s*(?:of|\/)?\s*\d*\s*instances?/i);
    expect(text).not.toMatch(/grade|score/i);
  });

  it("leaves the load output untouched for a handover without observations", () => {
    save();
    const text = callTool("soil_load", { code: "#001" }, store).content[0]
      ?.text as string;
    expect(text).not.toContain("WORKING STYLE");
  });
});

// ---------------------------------------------------------------------
// The producer surface: what a model can say through the DECLARED schema.
//
// Before this, the tool declared every section as a plain string. A model
// going through the tool interface could reach only the statuses a bare
// string implies, `available` and `missing`, and no provenance label at all,
// while the recipe it is handed asks it to do both. The recipe and the
// interface described two different documents, and the interface is the door
// most callers go through.
//
// That sentence used to count both sets rather than name them, and its count
// of the statuses went stale the week a fourth one was added — in a comment
// nothing was checking, because the set had been agreed to be frozen and a
// category agreed to be safe is a category nobody looks at. It records a past
// state, so it names what it means instead: history keeps its meaning without
// borrowing a number that then has to stay true.
// ---------------------------------------------------------------------

describe("the producer surface", () => {
  function saveSchema(): Record<string, unknown> {
    const tool = TOOLS.find((entry) => entry.name === "soil_save");
    expect(tool).toBeDefined();
    return (tool as { inputSchema: Record<string, unknown> }).inputSchema;
  }

  function property(name: string): Record<string, unknown> {
    const properties = saveSchema()["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties[name]).toBeDefined();
    return properties[name] as Record<string, unknown>;
  }

  it("declares all 17 sections, every status and every provenance label", () => {
    for (const group of ["sections", "sectionStatus", "sectionProvenance"]) {
      const keys = Object.keys(
        property(group)["properties"] as Record<string, unknown>,
      );
      expect(keys.sort()).toEqual([...SECTION_KEYS].sort());
      expect(property(group)["additionalProperties"]).toBe(false);
    }

    const statuses = property("sectionStatus")["properties"] as Record<
      string,
      { enum: string[] }
    >;
    for (const key of SECTION_KEYS) {
      expect(statuses[key]?.enum).toEqual([...SECTION_STATUSES]);
      expect(statuses[key]?.enum).toContain("blocked");
    }

    const provenance = property("sectionProvenance")["properties"] as Record<
      string,
      { items: { enum: string[] } }
    >;
    for (const key of SECTION_KEYS) {
      expect(provenance[key]?.items.enum).toEqual([...PROVENANCE_LABELS]);
      expect(provenance[key]?.items.enum).toHaveLength(11);
    }

    expect(property("safety")["properties"]).toHaveProperty("unsafeOmissions");
    expect(property("observations")["type"]).toBe("array");
    expect(property("soilHandover")["type"]).toBe("string");
  });

  it("declares no union anywhere, and closes every object it declares", () => {
    const walk = (node: unknown, where: string): void => {
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      for (const keyword of ["anyOf", "oneOf", "allOf"]) {
        expect(record[keyword], `${where} declares ${keyword}`).toBeUndefined();
      }
      expect(Array.isArray(record["type"]), `${where} has a type list`).toBe(
        false,
      );
      if (record["type"] === "object") {
        expect(record["additionalProperties"], `${where} is open`).toBe(false);
        expect(typeof record["properties"], `${where} declares nothing`).toBe(
          "object",
        );
        for (const [key, value] of Object.entries(
          record["properties"] as Record<string, unknown>,
        )) {
          walk(value, `${where}.${key}`);
        }
      }
      if (record["items"] !== undefined) walk(record["items"], `${where}[]`);
    };
    for (const tool of TOOLS) walk(tool.inputSchema, tool.name);
  });

  it("round trips a blocked section and provenance labels", () => {
    // Producer input, stored canonical document, validation, rendering, and
    // whether a reader gets back what was sent.
    const result = callTool(
      "soil_save",
      {
        soilHandover: "1.0",
        projectId: "billing-rework",
        title: "Billing rework, blocked and labelled",
        sections: {
          projectIdentity:
            "Ship the billing rework without breaking invoicing.",
          decisions: "Postgres stays; the queue moves to the outbox pattern.",
          constraints:
            "The provider key exists and is set in the deployment platform. Its value is withheld here.",
          safetySummary:
            "One credential was withheld: the billing provider key, configured in the deployment platform.",
        },
        sectionStatus: {
          constraints: "blocked",
          decisions: "available",
          workflow: "missing",
        },
        sectionProvenance: {
          decisions: ["user_locked_memory", "repo_verified"],
          constraints: ["blocked"],
          projectIdentity: ["model_reported"],
        },
        safety: {
          unsafeOmissions: [
            "The billing provider key exists and is configured in the deployment platform.",
          ],
        },
        observations: [
          {
            kind: "kind.from.the.future",
            data: [
              { name: "note", value: "A producer this reader postdates." },
            ],
          },
        ],
      },
      store,
      NOW,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain(
      "Withheld for safety, recorded as blocked",
    );

    const stored = store.read("#001");
    expect(validateHandover(stored).valid).toBe(true);
    expect(stored.soilHandover).toBe("1.0");
    expect(stored.sections.constraints.status).toBe("blocked");
    expect(stored.sections.constraints.provenance).toEqual(["blocked"]);
    expect(stored.sections.decisions.provenance).toEqual([
      "user_locked_memory",
      "repo_verified",
    ]);
    expect(stored.sections.workflow.status).toBe("missing");
    expect(stored.safety?.unsafeOmissions).toHaveLength(1);
    expect(stored.observations?.[0]?.kind).toBe("kind.from.the.future");
    expect(stored.observations?.[0]?.data).toEqual({
      note: "A producer this reader postdates.",
    });
    expect(stored.observations?.[0]?.producedBy).toBe(
      "@nativesoil/handover-mcp 0.1.0",
    );

    // Every one of the 17 keys is present in the stored document: a gap is
    // declared, never omitted, whichever of the three parallel objects it
    // was mentioned in.
    expect(Object.keys(stored.sections).sort()).toEqual(
      [...SECTION_KEYS].sort(),
    );

    const prompt = callTool("soil_load", { code: "#001" }, store).content[0]
      ?.text as string;
    expect(prompt).toContain("outbox pattern");
    expect(prompt).toContain("withheld");
  });

  it("does not report a section with no subject as a gap", () => {
    // The no-subject status exists to tell the next reader to stop looking.
    // Calling it a section with nothing in it says the opposite of what the
    // model stated, and the card and the restore prompt both get it right, so a
    // receipt that does not disagrees with them about the same document.
    const result = callTool(
      "soil_save",
      {
        projectId: "no-subject",
        title: "A project with no rejected paths",
        sections: {
          decisions: "One decision, with its reason.",
          rejectedPaths:
            "Nothing has been tried and abandoned on this project.",
          openQuestions:
            "The deployment target is open and nobody has proposed one.",
        },
        sectionStatus: {
          decisions: "available",
          rejectedPaths: "not_applicable",
          openQuestions: "blocked",
          workflow: "missing",
        },
      },
      store,
      NOW,
    );
    expect(result.isError).toBeUndefined();
    const receipt = result.content[0]?.text as string;

    const emptyLine = receipt
      .split("\n")
      .find((line) => line.startsWith("Sections with nothing in them"));
    expect(emptyLine).toBeDefined();
    expect(emptyLine).toContain("workflow");
    // Every status that is not an absence stays out of that line.
    expect(emptyLine).not.toContain("rejectedPaths");
    expect(emptyLine).not.toContain("openQuestions");
    expect(emptyLine).not.toContain("decisions");

    expect(receipt).toContain(
      "Recorded as having no subject in this project: rejectedPaths.",
    );
    expect(receipt).toContain(
      "Withheld for safety, recorded as blocked: openQuestions.",
    );

    const stored = store.read("#001");
    expect(stored.sections.rejectedPaths.status).toBe("not_applicable");
    expect(stored.sections.openQuestions.status).toBe("blocked");
    expect(stored.sections.workflow.status).toBe("missing");
  });

  it("refuses a status outside the permitted set rather than rewriting it", () => {
    const result = callTool(
      "soil_save",
      {
        projectId: "status",
        title: "Status",
        sections: { decisions: "One decision." },
        sectionStatus: { decisions: "Available" },
      },
      store,
      NOW,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("/sections/decisions/status");
    expect(store.list()).toHaveLength(0);
  });

  it("records a blocked section that carries no prose at all", () => {
    // The status alone is a statement: the section exists, it was withheld,
    // and the reader is told so rather than left to guess from an absence.
    callTool(
      "soil_save",
      {
        projectId: "blocked-only",
        title: "Blocked only",
        sections: { decisions: "One decision." },
        sectionStatus: { architecture: "blocked" },
      },
      store,
      NOW,
    );
    const stored = store.read("#001");
    expect(stored.sections.architecture.status).toBe("blocked");
    expect(stored.sections.architecture.summary).toBeNull();
    expect(validateHandover(stored).valid).toBe(true);
  });

  it("refuses the whole save when a declared observation carries a secret", () => {
    const result = callTool(
      "soil_save",
      {
        projectId: "obs",
        title: "Obs",
        sections: { decisions: "One decision." },
        observations: [
          {
            kind: "debug.note",
            data: [
              {
                name: "endpoint",
                value: "Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e",
              },
            ],
          },
        ],
      },
      store,
      NOW,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("NOTHING WAS STORED");
    expect(result.content[0]?.text).not.toContain(
      "7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e",
    );
    expect(store.list()).toHaveLength(0);
  });

  it("carries a declared observation and the working-style one together", () => {
    callTool(
      "soil_save",
      {
        projectId: "both",
        title: "Both",
        sections: { decisions: "One decision." },
        observations: [
          { kind: "quality.capture", data: [{ name: "note", value: "Thin." }] },
        ],
        workingStyle: {
          blocker:
            "The build broke on a missing type export. The thread read the failing file, added the export, and re-ran the build.",
        },
      },
      store,
      NOW,
    );
    const stored = store.read("#001");
    expect(stored.observations).toHaveLength(2);
    expect(stored.observations?.map((entry) => entry.kind)).toEqual([
      "quality.capture",
      "working.style",
    ]);
    expect(validateHandover(stored).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------
// The declared schema, enforced.
//
// `additionalProperties: false` in `tools/list` is a promise about what this
// surface accepts, and for a while only one side kept it. A member outside the
// schema was accepted, dropped, and answered with a load code: a model that
// guessed a field name lost its content and was told it succeeded. The same
// content pasted through `soil save` on the command line was refused, per path,
// with a non-zero exit. Two doors, two answers, one set of bytes.
//
// These pin the answer, not the mechanism: the path the caller stated, the words
// the command-line door already uses, an error flag, and an empty store. And the
// other direction with them, because a door that refused everything would pass
// all of that and be useless.
// ---------------------------------------------------------------------

describe("the declared schema is enforced", () => {
  const LEGAL = {
    projectId: "strictness",
    title: "A legal save",
    sections: { executiveSummary: "A project." },
  };

  function save(args: Record<string, unknown>) {
    const result = callTool("soil_save", args, store, NOW);
    return { isError: result.isError, text: result.content[0]?.text ?? "" };
  }

  it("refuses an undeclared root argument, and stores nothing", () => {
    const out = save({
      ...LEGAL,
      totallyUndeclared: "content the caller stated",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/totallyUndeclared is not a field of this object",
    );
    expect(out.text).not.toContain("Saved locally");
    expect(store.list()).toHaveLength(0);
  });

  it("refuses an undeclared member nested inside a declared object", () => {
    const out = save({
      ...LEGAL,
      sections: { ...LEGAL.sections, notARealSection: "prose under a guess" },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/sections/notARealSection is not a field of this object",
    );
    expect(store.list()).toHaveLength(0);
  });

  it("refuses an undeclared member inside an array entry, by index", () => {
    const out = save({
      ...LEGAL,
      observations: [
        {
          kind: "quality.capture",
          data: [{ name: "note", value: "v" }],
          producedBy: "somebody else",
        },
      ],
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/observations/0/producedBy is not a field of this object",
    );
    expect(store.list()).toHaveLength(0);
  });

  it("refuses guessed working-style keys instead of storing zero answers", () => {
    // The measured case. Four plausible names, none of them the four the schema
    // declares: the save used to succeed, record no observation, and say nothing
    // about the payload it had just thrown away.
    const out = save({
      ...LEGAL,
      workingStyle: {
        correction: "The owner asked for shorter replies.",
        preference: "Answers in the project's own language.",
      },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/workingStyle/correction is not a field of this object",
    );
    expect(out.text).toContain(
      "/workingStyle/preference is not a field of this object",
    );
    expect(store.list()).toHaveLength(0);
  });

  it("names every undeclared member, not just the first", () => {
    const out = save({ ...LEGAL, aaa: 1, zzz: 2 });
    expect(out.text).toContain("/aaa is not a field of this object");
    expect(out.text).toContain("/zzz is not a field of this object");
  });

  it("refuses an undeclared argument on soil_load and soil_list too", () => {
    for (const name of ["soil_load", "soil_list"]) {
      const result = callTool(name, { projet: "a typo" }, store, NOW);
      expect(result.isError, name).toBe(true);
      expect(result.content[0]?.text, name).toContain(
        "/projet is not a field of this object",
      );
    }
  });

  it("leaves a member's TYPE to the validator, at the validator's path", () => {
    // The walk reads membership only. A declared member holding the wrong shape
    // must reach validation and be refused there, so the caller gets the message
    // that path deserves rather than a second, vaguer complaint.
    const out = save({ ...LEGAL, sectionStatus: { decisions: "nearly_done" } });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("/sections/decisions/status");
    expect(out.text).not.toContain("is not a field of this object");
  });

  it("accepts a prototype member name as the undeclared member it is", () => {
    const out = save({ ...LEGAL, constructor: "not a declared argument" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("/constructor is not a field of this object");
  });
});

// ---------------------------------------------------------------------
// A member the schema declares as required.
//
// The mirror of the block above, and for a while only one half of the rule held:
// an undeclared member could not be present, and a required one could still be
// absent. Measured on the tree before this existed: `soil_save` with no
// `sections` at all stored a document with every one of the 17 a gap and answered
// with a load code, which is exactly what a client that flattened this schema
// sends and exactly the answer that must never be given to it. The same for an
// observation stating no `data`, which reached the store carrying an empty
// payload.
//
// The half that must NOT change is the one below it. A required container stated
// and empty is a caller saying it had nothing, which is a handover this format
// keeps and pins in a fixture of its own, and turning that into a refusal is what
// teaches a model to pad. Silence is what is refused.
// ---------------------------------------------------------------------

describe("a member the schema declares as required", () => {
  const LEGAL = {
    projectId: "requiredness",
    title: "A legal save",
    sections: { executiveSummary: "A project." },
  };

  function save(args: Record<string, unknown>) {
    const result = callTool("soil_save", args, store, NOW);
    return { isError: result.isError, text: result.content[0]?.text ?? "" };
  }

  it("refuses a save with no sections at all, and stores nothing", () => {
    const { sections, ...withoutSections } = LEGAL;
    void sections;
    const out = save(withoutSections);
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/sections is required and must be an object holding all 17 sections",
    );
    expect(out.text).not.toContain("Saved locally");
    expect(store.list()).toHaveLength(0);
  });

  it("refuses an observation that states no payload, by index", () => {
    const out = save({
      ...LEGAL,
      observations: [{ kind: "quality.capture" }],
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/observations/0/data is required and must be an array of named text entries",
    );
    expect(store.list()).toHaveLength(0);
  });

  it("tells the caller that stating it empty is an answer", () => {
    const { sections, ...withoutSections } = LEGAL;
    void sections;
    const out = save(withoutSections);
    expect(out.text).toContain("state it empty if you genuinely have nothing");
  });

  it("keeps an empty container as the statement it is", () => {
    // The honest-thin case, and the reason absence is refused rather than
    // repaired: this spelling has to keep working, or the refusal above would be
    // a rule against saying you had nothing.
    const out = save({ ...LEGAL, sections: {} });
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain("0 of 17 sections carry content");
    expect(store.list()).toHaveLength(1);
  });

  it("keeps an empty observation payload as the statement it is", () => {
    const out = save({
      ...LEGAL,
      observations: [{ kind: "quality.capture", data: [] }],
    });
    expect(out.isError).toBeUndefined();
    const stored = store.read(store.list()[0]?.code ?? "last");
    expect(stored.observations?.[0]?.data).toEqual({});
  });

  it("names every absent required member at once, not just the first", () => {
    const { sections, ...withoutSections } = LEGAL;
    void sections;
    const out = save({
      ...withoutSections,
      observations: [{ kind: "quality.capture" }],
    });
    expect(out.text).toContain("/sections is required");
    expect(out.text).toContain("/observations/0/data is required");
  });

  it("leaves a required member that TRAVELS to the validator", () => {
    // `projectId` and `title` reach the document, so the validator refuses them
    // absent at their own paths in these same words. A second complaint from this
    // door would say one thing twice, and the refusal a caller reads must come
    // from the one place that judges the member.
    for (const key of ["projectId", "title"]) {
      const args: Record<string, unknown> = { ...LEGAL };
      delete args[key];
      const out = save(args);
      expect(out.isError, key).toBe(true);
      expect(out.text, key).toContain(
        `/${key} is required and must be a non-empty string`,
      );
      expect(out.text, key).not.toContain("cannot be inferred from the rest");
    }
    // Same for an observation's `kind`, which is carried into the document
    // exactly as written.
    const out = save({
      ...LEGAL,
      observations: [{ data: [{ name: "note", value: "v" }] }],
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/observations/0/kind is required and must be a non-empty string",
    );
    expect(store.list()).toHaveLength(0);
  });

  it("asks nothing of soil_load and soil_list, which require nothing", () => {
    callTool("soil_save", LEGAL, store, NOW);
    for (const name of ["soil_load", "soil_list"]) {
      const result = callTool(name, {}, store, NOW);
      expect(result.isError, name).toBeUndefined();
      expect(result.content[0]?.text, name).not.toContain("is required");
    }
  });
});

// ---------------------------------------------------------------------
// A stated value this surface cannot carry.
//
// Membership was the first half of the rule and this is the second. A member the
// schema declares, a caller fills, and this surface then discards is the same
// loss as an undeclared one, read a step further in, and the arguments it bites
// are the few this file READS rather than carries: they never reach the
// validator, so nothing downstream can catch them.
//
// Measured on the tree before this existed, each one answering with a normal
// receipt and no error flag: a whole capture stated as one string became
// seventeen empty sections and a load code; an observation entry that was not an
// object vanished whole; a payload field whose name was not text vanished from
// inside an entry that was still stored, which reads to every later reader as an
// observation its producer wrote empty; and a load code that was not text became
// "last", so a caller asking for one document was handed another.
//
// What each case gets is the point, so both answers are pinned. Content is
// REFUSED. An optional extra dropped by a documented fail-soft rule is REPORTED,
// because refusing there would cost a user their capture over a field the schema
// calls optional.
// ---------------------------------------------------------------------

describe("a stated value this surface cannot carry", () => {
  const LEGAL = {
    projectId: "discarded",
    title: "A legal save",
    sections: { executiveSummary: "A project." },
  };

  function save(args: Record<string, unknown>) {
    const result = callTool("soil_save", args, store, NOW);
    return { isError: result.isError, text: result.content[0]?.text ?? "" };
  }

  /** Two handovers whose PROSE names them, because a restore prompt renders the
   * sections rather than the title. */
  function seedTwo(): void {
    for (const which of ["The older handover", "The newer handover"]) {
      callTool(
        "soil_save",
        {
          ...LEGAL,
          title: which,
          sections: { executiveSummary: `A project, saved as ${which}.` },
        },
        store,
        NOW,
      );
    }
  }

  it("refuses a whole capture stated as one string, and stores nothing", () => {
    const out = save({
      ...LEGAL,
      sections: "Everything I know about this project, as one paragraph.",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/sections must be an object holding all 17 sections",
    );
    expect(out.text).not.toContain("Saved locally");
    expect(store.list()).toHaveLength(0);
  });

  it("refuses a parallel section object stated as something else", () => {
    for (const key of ["sectionStatus", "sectionProvenance"]) {
      const out = save({ ...LEGAL, [key]: "available" });
      expect(out.isError, key).toBe(true);
      expect(out.text, key).toContain(`/${key} must be an object`);
    }
    expect(store.list()).toHaveLength(0);
  });

  it("refuses an observation entry that is not an object", () => {
    const out = save({ ...LEGAL, observations: ["a note as a bare string"] });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/observations/0 must be an object with 'kind' and 'data'",
    );
    expect(store.list()).toHaveLength(0);
  });

  it("refuses one bad entry without storing the good ones beside it", () => {
    // The measured shape of the first drop: a caller sends two entries, one of
    // them malformed, and the save used to store the survivor and report one
    // observation as though that was what had been asked for.
    const out = save({
      ...LEGAL,
      observations: [
        { kind: "quality.capture", data: [{ name: "note", value: "Thin." }] },
        "the second one, as a bare string",
      ],
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("/observations/1");
    expect(out.text).not.toContain("1 observation(s) ride");
    expect(store.list()).toHaveLength(0);
  });

  it("refuses a payload whose field name is not usable, rather than emptying it", () => {
    // The worse of the two, and the reason it is worse is on the store: an
    // observation whose payload was dropped is indistinguishable from one a
    // producer wrote empty, and a reader carries it forward unchanged for as
    // long as the document lives.
    for (const name of [7, "   ", null]) {
      const out = save({
        ...LEGAL,
        observations: [
          { kind: "quality.capture", data: [{ name, value: "a value" }] },
        ],
      });
      expect(out.isError, JSON.stringify(name)).toBe(true);
      expect(out.text, JSON.stringify(name)).toContain(
        "/observations/0/data/0/name is required and must be a non-empty string",
      );
    }
    expect(store.list()).toHaveLength(0);
  });

  it("refuses a payload entry, or a whole payload, of the wrong shape", () => {
    const field = save({
      ...LEGAL,
      observations: [{ kind: "quality.capture", data: ["not an entry"] }],
    });
    expect(field.isError).toBe(true);
    expect(field.text).toContain("/observations/0/data/0 must be an object");

    const payload = save({
      ...LEGAL,
      observations: [{ kind: "quality.capture", data: "not an array" }],
    });
    expect(payload.isError).toBe(true);
    expect(payload.text).toContain(
      "/observations/0/data must be an array of named text entries",
    );

    const array = save({ ...LEGAL, observations: "one note" });
    expect(array.isError).toBe(true);
    expect(array.text).toContain(
      "/observations must be an array of observations",
    );
    expect(store.list()).toHaveLength(0);
  });

  it("refuses two payload fields under one name rather than keeping one", () => {
    // The payload is a list coming in and an object in the document, so two
    // entries under one name cannot both survive. The second used to overwrite
    // the first and the receipt reported one observation as though that was what
    // had been asked for. Trimming means two spellings collide without looking
    // alike, so both forms are checked.
    for (const second of ["note", " note "]) {
      const out = save({
        ...LEGAL,
        observations: [
          {
            kind: "quality.capture",
            data: [
              { name: "note", value: "the first value" },
              { name: second, value: "the second value" },
            ],
          },
        ],
      });
      expect(out.isError, second).toBe(true);
      expect(out.text, second).toContain(
        "/observations/0/data/1/name must not repeat a name already stated in this payload",
      );
    }
    expect(store.list()).toHaveLength(0);
  });

  it("refuses a named payload field with no value, which JSON would drop", () => {
    const out = save({
      ...LEGAL,
      observations: [{ kind: "quality.capture", data: [{ name: "note" }] }],
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/observations/0/data/0/value is required and must be a string",
    );
    expect(store.list()).toHaveLength(0);
  });

  it("names every discarded value at once, not just the first", () => {
    const out = save({
      ...LEGAL,
      sectionStatus: "available",
      observations: ["a bare string"],
    });
    expect(out.text).toContain("/sectionStatus must be an object");
    expect(out.text).toContain("/observations/0");
  });

  it("still leaves a CARRIED member's type to the validator, at its own path", () => {
    // The boundary of the new rule. `quality` travels into the document
    // untouched, so it must keep being refused by the validator rather than
    // picking up a second, vaguer complaint here.
    const out = save({ ...LEGAL, quality: "all good" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("/quality must be an object");
    expect(out.text).not.toContain("reads itself");
  });

  it("refuses a stated load code that is not a code, and reads no document", () => {
    seedTwo();
    for (const code of [1, "   ", null, ["#001"]]) {
      const result = callTool("soil_load", { code }, store, NOW);
      const text = result.content[0]?.text ?? "";
      expect(result.isError, JSON.stringify(code)).toBe(true);
      expect(text, JSON.stringify(code)).toContain(
        "/code must be a non-empty string",
      );
      expect(text, JSON.stringify(code)).not.toContain("The newer handover");
    }
  });

  it("keeps an ABSENT code meaning the most recent handover", () => {
    // The standing behaviour the refusal must not take with it: absent and
    // present-with-an-empty-value are two different things.
    seedTwo();
    for (const args of [{}, { code: "last" }, { code: "#002" }]) {
      const result = callTool("soil_load", args, store, NOW);
      expect(result.isError, JSON.stringify(args)).toBeUndefined();
      expect(result.content[0]?.text, JSON.stringify(args)).toContain(
        "The newer handover",
      );
    }
    expect(
      callTool("soil_load", { code: "#001" }, store, NOW).content[0]?.text,
    ).toContain("The older handover");
  });

  it("reports a working-style answer it could not record, and saves the rest", () => {
    const out = save({
      ...LEGAL,
      workingStyle: {
        blocker:
          "The build broke on a missing export. The thread added it and re-ran.",
        conflict: 42,
        integration: "   ",
        assumption: "x".repeat(2001),
      },
    });
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain("Saved locally as #001");
    expect(out.text).toContain("/workingStyle/conflict must be a string");
    expect(out.text).toContain("/workingStyle/integration must not be empty");
    expect(out.text).toContain(
      "/workingStyle/assumption is longer than the 2000 this server records for one answer",
    );
    // The answer that was usable is still recorded, and the one that was too
    // long is dropped rather than cut: a shortened recorded instance would be a
    // different statement than the one the model made.
    const instances = store.read("#001").observations?.[0]?.data[
      "instances"
    ] as { response: string }[];
    expect(instances).toHaveLength(1);
    expect(instances[0]?.response).not.toContain("xxxx");
  });

  it("reports a workingStyle that is not an object at all", () => {
    const out = save({ ...LEGAL, workingStyle: "not an object" });
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain("/workingStyle must be an object");
    expect(store.read("#001").observations).toBeUndefined();
  });

  it("says nothing about working style when every answer was recorded", () => {
    const out = save({
      ...LEGAL,
      workingStyle: {
        blocker:
          "The build broke on a missing export. The thread added it and re-ran.",
      },
    });
    expect(out.isError).toBeUndefined();
    expect(out.text).not.toContain("Not recorded from workingStyle");
  });

  it("says nothing about working style when the caller answered none", () => {
    // An absent answer is not a drop. Four "you left this out" lines on every
    // save without answers would bury the one line that matters.
    const out = save(LEGAL);
    expect(out.text).not.toContain("Not recorded from workingStyle");
  });

  it("reaches the store the same way whether a section is stated null or left out", () => {
    // The one place the document schema and this tool schema disagree, and the
    // reason the disagreement costs a producer nothing. The format admits a
    // string or null for a section summary; this schema admits a string, because
    // the only ways to widen it are a type list and an `anyOf`, and both are the
    // union shape a client may flatten into "no parameters". A producer says
    // "nothing here" by leaving the key out, and a producer that states null
    // anyway is not corrected and not refused: the two spellings arrive as one
    // document. If they ever stop arriving as one, the narrowing has become a
    // loss.
    const stated = save({
      ...LEGAL,
      sections: { ...LEGAL.sections, decisions: null },
    });
    expect(stated.isError).toBeUndefined();
    const withNull = store.read("#001").sections.decisions;

    const omitted = save(LEGAL);
    expect(omitted.isError).toBeUndefined();
    const withoutKey = store.read("#002").sections.decisions;

    expect(withNull).toEqual({ status: "missing", summary: null });
    expect(withNull).toEqual(withoutKey);
  });
});

describe("what the caller stated is what the store holds", () => {
  it("stores every declared document member the caller stated", () => {
    // The check a six-key allowlist cannot pass. Every root argument that is a
    // document member is stated at once, and every one of them has to be on disk
    // afterwards: a member the schema declares, the caller states, and the store
    // does not hold is content lost in silence, which is the whole defect in one
    // sentence.
    const result = callTool(
      "soil_save",
      {
        soilHandover: "1.0",
        projectId: "carry-through",
        title: "Everything stated at once",
        sections: {
          executiveSummary: "A project.",
          decisions: "One decision.",
          workflow: "This project has no process to run yet.",
        },
        sectionStatus: { workflow: "not_applicable" },
        sectionProvenance: {
          decisions: ["repo_verified", "user_locked_memory"],
        },
        quality: {
          missingInputs: ["The deploy history was not visible."],
          contradictions: ["Two docs disagree about the queue."],
        },
        safety: {
          unsafeOmissions: [
            "The provider key exists and is set in the deployment platform.",
          ],
        },
        source: {
          client: "a test",
          model: "none",
          provider: "none",
          recipeVersion: "1.4.2",
        },
        observations: [
          { kind: "quality.capture", data: [{ name: "note", value: "Thin." }] },
        ],
        workingStyle: {
          blocker:
            "The build broke on a missing export. The thread added it and re-ran.",
        },
      },
      store,
      NOW,
    );
    expect(result.isError).toBeUndefined();

    const stored = store.read("#001");
    expect(validateHandover(stored).valid).toBe(true);
    expect(stored.soilHandover).toBe("1.0");
    expect(stored.projectId).toBe("carry-through");
    expect(stored.title).toBe("Everything stated at once");
    expect(stored.sections.decisions.summary).toBe("One decision.");
    expect(stored.sections.workflow.status).toBe("not_applicable");
    expect(stored.sections.decisions.provenance).toEqual([
      "repo_verified",
      "user_locked_memory",
    ]);
    expect(stored.quality?.missingInputs).toHaveLength(1);
    expect(stored.quality?.contradictions).toHaveLength(1);
    expect(stored.safety?.unsafeOmissions).toHaveLength(1);
    expect(stored.source).toEqual({
      client: "a test",
      model: "none",
      provider: "none",
      recipeVersion: "1.4.2",
    });
    expect(stored.observations?.map((entry) => entry.kind)).toEqual([
      "quality.capture",
      "working.style",
    ]);
  });

  it("declares source.recipeVersion, which the recipe orders a model to emit", () => {
    const save = TOOLS.find((tool) => tool.name === "soil_save");
    const source = (
      save?.inputSchema["properties"] as Record<
        string,
        { properties: Record<string, Record<string, unknown>> }
      >
    )["source"];
    expect(Object.keys(source?.properties ?? {}).sort()).toEqual([
      "client",
      "model",
      "provider",
      "recipeVersion",
    ]);
    // The pattern is the validator's, so a version this schema accepts is a
    // version the stored document keeps.
    expect(source?.properties["recipeVersion"]?.["pattern"]).toBe(
      "^[0-9]+\\.[0-9]+\\.[0-9]+$",
    );
  });

  it("still saves, loads and lists on the shapes that worked before", () => {
    // The regression net for callers who were never sending junk: the smallest
    // legal save, the load that reads it back, and the list that shows it.
    const saved = callTool(
      "soil_save",
      {
        projectId: "unchanged",
        title: "Still works",
        sections: { executiveSummary: "A project." },
      },
      store,
      NOW,
    );
    expect(saved.isError).toBeUndefined();
    expect(saved.content[0]?.text).toContain("Saved locally as #001");
    expect(saved.content[0]?.text).toContain("1 of 17 sections carry content");

    // No `source` member at all when the caller mentioned none: a member nobody
    // stated must not appear as an empty object.
    expect(store.read("#001").source).toBeUndefined();

    expect(callTool("soil_load", {}, store, NOW).content[0]?.text).toContain(
      "unchanged",
    );
    expect(
      callTool("soil_load", { code: "#001" }, store, NOW).content[0]?.text,
    ).toContain("unchanged");
    expect(callTool("soil_list", {}, store, NOW).content[0]?.text).toContain(
      "#001",
    );
  });
});

// ---------------------------------------------------------------------
// The process surface: what a client actually receives.
//
// Everything above drives `handleMessage` in process, which cannot see the
// defect this guards. The server used to call `process.exit(0)` when stdin
// ended. On a pipe, stdout is asynchronous, so a reply larger than the
// operating system's pipe buffer was still queued at that moment and went
// away with the process: the client got the answer cut mid-line and could
// not parse it. Redirecting stdout to a file hid it, because writes to a
// regular file are synchronous on POSIX and there is no queue to lose.
//
// The test forces the queue rather than hoping for it. It asks for the
// largest reply the server writes, several times over, so the total is past
// any pipe buffer, and it leaves stdout unread for a moment so those writes
// have to queue behind a full pipe. Then it drains and counts.
// ---------------------------------------------------------------------

describe("the server over a real pipe", () => {
  const BIN = join(
    dirname(fileURLToPath(import.meta.url)),
    "../bin/soil-mcp.js",
  );
  // Eight tools listings is a few hundred kilobytes, comfortably past the
  // 64 KiB pipe buffer that both Linux and macOS top out at.
  const LISTINGS = 8;

  function burst(): string {
    const lines = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "pipe-test", version: "0" },
        },
      }),
    ];
    for (let index = 0; index < LISTINGS; index++) {
      lines.push(
        JSON.stringify({
          jsonrpc: "2.0",
          id: index + 2,
          method: "tools/list",
          params: {},
        }),
      );
    }
    return `${lines.join("\n")}\n`;
  }

  /** Replies that parse AND carry all three tool names. */
  function wholeListings(output: string): number {
    let whole = 0;
    for (const line of output.split("\n")) {
      if (line.trim().length === 0) continue;
      let message: { result?: { tools?: { name: string }[] } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue; // a truncated line does not parse, which is the symptom
      }
      const names = (message.result?.tools ?? []).map((tool) => tool.name);
      if (
        names.length === 3 &&
        ["soil_list", "soil_load", "soil_save"].every((name) =>
          names.includes(name),
        )
      ) {
        whole++;
      }
    }
    return whole;
  }

  it("delivers every reply when stdin ends before the client has read", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "soil-mcp-pipe-"));
    try {
      const child = spawn(process.execPath, [BIN], {
        env: { ...process.env, SOIL_HOME: scratch },
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Every listener goes on before anything is written. The old code was
      // gone about forty milliseconds in, so a listener attached later would
      // be waiting for an event that had already fired, and the test would
      // hang instead of reporting.
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
      });
      const drained = new Promise((resolve) => child.stdout.on("end", resolve));
      const closed = new Promise<number | null>((resolve) => {
        child.on("close", resolve);
      });

      // Hold the read end open but take nothing off it. The pipe fills, the
      // server's remaining writes queue behind it, and stdin ends underneath
      // all of that: the exact moment the old code tore the process down.
      child.stdout.pause();

      child.stdin.write(burst());
      child.stdin.end();

      await new Promise((resolve) => setTimeout(resolve, 300));
      child.stdout.resume();

      const code = await closed;
      await drained;

      expect(code).toBe(0);
      // Everything the server answered has to be here. The old code ended
      // this stream while most of the answer was still queued.
      expect(wholeListings(output)).toBe(LISTINGS);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
