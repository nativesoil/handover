/**
 * @nativesoil/handover-server
 *
 * The self-hostable single-node reference server for the Soil Handover
 * Specification: bearer-token users, shared projects, an HTTP API and an MCP
 * endpoint, all over the same plain-file stores the local tools use. One
 * machine, several people, and the operator owns every byte.
 *
 * Everything real is re-used from `@nativesoil/handover-sdk`: validation, the
 * fail-closed secret scan, identity, the store layout, the restore prompt.
 * This package adds users, projects, membership, and two wire surfaces.
 *
 * See `docs/server.md` for the five-minute setup and the security posture.
 */

export { resolveServerHome } from "./home.js";

/**
 * The single-writer lock, re-exported from the SDK.
 *
 * It used to live in this package. It now lives in `@nativesoil/handover-sdk`,
 * because the same read-modify-write it guards here is in `HandoverStore`,
 * which the CLI uses too; one mechanism serves both. Re-exported so a caller
 * that catches {@link LockBusyError} from this package keeps working.
 */
export {
  DEFAULT_STALE_MS,
  DEFAULT_TIMEOUT_MS,
  LockBusyError,
  withLock,
  type LockOptions,
} from "@nativesoil/handover-sdk";

export {
  SILENT_LOGGER,
  createLogger,
  type LogEvent,
  type Logger,
} from "./log.js";

export {
  INGEST_LIMITS,
  ingestRequestBody,
  type IngestOutcome,
} from "./ingest.js";

export {
  PROJECT_ID_PATTERN,
  REGISTRY_VERSION,
  Registry,
  RegistryError,
  RegistryVersionError,
  USERNAME_PATTERN,
  USER_ID_PATTERN,
  hashToken,
  mintToken,
  type ProjectRecord,
  type UserRecord,
} from "./registry.js";

export {
  NotVisibleError,
  ServerService,
  type ListedHandover,
  type SaveRefusal,
  type SaveSuccess,
} from "./service.js";

export {
  handleRequest,
  isAllowedOrigin,
  startServer,
  type StartOptions,
} from "./http.js";

export {
  SERVER_TOOLS,
  callServerTool,
  checkMirroredHeaders,
  handleMcpMessage,
  httpStatusForResponse,
  METHOD_HEADER,
  NAME_HEADER,
  PROTOCOL_VERSION_HEADER,
  type MirroredHeaders,
  type ToolDefinition,
  type ToolResult,
} from "./mcp.js";

export { runCli } from "./cli.js";
