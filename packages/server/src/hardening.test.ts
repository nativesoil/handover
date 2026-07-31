/**
 * The wire-level properties an operator is entitled to, attacked rather than
 * read: no private path leaves the building, a contended write is refused
 * loudly instead of acknowledged falsely, bytes come in through one door, and
 * every request leaves a line that carries no secret.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startServer } from "./http.js";
import { ingestRequestBody } from "./ingest.js";
import {
  makeHome,
  recordingLogger,
  removeHome,
  requestJson,
  seedHome,
  userIdOf,
  validHandover,
  type SeededTokens,
} from "./test-support.js";
import type { Server } from "node:http";

function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe("object");
  return value as Record<string, unknown>;
}

/**
 * Every place the running process id appears in an answer, as a value rather
 * than as a substring of the serialized document. A process id leaks as a run
 * of digits inside some text, usually a path, or as a number of its own. It
 * does not leak by being the tail of an unrelated number, and searching the
 * serialized form for it cannot tell the difference: the protocol's own error
 * codes are five-digit numbers, so a process id that happens to end one makes
 * a substring search fail against an answer that carries nothing private.
 */
function processIdSightings(value: unknown, path = ""): string[] {
  const wanted = String(process.pid);
  const here: string[] = [];
  if (typeof value === "string") {
    if ((value.match(/\d+/g) ?? []).includes(wanted)) here.push(path || "/");
  } else if (typeof value === "number") {
    if (String(value) === wanted) here.push(path || "/");
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      here.push(...processIdSightings(entry, `${path}/${index}`)),
    );
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      here.push(...processIdSightings(entry, `${path}/${key}`));
    }
  }
  return here;
}

describe("the process-id check finds a leak and not a coincidence", () => {
  const pid = String(process.pid);

  it("finds the process id inside a path and as a number of its own", () => {
    expect(
      processIdSightings({ error: { message: `/tmp/soil-${pid}/index.json` } }),
    ).toEqual(["/error/message"]);
    expect(processIdSightings({ worker: process.pid })).toEqual(["/worker"]);
    expect(processIdSightings(["ok", `pid ${pid} died`])).toEqual(["/1"]);
  });

  it("does not fire on an unrelated number that ends with it", () => {
    expect(processIdSightings({ error: { code: Number(`-1${pid}`) } })).toEqual(
      [],
    );
    expect(processIdSightings({ error: { code: -32603 } })).toEqual([]);
  });
});

describe("failures never carry the filesystem out", () => {
  let home: string;
  let tokens: SeededTokens;
  let base: string;
  let server: Server;

  beforeEach(async () => {
    home = makeHome();
    tokens = seedHome(home);
    // Break the store the way a half-written file or a bad restore does. The
    // SDK's reader answers this with an exception naming the absolute path.
    const store = join(home, "users", userIdOf(home, "alice"));
    mkdirSync(join(store, "handovers"), { recursive: true });
    writeFileSync(join(store, "index.json"), "{}", "utf8");
    const started = await startServer({ home, port: 0 });
    base = `http://127.0.0.1:${started.port}`;
    server = started.server;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeHome(home);
  });

  it("answers the MCP surface without the path or the process id", async () => {
    const { status, json } = await requestJson(
      base,
      "POST",
      "/v1/mcp",
      tokens.alice,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "soil_list", arguments: {} },
      },
    );
    // A request this server understood and then could not complete. `500` says
    // that, and says it to a proxy and a retry as well as to a reader; the body
    // is the same sentence it has always been.
    expect(status).toBe(500);
    const body = JSON.stringify(json);
    // The exception that produced this said: "the index at <home>/users/<id>/
    // index.json is not readable". None of that may travel to a model.
    expect(body).not.toContain(home);
    expect(body).not.toContain("index.json");
    expect(processIdSightings(json)).toEqual([]);
    expect(body).not.toMatch(/(^|")\/[A-Za-z0-9._/-]{8,}/);
    expect(String(asRecord(asRecord(json)["error"])["message"])).toContain(
      "nothing was stored",
    );
  });

  it("answers the HTTP surface the same way", async () => {
    const { status, json } = await requestJson(
      base,
      "GET",
      "/v1/handovers",
      tokens.alice,
    );
    expect(status).toBe(500);
    expect(asRecord(json)["error"]).toBe("internal error");
    expect(JSON.stringify(json)).not.toContain(home);
  });

  it("answers 500 in either era, with the same bytes", async () => {
    // The status is a judgment, not conformance: the transport says nothing about
    // a server-side failure. What settled it is that the request was well formed
    // and this server could not answer it, which is what `500` means and what a
    // `200` cannot say to a proxy, a retry or a log. The body is the part that
    // must not move, so it is compared byte for byte across the two eras.
    const legacy = await requestJson(base, "POST", "/v1/mcp", tokens.alice, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "soil_list", arguments: {} },
    });
    const modern = await requestJson(
      base,
      "POST",
      "/v1/mcp",
      tokens.alice,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "soil_list",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
      {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "soil_list",
      },
    );
    expect(legacy.status).toBe(500);
    expect(modern.status).toBe(500);
    expect(modern.text).toBe(legacy.text);
    expect(legacy.text).toBe(
      `{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "the server could not complete that call; nothing was stored. The operator's log has the detail."
  }
}
`,
    );
  });

  it("logs a 500 as an error rather than as a refusal", async () => {
    // An operator reading back through a day needs the two apart: a refusal is
    // the message being wrong, a 500 is this server failing.
    const logger = recordingLogger();
    const withLog = await startServer({ home, port: 0, logger });
    try {
      await requestJson(
        `http://127.0.0.1:${withLog.port}`,
        "POST",
        "/v1/mcp",
        tokens.alice,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "soil_list", arguments: {} },
        },
      );
    } finally {
      await new Promise<void>((resolve) =>
        withLog.server.close(() => resolve()),
      );
    }
    const line = logger.lines.at(-1);
    expect(line?.status).toBe(500);
    expect(line?.outcome).toBe("error");
    expect(line?.detail).toBe("-32603");
  });

  it("says the same thing on both surfaces", async () => {
    // The audit's complaint was inconsistency: one surface generic, the other
    // not. Both must now be generic; neither may name a path.
    const mcp = await requestJson(base, "POST", "/v1/mcp", tokens.alice, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "soil_list", arguments: {} },
    });
    const http = await requestJson(base, "GET", "/v1/handovers", tokens.alice);
    for (const body of [JSON.stringify(mcp.json), JSON.stringify(http.json)]) {
      expect(body).not.toContain(home);
    }
  });
});

describe("a contended write is refused, never acknowledged", () => {
  let home: string;
  let tokens: SeededTokens;
  let base: string;
  let server: Server;

  beforeEach(async () => {
    home = makeHome();
    tokens = seedHome(home);
    const started = await startServer({
      home,
      port: 0,
      lockOptions: { timeoutMs: 80 },
    });
    base = `http://127.0.0.1:${started.port}`;
    server = started.server;
    // Exactly what another process holding this store's lock leaves on disk.
    const dir = join(
      home,
      ".locks",
      `personal-${userIdOf(home, "alice")}.lock`,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "holder.json"),
      JSON.stringify({
        holder: "99999999-9999-4999-8999-999999999999",
        acquiredAt: Date.now(),
        host: "another-container",
        pid: process.pid,
      }),
      "utf8",
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeHome(home);
  });

  it("answers 503 with Retry-After, and stores nothing", async () => {
    const saved = await requestJson(
      base,
      "POST",
      "/v1/handovers",
      tokens.alice,
      validHandover(),
    );
    expect(saved.status).toBe(503);
    expect(saved.headers.get("retry-after")).toBe("1");
    expect(String(asRecord(saved.json)["error"])).toContain(
      "nothing was stored",
    );

    // Reads still work while a write is blocked, and show nothing was written.
    const listed = await requestJson(
      base,
      "GET",
      "/v1/handovers",
      tokens.alice,
    );
    expect(listed.status).toBe(200);
    expect(asRecord(listed.json)["handovers"]).toHaveLength(0);
  });

  it("tells a model to try again rather than pretending it saved", async () => {
    const { json } = await requestJson(base, "POST", "/v1/mcp", tokens.alice, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "soil_save",
        arguments: {
          projectId: "billing-rework",
          title: "a save that will not land",
          sections: { projectIdentity: "Ship the billing rework." },
        },
      },
    });
    const result = asRecord(asRecord(json)["result"]);
    expect(result["isError"]).toBe(true);
    const text = String(
      (result["content"] as Record<string, unknown>[])[0]?.["text"],
    );
    expect(text).toContain("nothing was stored");
    expect(text).not.toContain(home);
  });
});

describe("one door for bytes", () => {
  it("refuses a byte order mark, invalid UTF-8 and broken JSON, by code", () => {
    expect(ingestRequestBody(Buffer.from('{"a":1}', "utf8"))).toEqual({
      ok: true,
      value: { a: 1 },
    });

    const bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"a":1}', "utf8"),
    ]);
    expect(ingestRequestBody(bom)).toMatchObject({
      ok: false,
      code: "encoding.byte_order_mark",
    });

    expect(
      ingestRequestBody(
        Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]),
      ),
    ).toMatchObject({ ok: false, code: "encoding.invalid_utf8" });

    expect(ingestRequestBody(Buffer.from("{not json", "utf8"))).toMatchObject({
      ok: false,
      code: "syntax.invalid_json",
    });
  });

  it("is the door the HTTP surface actually uses", async () => {
    const home = makeHome();
    const tokens = seedHome(home);
    const started = await startServer({ home, port: 0 });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      // A body that `Buffer.toString("utf8")` would have quietly repaired into
      // U+FFFD and handed to the validator as if it were what was sent.
      const response = await fetch(`${base}/v1/handovers`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.alice}`,
          "content-type": "application/json",
        },
        body: Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("encoding.invalid_utf8");

      const withBom = await fetch(`${base}/v1/handovers`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.alice}`,
          "content-type": "application/json",
        },
        body: Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(JSON.stringify(validHandover()), "utf8"),
        ]),
      });
      expect(withBom.status).toBe(400);
      expect(((await withBom.json()) as Record<string, unknown>)["code"]).toBe(
        "encoding.byte_order_mark",
      );
    } finally {
      await new Promise<void>((resolve) =>
        started.server.close(() => resolve()),
      );
      removeHome(home);
    }
  });

  /**
   * The Model A guarantee, checked on the wire rather than argued.
   *
   * Every surface that claims full support accepts the whole normative domain
   * and no more. A surface that accepts LESS is the failure the conformance
   * suite is built around; a surface that accepts MORE is worse, because a
   * document admitted here may be unreadable everywhere else, and that is the
   * interoperation the format exists to provide.
   *
   * The fixtures are the same ones the five conformance runners use, read from
   * the same manifest, so this cannot drift from them by accident. Measured
   * before this test existed, this server answered `201 Created` to a complete
   * handover carrying a repeated `projectId`, and `500 internal error` to a
   * document 33 levels deep, one carrying `0.92` and one carrying
   * 9007199254740992 — after writing each of them to disk, where every later
   * read of them answered `500` as well.
   */
  it("refuses on the wire exactly what the shared boundary refuses", async () => {
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "conformance/fixtures/manifest.json"), "utf8"),
    ) as {
      boundary: readonly {
        name: string;
        file?: string;
        generateBytes?: number;
        ingest: string;
      }[];
    };

    const bytesFor = (entry: {
      file?: string;
      generateBytes?: number;
    }): Buffer =>
      entry.file !== undefined
        ? readFileSync(join(ROOT, "conformance/fixtures", entry.file))
        : Buffer.from(
            `{"pad":"${"x".repeat((entry.generateBytes ?? 0) - 10)}"}`,
            "utf8",
          );

    const home = makeHome();
    const tokens = seedHome(home);
    const started = await startServer({ home, port: 0 });
    const base = `http://127.0.0.1:${started.port}`;

    const post = async (
      body: Buffer,
    ): Promise<{ status: number; code: unknown }> => {
      const response = await fetch(`${base}/v1/handovers`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.alice}`,
          "content-type": "application/json",
        },
        body,
      });
      const raw = await response.text();
      let code: unknown;
      try {
        code = (JSON.parse(raw) as Record<string, unknown>)["code"];
      } catch {
        code = undefined;
      }
      return { status: response.status, code };
    };

    try {
      const refused = manifest.boundary.filter((e) => e.ingest !== "accepted");
      expect(refused.length).toBeGreaterThan(10);

      for (const entry of refused) {
        const { status, code } = await post(bytesFor(entry));
        if (entry.ingest === "document.too_large") {
          // The one refusal the boundary never gets to make on this surface:
          // `readBody` stops reading at the same ceiling and answers with the
          // HTTP status for an oversize body, so the bytes never arrive here.
          expect([entry.name, status]).toEqual([entry.name, 413]);
          continue;
        }
        expect([entry.name, status, code]).toEqual([
          entry.name,
          400,
          entry.ingest,
        ]);
      }

      // The other half of Model A: a surface that refuses MORE than the domain
      // is also wrong. Nothing the boundary accepts may be turned away at the
      // door — what the validator then says about it is a different layer.
      for (const entry of manifest.boundary.filter(
        (e) => e.ingest === "accepted",
      )) {
        const { status } = await post(bytesFor(entry));
        expect([entry.name, status === 400]).toEqual([entry.name, false]);
      }
    } finally {
      await new Promise<void>((resolve) =>
        started.server.close(() => resolve()),
      );
      removeHome(home);
    }
  });
});

/**
 * The `Origin` header, and the one attack it is there for.
 *
 * A page in a browser on the operator's own machine can reach a server bound to
 * loopback: the browser resolves a name the attacker controls to `127.0.0.1` and
 * posts to it. What the page cannot do is lie about where it came from, because
 * the browser fills this header in from where the page was loaded, not from where
 * it is sending to. So the check has something real to work with, and it is the
 * only defence in the building that does: binding loopback does not stop this,
 * and a token does not either once a page has one.
 *
 * Absent is not the same as wrong. A caller that is not a browser sends no
 * `Origin` at all, which is every client this server has, so an absent header is
 * served. Only a present one is judged.
 */
describe("the Origin a request says it came from", () => {
  let home: string;
  let tokens: SeededTokens;
  let base: string;
  let server: Server;

  beforeEach(async () => {
    home = makeHome();
    tokens = seedHome(home);
    const started = await startServer({ home, port: 0 });
    base = `http://127.0.0.1:${started.port}`;
    server = started.server;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeHome(home);
  });

  // An options object rather than positional arguments with defaults. A default
  // parameter applies to an argument that is `undefined`, so "no token" written
  // positionally would silently mean "the usual token" and a test about acting
  // without one would test nothing.
  const ping = async (
    options: { origin?: string; withToken?: boolean } = {},
  ): Promise<{ status: number; text: string; headers: Headers }> =>
    requestJson(
      base,
      "POST",
      "/v1/mcp",
      options.withToken === false ? undefined : tokens.alice,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      options.origin === undefined ? {} : { origin: options.origin },
    );

  it("serves a request that sends no Origin at all", async () => {
    const served = await ping();
    expect(served.status).toBe(200);
  });

  it("serves a page served from this machine, on any scheme and any port", async () => {
    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:8787",
      "https://localhost",
      "http://[::1]:5173",
    ]) {
      const served = await ping({ origin });
      expect(served.status, origin).toBe(200);
    }
  });

  it("answers 403 to a page served from anywhere else", async () => {
    const refused = await ping({ origin: "https://handovers.example" });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.text)).toEqual({ error: "forbidden origin" });
  });

  it("answers 403 to an origin that cannot say where it came from", async () => {
    // A sandboxed frame, a page from a file, a redirect that dropped the origin:
    // all of them send this, and none of them is the operator.
    for (const origin of ["null", "", "not a url", "file://"]) {
      const refused = await ping({ origin });
      expect(refused.status, origin).toBe(403);
    }
  });

  it("is not fooled by a hostname that merely contains a loopback name", async () => {
    for (const origin of [
      "https://localhost.evil.example",
      "https://127.0.0.1.evil.example",
      "https://evil.example:8787",
    ]) {
      const refused = await ping({ origin });
      expect(refused.status, origin).toBe(403);
    }
  });

  it("refuses before the token, so a page never acts whatever it attached", async () => {
    const refused = await ping({
      origin: "https://handovers.example",
      withToken: false,
    });
    expect(refused.status).toBe(403);
  });

  it("guards the routes that write files, not the MCP endpoint alone", async () => {
    // The attack does not care which path it posts to, and these are the paths
    // that change what is on disk.
    const listed = await requestJson(
      base,
      "GET",
      "/v1/handovers",
      tokens.alice,
      undefined,
      {
        origin: "https://handovers.example",
      },
    );
    expect(listed.status).toBe(403);
    const saved = await requestJson(
      base,
      "POST",
      "/v1/handovers",
      tokens.alice,
      { handover: validHandover() },
      { origin: "https://handovers.example" },
    );
    expect(saved.status).toBe(403);
    // And nothing was written by the refused save.
    const after = await requestJson(base, "GET", "/v1/handovers", tokens.alice);
    expect(asRecord(after.json)["handovers"]).toEqual([]);
  });

  it("answers an origin the operator vouched for", async () => {
    const withList = await startServer({
      home,
      port: 0,
      allowedOrigins: ["https://handovers.example"],
    });
    const listBase = `http://127.0.0.1:${withList.port}`;
    try {
      const served = await requestJson(
        listBase,
        "POST",
        "/v1/mcp",
        tokens.alice,
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { origin: "https://handovers.example" },
      );
      expect(served.status).toBe(200);
      // The list is what it says and nothing near it: another scheme, another
      // port and another host are all still somewhere else.
      for (const origin of [
        "http://handovers.example",
        "https://handovers.example:8443",
        "https://other.example",
      ]) {
        const refused = await requestJson(
          listBase,
          "POST",
          "/v1/mcp",
          tokens.alice,
          { jsonrpc: "2.0", id: 1, method: "ping" },
          { origin },
        );
        expect(refused.status, origin).toBe(403);
      }
    } finally {
      await new Promise<void>((resolve) =>
        withList.server.close(() => resolve()),
      );
    }
  });

  it("never sends an allow-origin header, because this is not CORS", async () => {
    // The server refusing to act is the whole mechanism. Telling a browser what
    // it may read would be a different feature, and a browser that was told it
    // may read this would be told by a server that had already acted.
    const served = await requestJson(
      base,
      "POST",
      "/v1/mcp",
      tokens.alice,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { origin: "http://localhost:3000" },
    );
    expect(served.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("records a refused origin in the log as its own outcome", async () => {
    const logger = recordingLogger();
    const logged = await startServer({ home, port: 0, logger });
    try {
      await requestJson(
        `http://127.0.0.1:${logged.port}`,
        "POST",
        "/v1/mcp",
        tokens.alice,
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { origin: "https://handovers.example" },
      );
    } finally {
      await new Promise<void>((resolve) =>
        logged.server.close(() => resolve()),
      );
    }
    const line = logger.lines.at(-1);
    expect(line?.status).toBe(403);
    expect(line?.outcome).toBe("forbidden");
    // Nothing about who: the request never got as far as a token.
    expect(line?.userId).toBeNull();
  });
});

describe("the audit trail", () => {
  let home: string;
  let tokens: SeededTokens;
  let base: string;
  let server: Server;
  let logger: ReturnType<typeof recordingLogger>;

  beforeEach(async () => {
    home = makeHome();
    tokens = seedHome(home);
    logger = recordingLogger();
    const started = await startServer({ home, port: 0, logger });
    base = `http://127.0.0.1:${started.port}`;
    server = started.server;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeHome(home);
  });

  it("records who did what, on both surfaces, including the refusals", async () => {
    await requestJson(base, "GET", "/v1/handovers");
    await requestJson(base, "POST", "/v1/handovers", tokens.alice, {
      handover: validHandover(),
      project: "team-x",
    });
    await requestJson(
      base,
      "GET",
      "/v1/handovers/%23001?project=team-x",
      tokens.bob,
    );
    await requestJson(
      base,
      "GET",
      "/v1/handovers?project=team-x",
      tokens.mallory,
    );
    await requestJson(base, "POST", "/v1/mcp", tokens.alice, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "soil_list", arguments: {} },
    });

    const lines = logger.lines;
    expect(lines.length).toBeGreaterThanOrEqual(6);

    const unauthorized = lines.find((line) => line.outcome === "unauthorized");
    expect(unauthorized).toBeDefined();
    expect(unauthorized?.userId).toBeNull();

    const save = lines.find(
      (line) => line.action === "POST /v1/handovers" && line.outcome === "ok",
    );
    expect(save).toMatchObject({
      surface: "http",
      username: "alice",
      project: "team-x",
      code: "#001",
      status: 201,
      sections: 2,
    });
    expect(save?.userId).toBe(userIdOf(home, "alice"));
    expect(typeof save?.durationMs).toBe("number");

    const load = lines.find(
      (line) =>
        line.action === "GET /v1/handovers/%23001" && line.status === 200,
    );
    expect(load?.username).toBe("bob");

    const denied = lines.find((line) => line.outcome === "not-found");
    expect(denied?.username).toBe("mallory");

    // The MCP surface logs the tool by name, not just "POST /v1/mcp".
    expect(lines.some((line) => line.action === "soil_list")).toBe(true);
  });

  it("never writes a token, a hash, or a word of a handover", async () => {
    await requestJson(
      base,
      "POST",
      "/v1/handovers",
      tokens.alice,
      validHandover(),
    );
    await requestJson(base, "GET", "/v1/handovers/%23001", tokens.alice);
    await requestJson(base, "GET", "/v1/handovers", "0".repeat(64));

    const dump = JSON.stringify(logger.lines);
    for (const token of [tokens.alice, tokens.bob, tokens.mallory]) {
      expect(dump).not.toContain(token);
    }
    expect(dump).not.toContain("0".repeat(64));
    // Section content and the title of the document that was just saved.
    expect(dump).not.toContain("outbox pattern");
    expect(dump).not.toContain("Billing rework, midpoint");
    expect(dump).not.toContain("without breaking invoicing");
    // And no absolute path.
    expect(dump).not.toContain(home);
  });
});
