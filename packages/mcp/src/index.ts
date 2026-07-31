/**
 * A local MCP server over stdio.
 *
 * JSON-RPC 2.0, one message per line, no dependencies. It exposes exactly three
 * tools (`soil_save`, `soil_load`, `soil_list`) against the same `~/.soil` store
 * the CLI uses, so a handover saved from your editor loads in your terminal and
 * the other way round.
 *
 * It answers clients of either protocol era: one that opens with an
 * `initialize` handshake, and one that carries its protocol version and
 * capabilities in each request's `_meta` and expects no handshake at all. Which
 * era a request gets is decided from that request alone.
 *
 * `handleMessage` is pure apart from the store's file I/O, which is what makes
 * the protocol testable without spawning a process.
 */

import {
  HandoverNotFoundError,
  HandoverStore,
  resolveStoreHome,
} from "@nativesoil/handover-sdk";

import { TOOLS, callTool } from "./tools.js";

export {
  TOOLS,
  callTool,
  type ToolDefinition,
  type ToolResult,
} from "./tools.js";

/**
 * The protocol revisions this server speaks, newest first.
 *
 * Two eras sit side by side here. From `2026-07-28` onward a client carries the
 * protocol version and its capabilities in every request's `_meta`, and the
 * server answers each request on its own with no handshake before it.
 * Everything earlier opens with an `initialize` handshake and keeps what that
 * handshake settled. One process serves both, and decides per request from what
 * the request actually carries, so a client of either era works and no client
 * that works today stops working.
 */
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SUPPORTED_PROTOCOL_VERSIONS = [
  MODERN_PROTOCOL_VERSION,
  ...LEGACY_PROTOCOL_VERSIONS,
];

/**
 * What an `initialize` handshake settles on when the client asks for a version
 * this server does not know. Only the legacy revisions are candidates, because
 * the modern revisions have no handshake to settle.
 */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/**
 * The reserved `_meta` keys the modern revisions use. `protocolVersion` and
 * `clientCapabilities` are required on every modern request. `clientInfo` is
 * not, so a request that leaves it out is still served.
 */
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const SERVER_INFO = {
  name: "soil-handover",
  title: "Soil Handover (local)",
  version: "0.1.0",
} as const;

/**
 * What this server can do. `extensions` is the modern era's home for optional,
 * separately specified capabilities, replacing the old `experimental` object.
 * This server implements none of them, and says so with an empty map rather
 * than leaving the field out.
 */
const CAPABILITIES = {
  tools: { listChanged: false },
  extensions: {},
} as const;

const INSTRUCTIONS =
  "Soil carries a project's working state between sessions. Call soil_save when the user asks to save, when a thread is getting long, or before switching tools: fill every section you can, enumerate the locked decisions with their reasons, and never include secrets or private paths. Call soil_load at the start of a session to pick a project back up. Everything is stored in local files on this machine; nothing is sent anywhere. A save reports how many of the 17 sections carry content; the soil CLI's check command can grade a stored handover with deterministic, documented rules, and only a real load shows what a target model actually keeps. Alongside the sections, soil_save asks four working-style questions: answer them from real moments in the thread when you can, skip them when you cannot, and the save succeeds either way.";

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/**
 * Reserved by MCP for a request naming a protocol version the server will not
 * speak. The error carries the versions it does speak, so the client can pick
 * one and try again instead of guessing.
 */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ok(id: string | number | null, result: object): JsonRpcResponse {
  // Every result names its own type and carries the server's identity, because
  // on the modern path there is no handshake in which either could have been
  // said once. Both are safe to send to a legacy client too: an earlier
  // revision requires reading an absent `resultType` as `complete`, and ignores
  // `_meta` keys it does not recognise. A caller that sets either field itself
  // wins, which is why the defaults come first.
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      _meta: { [META_SERVER_INFO]: SERVER_INFO },
      ...result,
    },
  };
}

function fail(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

/**
 * Whether a request opens in the modern era, decided only from what the request
 * carries: its `_meta` declares the protocol version the modern revisions
 * require on every request.
 *
 * The version key alone decides it, and that is a recorded divergence from the
 * specification's letter, which reserves both per-request keys and requires
 * both on every modern request. A conforming `2026-07-28` client must declare
 * its protocol version every time, so the version key is the one reliable
 * marker of a client that intends the new revision. Real client runtimes send
 * `clientCapabilities` alone, with no version key, and are legacy clients in
 * every other respect; reading that shape as modern turned each of their calls
 * into a refusal. A server's job is serving clients, so the tolerant reading
 * wins: capabilities without a version is served exactly as a legacy request,
 * byte for byte, and a request that does declare the version key keeps the
 * full modern handling, including the requirement that capabilities accompany
 * it.
 *
 * Anything else is served exactly as it was before this revision existed. That
 * includes a legacy request whose `_meta` carries only a `progressToken`, which
 * is why the test is for the reserved version key and not for `_meta` itself.
 */
function isModernRequest(params: unknown): boolean {
  if (!isRecord(params)) return false;
  const meta = params["_meta"];
  if (!isRecord(meta)) return false;
  return META_PROTOCOL_VERSION in meta;
}

/**
 * Check the modern metadata on a request. Returns the refusal to send back, or
 * `undefined` when the request may proceed.
 *
 * A missing required field is malformed params. An unrecognised version is
 * refused rather than quietly downgraded: the legacy handshake could report a
 * downgrade in its reply, and a per-request protocol has nowhere to say it, so
 * silence would leave the client believing something untrue about every answer
 * it got.
 */
function refuseModern(
  id: string | number | null,
  params: unknown,
): JsonRpcResponse | undefined {
  const meta =
    isRecord(params) && isRecord(params["_meta"]) ? params["_meta"] : {};
  const version = meta[META_PROTOCOL_VERSION];

  const missing: string[] = [];
  if (typeof version !== "string") missing.push(META_PROTOCOL_VERSION);
  if (!isRecord(meta[META_CLIENT_CAPABILITIES]))
    missing.push(META_CLIENT_CAPABILITIES);
  if (missing.length > 0) {
    return fail(
      id,
      INVALID_PARAMS,
      `a ${MODERN_PROTOCOL_VERSION} request must carry ${missing.join(
        " and ",
      )} in params._meta`,
      { missing },
    );
  }

  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version as string)) {
    return fail(
      id,
      UNSUPPORTED_PROTOCOL_VERSION,
      "Unsupported protocol version",
      { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: version },
    );
  }

  return undefined;
}

/**
 * Refuse a method that exists in both eras when it opened modern but did not
 * carry what the modern revisions require. A request that did not open modern
 * is left alone, because it is a legacy request and gets served as one.
 */
function refuseIfModern(
  id: string | number | null,
  params: unknown,
): JsonRpcResponse | undefined {
  return isModernRequest(params) ? refuseModern(id, params) : undefined;
}

/**
 * Handle one incoming message. Returns the response to write back, or
 * `undefined` for a notification, which by protocol gets no reply.
 */
export function handleMessage(
  message: unknown,
  store: HandoverStore,
  now: Date = new Date(),
): JsonRpcResponse | undefined {
  if (!isRecord(message) || typeof message["method"] !== "string") {
    return fail(null, INVALID_REQUEST, "not a JSON-RPC request");
  }
  const request = message as unknown as JsonRpcRequest;
  const id = request.id ?? null;
  const isNotification = request.id === undefined;

  switch (request.method) {
    case "initialize": {
      // The handshake is the legacy era's opening move, so it selects legacy
      // semantics even if the request also carries modern metadata. Only the
      // legacy versions are on offer here, and an unknown one still settles on
      // the default: a legacy client has no way to fall forward, and this reply
      // is the only place it can be told what it actually got.
      const params = isRecord(request.params) ? request.params : {};
      const asked = params["protocolVersion"];
      const protocolVersion =
        typeof asked === "string" && LEGACY_PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : DEFAULT_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case "server/discover": {
      // Mandatory from `2026-07-28` on. It is also the request a client sends
      // first to find out which era it is talking to, so it has to answer
      // before anything else about this server is known.
      if (isNotification) return undefined;
      const refusal = refuseModern(id, request.params);
      if (refusal !== undefined) return refusal;
      return ok(id, {
        supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
        capabilities: CAPABILITIES,
        instructions: INSTRUCTIONS,
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;

    case "ping": {
      const refusal = refuseIfModern(id, request.params);
      if (refusal !== undefined) return refusal;
      return ok(id, {});
    }

    case "tools/list": {
      const refusal = refuseIfModern(id, request.params);
      if (refusal !== undefined) return refusal;
      return ok(id, { tools: TOOLS });
    }

    case "tools/call": {
      const refusal = refuseIfModern(id, request.params);
      if (refusal !== undefined) return refusal;
      const params = isRecord(request.params) ? request.params : {};
      const name = params["name"];
      if (typeof name !== "string") {
        return fail(id, INVALID_REQUEST, "tools/call needs a tool name");
      }
      try {
        const result = callTool(name, params["arguments"], store, now);
        return ok(id, result);
      } catch (error) {
        if (error instanceof HandoverNotFoundError) {
          return ok(id, {
            content: [
              {
                type: "text",
                text: `${error.message}. Call soil_list to see what is stored.`,
              },
            ],
            isError: true,
          });
        }
        return fail(id, INTERNAL_ERROR, (error as Error).message);
      }
    }

    default:
      if (isNotification) return undefined;
      return fail(id, METHOD_NOT_FOUND, `unknown method: ${request.method}`);
  }
}

/** Read newline-delimited JSON-RPC from stdin and answer on stdout. */
export function serveStdio(
  store: HandoverStore = new HandoverStore(resolveStoreHome()),
): void {
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        let response: JsonRpcResponse | undefined;
        try {
          response = handleMessage(JSON.parse(line), store);
        } catch (error) {
          response = fail(null, INVALID_REQUEST, (error as Error).message);
        }
        if (response !== undefined) {
          process.stdout.write(`${JSON.stringify(response)}\n`);
        }
      }
      newline = buffer.indexOf("\n");
    }
  });

  process.stdin.on("end", () => {
    // End of input means no further request can arrive, so the server is
    // done. It must not call process.exit here.
    //
    // On a pipe, stdout is asynchronous: a write is queued and handed to the
    // kernel later. process.exit tears the process down at once and discards
    // whatever is still queued, so a reply larger than the operating system's
    // pipe buffer arrives cut mid-line and the client cannot parse it. The
    // tools listing is the everyday case, because it is the largest thing
    // this server writes. Redirecting stdout to a file hid the defect,
    // because writes to a regular file are synchronous on POSIX and there is
    // never a queue to discard.
    //
    // Setting the exit code and returning lets the event loop run dry
    // instead. Node's own shutdown path flushes the pending writes first, and
    // stdin is the only thing holding the loop open, so the process still
    // ends on its own once the last byte is out. The exit is later than
    // process.exit made it, by exactly the time the client needs to read what
    // it asked for.
    process.exitCode = 0;
  });
}
