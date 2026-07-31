import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HandoverStore,
  PROVENANCE_LABELS,
  SECTION_KEYS,
  SECTION_STATUSES,
  validateHandover,
  type Handover,
} from "@nativesoil/handover-sdk";
// The local stdio server, imported here on purpose: two of this file's checks
// are cross-surface, and the only honest way to show that the two surfaces
// read one stored document the same is to read it with both.
import { callTool } from "@nativesoil/handover-mcp";

import { SERVER_TOOLS } from "./mcp.js";
import {
  makeHome,
  personalHandoversDir,
  recordingLogger,
  removeHome,
  requestJson,
  seedHome,
  startTestServer,
  userIdOf,
  type SeededTokens,
  type TestServer,
} from "./test-support.js";

/** The same text with this render's boundary marker taken out. */
function withoutMark(text: string): string {
  return text.replace(/soil:[0-9a-f]{32}/g, "soil:<mark>");
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe("object");
  return value as Record<string, unknown>;
}

function toolText(response: unknown): {
  text: string;
  isError: boolean;
} {
  const result = asRecord(asRecord(response)["result"]);
  const content = result["content"] as Record<string, unknown>[];
  return {
    text: String(content[0]?.["text"]),
    isError: result["isError"] === true,
  };
}

async function rpc(
  ts: TestServer,
  token: string,
  method: string,
  params?: unknown,
  id: number | undefined = 1,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown; text: string }> {
  return requestJson(
    ts.base,
    "POST",
    "/v1/mcp",
    token,
    {
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method,
      ...(params === undefined ? {} : { params }),
    },
    headers,
  );
}

/**
 * The per-request metadata a `2026-07-28` client carries in every request body.
 * One definition for the whole file, because three copies of it drifted apart
 * once already and the era every test below reads is decided from this object.
 */
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/**
 * One modern request, sent the way a conforming `2026-07-28` client sends one:
 * the metadata in the body and all three mirrored headers alongside it.
 *
 * Only the version header is required by this endpoint, but the helper sends
 * all three because a conforming client does, and the baseline every test
 * builds on should be a request with nothing unusual about it. A test that
 * wants an absence or a contradiction states the one it wants.
 *
 * `headers` is merged last, so a test can drop a header by passing `undefined`
 * for it or contradict one by passing another value.
 */
async function modernRpc(
  ts: TestServer,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  id: number | undefined = 1,
  headers: Record<string, string | undefined> = {},
): Promise<{ status: number; json: unknown; text: string }> {
  const name = params["name"];
  const mirrored: Record<string, string | undefined> = {
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(method === "tools/call" && typeof name === "string"
      ? { "mcp-name": name }
      : {}),
    ...headers,
  };
  const sent: Record<string, string> = {};
  for (const [key, value] of Object.entries(mirrored)) {
    if (value !== undefined) sent[key] = value;
  }
  return rpc(ts, token, method, { ...params, _meta: MODERN_META }, id, sent);
}

const SAVE_ARGS = {
  projectId: "billing-rework",
  title: "Billing rework, MCP save",
  sections: {
    projectIdentity: "Ship the billing rework without breaking invoicing.",
    decisions: "Postgres stays; the queue moves to the outbox pattern.",
  },
};

describe("the MCP endpoint", () => {
  let home: string;
  let tokens: SeededTokens;
  let ts: TestServer;

  beforeEach(async () => {
    home = makeHome();
    tokens = seedHome(home);
    ts = await startTestServer(home);
  });

  afterEach(async () => {
    await ts.close();
    removeHome(home);
  });

  it("requires a bearer token like every other route", async () => {
    const { status } = await requestJson(
      ts.base,
      "POST",
      "/v1/mcp",
      undefined,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      },
    );
    expect(status).toBe(401);
  });

  it("initializes, acknowledges notifications, and lists the three tools", async () => {
    const init = await rpc(ts, tokens.alice, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.status).toBe(200);
    const initResult = asRecord(asRecord(init.json)["result"]);
    expect(initResult["protocolVersion"]).toBe("2025-06-18");
    expect(asRecord(initResult["serverInfo"])["name"]).toBe(
      "soil-handover-server",
    );

    const note = await rpc(
      ts,
      tokens.alice,
      "notifications/initialized",
      undefined,
      undefined,
    );
    expect(note.status).toBe(202);
    expect(note.json).toBeUndefined();

    const list = await rpc(ts, tokens.alice, "tools/list");
    const tools = asRecord(asRecord(list.json)["result"])["tools"] as Record<
      string,
      unknown
    >[];
    expect(tools.map((tool) => tool["name"])).toEqual([
      "soil_save",
      "soil_load",
      "soil_list",
    ]);
    for (const tool of tools) {
      const schema = asRecord(tool["inputSchema"]);
      expect(schema["additionalProperties"]).toBe(false);
      expect(asRecord(schema["properties"])["project"]).toBeDefined();
    }
  });

  it("answers ping and rejects unknown methods", async () => {
    const ping = await rpc(ts, tokens.alice, "ping");
    // Still an empty result, now carrying the two fields every result carries:
    // the result's own type, and who answered. Pinned exactly rather than
    // loosely, so a change to either has to be deliberate.
    expect(asRecord(ping.json)["result"]).toEqual({
      resultType: "complete",
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "soil-handover-server",
          title: "Soil Handover (self-hosted server)",
          version: "0.2.0",
        },
      },
    });
    const unknown = await rpc(ts, tokens.alice, "no/such/method");
    expect(asRecord(asRecord(unknown.json)["error"])["code"]).toBe(-32601);
  });

  it("saves into a project, and another member loads it back", async () => {
    const saved = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: { ...SAVE_ARGS, project: "team-x" },
    });
    const savedOut = toolText(saved.json);
    expect(savedOut.isError).toBe(false);
    expect(savedOut.text).toContain("project team-x");
    expect(savedOut.text).toContain("#001");

    const listed = await rpc(ts, tokens.bob, "tools/call", {
      name: "soil_list",
      arguments: {},
    });
    expect(toolText(listed.json).text).toContain("project team-x");

    const loaded = await rpc(ts, tokens.bob, "tools/call", {
      name: "soil_load",
      arguments: { code: "#001", project: "team-x" },
    });
    const loadedOut = toolText(loaded.json);
    expect(loadedOut.isError).toBe(false);
    expect(loadedOut.text).toContain("outbox pattern");
  });

  it("reads @team-x and team-x as the same reference", async () => {
    // The product's one command grammar: @ says where, # says which. The
    // leading @ is the grammar's marker, never part of the name, so a client
    // taught `@team-x` by the local tools says the same thing here.
    const saved = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: { ...SAVE_ARGS, project: "@team-x" },
    });
    const savedOut = toolText(saved.json);
    expect(savedOut.isError).toBe(false);
    expect(savedOut.text).toContain("project team-x");

    const loaded = await rpc(ts, tokens.bob, "tools/call", {
      name: "soil_load",
      arguments: { code: "#001", project: "@team-x" },
    });
    expect(toolText(loaded.json).isError).toBe(false);

    // A bare @ names nothing and is refused, never read as personal.
    const refused = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: { ...SAVE_ARGS, project: "@" },
    });
    const refusedOut = toolText(refused.json);
    expect(refusedOut.isError).toBe(true);
    expect(refusedOut.text).toContain("/project must be");
  });

  it("reports the checked-at-save line in the local receipt's own words", async () => {
    // One capability level: a member saving through this endpoint is owed the
    // same receipt as the same person saving locally. The line is not held to
    // prose but to the other surface: the same save arguments go through the
    // local stdio server, and the two receipts' check lines must be one
    // string. The grade never turns a save into a refusal.
    const saved = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: SAVE_ARGS,
    });
    const savedOut = toolText(saved.json);
    expect(savedOut.isError).toBe(false);
    const line = /^Checked at save: .*$/m.exec(savedOut.text)?.[0];
    expect(line).toBeDefined();
    expect(line).toMatch(
      /^Checked at save: (strong|adequate|thin|failing) · \d+ problems? · \d+ cautions? · \d+ advice\. The deterministic document check informs and never blocks a save; only a real load proves restore\.$/,
    );

    const local = callTool(
      "soil_save",
      SAVE_ARGS,
      new HandoverStore(join(home, "local-door")),
    );
    const localLine = /^Checked at save: .*$/m.exec(
      local.content[0]?.text ?? "",
    )?.[0];
    expect(localLine).toBe(line);

    // A thin capture is still stored and still answered as a result, with the
    // poor grade on the receipt rather than in a refusal.
    const thin = await rpc(
      ts,
      tokens.alice,
      "tools/call",
      {
        name: "soil_save",
        arguments: {
          projectId: "thin",
          title: "A thin capture",
          sections: { executiveSummary: "Some work happened." },
        },
      },
      2,
    );
    expect(thin.status).toBe(200);
    const thinOut = toolText(thin.json);
    expect(thinOut.isError).toBe(false);
    expect(thinOut.text).toMatch(/Checked at save: (thin|failing)/);
    expect(thinOut.text).toContain("#002");
  });

  it("never prints a bare section ratio", async () => {
    // Both surfaces of this endpoint state what the number counts. A ratio on
    // its own reads as completeness, which is the claim the count cannot make.
    const saved = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: SAVE_ARGS,
    });
    expect(toolText(saved.json).text).toContain("sections carry content");

    const listed = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_list",
      arguments: {},
    });
    const text = toolText(listed.json).text;
    expect(text).toContain("/17 sections carrying content");
    expect(text).not.toMatch(/\/17 sections,/);
  });

  it("saves personally without a project argument", async () => {
    const saved = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: SAVE_ARGS,
    });
    const out = toolText(saved.json);
    expect(out.isError).toBe(false);
    expect(out.text).toContain("personal");

    const loaded = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_load",
      arguments: {},
    });
    expect(toolText(loaded.json).text).toContain("outbox pattern");
  });

  it("keeps a non-member out with the same words as a missing project", async () => {
    await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: { ...SAVE_ARGS, project: "team-x" },
    });
    const denied = await rpc(ts, tokens.mallory, "tools/call", {
      name: "soil_load",
      arguments: { code: "#001", project: "team-x" },
    });
    const deniedOut = toolText(denied.json);
    expect(deniedOut.isError).toBe(true);
    expect(deniedOut.text).toContain("not found");

    const ghost = await rpc(ts, tokens.mallory, "tools/call", {
      name: "soil_load",
      arguments: { code: "#001", project: "no-such-project" },
    });
    const ghostOut = toolText(ghost.json);
    expect(ghostOut.isError).toBe(true);
    // Identical wording apart from the id: existence never leaks.
    expect(deniedOut.text.replace("team-x", "X")).toBe(
      ghostOut.text.replace("no-such-project", "X"),
    );
  });

  it("refuses a secret-bearing save and stores nothing", async () => {
    const saved = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: {
        ...SAVE_ARGS,
        sections: {
          projectIdentity: "The key sk-abc123def unlocks the billing API.",
        },
      },
    });
    const out = toolText(saved.json);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("NOTHING WAS STORED");
    expect(out.text).not.toContain("sk-abc123def");

    const aliceDir = personalHandoversDir(home, "alice");
    expect(!existsSync(aliceDir) || readdirSync(aliceDir).length === 0).toBe(
      true,
    );
  });

  it("answers GET on the endpoint with 405, not a stream", async () => {
    const { status } = await requestJson(
      ts.base,
      "GET",
      "/v1/mcp",
      tokens.alice,
    );
    expect(status).toBe(405);
  });

  // ---------------------------------------------------------------------
  // The producer surface: what a model can actually say through the
  // DECLARED schema, not through an out-of-schema call that happens to work.
  // ---------------------------------------------------------------------

  function saveSchema(): Record<string, unknown> {
    const tool = SERVER_TOOLS.find((entry) => entry.name === "soil_save");
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
      const properties = Object.keys(
        property(group)["properties"] as Record<string, unknown>,
      );
      expect(properties.sort()).toEqual([...SECTION_KEYS].sort());
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

    // The safety record, the observations and the format version are the rest
    // of what the recipe asks a model to write.
    expect(property("safety")["properties"]).toHaveProperty("unsafeOmissions");
    expect(property("observations")["type"]).toBe("array");
    expect(property("soilHandover")["type"]).toBe("string");
  });

  it("declares no union anywhere, and closes every object it declares", () => {
    // A union is the shape some clients flatten to "no parameters", which is
    // how this class of defect reaches production unseen. The walk is over the
    // schema as advertised, items included.
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
    for (const tool of SERVER_TOOLS) walk(tool.inputSchema, tool.name);
  });

  it("round trips a blocked section and provenance labels through the declared schema", async () => {
    // The whole producer path in one check: a model-shaped call, the stored
    // canonical document, its validity, the rendered restore prompt, and
    // whether a reader gets back what was sent.
    const saved = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: {
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
    });
    const out = toolText(saved.json);
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Withheld for safety, recorded as blocked");
    expect(out.text).toContain("constraints");

    // What landed on disk, read straight from the store rather than from the
    // receipt that describes it.
    const store = new HandoverStore(
      join(home, "users", userIdOf(home, "alice")),
    );
    const stored: Handover = store.read("#001");
    expect(validateHandover(stored).valid).toBe(true);
    expect(stored.soilHandover).toBe("1.0");
    expect(stored.sections.constraints.status).toBe("blocked");
    expect(stored.sections.constraints.provenance).toEqual(["blocked"]);
    expect(stored.sections.decisions.status).toBe("available");
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
      "@nativesoil/handover-server 0.2.0",
    );

    // And what a reader gets: the withheld fact travels, the withheld value
    // never existed, and the blocked section is not silently absent.
    const loaded = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_load",
      arguments: { code: "#001" },
    });
    const prompt = toolText(loaded.json).text;
    expect(prompt).toContain("outbox pattern");
    expect(prompt).toContain("withheld");
  });

  it("never stores a provenance label outside the fixed set", async () => {
    // The label set is fixed so that a label means the same thing in every
    // implementation. What this pins is the outcome, not the mechanism: the
    // call either refuses or stores a document without the invented label,
    // and an invented label reaching disk is the one thing that must not
    // happen. Which of the two happens is normalization's call, not this
    // surface's.
    const saved = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: {
        ...SAVE_ARGS,
        sectionProvenance: { decisions: ["repo_verified", "vibes_verified"] },
      },
    });
    if (toolText(saved.json).isError) return;
    const store = new HandoverStore(
      join(home, "users", userIdOf(home, "alice")),
    );
    const labels = store.read("#001").sections.decisions.provenance ?? [];
    expect(labels).not.toContain("vibes_verified");
    for (const label of labels) {
      expect(PROVENANCE_LABELS).toContain(label);
    }
  });

  it("refuses a status outside the three rather than rewriting it", async () => {
    const saved = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: { ...SAVE_ARGS, sectionStatus: { decisions: "Available" } },
    });
    const out = toolText(saved.json);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("/sections/decisions/status");
  });

  // ---------------------------------------------------------------------
  // "The same three tools, each with one addition." One addition, and no
  // omission: the working-style half used to be missing from this endpoint.
  // ---------------------------------------------------------------------

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

  it("takes working-style answers on save and renders them as evidence at load", async () => {
    const saved = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: { ...SAVE_ARGS, workingStyle: ANSWERS },
    });
    expect(toolText(saved.json).isError).toBe(false);
    expect(toolText(saved.json).text).toContain("recorded instances");

    const store = new HandoverStore(
      join(home, "users", userIdOf(home, "alice")),
    );
    const stored = store.read("#001");
    expect(stored.observations).toHaveLength(1);
    expect(stored.observations?.[0]?.kind).toBe("working.style");
    expect(stored.observations?.[0]?.producedBy).toBe(
      "@nativesoil/handover-server 0.2.0",
    );
    expect(validateHandover(stored).valid).toBe(true);

    const loaded = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_load",
      arguments: { code: "#001" },
    });
    const text = toolText(loaded.json).text;
    expect(text).toMatch(
      /^=== soil:[0-9a-f]{32} WORKING STYLE, RECORDED INSTANCES ===$/m,
    );
    expect(text).toContain("Evidence from @nativesoil/handover-server 0.2.0");
    expect(text).toContain(ANSWERS.assumption);
    expect(text).toContain("the section wins");
    // Sections first: the evidence follows the prompt, never replaces it.
    expect(text.indexOf("the section wins")).toBeGreaterThan(
      text.indexOf("outbox pattern"),
    );
    // Evidence, never a grade.
    expect(text).not.toMatch(/grade|score/i);
    expect(text).not.toMatch(/\d+\s*(?:of|\/)?\s*\d*\s*instances?/i);
  });

  it("shows one stored document's evidence identically through both surfaces", async () => {
    // The method that found the defect, run as a test: store a correctly
    // formed working-style observation through this server, then load it back
    // through this server and through the local stdio server. Before the
    // repair the local surface showed the evidence block and this one showed
    // nothing.
    await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: { ...SAVE_ARGS, workingStyle: ANSWERS },
    });
    const store = new HandoverStore(
      join(home, "users", userIdOf(home, "alice")),
    );

    const throughTheServer = toolText(
      (
        await rpc(ts, tokens.alice, "tools/call", {
          name: "soil_load",
          arguments: { code: "#001" },
        })
      ).json,
    ).text;
    const throughTheLocalServer =
      callTool("soil_load", { code: "#001" }, store).content[0]?.text ?? "";

    const block = (text: string): string =>
      text.slice(text.search(/^=== soil:[0-9a-f]{32} WORKING STYLE/m));
    expect(block(throughTheServer)).toContain("Evidence from");
    // Each render draws its own marker, so the two blocks agree once the
    // marker is set aside: what is compared is the evidence, not the boundary.
    expect(withoutMark(block(throughTheServer))).toBe(
      withoutMark(block(throughTheLocalServer)),
    );
  });

  it("leaves a save without answers exactly as it was, and its load silent", async () => {
    await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: SAVE_ARGS,
    });
    const store = new HandoverStore(
      join(home, "users", userIdOf(home, "alice")),
    );
    expect(store.read("#001").observations).toBeUndefined();
    const loaded = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_load",
      arguments: { code: "#001" },
    });
    expect(toolText(loaded.json).text).not.toContain("WORKING STYLE");
  });

  it("refuses the whole save when a working-style answer carries a secret", async () => {
    const saved = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: {
        ...SAVE_ARGS,
        workingStyle: { blocker: "We fixed it by setting sk-abc123def456." },
      },
    });
    const out = toolText(saved.json);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("NOTHING WAS STORED");
    expect(out.text).not.toContain("sk-abc123def456");
    const aliceDir = personalHandoversDir(home, "alice");
    expect(!existsSync(aliceDir) || readdirSync(aliceDir).length === 0).toBe(
      true,
    );
  });

  it("refuses the whole save when a declared observation carries a secret", async () => {
    const saved = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: {
        ...SAVE_ARGS,
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
    });
    const out = toolText(saved.json);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("NOTHING WAS STORED");
    expect(out.text).not.toContain("7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e");
  });

  // -------------------------------------------------------------------
  // The declared schema, enforced, over the wire.
  //
  // Same rule and same words as the local server, checked through a real HTTP
  // request because that is what a client sends. `additionalProperties: false`
  // in `tools/list` is a promise about what this endpoint accepts, and a member
  // outside it used to be accepted, dropped, and answered with a load code.
  // -------------------------------------------------------------------

  async function saveArgs(args: Record<string, unknown>) {
    const response = await rpc(ts, tokens.alice, "tools/call", {
      name: "soil_save",
      arguments: args,
    });
    return toolText(response.json);
  }

  function aliceIsEmpty(): boolean {
    const dir = personalHandoversDir(home, "alice");
    return !existsSync(dir) || readdirSync(dir).length === 0;
  }

  it("refuses an undeclared root argument over HTTP, and stores nothing", async () => {
    const out = await saveArgs({
      ...SAVE_ARGS,
      totallyUndeclared: "content the caller stated",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/totallyUndeclared is not a field of this object",
    );
    expect(out.text).not.toContain("Saved on this server");
    expect(aliceIsEmpty()).toBe(true);
  });

  it("refuses an undeclared member nested inside a declared object", async () => {
    const out = await saveArgs({
      ...SAVE_ARGS,
      sections: { ...SAVE_ARGS.sections, notARealSection: "prose" },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/sections/notARealSection is not a field of this object",
    );
    expect(aliceIsEmpty()).toBe(true);
  });

  it("refuses an undeclared member inside an array entry, by index", async () => {
    const out = await saveArgs({
      ...SAVE_ARGS,
      observations: [
        {
          kind: "quality.capture",
          data: [{ name: "note", value: "v" }],
          producedAt: "2026-07-22T10:00:00Z",
        },
      ],
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/observations/0/producedAt is not a field of this object",
    );
    expect(aliceIsEmpty()).toBe(true);
  });

  it("refuses guessed working-style keys instead of storing zero answers", async () => {
    const out = await saveArgs({
      ...SAVE_ARGS,
      workingStyle: { correction: "The owner asked for shorter replies." },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/workingStyle/correction is not a field of this object",
    );
    expect(aliceIsEmpty()).toBe(true);
  });

  it("refuses an undeclared argument on soil_load and soil_list too", async () => {
    for (const name of ["soil_load", "soil_list"]) {
      const response = await rpc(ts, tokens.alice, "tools/call", {
        name,
        arguments: { projet: "a typo" },
      });
      const out = toolText(response.json);
      expect(out.isError, name).toBe(true);
      expect(out.text, name).toContain("/projet is not a field of this object");
    }
  });

  it("keeps the project argument working, which is not a document member", async () => {
    // `project` addresses a store rather than saying anything about the
    // handover, so it must be accepted and must not reach the document.
    const out = await saveArgs({ ...SAVE_ARGS, project: "team-x" });
    expect(out.isError).toBe(false);
    const store = new HandoverStore(join(home, "projects", "team-x"));
    const stored: Handover = store.read("#001");
    expect(validateHandover(stored).valid).toBe(true);
    expect(Object.keys(stored)).not.toContain("project");
  });

  it("stores every declared document member the caller stated", async () => {
    // The check a six-key allowlist cannot pass. A member the schema declares,
    // the caller states, and the store does not hold is content lost in silence.
    const out = await saveArgs({
      soilHandover: "1.0",
      projectId: "carry-through",
      title: "Everything stated at once",
      sections: {
        executiveSummary: "A project.",
        decisions: "One decision.",
        workflow: "This project has no process to run yet.",
      },
      sectionStatus: { workflow: "not_applicable" },
      sectionProvenance: { decisions: ["repo_verified", "user_locked_memory"] },
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
    });
    expect(out.isError).toBe(false);

    const store = new HandoverStore(
      join(home, "users", userIdOf(home, "alice")),
    );
    const stored: Handover = store.read("#001");
    expect(validateHandover(stored).valid).toBe(true);
    expect(stored.soilHandover).toBe("1.0");
    expect(stored.projectId).toBe("carry-through");
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

  it("does not report a section with no subject as a gap", async () => {
    // The fourth status exists to tell the next reader to stop looking, so a
    // receipt that lists it among the sections with nothing in them says the
    // opposite of what the model stated. The card and the restore prompt both
    // get this right, and this endpoint must give the same answer as the local
    // one for the same document.
    const out = await saveArgs({
      projectId: "no-subject",
      title: "A project with no rejected paths",
      sections: {
        decisions: "One decision, with its reason.",
        rejectedPaths: "Nothing has been tried and abandoned on this project.",
        openQuestions:
          "The deployment target is open and nobody has proposed one.",
      },
      sectionStatus: {
        decisions: "available",
        rejectedPaths: "not_applicable",
        openQuestions: "blocked",
        workflow: "missing",
      },
    });
    expect(out.isError).toBe(false);

    const emptyLine = out.text
      .split("\n")
      .find((line) => line.startsWith("Sections with nothing in them"));
    expect(emptyLine).toBeDefined();
    expect(emptyLine).toContain("workflow");
    expect(emptyLine).not.toContain("rejectedPaths");
    expect(emptyLine).not.toContain("openQuestions");
    expect(emptyLine).not.toContain("decisions");

    expect(out.text).toContain(
      "Recorded as having no subject in this project: rejectedPaths.",
    );
    expect(out.text).toContain(
      "Withheld for safety, recorded as blocked: openQuestions.",
    );
  });

  it("declares source.recipeVersion, which the recipe orders a model to emit", () => {
    const source = property("source") as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(source.properties).sort()).toEqual([
      "client",
      "model",
      "provider",
      "recipeVersion",
    ]);
    expect(source.properties["recipeVersion"]?.["pattern"]).toBe(
      "^[0-9]+\\.[0-9]+\\.[0-9]+$",
    );
  });

  // -------------------------------------------------------------------
  // A member the schema declares as required.
  //
  // The mirror of the block above, and for a while only one half of the rule
  // held: an undeclared member could not be present, and a required one could
  // still be absent. Measured on the tree before this existed: a save with no
  // `sections` at all stored a document with every one of the 17 a gap and
  // answered with a load code, over HTTP, exactly as the local server did.
  //
  // The half that must not change is stating the container EMPTY, which is a
  // caller saying it had nothing rather than saying nothing.
  // -------------------------------------------------------------------

  it("refuses a save with no sections at all, and stores nothing", async () => {
    const { sections, ...withoutSections } = SAVE_ARGS;
    void sections;
    const out = await saveArgs(withoutSections);
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/sections is required and must be an object holding all 17 sections",
    );
    expect(out.text).not.toContain("Saved on this server");
    expect(out.text).toContain("state it empty if you genuinely have nothing");
    expect(aliceIsEmpty()).toBe(true);
  });

  it("refuses an observation that states no payload, by index", async () => {
    const out = await saveArgs({
      ...SAVE_ARGS,
      observations: [{ kind: "quality.capture" }],
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/observations/0/data is required and must be an array of named text entries",
    );
    expect(aliceIsEmpty()).toBe(true);
  });

  it("keeps an empty container as the statement it is", async () => {
    // The honest-thin case. It has to keep working, or the refusal above would be
    // a rule against saying you had nothing.
    const out = await saveArgs({ ...SAVE_ARGS, sections: {} });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("0 of 17 sections carry content");
    const store = new HandoverStore(
      join(home, "users", userIdOf(home, "alice")),
    );
    expect(validateHandover(store.read("#001")).valid).toBe(true);
  });

  it("keeps an empty observation payload as the statement it is", async () => {
    const out = await saveArgs({
      ...SAVE_ARGS,
      observations: [{ kind: "quality.capture", data: [] }],
    });
    expect(out.isError).toBe(false);
    const store = new HandoverStore(
      join(home, "users", userIdOf(home, "alice")),
    );
    expect(store.read("#001").observations?.[0]?.data).toEqual({});
  });

  it("leaves a required member that TRAVELS to the validator", async () => {
    // `projectId` and `title` reach the document, so the validator refuses them
    // absent at their own paths in these same words, and this door says nothing
    // about them. Same for an observation's `kind`.
    for (const key of ["projectId", "title"]) {
      const args: Record<string, unknown> = { ...SAVE_ARGS };
      delete args[key];
      const out = await saveArgs(args);
      expect(out.isError, key).toBe(true);
      expect(out.text, key).toContain(
        `/${key} is required and must be a non-empty string`,
      );
      expect(out.text, key).not.toContain("cannot be inferred from the rest");
    }
    const out = await saveArgs({
      ...SAVE_ARGS,
      observations: [{ data: [{ name: "note", value: "v" }] }],
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/observations/0/kind is required and must be a non-empty string",
    );
    expect(aliceIsEmpty()).toBe(true);
  });

  it("gives the same answer as the local server for the same absence", async () => {
    // The two surfaces are held to each other rather than to prose. One stored
    // document read two ways is the only honest way to say they agree, and one
    // refusal answered two ways is the same claim about the way in.
    const { sections, ...withoutSections } = SAVE_ARGS;
    void sections;
    const overHttp = await saveArgs(withoutSections);
    const local = callTool(
      "soil_save",
      withoutSections,
      new HandoverStore(join(home, "local-door")),
    );
    expect(local.isError).toBe(true);
    expect(local.content[0]?.text).toBe(overHttp.text);
  });

  it("asks nothing of soil_load and soil_list, which require nothing", async () => {
    await saveArgs(SAVE_ARGS);
    for (const name of ["soil_load", "soil_list"]) {
      const response = await rpc(ts, tokens.alice, "tools/call", {
        name,
        arguments: {},
      });
      const out = toolText(response.json);
      expect(out.isError, name).toBe(false);
      expect(out.text, name).not.toContain("is required");
    }
  });

  // -------------------------------------------------------------------
  // A stated value this endpoint cannot carry.
  //
  // Membership was the first half of the rule and this is the second, and on this
  // endpoint the heaviest case is `project`. Stated as anything but a name it was
  // read as absent, so a caller that named a shared project got a save into its
  // own personal store and a receipt that said personal: the destination was the
  // one thing the caller had been most explicit about, and the answer contradicted
  // it without a word. The opposite case is a standing rule and is checked
  // alongside, because refusing a malformed reference and defaulting an absent one
  // are two behaviours and both have to hold.
  // -------------------------------------------------------------------

  it("refuses a stated project that is not a project name, and stores nothing anywhere", async () => {
    for (const project of [42, "   ", "", null, ["team-x"], {}]) {
      const out = await saveArgs({ ...SAVE_ARGS, project });
      const which = JSON.stringify(project);
      expect(out.isError, which).toBe(true);
      expect(out.text, which).toContain("/project must be a non-empty string");
      expect(out.text, which).not.toContain("Saved on this server");
      expect(out.text, which).not.toContain("(personal)");
    }
    expect(aliceIsEmpty()).toBe(true);
    expect(existsSync(join(home, "projects", "team-x", "handovers"))).toBe(
      false,
    );
  });

  it("keeps an ABSENT project meaning the personal store", async () => {
    // The standing rule the refusal must not take with it: a save with no
    // project reference is personal by design and is never filed into a project.
    const out = await saveArgs(SAVE_ARGS);
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Saved on this server (personal) as #001");
    expect(aliceIsEmpty()).toBe(false);
    expect(existsSync(join(home, "projects", "team-x", "handovers"))).toBe(
      false,
    );
  });

  it("refuses a malformed project on soil_load and soil_list too", async () => {
    for (const name of ["soil_load", "soil_list"]) {
      const out = toolText(
        (
          await rpc(ts, tokens.alice, "tools/call", {
            name,
            arguments: { project: 42 },
          })
        ).json,
      );
      expect(out.isError, name).toBe(true);
      expect(out.text, name).toContain("/project must be a non-empty string");
    }
  });

  it("refuses a whole capture stated as one string, and stores nothing", async () => {
    const out = await saveArgs({
      ...SAVE_ARGS,
      sections: "Everything I know about this project, as one paragraph.",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "/sections must be an object holding all 17 sections",
    );
    expect(out.text).not.toContain("Saved on this server");
    expect(aliceIsEmpty()).toBe(true);
  });

  it("refuses an observation entry, or a payload field name, it cannot carry", async () => {
    const entry = await saveArgs({
      ...SAVE_ARGS,
      observations: ["a note as a bare string"],
    });
    expect(entry.isError).toBe(true);
    expect(entry.text).toContain(
      "/observations/0 must be an object with 'kind' and 'data'",
    );

    const field = await saveArgs({
      ...SAVE_ARGS,
      observations: [
        { kind: "quality.capture", data: [{ name: 7, value: "a value" }] },
      ],
    });
    expect(field.isError).toBe(true);
    expect(field.text).toContain(
      "/observations/0/data/0/name is required and must be a non-empty string",
    );
    expect(aliceIsEmpty()).toBe(true);
  });

  it("refuses two payload fields under one name, and a named field with no value", async () => {
    const repeated = await saveArgs({
      ...SAVE_ARGS,
      observations: [
        {
          kind: "quality.capture",
          data: [
            { name: "note", value: "the first value" },
            { name: " note ", value: "the second value" },
          ],
        },
      ],
    });
    expect(repeated.isError).toBe(true);
    expect(repeated.text).toContain(
      "/observations/0/data/1/name must not repeat a name already stated in this payload",
    );

    const valueless = await saveArgs({
      ...SAVE_ARGS,
      observations: [{ kind: "quality.capture", data: [{ name: "note" }] }],
    });
    expect(valueless.isError).toBe(true);
    expect(valueless.text).toContain(
      "/observations/0/data/0/value is required and must be a string",
    );
    expect(aliceIsEmpty()).toBe(true);
  });

  it("refuses a stated load code that is not a code, and reads no document", async () => {
    await saveArgs(SAVE_ARGS);
    for (const code of [1, "   ", null]) {
      const out = toolText(
        (
          await rpc(ts, tokens.alice, "tools/call", {
            name: "soil_load",
            arguments: { code },
          })
        ).json,
      );
      expect(out.isError, JSON.stringify(code)).toBe(true);
      expect(out.text, JSON.stringify(code)).toContain(
        "/code must be a non-empty string",
      );
      expect(out.text, JSON.stringify(code)).not.toContain("billing-rework");
    }
    // Absent still means the newest, which is the documented default.
    const absent = toolText(
      (
        await rpc(ts, tokens.alice, "tools/call", {
          name: "soil_load",
          arguments: {},
        })
      ).json,
    );
    expect(absent.isError).toBe(false);
    expect(absent.text).toContain("billing-rework");
  });

  it("reports a working-style answer it could not record, and saves the rest", async () => {
    const out = await saveArgs({
      ...SAVE_ARGS,
      workingStyle: {
        blocker:
          "The build broke on a missing export. The thread added it and re-ran.",
        conflict: 42,
        assumption: "x".repeat(2001),
      },
    });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Saved on this server (personal) as #001");
    expect(out.text).toContain("/workingStyle/conflict must be a string");
    expect(out.text).toContain(
      "/workingStyle/assumption is longer than the 2000 this server records for one answer",
    );

    const store = new HandoverStore(
      join(home, "users", userIdOf(home, "alice")),
    );
    const instances = store.read("#001").observations?.[0]?.data[
      "instances"
    ] as { response: string }[];
    expect(instances).toHaveLength(1);
    expect(instances[0]?.response).not.toContain("xxxx");
  });

  it("says nothing about working style when every stated answer was recorded", async () => {
    const out = await saveArgs({
      ...SAVE_ARGS,
      workingStyle: {
        blocker:
          "The build broke on a missing export. The thread added it and re-ran.",
      },
    });
    expect(out.isError).toBe(false);
    expect(out.text).not.toContain("Not recorded from workingStyle");
  });

  it("still leaves a CARRIED member's type to the validator, at its own path", async () => {
    // The boundary of the new rule: `quality` travels into the document
    // untouched, so it keeps being refused by the validator rather than picking
    // up a second, vaguer complaint here.
    const out = await saveArgs({ ...SAVE_ARGS, quality: "all good" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("/quality must be an object");
    expect(out.text).not.toContain("reads itself");
  });

  it("still saves, loads and lists on the shapes that worked before", async () => {
    const saved = await saveArgs(SAVE_ARGS);
    expect(saved.isError).toBe(false);
    expect(saved.text).toContain("Saved on this server (personal) as #001");

    const store = new HandoverStore(
      join(home, "users", userIdOf(home, "alice")),
    );
    // A member nobody stated must not appear as an empty object.
    expect(store.read("#001").source).toBeUndefined();

    const loaded = toolText(
      (
        await rpc(ts, tokens.alice, "tools/call", {
          name: "soil_load",
          arguments: {},
        })
      ).json,
    );
    expect(loaded.isError).toBe(false);
    expect(loaded.text).toContain("billing-rework");

    const listed = toolText(
      (
        await rpc(ts, tokens.alice, "tools/call", {
          name: "soil_list",
          arguments: {},
        })
      ).json,
    );
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain("#001");
  });
});

/**
 * One endpoint, two protocol eras. These checks exist because the rest of the
 * suite cannot see any of this: it asserts what the tools do, and the era a
 * request is served under is decided before a tool is ever reached.
 */
describe("both protocol eras on one endpoint", () => {
  let home: string;
  let tokens: SeededTokens;
  let ts: TestServer;

  beforeEach(async () => {
    home = makeHome();
    tokens = seedHome(home);
    ts = await startTestServer(home);
  });

  afterEach(async () => {
    await ts.close();
    removeHome(home);
  });

  const resultOf = (json: unknown): Record<string, unknown> =>
    asRecord(asRecord(json)["result"]);
  const errorOf = (json: unknown): Record<string, unknown> =>
    asRecord(asRecord(json)["error"]);

  describe("a legacy client still works", () => {
    it("gets a handshake, and a legacy version out of it", async () => {
      const init = await rpc(ts, tokens.alice, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "legacy", version: "0" },
      });
      expect(init.status).toBe(200);
      expect(resultOf(init.json)["protocolVersion"]).toBe("2025-03-26");
    });

    it("is never told the handshake settled on a handshake-free revision", async () => {
      // A legacy client cannot fall forward, so answering `2026-07-28` here
      // would strand it: it would believe it had negotiated a revision whose
      // rules it cannot follow.
      const init = await rpc(ts, tokens.alice, "initialize", {
        protocolVersion: "2026-07-28",
      });
      expect(resultOf(init.json)["protocolVersion"]).toBe("2025-06-18");
    });

    it("is served, not refused, when its _meta carries only a progressToken", async () => {
      // The era is keyed to the reserved protocol fields, not to `_meta`
      // itself. A legacy client that opts into progress notifications must not
      // trip the modern requirements.
      const list = await rpc(ts, tokens.alice, "tools/list", {
        _meta: { progressToken: 7 },
      });
      expect(asRecord(list.json)["error"]).toBeUndefined();
      expect(resultOf(list.json)["tools"]).toHaveLength(SERVER_TOOLS.length);
    });

    it("is served, not refused, when it sends no params at all", async () => {
      const list = await rpc(ts, tokens.alice, "tools/list");
      expect(asRecord(list.json)["error"]).toBeUndefined();
    });
  });

  describe("a modern client works without any handshake", () => {
    it("discovers the endpoint, which must implement server/discover", async () => {
      const found = await modernRpc(ts, tokens.alice, "server/discover");
      const result = resultOf(found.json);
      expect(result["supportedVersions"]).toContain("2026-07-28");
      expect(result["supportedVersions"]).toContain("2025-06-18");
      // Optional capabilities live in `extensions` now, not `experimental`.
      const capabilities = asRecord(result["capabilities"]);
      expect(capabilities["extensions"]).toEqual({});
      expect(capabilities).not.toHaveProperty("experimental");
      expect(String(result["instructions"]).length).toBeGreaterThan(0);
    });

    it("saves and loads with no initialize ever sent", async () => {
      const saved = await modernRpc(ts, tokens.alice, "tools/call", {
        name: "soil_save",
        arguments: SAVE_ARGS,
      });
      expect(toolText(saved.json).isError).toBe(false);

      const loaded = await modernRpc(ts, tokens.alice, "tools/call", {
        name: "soil_load",
        arguments: {},
      });
      expect(toolText(loaded.json).text).toContain("outbox pattern");
    });
  });

  describe("a request carrying capabilities but no version is served as legacy", () => {
    // The hybrid shape real client runtimes send today: `_meta` carrying only
    // `io.modelcontextprotocol/clientCapabilities`, no version key, and no
    // mirrored headers alongside it. The specification reserves both keys for
    // the modern revisions, but a conforming `2026-07-28` client must declare
    // its protocol version on every request, so the version key is the one
    // reliable marker of modern intent and capabilities alone is not. Reading
    // this shape as modern refused every call such a client made, so the era
    // is decided by the version key alone and this shape is served as the
    // legacy request it otherwise is, byte for byte.
    const CAPABILITIES_ONLY = {
      _meta: { "io.modelcontextprotocol/clientCapabilities": {} },
    };

    it("serves tools/list byte-identically to the bare request", async () => {
      const bare = await rpc(ts, tokens.alice, "tools/list");
      const hybrid = await rpc(ts, tokens.alice, "tools/list", {
        ...CAPABILITIES_ONLY,
      });
      expect(hybrid.status).toBe(200);
      expect(hybrid.text).toBe(bare.text);
    });

    it("serves a tool call byte-identically to the bare request", async () => {
      const bare = await rpc(ts, tokens.alice, "tools/call", {
        name: "soil_list",
        arguments: {},
      });
      const hybrid = await rpc(ts, tokens.alice, "tools/call", {
        name: "soil_list",
        arguments: {},
        ...CAPABILITIES_ONLY,
      });
      expect(hybrid.status).toBe(200);
      expect(hybrid.text).toBe(bare.text);
    });

    it("serves ping byte-identically to the bare request", async () => {
      const bare = await rpc(ts, tokens.alice, "ping");
      const hybrid = await rpc(ts, tokens.alice, "ping", {
        ...CAPABILITIES_ONLY,
      });
      expect(hybrid.status).toBe(200);
      expect(hybrid.text).toBe(bare.text);
    });

    it("still refuses server/discover without the version key, naming it", async () => {
      // `server/discover` exists only from `2026-07-28` on, so it is held to
      // the modern requirements whatever its `_meta` carries, and the missing
      // version key is the fault that gets named.
      const refused = await rpc(
        ts,
        tokens.alice,
        "server/discover",
        CAPABILITIES_ONLY,
      );
      const error = errorOf(refused.json);
      expect(error["code"]).toBe(-32602);
      expect(asRecord(error["data"])["missing"]).toEqual([
        "io.modelcontextprotocol/protocolVersion",
      ]);
    });
  });

  describe("a modern request missing what the revision requires is refused", () => {
    it("refuses a missing clientCapabilities with -32602", async () => {
      // The version key opened the modern era, so everything the revision
      // requires is required of this request, capabilities included. Only the
      // reverse shape, capabilities without the version key, is read as
      // legacy.
      const refused = await rpc(
        ts,
        tokens.alice,
        "tools/list",
        { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
        1,
        { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
      );
      const error = errorOf(refused.json);
      expect(error["code"]).toBe(-32602);
      expect(asRecord(error["data"])["missing"]).toEqual([
        "io.modelcontextprotocol/clientCapabilities",
      ]);
    });

    it("refuses a bare server/discover, which cannot be a legacy request", async () => {
      const refused = await rpc(ts, tokens.alice, "server/discover", {});
      expect(errorOf(refused.json)["code"]).toBe(-32602);
    });

    it("refuses an unsupported version with -32022 instead of downgrading", async () => {
      const refused = await rpc(
        ts,
        tokens.alice,
        "tools/list",
        {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "1900-01-01",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
        1,
        { "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/list" },
      );
      const error = errorOf(refused.json);
      expect(error["code"]).toBe(-32022);
      expect(error["data"]).toEqual({
        supported: ["2026-07-28", "2025-06-18", "2025-03-26", "2024-11-05"],
        requested: "1900-01-01",
      });
    });
  });

  describe("every result names its own type", () => {
    it("carries resultType and the server's identity, whichever era asked", async () => {
      const legacy = await rpc(ts, tokens.alice, "initialize", {
        protocolVersion: "2025-06-18",
      });
      const modern = await modernRpc(ts, tokens.alice, "server/discover");
      const plain = await rpc(ts, tokens.alice, "tools/list");
      for (const response of [legacy, modern, plain]) {
        const result = resultOf(response.json);
        expect(result["resultType"]).toBe("complete");
        expect(
          asRecord(result["_meta"])["io.modelcontextprotocol/serverInfo"],
        ).toMatchObject({ name: "soil-handover-server" });
      }
    });
  });
});

/**
 * What the HTTP binding says about a message, next to what the protocol says
 * inside it. The status is load-bearing on this transport: a client working out
 * what kind of server answered reads the status before the body, so a refusal
 * delivered as `200` reads as a request that was understood.
 */
describe("the status the MCP endpoint answers with", () => {
  let home: string;
  let tokens: SeededTokens;
  let ts: TestServer;

  const MODERN_VERSION = "2026-07-28";
  beforeEach(async () => {
    home = makeHome();
    tokens = seedHome(home);
    ts = await startTestServer(home);
  });

  afterEach(async () => {
    await ts.close();
    removeHome(home);
  });

  const errorOf = (json: unknown): Record<string, unknown> =>
    asRecord(asRecord(json)["error"]);

  describe("a protocol refusal is an HTTP failure", () => {
    it("answers 200 when a request carries capabilities but no version", async () => {
      // This used to pin a 400, on the reading that either reserved key opens
      // the modern era. The version key alone does, because it is the one a
      // conforming `2026-07-28` client must send on every request, and this
      // shape is what real client runtimes send while remaining legacy in
      // every other respect. It is served, not refused.
      const served = await rpc(ts, tokens.alice, "tools/list", {
        _meta: { "io.modelcontextprotocol/clientCapabilities": {} },
      });
      expect(served.status).toBe(200);
      expect(asRecord(served.json)["error"]).toBeUndefined();
    });

    it("answers 400 when a modern request leaves out clientCapabilities", async () => {
      const refused = await rpc(
        ts,
        tokens.alice,
        "tools/list",
        {
          _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION },
        },
        1,
        { "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/list" },
      );
      expect(refused.status).toBe(400);
      expect(errorOf(refused.json)["code"]).toBe(-32602);
    });

    it("answers 400 with the supported list when the version is unknown", async () => {
      const refused = await rpc(
        ts,
        tokens.alice,
        "tools/list",
        {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "1900-01-01",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
        1,
        { "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/list" },
      );
      expect(refused.status).toBe(400);
      const error = errorOf(refused.json);
      expect(error["code"]).toBe(-32022);
      expect(error["message"]).toBe("Unsupported protocol version");
      expect(error["data"]).toEqual({
        supported: ["2026-07-28", "2025-06-18", "2025-03-26", "2024-11-05"],
        requested: "1900-01-01",
      });
    });

    it("logs the refusal as one, with the code that caused it", async () => {
      const logger = recordingLogger();
      const withLog = await startTestServer(home, logger);
      try {
        await rpc(
          withLog,
          tokens.alice,
          "tools/list",
          {
            _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
          },
          1,
          { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
        );
      } finally {
        await withLog.close();
      }
      const line = logger.lines.at(-1);
      expect(line?.status).toBe(400);
      expect(line?.outcome).toBe("refused");
      expect(line?.detail).toBe("-32602");
    });
  });

  describe("an answer stays 200", () => {
    it("keeps 200 for a tool call whose own result reports an error", async () => {
      // The envelope succeeded and the call answered. `isError` inside a result
      // is the tool reporting its outcome, and a transport that turned that into
      // a `400` would be telling the client its request was never understood.
      const called = await modernRpc(ts, tokens.alice, "tools/call", {
        name: "soil_load",
        arguments: { code: "#404" },
      });
      expect(called.status).toBe(200);
      const out = toolText(called.json);
      expect(out.isError).toBe(true);
      expect(out.text).toContain("not found");
      expect(asRecord(called.json)["error"]).toBeUndefined();
    });

    it("pins the bytes of one whole legacy answer", async () => {
      // A small answer, pinned in full, so that a change to what a legacy client
      // receives has to be a decision rather than a side effect.
      const ping = await rpc(ts, tokens.alice, "ping");
      expect(ping.status).toBe(200);
      expect(ping.text).toBe(
        `{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "complete",
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "soil-handover-server",
        "title": "Soil Handover (self-hosted server)",
        "version": "0.2.0"
      }
    }
  }
}
`,
      );
    });
  });

  /**
   * One status per error code, not one per class of error. The transport names
   * `404` for a method the server does not implement and `400` for the refusals
   * that come from the request's own metadata, and the distinction is the whole
   * point: the body of a `404` is what a client reads to tell this endpoint from
   * an older server that does not host it at all.
   */
  describe("a method this endpoint does not implement", () => {
    it("answers 404 with the reserved code, whichever era asked", async () => {
      const legacy = await rpc(ts, tokens.alice, "no/such/method");
      expect(legacy.status).toBe(404);
      expect(errorOf(legacy.json)["code"]).toBe(-32601);

      const modern = await modernRpc(ts, tokens.alice, "no/such/method");
      expect(modern.status).toBe(404);
      expect(errorOf(modern.json)["code"]).toBe(-32601);
    });

    it("carries a JSON-RPC error body, which is what makes the 404 readable", async () => {
      // A client that has to work out what it reached inspects this body: an
      // older server that does not host this endpoint answers 404 with something
      // that is not a JSON-RPC error, and that is the difference it reads.
      const unknown = await rpc(ts, tokens.alice, "no/such/method");
      expect(unknown.text).toBe(
        `{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32601,
    "message": "unknown method: no/such/method"
  }
}
`,
      );
    });

    it("still answers a notification 202, because a notification gets no reply", async () => {
      // Written without the `rpc` helper on purpose: it cannot express a message
      // with no `id`, and a message with no `id` is the whole case. An
      // unimplemented method that arrives as a notification is still a
      // notification, and the transport gives a notification no error to carry.
      const note = await requestJson(ts.base, "POST", "/v1/mcp", tokens.alice, {
        jsonrpc: "2.0",
        method: "no/such/method",
      });
      expect(note.status).toBe(202);
      expect(note.text).toBe("");
    });

    it("leaves the refusals that are 400 exactly where they were", async () => {
      // Proof that the new mapping is per code: the three refusals that were
      // already 400 did not follow -32601 to 404.
      const missing = await rpc(ts, tokens.alice, "tools/list", {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      });
      const unsupported = await rpc(ts, tokens.alice, "tools/list", {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "1900-01-01",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      });
      expect([missing.status, unsupported.status]).toEqual([400, 400]);
    });
  });

  /**
   * A body that is not a JSON-RPC request. The transport says nothing about this
   * one, so it is settled on the readability ground the rest of the mapping
   * stands on, and on one plain inconsistency: bytes that do not parse are
   * already answered `400` a layer earlier, so answering `200` to bytes that
   * parse into something that is still not a message reported half of one fault
   * as a success.
   */
  describe("a body that is not a JSON-RPC request", () => {
    const postRaw = async (
      body: string,
    ): Promise<{ status: number; text: string }> => {
      const response = await fetch(`${ts.base}/v1/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.alice}`,
          "content-type": "application/json",
        },
        body,
      });
      return { status: response.status, text: await response.text() };
    };

    it("answers 400 with -32600 and the body it always sent", async () => {
      const refused = await postRaw(JSON.stringify({ hello: "world" }));
      expect(refused.status).toBe(400);
      expect(refused.text).toBe(
        `{
  "jsonrpc": "2.0",
  "id": null,
  "error": {
    "code": -32600,
    "message": "not a JSON-RPC request"
  }
}
`,
      );
    });

    it("reads a JSON array as one of those, not as a batch", async () => {
      const refused = await postRaw("[]");
      expect(refused.status).toBe(400);
      expect(errorOf(JSON.parse(refused.text))["code"]).toBe(-32600);
    });

    it("answers a nameless tools/call the same way, since it is the same code", async () => {
      // The second and last place this endpoint says -32600. Its status moves
      // with the code, which is what per-code mapping means, and its body is
      // untouched.
      // No `Mcp-Name` either, and correctly so: the body names no tool, so
      // there is no value for that header to mirror and none to require.
      const refused = await modernRpc(ts, tokens.alice, "tools/call");
      expect(refused.status).toBe(400);
      expect(refused.text).toBe(
        `{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32600,
    "message": "tools/call needs a tool name"
  }
}
`,
      );
    });

    it("still answers bytes that are not JSON at all before any of this", async () => {
      const refused = await postRaw("not json");
      expect(refused.status).toBe(400);
      expect(refused.text).toContain("well-formed JSON");
    });
  });
});

/**
 * The mirrored protocol version header, and the client it could take the server
 * away from. A legacy client that works today must get the same answer to the
 * byte, and comparing a header against a version it never declared is the
 * likeliest way to lose that.
 */
describe("the mirrored protocol version header", () => {
  let home: string;
  let tokens: SeededTokens;
  let ts: TestServer;

  const HEADER = "mcp-protocol-version";
  const MODERN_VERSION = "2026-07-28";
  beforeEach(async () => {
    home = makeHome();
    tokens = seedHome(home);
    ts = await startTestServer(home);
  });

  afterEach(async () => {
    await ts.close();
    removeHome(home);
  });

  const errorOf = (json: unknown): Record<string, unknown> =>
    asRecord(asRecord(json)["error"]);

  describe("a header that disagrees with the body", () => {
    it("is refused with 400 and the reserved code for it", async () => {
      const refused = await rpc(
        ts,
        tokens.alice,
        "tools/list",
        { _meta: MODERN_META },
        1,
        { [HEADER]: "2025-11-25" },
      );
      expect(refused.status).toBe(400);
      const error = errorOf(refused.json);
      expect(error["code"]).toBe(-32020);
      expect(String(error["message"])).toContain("Header mismatch");
      expect(String(error["message"])).toContain("2025-11-25");
      expect(String(error["message"])).toContain(MODERN_VERSION);
      expect(asRecord(refused.json)["id"]).toBe(1);
    });

    it("is quoted back cut short, not in full", async () => {
      const refused = await rpc(
        ts,
        tokens.alice,
        "tools/list",
        { _meta: MODERN_META },
        1,
        { [HEADER]: "x".repeat(400) },
      );
      expect(refused.status).toBe(400);
      expect(String(errorOf(refused.json)["message"]).length).toBeLessThan(200);
    });

    it("serves a capabilities-only body whatever the version header says", async () => {
      // A body that declares capabilities but no version key is a legacy
      // request now, so there is no declared version for this header to
      // disagree with and nothing the modern era requires of it. This used to
      // be refused with -32602 for the missing field; the field is not
      // missing from a legacy request, because no legacy revision defines it.
      const served = await rpc(
        ts,
        tokens.alice,
        "tools/list",
        { _meta: { "io.modelcontextprotocol/clientCapabilities": {} } },
        1,
        { [HEADER]: MODERN_VERSION, "mcp-method": "tools/list" },
      );
      expect(served.status).toBe(200);
      expect(asRecord(served.json)["error"]).toBeUndefined();
    });
  });

  describe("a header there is nothing to compare", () => {
    it("serves a modern request whose header agrees with the body", async () => {
      const served = await modernRpc(
        ts,
        tokens.alice,
        "server/discover",
        {},
        1,
        { [HEADER]: MODERN_VERSION },
      );
      expect(served.status).toBe(200);
      expect(asRecord(served.json)["error"]).toBeUndefined();
    });

    it("refuses a modern request that sends no version header at all", async () => {
      // This test used to pin the opposite answer, on the reading that a server
      // which supports clients predating the header may take its absence as an
      // older revision. That permission is for supporting those clients, and it
      // does not reach a body that declares `2026-07-28`: reading such a request
      // as an older version contradicts the body, and the body is the source of
      // truth. So the header is required here, exactly as the other two are.
      const refused = await modernRpc(
        ts,
        tokens.alice,
        "server/discover",
        {},
        1,
        { [HEADER]: undefined },
      );
      expect(refused.status).toBe(400);
      const error = errorOf(refused.json);
      expect(error["code"]).toBe(-32020);
      expect(String(error["message"])).toContain("MCP-Protocol-Version");
      expect(String(error["message"])).toContain(MODERN_VERSION);
    });

    it("serves the same request in the legacy era with no version header", async () => {
      // The permission the test above used to lean on, applied where it belongs:
      // a request that declares no version is a client of a revision that had no
      // such header, and it is served without one.
      const served = await rpc(ts, tokens.alice, "tools/list");
      expect(served.status).toBe(200);
      expect(asRecord(served.json)["error"]).toBeUndefined();
    });

    it("serves a request that declares no version and sends no header", async () => {
      // Nothing for the header to mirror, so the header is not required
      // either, and a body without the version key is a legacy request:
      // served, exactly as it was before the modern revisions existed.
      const served = await rpc(
        ts,
        tokens.alice,
        "tools/list",
        { _meta: { "io.modelcontextprotocol/clientCapabilities": {} } },
        1,
        { "mcp-method": "tools/list" },
      );
      expect(served.status).toBe(200);
      expect(asRecord(served.json)["error"]).toBeUndefined();
    });

    it("does not read the version header through the base64 sentinel", async () => {
      // The transport names `Mcp-Name` and `Mcp-Param-{Name}` as the headers a
      // server must decode before comparing, and this is neither. A version that
      // arrives looking like a sentinel is a version that says that, so it does
      // not match a body that declares the value inside it.
      const encoded = `=?base64?${Buffer.from(MODERN_VERSION, "utf8").toString(
        "base64",
      )}?=`;
      const refused = await modernRpc(
        ts,
        tokens.alice,
        "server/discover",
        {},
        1,
        { [HEADER]: encoded },
      );
      expect(refused.status).toBe(400);
      expect(errorOf(refused.json)["code"]).toBe(-32020);
    });

    it("serves a legacy request whatever its header says", async () => {
      // A `2025-06-18` client sends this header on every request after its
      // handshake. A legacy request declares no version to compare it against,
      // and a stateless endpoint kept no negotiated version either, so the only
      // thing a comparison could do here is break a client that works.
      for (const value of ["2025-06-18", "2026-07-28", "not-a-version"]) {
        const served = await rpc(
          ts,
          tokens.alice,
          "tools/list",
          { _meta: { progressToken: 7 } },
          1,
          { [HEADER]: value },
        );
        expect(served.status).toBe(200);
        expect(asRecord(served.json)["error"]).toBeUndefined();
      }
    });
  });

  describe("a legacy request answers exactly as it did before", () => {
    // The status a legacy client gets for each of these, stated per row rather
    // than assumed for all six. Five are `200` and always were. The sixth names a
    // method this endpoint does not implement, and that status is `404` because
    // the transport requires it; its body is unchanged, which the byte pin below
    // is what proves.
    const legacyMessages: ReadonlyArray<[string, string, unknown, number]> = [
      [
        "the handshake",
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy", version: "0" },
        },
        200,
      ],
      ["a tool listing", "tools/list", undefined, 200],
      [
        "a request that opted into progress",
        "tools/list",
        { progressToken: 7 },
        200,
      ],
      ["a tool call", "tools/call", { name: "soil_list", arguments: {} }, 200],
      ["ping", "ping", undefined, 200],
      ["an unknown method", "no/such/method", undefined, 404],
    ];

    it.each(legacyMessages)(
      "answers %s with the same status and the same bytes, header or no header",
      async (_name, method, params, status) => {
        const bare = await rpc(ts, tokens.alice, method, params);
        expect(bare.status).toBe(status);
        for (const value of ["2025-06-18", "2026-07-28"]) {
          const withHeader = await rpc(ts, tokens.alice, method, params, 1, {
            [HEADER]: value,
          });
          expect(withHeader.status).toBe(bare.status);
          expect(withHeader.text).toBe(bare.text);
        }
      },
    );

    it.each(legacyMessages)(
      "answers %s with the bytes a mirrored method header does not change",
      async (_name, method, params, status) => {
        // The two headers this revision added, sent with the value the body
        // already declares. A copy that agrees is not a fault, so a legacy answer
        // must come back untouched: same status, same bytes.
        const bare = await rpc(ts, tokens.alice, method, params);
        const withHeaders = await rpc(ts, tokens.alice, method, params, 1, {
          "mcp-method": method,
          ...(method === "tools/call" ? { "mcp-name": "soil_list" } : {}),
        });
        expect(bare.status).toBe(status);
        expect(withHeaders.status).toBe(bare.status);
        expect(withHeaders.text).toBe(bare.text);
      },
    );

    it.each(legacyMessages)(
      "answers %s with no mirrored headers at all, which is now a distinct case",
      async (_name, method, params, status) => {
        // Sending none of the three headers is served in the legacy era and
        // refused in the modern one, for the version header alone, so the era
        // gate is the only thing standing between a working legacy client and
        // a 400. Every one of the six is checked here rather than one
        // standing in for the rest.
        const bare = await rpc(ts, tokens.alice, method, params);
        expect(bare.status).toBe(status);
        expect(asRecord(bare.json)["error"]).toEqual(
          status === 404
            ? { code: -32601, message: `unknown method: ${method}` }
            : undefined,
        );
      },
    );

    it.each(legacyMessages)(
      "refuses %s with no mirrored headers once its body opens modern",
      async (_name, method, params, _status) => {
        // The same six bodies with the per-request metadata added and nothing
        // else changed. Each one flips from served to refused, which is what
        // proves the era gate is doing the work rather than something about the
        // particular message.
        const modern = await rpc(ts, tokens.alice, method, {
          ...(typeof params === "object" && params !== null ? params : {}),
          _meta: MODERN_META,
        });
        expect(modern.status).toBe(400);
        const error = asRecord(asRecord(modern.json)["error"]);
        expect(error["code"]).toBe(-32020);
        // The version header is the one named because it is the only one of
        // the three the modern era requires: a body that declares
        // `2026-07-28` cannot have its absent version header read as an older
        // revision, where the other two are copies this endpoint checks only
        // when they arrive.
        expect(String(error["message"])).toContain("MCP-Protocol-Version");
      },
    );

    it("still acknowledges a legacy notification with 202 and no body", async () => {
      const note = await rpc(
        ts,
        tokens.alice,
        "notifications/initialized",
        undefined,
        undefined,
        { [HEADER]: "2025-06-18" },
      );
      expect(note.status).toBe(202);
      expect(note.text).toBe("");
    });
  });
});

/**
 * The other two mirrored headers. `Mcp-Method` copies the body's method and
 * `Mcp-Name` copies the name a call addresses, so an intermediary can route
 * without parsing. The body stays the source of truth, and a copy that says
 * something else is the shape of a request two components would act on
 * differently: a gateway routing on the header, this server acting on the body.
 *
 * Checked when sent, never required, in either era. That is a recorded
 * divergence from the specification's letter, which lists a missing standard
 * header among the conditions a server must reject: real client runtimes that
 * carry the modern metadata in the body send no mirrored headers at all, and
 * refusing their absence would refuse every call those clients make while
 * protecting nothing, because this endpoint acts on the body alone.
 * `docs/server.md` states the divergence rather than implying conformance.
 */
describe("the mirrored method and name headers", () => {
  let home: string;
  let tokens: SeededTokens;
  let ts: TestServer;

  const METHOD = "mcp-method";
  const NAME = "mcp-name";
  const CALL_ARGS = { name: "soil_list", arguments: {} };
  const CALL_PARAMS = { ...CALL_ARGS, _meta: MODERN_META };

  const sentinel = (value: string): string =>
    `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;

  beforeEach(async () => {
    home = makeHome();
    tokens = seedHome(home);
    ts = await startTestServer(home);
  });

  afterEach(async () => {
    await ts.close();
    removeHome(home);
  });

  const errorOf = (json: unknown): Record<string, unknown> =>
    asRecord(asRecord(json)["error"]);

  describe("a copy that agrees, or that has nothing to disagree with", () => {
    it("serves a request whose headers both match the body", async () => {
      const served = await modernRpc(
        ts,
        tokens.alice,
        "tools/call",
        CALL_ARGS,
        1,
        { [METHOD]: "tools/call", [NAME]: "soil_list" },
      );
      expect(served.status).toBe(200);
      expect(asRecord(served.json)["error"]).toBeUndefined();
    });

    it("serves a name sent through the base64 sentinel that decodes to the body value", async () => {
      // A value outside plain visible ASCII travels wrapped, and the wrapper has
      // to come off before anything is compared, or every encoded name reads as
      // a mismatch.
      const served = await modernRpc(
        ts,
        tokens.alice,
        "tools/call",
        CALL_ARGS,
        1,
        { [NAME]: sentinel("soil_list") },
      );
      expect(served.status).toBe(200);
      expect(asRecord(served.json)["error"]).toBeUndefined();
    });

    it("neither requires nor reads a name header where the body names nothing", async () => {
      // `tools/list` has no name or uri in its params. There is no value for
      // `Mcp-Name` to mirror, so it is not required here even in the modern era,
      // and one sent anyway is a copy of nothing rather than a fault.
      const withHeader = await modernRpc(
        ts,
        tokens.alice,
        "tools/list",
        {},
        1,
        { [NAME]: "whatever" },
      );
      expect(withHeader.status).toBe(200);
      expect(asRecord(withHeader.json)["error"]).toBeUndefined();

      const withoutHeader = await modernRpc(ts, tokens.alice, "tools/list");
      expect(withoutHeader.status).toBe(200);
      expect(asRecord(withoutHeader.json)["error"]).toBeUndefined();
    });

    it("reports an unimplemented method as one, not as a name mismatch", async () => {
      // `Mcp-Name` mirrors the name field of the three calls the transport lists,
      // and this is not one of them. A `params.name` on some other method is not
      // the field the header copies, so a header that disagrees with it is not a
      // fault: the fault is the method, and that is what the answer says.
      const refused = await modernRpc(
        ts,
        tokens.alice,
        "no/such/method",
        { name: "something" },
        1,
        { [NAME]: "something-else" },
      );
      expect(refused.status).toBe(404);
      expect(errorOf(refused.json)["code"]).toBe(-32601);
    });
  });

  /**
   * These two headers are never required, in either era. The transport lists a
   * missing standard header among the conditions a server must reject, and this
   * endpoint diverges from that on purpose: the same real client runtimes that
   * carry the modern per-request metadata send no mirrored headers at all, so
   * requiring the copies would refuse every call those clients make, over
   * headers whose only reader here is the comparison itself. Absence is served;
   * a copy does its answering for a contradiction only when it arrives. The
   * version header is the one exception and keeps its own rule, pinned in the
   * block above.
   */
  describe("a copy that was not sent", () => {
    it("serves a modern request that sends no method header", async () => {
      // This used to be refused with -32020. The refusal turned away real
      // modern-opening clients and defended nothing: the body already says
      // the method, and this endpoint reads nothing else.
      const served = await modernRpc(ts, tokens.alice, "tools/list", {}, 1, {
        [METHOD]: undefined,
      });
      expect(served.status).toBe(200);
      expect(asRecord(served.json)["error"]).toBeUndefined();
    });

    it("serves a modern tools/call that sends no name header", async () => {
      const served = await modernRpc(
        ts,
        tokens.alice,
        "tools/call",
        CALL_ARGS,
        1,
        { [NAME]: undefined },
      );
      expect(served.status).toBe(200);
      expect(asRecord(served.json)["error"]).toBeUndefined();
    });

    it("serves a modern tools/call that sends no mirrored header but the version", async () => {
      // The measured shape of a conforming-enough modern client: metadata in
      // the body, the version header alongside it, and neither copy.
      const served = await modernRpc(
        ts,
        tokens.alice,
        "tools/call",
        CALL_ARGS,
        1,
        { [METHOD]: undefined, [NAME]: undefined },
      );
      expect(served.status).toBe(200);
      expect(asRecord(served.json)["error"]).toBeUndefined();
    });

    it("serves the same two requests in the legacy era", async () => {
      // The same bodies with the metadata taken out. Same answer both times
      // now, and this pair stays pinned so the absence rule cannot quietly
      // become an era rule again.
      const listed = await rpc(ts, tokens.alice, "tools/list");
      expect(listed.status).toBe(200);
      expect(asRecord(listed.json)["error"]).toBeUndefined();

      const called = await rpc(ts, tokens.alice, "tools/call", CALL_ARGS);
      expect(called.status).toBe(200);
      expect(asRecord(called.json)["error"]).toBeUndefined();
    });

    it("does not require a header of a modern notification", async () => {
      // The transport states these requirements for requests and says plainly
      // that it does not define them for a notification POST. A requirement the
      // specification declines to state is not one this endpoint invents.
      const note = await requestJson(ts.base, "POST", "/v1/mcp", tokens.alice, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: { _meta: MODERN_META },
      });
      expect(note.status).toBe(202);
      expect(note.text).toBe("");
    });

    it("still refuses a notification whose header contradicts its body", async () => {
      // The other fault, which the transport does state. A copy that says
      // something else splits a gateway from this server whether or not an
      // answer was expected.
      const refused = await requestJson(
        ts.base,
        "POST",
        "/v1/mcp",
        tokens.alice,
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: { _meta: MODERN_META },
        },
        { [METHOD]: "tools/call" },
      );
      expect(refused.status).toBe(400);
      expect(errorOf(refused.json)["code"]).toBe(-32020);
    });
  });

  describe("a copy that contradicts the body", () => {
    it("refuses a method header that names another method", async () => {
      const refused = await modernRpc(ts, tokens.alice, "tools/list", {}, 1, {
        [METHOD]: "tools/call",
      });
      expect(refused.status).toBe(400);
      const error = errorOf(refused.json);
      expect(error["code"]).toBe(-32020);
      expect(String(error["message"])).toContain("Mcp-Method");
      expect(String(error["message"])).toContain("tools/call");
      expect(String(error["message"])).toContain("tools/list");
      expect(asRecord(refused.json)["id"]).toBe(1);
    });

    it("refuses a name header that names another tool", async () => {
      const refused = await modernRpc(
        ts,
        tokens.alice,
        "tools/call",
        CALL_ARGS,
        1,
        { [NAME]: "soil_save" },
      );
      expect(refused.status).toBe(400);
      const error = errorOf(refused.json);
      expect(error["code"]).toBe(-32020);
      expect(String(error["message"])).toContain("Mcp-Name");
    });

    it("refuses a sentinel that decodes to a different tool", async () => {
      const refused = await modernRpc(
        ts,
        tokens.alice,
        "tools/call",
        CALL_ARGS,
        1,
        { [NAME]: sentinel("soil_save") },
      );
      expect(refused.status).toBe(400);
      expect(errorOf(refused.json)["code"]).toBe(-32020);
      // Quoted back decoded, because the decoded value is the claim that was
      // wrong; the encoding of it says nothing a reader can use.
      expect(String(errorOf(refused.json)["message"])).toContain("soil_save");
    });

    it("quotes a long value back cut short, not in full", async () => {
      const refused = await modernRpc(
        ts,
        tokens.alice,
        "tools/call",
        CALL_ARGS,
        1,
        { [METHOD]: `tools/${"x".repeat(400)}` },
      );
      expect(refused.status).toBe(400);
      expect(String(errorOf(refused.json)["message"]).length).toBeLessThan(200);
    });

    it("refuses before the tool runs, so nothing is stored", async () => {
      const before = await modernRpc(ts, tokens.alice, "tools/list");
      expect(before.status).toBe(200);
      const refused = await modernRpc(
        ts,
        tokens.alice,
        "tools/call",
        { name: "soil_save", arguments: SAVE_ARGS },
        1,
        { [NAME]: "soil_list" },
      );
      expect(refused.status).toBe(400);
      const listed = await modernRpc(ts, tokens.alice, "tools/call", CALL_ARGS);
      expect(toolText(listed.json).text).toContain("Nothing saved yet");
    });

    it("refuses a legacy request whose copy contradicts its own body", async () => {
      // A legacy request can reach this path, and this is the only way in: by
      // sending a header its own era never defined and filling it with something
      // its body denies. The harm a mismatch does belongs to no era, because a
      // gateway routing on one value while this server acts on another is the
      // same split whichever revision the body claims.
      const refused = await rpc(ts, tokens.alice, "tools/list", undefined, 1, {
        [METHOD]: "tools/call",
      });
      expect(refused.status).toBe(400);
      expect(errorOf(refused.json)["code"]).toBe(-32020);
    });
  });

  describe("which fault a request with several of them is told about", () => {
    it("reports the missing capabilities field once the headers all agree", async () => {
      // A modern body that left out `clientCapabilities`, with every header it
      // sends agreeing with it. The headers are not the fault, so the field
      // is what gets named.
      const refused = await rpc(
        ts,
        tokens.alice,
        "tools/list",
        { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
        1,
        { "mcp-protocol-version": "2026-07-28", [METHOD]: "tools/list" },
      );
      expect(refused.status).toBe(400);
      expect(errorOf(refused.json)["code"]).toBe(-32602);
    });

    it("reports the unimplemented method, header or no header", async () => {
      // An absent `Mcp-Method` is not a fault any more, so there is nothing
      // for it to be reported before: the one fault this request has is the
      // method, and that is what both answers say.
      const bare = await modernRpc(ts, tokens.alice, "no/such/method", {}, 1, {
        [METHOD]: undefined,
      });
      expect(bare.status).toBe(404);
      expect(errorOf(bare.json)["code"]).toBe(-32601);

      const mirrored = await modernRpc(ts, tokens.alice, "no/such/method");
      expect(mirrored.status).toBe(404);
      expect(errorOf(mirrored.json)["code"]).toBe(-32601);
    });

    it("reports a contradicting method header on the capabilities-only shape too", async () => {
      // The hybrid body is served as legacy, and legacy is not a pass on
      // contradiction: a copy of the method that names another method splits
      // a gateway from this server whatever era the body opened, so it is
      // refused for what it says, not for who sent it.
      const refused = await rpc(
        ts,
        tokens.alice,
        "tools/list",
        { _meta: { "io.modelcontextprotocol/clientCapabilities": {} } },
        1,
        { [METHOD]: "tools/call" },
      );
      expect(refused.status).toBe(400);
      expect(errorOf(refused.json)["code"]).toBe(-32020);
    });
  });
});
