/**
 * The `soil` CLI.
 *
 * Two halves of one round trip:
 *
 *   soil save              prints the recipe you paste into your model
 *   soil save -            reads the model's JSON back and stores it
 *   soil load #004         prints the restore prompt you paste anywhere else
 *
 * Everything runs against `~/.soil`. No account, no network, no telemetry. The
 * command surface is deliberately small: a tool you use at the exact moment a
 * thread is dying should have nothing to learn.
 *
 * `run` takes its whole environment as an argument so tests drive the real
 * command paths without spawning a process or touching a real home directory.
 */

import { readFileSync } from "node:fs";

import {
  HandoverNotFoundError,
  HandoverStore,
  HandoverValidationError,
  IngestError,
  RESCUE_PROMPT,
  buildRestorePrompt,
  checkHandover,
  checkObservation,
  extractJsonBlock,
  ingestDocument,
  ingestText,
  normalizeHandover,
  uuidv7,
  renderCheck,
  renderList,
  renderLoaded,
  renderRecipe,
  renderSaved,
  renderValidation,
  resolveStoreHome,
  validateHandover,
  type Handover,
} from "@nativesoil/handover-sdk";

/**
 * Everything the CLI touches that is not an argument.
 *
 * The two input hooks hand back BYTES, not text. A raw document arriving on
 * stdin or from a file is bytes until the ingestion boundary has decided what
 * they are: decoding them here with `toString("utf8")` would replace an
 * undecodable byte with U+FFFD and strip nothing else, which is exactly the
 * silent repair the encoding rule forbids.
 */
export interface CliEnvironment {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly readStdin: () => Promise<Uint8Array>;
  readonly readFile: (path: string) => Uint8Array;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => Date;
  /**
   * How this CLI was actually invoked, for the one place that prints a
   * command back at the user to run next.
   *
   * Nothing on a from-source checkout puts a bare `soil` on the PATH. The
   * documented install is `pnpm install && pnpm build` followed by
   * `node packages/cli/bin/soil.js`, and the alias is offered as an option
   * the user may decline, so a hard-coded `soil save -` is an instruction
   * that fails for exactly the reader who most needs it to work. The real
   * invocation is derived in `defaultEnvironment` and echoed back verbatim.
   *
   * Optional so a caller that never prints the trailer, a test included, is
   * not forced to describe a process it did not spawn.
   */
  readonly invocation?: string;
}

/**
 * The command to tell the user to run, derived from how they reached us.
 *
 * An installed bin is on the PATH under its own name and is echoed bare. A
 * script path is not, so it is echoed the way it has to be typed.
 */
export function invocationFrom(scriptPath: string | undefined): string {
  if (scriptPath === undefined || scriptPath.length === 0) return "soil";
  const base = scriptPath.slice(scriptPath.lastIndexOf("/") + 1);
  return base === "soil" ? "soil" : `node ${scriptPath}`;
}

const HELP = `soil — save the project state, load it anywhere, see what survived.

USAGE
  soil save                     print the extraction recipe to paste into your model
  soil save -                   read the model's JSON reply on stdin and store it
  soil save <file.json>         store a handover from a file
  soil load [#NNN|last]         print the restore prompt for a stored handover
  soil list                     list what is stored
  soil validate <file|->        check a document against the spec
  soil check <#NNN|file|->      check and grade a handover with deterministic rules
  soil render <#NNN|file>       print the rail card for a handover
  soil rescue                   print the prompt for a dead or full thread
  soil where                    print the store location

OPTIONS
  --json                        with load/render/check: print the raw document or report
  --quiet                       with save: print only the load code
  --attach                      with check on a stored code: write the report onto the
                                handover as a quality.capture observation
  -h, --help                    this text, on its own or after any command
  -v, --version                 print the version

An option a command does not take is refused by name, never ignored.

The store is ~/.soil, or $SOIL_HOME when that is set. Nothing leaves the machine.
Saving records what your model wrote and counts the sections that carry content.
\`soil check\` grades the document with open deterministic rules (docs/checking.md);
whether a handover actually restores a session is answered only by a real load.
`;

const CLI_VERSION = "0.1.0";
const VERSION = `${CLI_VERSION} (spec 1.0)`;

/**
 * What each command takes, which is also what each command refuses.
 *
 * Every command used to strip anything option-shaped out of its arguments and
 * never look at it again, so a misspelled option and a correct one produced
 * the same success: `soil validate file.json --json` printed the human card
 * and exited 0, and a script that asked for machine output got a rail card
 * with nothing to tell it apart from one. An option nobody reads is worse than
 * an option nobody has.
 *
 * This table is the whole parser, and it is deliberately a table. There are
 * nine verbs and three options between them; a general parser would be a
 * larger thing to read than the surface it guards. Each list is exactly the
 * options that command's body reads, and the test suite walks the table
 * against every command, so a new option cannot be added to one without the
 * other.
 */
const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  save: ["--quiet"],
  load: ["--json"],
  list: [],
  ls: [],
  validate: [],
  check: ["--json", "--attach"],
  render: ["--json"],
  rescue: [],
  where: [],
};

/**
 * The two questions any command answers, because the usage text offers them
 * without qualification and a reader who has just read it types them where
 * they are standing.
 */
const HELP_OPTIONS: readonly string[] = ["-h", "--help"];
const VERSION_OPTIONS: readonly string[] = ["-v", "--version"];

/**
 * Option-shaped means it leads with a dash and is not the bare `-` that every
 * input path uses for stdin.
 */
function isOption(arg: string): boolean {
  return arg.startsWith("-") && arg !== "-";
}

/** The arguments a command reads as targets rather than as options. */
function positionalsIn(args: readonly string[]): readonly string[] {
  return args.filter((arg) => !isOption(arg));
}

/** `a`, `a and b`, `a, b and c`. */
function listInProse(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * What a developer sees the moment they mistype an option: the option that was
 * not understood, and what this command does take. Nothing else. They are at a
 * terminal mid-thought and the next thing they do is retype the line.
 */
function unknownOptionMessage(
  command: string,
  unknown: readonly string[],
  allowed: readonly string[],
): string {
  const named =
    unknown.length === 1
      ? `unknown option ${unknown[0]}`
      : `unknown options ${listInProse(unknown)}`;
  const takes =
    allowed.length === 0
      ? `soil ${command} takes no options`
      : `soil ${command} takes ${listInProse(allowed)}`;
  return `soil ${command}: ${named}\n${takes}\n`;
}

function defaultEnvironment(): CliEnvironment {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
    readFile: (path) => readFileSync(path),
    env: process.env,
    now: () => new Date(),
    invocation: invocationFrom(process.argv[1]),
  };
}

function storeFor(env: CliEnvironment): HandoverStore {
  return new HandoverStore(resolveStoreHome(env.env));
}

/**
 * Turn arbitrary text into a stored-ready handover: pull the JSON out of
 * whatever the model wrapped it in, normalize the loose shapes, then assign
 * identity. The CLI save path is a writer, so a document that arrives without
 * a `handoverId` gets a fresh UUIDv7 here; a document that already carries
 * one keeps it, because a copy keeps its identity.
 *
 * An id that is present but malformed is left exactly as it is. Minting a
 * fresh one over the top would replace an id the spec requires to be refused,
 * and nobody would ever be told the original was wrong.
 */
function parseCandidate(bytes: Uint8Array, now: Date): unknown {
  const normalized: unknown = normalizeHandover(ingestRawDocument(bytes));
  if (
    typeof normalized !== "object" ||
    normalized === null ||
    Array.isArray(normalized)
  ) {
    return normalized;
  }
  const document = normalized as Record<string, unknown>;
  return "handoverId" in document
    ? document
    : { ...document, handoverId: uuidv7(now) };
}

/**
 * The CLI's raw-document input path, in one place.
 *
 * Input arrives as bytes, often as a whole model reply with prose around the
 * JSON. The encoding rule is about the bytes, so it is applied to the whole
 * input first; the structural rules are about the document, so they are
 * applied to the block lifted out of it. Both halves are the same boundary,
 * and neither is skipped because the input happened to be a paste.
 */
function ingestRawDocument(bytes: Uint8Array): unknown {
  const whole = ingestDocument(bytes);
  if (!whole.ok) {
    // A prose reply is not a JSON document, so a syntax refusal here says
    // nothing: the encoding verdict is the part that binds on raw bytes.
    if (whole.issue.code !== "syntax.invalid_json") {
      throw new IngestError(whole.issue);
    }
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const json = extractJsonBlock(text);
  if (json === undefined) {
    throw new Error("no JSON found in the input");
  }
  const result = ingestText(json);
  if (!result.ok) throw new IngestError(result.issue);
  return result.value;
}

async function cmdSave(
  args: readonly string[],
  env: CliEnvironment,
): Promise<number> {
  const quiet = args.includes("--quiet");
  const positional = positionalsIn(args);
  const target = positional[0];

  if (target === undefined) {
    env.stdout(renderRecipe());
    env.stdout(
      `\nPaste that into the session you want to keep. When the model answers with the JSON block, run:\n\n  ${env.invocation ?? "soil"} save -\n\nand paste the reply.\n`,
    );
    return 0;
  }

  const bytes = target === "-" ? await env.readStdin() : env.readFile(target);

  let candidate: unknown;
  try {
    candidate = parseCandidate(bytes, env.now());
  } catch (error) {
    env.stderr(`soil save: ${(error as Error).message}\n`);
    return 1;
  }

  const result = validateHandover(candidate);
  if (!result.valid) {
    env.stderr(`${renderValidation(result, "the pasted document")}\n`);
    return 1;
  }

  const store = storeFor(env);
  const entry = store.save(candidate as never);
  if (quiet) {
    env.stdout(`${entry.code}\n`);
    return 0;
  }
  env.stdout(`${renderSaved(store.read(entry.code), entry.code)}\n`);
  return 0;
}

function cmdLoad(args: readonly string[], env: CliEnvironment): number {
  const positional = positionalsIn(args);
  const code = positional[0] ?? "last";
  const store = storeFor(env);

  const handover = store.read(code);
  if (args.includes("--json")) {
    env.stdout(`${JSON.stringify(handover, null, 2)}\n`);
    return 0;
  }
  env.stdout(`${renderLoaded(handover)}\n\n`);
  // Recorded working-style instances are part of the prompt the assembler
  // builds, not something printed after it: a block written outside the
  // assembler carries no marker, and a heading spelled inside a recorded
  // instance would then render as one.
  env.stdout(buildRestorePrompt(handover, { workingStyleEvidence: true }));
  return 0;
}

function cmdList(env: CliEnvironment): number {
  const store = storeFor(env);
  env.stdout(`${renderList(store.list())}\n`);
  return 0;
}

async function cmdValidate(
  args: readonly string[],
  env: CliEnvironment,
): Promise<number> {
  const target = positionalsIn(args)[0];
  if (target === undefined) {
    env.stderr("soil validate: give a file path, or - for stdin\n");
    return 2;
  }
  const bytes = target === "-" ? await env.readStdin() : env.readFile(target);
  let parsed: unknown;
  try {
    parsed = ingestRawDocument(bytes);
  } catch (error) {
    env.stderr(`soil validate: ${(error as Error).message}\n`);
    return 1;
  }
  const result = validateHandover(parsed);
  env.stdout(`${renderValidation(result, target)}\n`);
  return result.valid ? 0 : 1;
}

/**
 * `soil check`: the open save-time baseline. Deterministic rules over the
 * document itself, a grade band, exit 0 for strong or adequate and 1 for thin
 * or failing, so a script or a CI step can gate on it. `--attach` writes the
 * report onto the stored handover as a `quality.capture` observation through
 * the store's update path, which keeps the handoverId and the code unchanged.
 */
async function cmdCheck(
  args: readonly string[],
  env: CliEnvironment,
): Promise<number> {
  const attach = args.includes("--attach");
  const asJson = args.includes("--json");
  const target = positionalsIn(args)[0];
  if (target === undefined) {
    env.stderr("soil check: give a load code, a file path, or - for stdin\n");
    return 2;
  }

  const store = storeFor(env);
  const fromStore =
    target.startsWith("#") ||
    target.toLowerCase() === "last" ||
    /^\d+$/.test(target);

  let handover: Handover;
  if (fromStore) {
    handover = store.read(target);
  } else {
    const bytes = target === "-" ? await env.readStdin() : env.readFile(target);
    let candidate: unknown;
    try {
      candidate = parseCandidate(bytes, env.now());
    } catch (error) {
      env.stderr(`soil check: ${(error as Error).message}\n`);
      return 1;
    }
    const result = validateHandover(candidate);
    if (!result.valid) {
      env.stderr(`${renderValidation(result, target)}\n`);
      return 1;
    }
    handover = candidate as Handover;
  }

  const report = checkHandover(handover);

  if (attach) {
    if (!fromStore || handover.code === undefined) {
      env.stderr(
        "soil check: --attach needs a stored handover, give its load code\n",
      );
      return 2;
    }
    const observation = checkObservation(handover, report, {
      producedBy: `soil-cli/${CLI_VERSION}`,
      producedAt: env.now().toISOString(),
    });
    store.update(handover.code, {
      ...handover,
      observations: [...(handover.observations ?? []), observation],
    });
  }

  if (asJson) {
    env.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    env.stdout(`${renderCheck(handover, report)}\n`);
    if (attach) {
      env.stdout(
        `\n  report attached to ${handover.code} as a quality.capture observation\n`,
      );
    }
  }
  return report.grade === "strong" || report.grade === "adequate" ? 0 : 1;
}

function cmdRender(args: readonly string[], env: CliEnvironment): number {
  const target = positionalsIn(args)[0];
  if (target === undefined) {
    env.stderr("soil render: give a load code or a file path\n");
    return 2;
  }
  const store = storeFor(env);
  const handover = target.startsWith("#")
    ? store.read(target)
    : (ingestRawDocument(env.readFile(target)) as never);

  if (args.includes("--json")) {
    env.stdout(`${JSON.stringify(handover, null, 2)}\n`);
    return 0;
  }
  const result = validateHandover(handover);
  if (!result.valid) {
    env.stdout(`${renderValidation(result, target)}\n`);
    return 1;
  }
  env.stdout(`${renderLoaded(handover)}\n`);
  return 0;
}

/** Run one command. Returns the process exit code. */
export async function run(
  argv: readonly string[],
  environment: CliEnvironment = defaultEnvironment(),
): Promise<number> {
  const [command, ...args] = argv;

  if (
    command === undefined ||
    command === "-h" ||
    command === "--help" ||
    command === "help"
  ) {
    environment.stdout(HELP);
    return 0;
  }
  if (command === "-v" || command === "--version" || command === "version") {
    environment.stdout(`${VERSION}\n`);
    return 0;
  }

  // One gate, in front of every command, because the commands that took no
  // arguments at all were the ones swallowing them most quietly. An unknown
  // command falls through untouched: its own answer is the help text, and it
  // is not improved by first being told which options it does not take.
  const allowed = COMMAND_OPTIONS[command];
  if (allowed !== undefined) {
    if (args.some((arg) => HELP_OPTIONS.includes(arg))) {
      environment.stdout(HELP);
      return 0;
    }
    if (args.some((arg) => VERSION_OPTIONS.includes(arg))) {
      environment.stdout(`${VERSION}\n`);
      return 0;
    }
    const unknown = args.filter(
      (arg) => isOption(arg) && !allowed.includes(arg),
    );
    if (unknown.length > 0) {
      environment.stderr(unknownOptionMessage(command, unknown, allowed));
      return 2;
    }
  }

  try {
    switch (command) {
      case "save":
        return await cmdSave(args, environment);
      case "load":
        return cmdLoad(args, environment);
      case "list":
      case "ls":
        return cmdList(environment);
      case "validate":
        return await cmdValidate(args, environment);
      case "check":
        return await cmdCheck(args, environment);
      case "render":
        return cmdRender(args, environment);
      case "rescue":
        environment.stdout(`${RESCUE_PROMPT}\n`);
        return 0;
      case "where":
        environment.stdout(`${resolveStoreHome(environment.env)}\n`);
        return 0;
      default:
        environment.stderr(`soil: unknown command "${command}"\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof HandoverNotFoundError) {
      environment.stderr(
        `soil: ${error.message}. Run \`soil list\` to see what is stored.\n`,
      );
      return 1;
    }
    if (error instanceof HandoverValidationError) {
      environment.stderr(`soil: ${error.message}\n`);
      return 1;
    }
    if (error instanceof IngestError) {
      environment.stderr(
        `soil: ${error.issue.code} at ${error.issue.path || "/"}: ${error.issue.message}\n`,
      );
      return 1;
    }
    environment.stderr(`soil: ${(error as Error).message}\n`);
    return 1;
  }
}

/** Entry point used by `bin/soil.js`. */
export async function main(argv: readonly string[]): Promise<number> {
  return run(argv);
}
