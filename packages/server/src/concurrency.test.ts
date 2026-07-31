/**
 * Two processes, one data directory.
 *
 * This is the file that decides whether the server can honestly be run by a
 * team. Every state change in the server is a read-modify-write: read
 * `index.json`, write the handover, write `index.json` back. Inside one process
 * that is safe by construction, because Node runs a synchronous handler to
 * completion. Across two processes on one volume, which is what two containers
 * or an operator running the admin CLI against a live server are, it is not
 * safe at all: both read the same index, both write a document at the same
 * code, and the second index write erases the first one's row.
 *
 * So these tests spawn real processes (see `test-workers/concurrent-writer.mjs`)
 * and check three things the audit measured going wrong:
 *
 *   1. every save the server acknowledged is on disk afterwards
 *   2. the load code in a receipt still holds the document that receipt named
 *   3. every token `user add` printed still authenticates
 *
 * They are slow by the standards of the rest of the suite. They are also the
 * only tests here that can fail for a reason a reader would call "a race", so
 * they get their own file and their own build step.
 */

import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { Registry } from "./registry.js";
import { ServerService } from "./service.js";
import { makeHome, removeHome, seedHome } from "./test-support.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const repoRoot = join(packageRoot, "..", "..");
const worker = join(packageRoot, "test-workers", "concurrent-writer.mjs");

/** One acknowledgement a worker process wrote down. */
interface Ack {
  readonly ok: boolean;
  readonly code?: string;
  readonly marker?: string;
  readonly username?: string;
  readonly token?: string;
  readonly threw?: string;
}

/** How long the workers get before the test gives up on them. */
const WORKER_TIMEOUT_MS = 60_000;

/**
 * The workers run the built server, so the build has to be current. `tsc -b` is
 * incremental and costs about a tenth of a second when nothing changed.
 *
 * The compiler is reached through Node's own module resolution and run with the
 * Node already running this test, never through `node_modules/.bin/tsc`. That
 * path is a launcher a package manager writes for a shell: on Unix it is a
 * `#!/bin/sh` script with the exec bit, and on Windows the runnable artefact is
 * a sibling `.cmd`, so the extensionless name has no executable image to start
 * and `spawnSync` answers ENOENT. Resolving the compiler's declared entry point
 * asks the same question the shell launcher exists to answer, and gets a real
 * file back on every platform.
 */
const tscEntryPoint = createRequire(import.meta.url).resolve(
  "typescript/bin/tsc",
);

beforeAll(() => {
  execFileSync(
    process.execPath,
    [tscEntryPoint, "-b", join(packageRoot, "tsconfig.json")],
    { cwd: repoRoot, stdio: "pipe" },
  );
}, 120_000);

/**
 * Run N worker processes that all begin writing at the same instant, and hand
 * back every acknowledgement they collected plus every exit code.
 */
async function race(
  args: readonly (readonly string[])[],
  outPath: string,
): Promise<{ acks: Ack[]; exits: number[] }> {
  const startAt = String(Date.now() + 400);
  const exits = await Promise.all(
    args.map(
      (argv) =>
        new Promise<number>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [worker, argv[0]!, argv[1]!, startAt, ...argv.slice(2)],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("a worker process did not finish in time"));
          }, WORKER_TIMEOUT_MS);
          let stderr = "";
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          child.on("error", reject);
          child.on("exit", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
              // Not only when there is something on stderr. A worker that
              // failed before it could print leaves stderr empty, and waiting
              // for output before calling that a failure is how a broken
              // worker gets reported as a mismatched exit status pages later.
              const said = stderr.length > 0 ? `: ${stderr}` : "";
              reject(new Error(`worker failed (${String(code)})${said}`));
              return;
            }
            resolve(code);
          });
        }),
    ),
  );
  const acks = existsSync(outPath)
    ? readFileSync(outPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Ack)
    : [];
  return { acks, exits };
}

describe("two processes on one store", () => {
  it(
    "loses nothing when four processes save into one personal store",
    { timeout: 120_000 },
    async () => {
      const home = makeHome();
      try {
        const tokens = seedHome(home);
        const out = join(home, "acks.jsonl");
        const perProcess = 15;
        const processes = 4;

        const { acks, exits } = await race(
          Array.from({ length: processes }, () => [
            "save",
            home,
            String(perProcess),
            out,
            tokens.alice,
            "-",
          ]),
          out,
        );
        expect(exits).toEqual(Array.from({ length: processes }, () => 0));

        const acknowledged = acks.filter((ack) => ack.ok);
        expect(acknowledged).toHaveLength(perProcess * processes);

        const service = new ServerService(home);
        const caller = service.registry.authenticate(tokens.alice);
        expect(caller).toBeDefined();
        const store = service.personalStore(caller!);

        // 1. Nothing the server said "saved" to may be missing afterwards.
        const onDisk = readdirSync(store.handoversDir).filter((file) =>
          file.endsWith(".json"),
        );
        expect(onDisk).toHaveLength(acknowledged.length);
        expect(store.list()).toHaveLength(acknowledged.length);

        // 2. No two receipts may carry the same load code.
        const codes = acknowledged.map((ack) => ack.code);
        expect(new Set(codes).size).toBe(codes.length);

        // 3. Every receipt's code must still hold the document it named.
        for (const ack of acknowledged) {
          expect(store.read(ack.code!).title).toBe(ack.marker);
        }
      } finally {
        removeHome(home);
      }
    },
  );

  it(
    "never hands one member's code to another in a shared project",
    { timeout: 120_000 },
    async () => {
      const home = makeHome();
      try {
        const tokens = seedHome(home);
        const out = join(home, "acks.jsonl");
        const perProcess = 10;

        const { acks, exits } = await race(
          [
            ["save", home, String(perProcess), out, tokens.alice, "team-x"],
            ["save", home, String(perProcess), out, tokens.bob, "team-x"],
            ["save", home, String(perProcess), out, tokens.alice, "team-x"],
            ["save", home, String(perProcess), out, tokens.bob, "team-x"],
          ],
          out,
        );
        expect(exits).toEqual([0, 0, 0, 0]);

        const acknowledged = acks.filter((ack) => ack.ok);
        expect(acknowledged).toHaveLength(perProcess * 4);

        const service = new ServerService(home);
        const alice = service.registry.authenticate(tokens.alice)!;
        const store = service.projectStore(alice, "team-x");

        expect(
          readdirSync(store.handoversDir).filter((file) =>
            file.endsWith(".json"),
          ),
        ).toHaveLength(acknowledged.length);

        const codes = acknowledged.map((ack) => ack.code);
        expect(new Set(codes).size).toBe(codes.length);

        // The marker carries the writing process's random worker id, so a code
        // that comes back holding another marker is a receipt pointing at
        // somebody else's document. The id is random and not a pid: two
        // containers on one volume both run as pid 1.
        for (const ack of acknowledged) {
          expect(store.read(ack.code!).title).toBe(ack.marker);
        }
      } finally {
        removeHome(home);
      }
    },
  );

  it(
    "keeps every user eight concurrent processes created",
    { timeout: 120_000 },
    async () => {
      const home = makeHome();
      try {
        new Registry(home).init();
        const out = join(home, "acks.jsonl");
        const processes = 8;

        const { acks, exits } = await race(
          Array.from({ length: processes }, (_unused, index) => [
            "adduser",
            home,
            "1",
            out,
            `worker${index}user`,
          ]),
          out,
        );
        expect(exits).toEqual(Array.from({ length: processes }, () => 0));

        const created = acks.filter((ack) => ack.ok);
        expect(created).toHaveLength(processes);

        const registry = new Registry(home);
        // Every token the CLI printed has to still authenticate. A token that
        // was acknowledged and then erased by another process is a person who
        // was told they have an account and does not.
        for (const ack of created) {
          expect(registry.authenticate(ack.token!)).toBeDefined();
        }
        expect(
          registry
            .listUsers()
            .map((user) => user.username)
            .sort(),
        ).toEqual(created.map((ack) => ack.username).sort());
      } finally {
        removeHome(home);
      }
    },
  );
});
