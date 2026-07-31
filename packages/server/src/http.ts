/**
 * The HTTP layer: bearer auth, routing, JSON in and out.
 *
 * Every route lives under `/v1` and every route requires a bearer token. The
 * server binds 127.0.0.1 unless told otherwise; putting it on a network is a
 * deliberate act, and the operator who does it should put TLS in front
 * (see `docs/server.md`).
 *
 * Error shapes are boring on purpose: `403 {"error":"forbidden origin"}` for a
 * browser origin the operator has not vouched for, `401 {"error":"unauthorized"}`
 * for a missing or wrong token, `404 {"error":"not found: ..."}` for anything the
 * caller cannot see, whether it exists or not, `422` with the validation issues
 * when a save is refused, and `503` with `Retry-After` when another process
 * holds the store lock. A refused save writes nothing, and so does a busy one.
 *
 * The MCP endpoint carries the JSON-RPC error as the body of a failure, and the
 * status that goes with it is `mcp.ts`'s to say: one status per error code, not
 * one per class of error, because the transport names them one at a time and
 * they are not all the same. That table is also where a `500` comes from, for
 * the one error in it that is this server's fault rather than the caller's. The
 * era a message is read under is decided there too.
 *
 * Request bodies never reach `JSON.parse` here. They go through
 * `ingest.ts`, which is the one door bytes come through on this surface; that
 * file says exactly where the shared boundary plugs in.
 *
 * Every request is logged, once, on the way out. See `log.ts` for what a line
 * may and may not carry.
 */

import {
  LockBusyError,
  checkHandover,
  type LockOptions,
} from "@nativesoil/handover-sdk";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { ingestRequestBody, INGEST_LIMITS } from "./ingest.js";
import { createLogger, type Logger } from "./log.js";
import {
  checkMirroredHeaders,
  handleMcpMessage,
  httpStatusForResponse,
  METHOD_HEADER,
  NAME_HEADER,
  PROTOCOL_VERSION_HEADER,
  type JsonRpcResponse,
} from "./mcp.js";
import { RegistryError } from "./registry.js";
import { NotVisibleError, ServerService } from "./service.js";

/** The largest request body the server will read, in bytes. */
const MAX_BODY_BYTES = INGEST_LIMITS.maxBytes;

interface JsonReply {
  readonly status: number;
  readonly body: unknown;
  /** Extra response headers, e.g. `Retry-After`. */
  readonly headers?: Record<string, string>;
  /** What to write in the log line for this reply. */
  readonly logged?: {
    readonly outcome: string;
    readonly project?: string | null;
    readonly code?: string | null;
    readonly sections?: number;
    readonly detail?: string;
  };
}

function reply(
  status: number,
  body: unknown,
  extra: Omit<JsonReply, "status" | "body"> = {},
): JsonReply {
  return { status, body, ...extra };
}

function send(res: ServerResponse, out: JsonReply): void {
  const payload =
    out.body === undefined ? "" : `${JSON.stringify(out.body, null, 2)}\n`;
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
    ...(out.headers ?? {}),
  };
  if (out.status === 401) {
    headers["www-authenticate"] = "Bearer";
  }
  res.writeHead(out.status, headers);
  res.end(payload);
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/** Read the body as bytes. Nothing decodes it here; `ingest.ts` does that. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

class BodyTooLargeError extends Error {
  constructor() {
    super(`the request body is larger than ${MAX_BODY_BYTES} bytes`);
    this.name = "BodyTooLargeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The hosts a page may be served from and still be treated as the operator's own.
 *
 * This is the whole default trust set, and it is this short because of what the
 * rule is for. A page on some other machine cannot cause a browser to send one of
 * these: the value comes from where the page was loaded from, not from where it is
 * sending to, so a site that points its own name at `127.0.0.1` still sends its
 * own name. Making the loopback names the default therefore costs nothing and
 * keeps a locally served page working, while every other value is a page that
 * arrived from somewhere else.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Whether an `Origin` value is one this server answers.
 *
 * An operator entry matches on scheme, host and port, all three, and the scheme
 * and host case-insensitively because that is how they compare. A loopback host
 * matches on any scheme and any port, because a page served from this machine is
 * already on this machine and the port it happens to sit on says nothing more.
 *
 * A value that is not a URL at all never matches. `Origin: null` is the ordinary
 * way that happens: a sandboxed frame, a redirect that dropped the origin, or a
 * page loaded from a file. It is an opaque origin, which is exactly a caller
 * that cannot show where it came from.
 */
export function isAllowedOrigin(
  origin: string,
  allowed: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    return true;
  }
  return allowed.some((candidate) => {
    try {
      const other = new URL(candidate);
      return (
        other.protocol === parsed.protocol &&
        other.hostname.toLowerCase() === parsed.hostname.toLowerCase() &&
        other.port === parsed.port
      );
    } catch {
      return false;
    }
  });
}

/**
 * Pull the handover document and the optional project out of a POST body.
 * The body is either `{"handover": {...}, "project": "id"}` or, leniently,
 * a bare handover document with no project.
 */
function parseSaveBody(parsed: unknown): {
  document: unknown;
  project: string | undefined;
} {
  if (isRecord(parsed) && "handover" in parsed) {
    const project = parsed["project"];
    return {
      document: parsed["handover"],
      project:
        typeof project === "string" && project.trim().length > 0
          ? project.trim()
          : undefined,
    };
  }
  return { document: parsed, project: undefined };
}

/** Handle one request against one service. Exported for the tests. */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: ServerService,
  logger: Logger = createLogger(),
  allowedOrigins: readonly string[] = [],
): Promise<void> {
  const started = Date.now();
  const action = `${req.method ?? "GET"} ${new URL(req.url ?? "/", "http://localhost").pathname}`;
  let out: JsonReply;
  let who: { userId: string | null; username: string | null } = {
    userId: null,
    username: null,
  };
  try {
    const routed = await route(
      req,
      service,
      logger,
      allowedOrigins,
      (identified) => {
        who = identified;
      },
    );
    out = routed;
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      out = reply(
        413,
        { error: error.message },
        { logged: { outcome: "refused" } },
      );
    } else if (error instanceof LockBusyError) {
      out = busyReply(error);
    } else {
      // The message is never sent. An exception here has been observed to carry
      // an absolute path, and a private path is not something that travels.
      out = reply(
        500,
        { error: "internal error" },
        { logged: { outcome: "error", detail: (error as Error).name } },
      );
    }
  }
  send(res, out);
  logger.log({
    surface: action.endsWith("/v1/mcp") ? "mcp" : "http",
    action,
    userId: who.userId,
    username: who.username,
    status: out.status,
    outcome: out.logged?.outcome ?? (out.status < 400 ? "ok" : "error"),
    ...(out.logged?.project === undefined
      ? {}
      : { project: out.logged.project }),
    ...(out.logged?.code === undefined ? {} : { code: out.logged.code }),
    ...(out.logged?.sections === undefined
      ? {}
      : { sections: out.logged.sections }),
    ...(out.logged?.detail === undefined ? {} : { detail: out.logged.detail }),
    durationMs: Date.now() - started,
  });
}

/** The one place a busy lock becomes a wire answer. */
function busyReply(error: LockBusyError): JsonReply {
  return reply(
    503,
    {
      error:
        "the server is busy writing; nothing was stored. Try the same request again.",
    },
    {
      headers: { "retry-after": "1" },
      logged: { outcome: "busy", detail: error.lockName },
    },
  );
}

async function route(
  req: IncomingMessage,
  service: ServerService,
  logger: Logger,
  allowedOrigins: readonly string[],
  identify: (who: { userId: string | null; username: string | null }) => void,
): Promise<JsonReply> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  // Before the token, because this is not a question about who is calling. A
  // request that carries an `Origin` this server does not answer was sent by a
  // page in somebody's browser, and the point of the check is that the page never
  // gets to act, whatever credential it managed to attach.
  //
  // The check covers every route rather than the MCP endpoint alone. The attack
  // it is named for does not care which path it posts to, and the routes that
  // write files are on the same listener; guarding one path and leaving the save
  // route open would be a guard in name only.
  //
  // Nothing here is a CORS implementation, and no allow-origin header is ever
  // sent. This is the server refusing to act, not the browser being told what it
  // may read.
  const origin = req.headers.origin;
  if (typeof origin === "string" && !isAllowedOrigin(origin, allowedOrigins)) {
    return reply(
      403,
      { error: "forbidden origin" },
      { logged: { outcome: "forbidden" } },
    );
  }

  const token = bearerToken(req);
  const user = token === undefined ? undefined : service.registry.lookup(token);
  if (user === undefined) {
    return reply(
      401,
      { error: "unauthorized" },
      { logged: { outcome: "unauthorized" } },
    );
  }
  identify({ userId: user.userId, username: user.username });

  try {
    return await routeAuthed(method, url, req, service, user.userId, logger);
  } catch (error) {
    if (error instanceof NotVisibleError) {
      return reply(
        404,
        { error: error.message },
        { logged: { outcome: "not-found" } },
      );
    }
    if (error instanceof LockBusyError) {
      return busyReply(error);
    }
    if (error instanceof RegistryError) {
      // The operator's problem, not the caller's: say nothing specific on the
      // wire, and put the reason in the log where the operator will find it.
      return reply(
        500,
        { error: "internal error" },
        { logged: { outcome: "error", detail: error.name } },
      );
    }
    throw error;
  }
}

async function routeAuthed(
  method: string,
  url: URL,
  req: IncomingMessage,
  service: ServerService,
  caller: string,
  logger: Logger,
): Promise<JsonReply> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const projectParam = url.searchParams.get("project") ?? undefined;

  if (path === "/v1/projects" && method === "GET") {
    return reply(200, {
      projects: service.memberships(caller).map((project) => ({
        id: project.id,
        name: project.name,
        members: service.registry.memberNames(project),
      })),
    });
  }

  if (path === "/v1/handovers" && method === "GET") {
    return reply(
      200,
      { handovers: service.list(caller, projectParam) },
      { logged: { outcome: "ok", project: projectParam ?? null } },
    );
  }

  if (path === "/v1/handovers" && method === "POST") {
    const parsed = ingestRequestBody(await readBody(req));
    if (!parsed.ok) return refusedBody(parsed.code, parsed.message);
    const { document, project } = parseSaveBody(parsed.value);
    const outcome = service.save(caller, document, project ?? projectParam);
    if (!outcome.ok) {
      return reply(
        422,
        {
          error: "the handover was refused; nothing was stored",
          issues: outcome.issues,
        },
        {
          logged: {
            outcome: "refused",
            project: project ?? projectParam ?? null,
          },
        },
      );
    }
    const counts = service.counts(outcome.handover);
    // The open deterministic document check, run on what was just stored,
    // reported in the receipt in the same vocabulary the local save prints:
    // the grade band and the problem, caution and advice counts. Report only:
    // the grade never touches the status code, because an honest gap never
    // blocks a save, and nothing from it is written onto the handover.
    const report = checkHandover(outcome.handover);
    return reply(
      201,
      {
        code: outcome.entry.code,
        project: outcome.project,
        handoverId: outcome.handover.handoverId,
        projectId: outcome.entry.projectId,
        title: outcome.entry.title,
        createdAt: outcome.entry.createdAt,
        sections: counts,
        check: {
          grade: report.grade,
          problems: report.counts.problems,
          cautions: report.counts.cautions,
          advice: report.counts.advice,
        },
      },
      {
        logged: {
          outcome: "ok",
          project: outcome.project,
          code: outcome.entry.code,
          sections: counts.withContent,
        },
      },
    );
  }

  const loadMatch = /^\/v1\/handovers\/([^/]+)$/.exec(path);
  if (loadMatch?.[1] !== undefined && method === "GET") {
    const code = decodeURIComponent(loadMatch[1]);
    const { handover, restorePrompt } = service.load(
      caller,
      code,
      projectParam,
    );
    return reply(
      200,
      { handover, restorePrompt },
      {
        logged: {
          outcome: "ok",
          project: projectParam ?? null,
          code: handover.code ?? code,
        },
      },
    );
  }

  if (path === "/v1/mcp" && method === "POST") {
    const parsed = ingestRequestBody(await readBody(req));
    if (!parsed.ok) return refusedBody(parsed.code, parsed.message);
    const mismatch = checkMirroredHeaders(parsed.value, {
      [PROTOCOL_VERSION_HEADER]: req.headers[PROTOCOL_VERSION_HEADER],
      [METHOD_HEADER]: req.headers[METHOD_HEADER],
      [NAME_HEADER]: req.headers[NAME_HEADER],
    });
    if (mismatch !== undefined) {
      return jsonRpcFailure(mismatch, httpStatusForResponse(mismatch));
    }
    const response = handleMcpMessage(
      parsed.value,
      service,
      caller,
      undefined,
      logger,
    );
    if (response === undefined) {
      // A notification gets no JSON-RPC reply; acknowledge receipt only.
      return reply(202, undefined);
    }
    const status = httpStatusForResponse(response);
    if (status !== 200) return jsonRpcFailure(response, status);
    return reply(200, response);
  }

  if (path === "/v1/mcp") {
    // No SSE stream and no server-initiated messages on this endpoint.
    return reply(405, {
      error: "this MCP endpoint answers POSTed JSON-RPC only",
    });
  }

  return reply(
    404,
    { error: "not found" },
    { logged: { outcome: "not-found" } },
  );
}

function refusedBody(code: string, message: string): JsonReply {
  return reply(
    400,
    { error: message, code },
    { logged: { outcome: "refused", detail: code } },
  );
}

/**
 * A JSON-RPC message this endpoint answered with an error rather than a result:
 * it named a version the endpoint will not speak, left out a field its revision
 * requires, carried a mirrored header that disagreed with its own body, named a
 * method that is not implemented, was not a JSON-RPC request at all, or was a
 * request this server then failed to complete.
 *
 * The status is part of the answer, not decoration, and it comes in from
 * `mcp.ts` because it belongs to the error code rather than to this function. A
 * client that has to work out which kind of server it reached reads the status
 * first and the body second, and one status for every error would flatten
 * distinctions the client is reading them for.
 *
 * The log line follows the status rather than guessing: everything in the `4xx`
 * range is the message being refused, and a `5xx` is this server failing, which
 * is a different thing for an operator reading back through a day.
 */
function jsonRpcFailure(response: JsonRpcResponse, status: number): JsonReply {
  return reply(status, response, {
    logged: {
      outcome: status >= 500 ? "error" : "refused",
      detail: String(response.error?.code),
    },
  });
}

/** Options for {@link startServer}. */
export interface StartOptions {
  /** The server data root. */
  readonly home: string;
  /** Port to listen on. `0` picks an ephemeral one. */
  readonly port: number;
  /** Interface to bind. Defaults to 127.0.0.1: localhost only. */
  readonly host?: string;
  /** Where request lines go. Defaults to JSON on stdout. */
  readonly logger?: Logger;
  /** How long a write waits for the store lock. Tests shorten it. */
  readonly lockOptions?: LockOptions;
  /**
   * Browser origins the operator vouches for, beyond the loopback ones that are
   * always answered. Each is a scheme, host and port, e.g.
   * `https://handovers.example`. Empty by default: a caller that is not a browser
   * sends no `Origin` at all and needs nothing here.
   */
  readonly allowedOrigins?: readonly string[];
}

/** Start the HTTP server. Resolves once it is listening. */
export function startServer(
  options: StartOptions,
): Promise<{ server: Server; port: number; host: string }> {
  const host = options.host ?? "127.0.0.1";
  const logger = options.logger ?? createLogger();
  const service = new ServerService(options.home, options.lockOptions ?? {});
  const allowedOrigins = options.allowedOrigins ?? [];
  const server = createServer((req, res) => {
    void handleRequest(req, res, service, logger, allowedOrigins);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null
          ? address.port
          : options.port;
      resolve({ server, port, host });
    });
  });
}
