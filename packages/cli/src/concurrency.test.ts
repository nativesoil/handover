/**
 * Two `soil save` processes, one store.
 *
 * The server was made safe by wrapping its store call in a lock. That did not
 * fix the store: `HandoverStore.save` was itself an unlocked read-modify-write,
 * so the defect stayed reachable through the published tool. Two CLI processes
 * against one `~/.soil` reproduced it exactly — an agent running `soil save`
 * beside a person doing the same is two processes on one store.
 *
 * Measured on the unmerged base, four processes saving fifteen times each:
 * 60 saves acknowledged, 26 documents on disk, 34 acknowledgements for
 * documents that no longer existed. The store now takes the same lock the
 * server takes (`packages/sdk-ts/src/lock.ts`), and this file is what says so.
 *
 * The checks are the ones the server's own concurrency test makes, because it
 * is the same defect:
 *
 *   1. every save the CLI acknowledged is on disk afterwards
 *   2. no two acknowledgements carry the same load code
 *   3. every acknowledged code still holds the document that receipt named
 *
 * Nothing here identifies a writer by its process id. Markers are random ids
 * (see `test-workers/concurrent-save.mjs`): two containers on one volume both
 * run as pid 1, and a test that told writers apart by pid would agree with
 * itself for the wrong reason.
 *
 * Slow by the standards of the rest of this package, and the only test here
 * that can fail for a reason a reader would call "a race", so it gets its own
 * file.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { HandoverStore } from "@nativesoil/handover-sdk";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const repoRoot = join(packageRoot, "..", "..");
const worker = join(packageRoot, "test-workers", "concurrent-save.mjs");

/** One acknowledgement a worker process wrote down. */
interface Ack {
  readonly ok: boolean;
  readonly code?: string;
  readonly marker?: string;
  readonly stderr?: string;
}

/** How long the workers get before the test gives up on them. */
const WORKER_TIMEOUT_MS = 60_000;

/**
 * The workers run the built CLI, so the build has to be current. `tsc -b` is
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

/** Run N worker processes that all begin saving at the same instant. */
async function race(
  processes: number,
  perProcess: number,
  home: string,
  out: string,
  docDir: string,
): Promise<{ acks: Ack[]; exits: number[] }> {
  const startAt = String(Date.now() + 400);
  const exits = await Promise.all(
    Array.from(
      { length: processes },
      () =>
        new Promise<number>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [worker, home, startAt, String(perProcess), out, docDir],
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
  const acks = existsSync(out)
    ? readFileSync(out, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Ack)
    : [];
  return { acks, exits };
}

describe("two soil save processes on one store", () => {
  it(
    "loses nothing when four processes save into one store",
    { timeout: 120_000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), "soil-cli-concurrency-"));
      try {
        const store = join(home, "store");
        const docs = join(home, "docs");
        const out = join(home, "acks.jsonl");
        mkdirSync(store, { recursive: true });
        mkdirSync(docs, { recursive: true });

        const processes = 4;
        const perProcess = 15;
        const { acks, exits } = await race(
          processes,
          perProcess,
          store,
          out,
          docs,
        );
        expect(exits).toEqual(Array.from({ length: processes }, () => 0));
        expect(acks).toHaveLength(processes * perProcess);

        const acknowledged = acks.filter((ack) => ack.ok);

        // A save that was refused under contention is honest, and this store
        // is uncontended enough that none should be. Either way the invariant
        // below is about what was acknowledged, never about what was tried.
        const refused = acks.filter((ack) => !ack.ok);
        expect(refused.map((ack) => ack.stderr)).toEqual([]);
        expect(acknowledged).toHaveLength(processes * perProcess);

        const handoverStore = new HandoverStore(store);

        // 1. Nothing the CLI printed a code for may be missing afterwards.
        const onDisk = readdirSync(handoverStore.handoversDir).filter((file) =>
          file.endsWith(".json"),
        );
        expect(onDisk).toHaveLength(acknowledged.length);
        expect(handoverStore.list()).toHaveLength(acknowledged.length);

        // 2. No two receipts may carry the same load code.
        const codes = acknowledged.map((ack) => ack.code);
        expect(new Set(codes).size).toBe(codes.length);

        // 3. Every receipt's code must still hold the document it named.
        for (const ack of acknowledged) {
          expect(handoverStore.read(ack.code!).title).toBe(ack.marker);
        }

        // 4. No half-written temporary file survived the race.
        expect(onDisk.filter((file) => file.includes(".tmp-"))).toEqual([]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
