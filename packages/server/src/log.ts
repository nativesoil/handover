/**
 * Request logging, and the beginning of an audit trail.
 *
 * Before this, the server printed two lines at startup and then nothing, ever,
 * including on failure. An operator running it for a team had no way to answer
 * "who saved that", "when did this start failing", or "is anyone even using
 * it", and learned about every problem from a person complaining.
 *
 * One line per request, JSON, to stdout, so the usual tools (`jq`, a log
 * shipper, a file) work without a format of our own.
 *
 * ## What is deliberately not in a line
 *
 * - **No token.** Not the token, not a prefix of it, not its hash. A log that
 *   carries a hash is a log that carries a credential-equivalent, because the
 *   registry authenticates by comparing exactly that hash.
 * - **No handover content.** Not a section, not a title, not a summary. The
 *   whole point of the format is that a handover is a project's real working
 *   state, which means it is the most sensitive thing on the disk. A load code,
 *   a project id and a section *count* say what happened without saying what it
 *   said.
 * - **No absolute paths.** The same rule the format itself holds: a private
 *   path is not something that may travel.
 *
 * What a line does carry: when, which surface, what was attempted, who
 * attempted it (user id and username, both stable enough to follow across a
 * rename), which project or code was addressed, the outcome, and how long it
 * took.
 */

/** One logged event. Every field here is safe to keep. */
export interface LogEvent {
  /** `http` for a REST route, `mcp` for a JSON-RPC tool call. */
  readonly surface: "http" | "mcp" | "server";
  /** What was attempted: `GET /v1/handovers`, `soil_save`, `listening`. */
  readonly action: string;
  /** The caller's stable user id, or `null` before authentication. */
  readonly userId?: string | null;
  /** The caller's username at the time, for a human reading the log. */
  readonly username?: string | null;
  /** The project addressed, or `null` for a personal operation. */
  readonly project?: string | null;
  /** The load code addressed or issued, e.g. `#004`. Never content. */
  readonly code?: string | null;
  /** HTTP status, when there is one. */
  readonly status?: number;
  /** `ok`, `refused`, `not-found`, `unauthorized`, `busy`, `error`. */
  readonly outcome?: string;
  /** How many of the 17 sections carried content. A count, never the content. */
  readonly sections?: number;
  readonly durationMs?: number;
  /** A short, non-identifying note. Never an exception message. */
  readonly detail?: string;
}

/** Somewhere to put a line. */
export interface Logger {
  log(event: LogEvent): void;
}

/** A logger that drops everything, for tests that do not care. */
export const SILENT_LOGGER: Logger = { log: () => {} };

/**
 * Build a logger. `SOIL_SERVER_LOG=none` turns request logging off for an
 * operator who has their own opinion; anything else, including unset, logs.
 */
export function createLogger(
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  now: () => Date = () => new Date(),
): Logger {
  if (env["SOIL_SERVER_LOG"] === "none") return SILENT_LOGGER;
  return {
    log(event: LogEvent): void {
      const line: Record<string, unknown> = { ts: now().toISOString() };
      for (const [key, value] of Object.entries(event)) {
        if (value !== undefined) line[key] = value;
      }
      write(JSON.stringify(line));
    },
  };
}
