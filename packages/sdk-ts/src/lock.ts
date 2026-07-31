/**
 * The single-writer guarantee.
 *
 * Every state change that touches a store is a read-modify-write: read
 * `index.json`, write a document, write `index.json` back; read `users.json`,
 * append a row, write it back. Inside one process that is safe by construction,
 * because Node runs a synchronous handler to completion and nothing
 * interleaves. Across two processes on one directory it is not safe at all, and
 * the failure is silent: both processes read the same index, both write a
 * document at the same load code, and the second index write erases the first
 * one's row. Both callers were told "saved".
 *
 * Two processes on one directory is not a hypothetical. It is two containers on
 * one volume; it is the operator running `soil-server user add` on a machine
 * that is also serving; and it is two `soil save` invocations against one
 * `~/.soil`, which is an agent running the CLI beside a person doing the same.
 *
 * This module is one mechanism used by two surfaces. `HandoverStore` in
 * `store.ts` takes it around its own read-modify-writes, and the server takes
 * it around the wider sections it needs (a save plus the read-back that proves
 * the receipt, a registry append). Neither reimplements it.
 *
 * ## The mechanism
 *
 * An advisory lock directory, taken with `mkdir`. `mkdir` either creates the
 * directory or fails with `EEXIST`, in one indivisible step, on every
 * filesystem this code can run on including NFS, where `O_EXCL` on a plain
 * file historically could not be trusted. No dependency: the alternative
 * considered was `proper-lockfile`, which is well made and does the same thing
 * with the same primitive, and was rejected because this is thirty lines and
 * neither package has a runtime dependency today.
 *
 * A `holder.json` inside the directory records who holds it. The holder id is
 * random, never a process id. Two containers that both run as pid 1 must not be
 * able to look like each other; that also rules out any "is that pid alive"
 * stale check, which would be wrong across containers anyway.
 *
 * ## What happens when the lock cannot be taken
 *
 * The write is refused. Nothing is written and nothing is half-written: the
 * caller gets {@link LockBusyError}, which the HTTP surface answers as `503`
 * with `Retry-After: 1`, the MCP surface answers as a plain "busy, try again"
 * tool error, and the CLI reports on stderr with a non-zero exit status. A
 * refusal a caller can retry is the honest outcome; the thing that must never
 * happen is an acknowledgement for a write that did not survive.
 *
 * ## What it costs
 *
 * Waiting is synchronous and blocks this process's event loop. That is a
 * deliberate trade. In-process, the lock is never contended, because Node
 * cannot interleave two synchronous handlers, so a wait only ever happens when
 * *another process* holds the lock, and the held section is a few file writes.
 * The alternative, an async lock, would additionally need an in-process queue,
 * because two `await`ing handlers in one process could then interleave where
 * today they cannot. That is more machinery guarding a case that does not
 * exist. The timeout is short for the same reason.
 *
 * A stale lock, left by a process that was killed mid-write, is broken after
 * {@link DEFAULT_STALE_MS}. Breaking a lock is the one unsound moment in any
 * advisory scheme, so it is deliberately far beyond any honest hold time.
 *
 * ## Two refusals, one rule
 *
 * Both ends of the lock are a filesystem call that can be refused for a reason
 * that passes, and both are held to the same rule: retry for
 * {@link RETRY_BUDGET_MS}, then report the refusal as itself.
 *
 * Releasing is a directory removal. It is refused on Windows when another
 * process holds a file inside the directory open, which is exactly what every
 * waiter is doing to `holder.json`. A release whose outcome is discarded is
 * worse than one that fails loudly: the holder carries on believing it
 * released, and every other writer waits the whole staleness window for a lock
 * that nobody holds.
 *
 * Taking is a directory create. `mkdir` says `EEXIST` when somebody else holds
 * the lock, and that is the ordinary answer, but it is not the only way a
 * platform says the name is unavailable. Windows refuses a create on a name
 * whose deletion has been accepted and not yet finished, with access denied,
 * while a lookup of that same name already reports it as gone: for a few
 * milliseconds the name is neither present nor creatable. Measured on a Windows
 * runner over 180 repetitions of two races: 38 refused creates, all of them
 * access denied, all of them with a lookup reporting the name absent, and every
 * one resolving into a taken lock between 4 and 121 milliseconds.
 *
 * So a create refused for anything but `EEXIST` is treated as contention for as
 * long as the budget, and reported as itself once the budget is spent. It is
 * never turned into {@link LockBusyError}, because a directory that cannot be
 * created is not a busy lock, and the difference has to reach the caller.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

/** How long an acquire waits before giving up. */
export const DEFAULT_TIMEOUT_MS = 5_000;

/** How old a lock must be before it is treated as abandoned. */
export const DEFAULT_STALE_MS = 30_000;

/**
 * How long either side of the lock keeps trying a filesystem call that was
 * refused for a reason that passes, before reporting the refusal as itself.
 * Well inside {@link DEFAULT_TIMEOUT_MS}, so a retry never itself becomes the
 * reason a waiter is refused, and far short of {@link DEFAULT_STALE_MS}.
 */
const RETRY_BUDGET_MS = 1_000;

/** Thrown when a lock could not be taken. Nothing was written. */
export class LockBusyError extends Error {
  /** The lock that was contended, as a short name, never a path. */
  readonly lockName: string;

  constructor(lockName: string) {
    super(
      `another process is writing and the ${lockName} lock could not be taken; nothing was written, try again`,
    );
    this.name = "LockBusyError";
    this.lockName = lockName;
  }
}

/** Tunables, for the tests. */
export interface LockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
}

interface Holder {
  readonly holder: string;
  readonly acquiredAt: number;
  readonly host: string;
  /** Informational only. Nothing is ever decided from this. */
  readonly pid: number;
}

/** Sleep without handing the event loop back, so a held section stays whole. */
function sleepMs(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

function readHolder(dir: string): Holder | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dir, "holder.json"), "utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Holder).holder === "string" &&
      typeof (parsed as Holder).acquiredAt === "number"
    ) {
      return parsed as Holder;
    }
  } catch {
    // A lock directory with no readable holder file is one that was created a
    // moment ago, or one whose holder died between the two steps. Both are
    // handled by the staleness path below.
  }
  return undefined;
}

/** When the lock directory itself was created, or `now` if it is unreadable. */
function directoryAge(dir: string): number {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return Date.now();
  }
}

/**
 * Remove the lock directory and whatever is inside it, once.
 *
 * Hands back `undefined` when the directory is gone afterwards, and the failure
 * when it is still there. Nobody may assume the removal happened: that
 * assumption is what turns one refused delete into a lock held for the whole
 * staleness window.
 */
function removeLockDirectory(dir: string): unknown {
  try {
    unlinkSync(join(dir, "holder.json"));
  } catch {
    // Left to the removal below, which is the call whose outcome is read.
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Give the lock back, retrying a removal that failed for a passing reason.
 *
 * Deleting a file another process holds open is refused outright on some
 * platforms, and every waiter reads `holder.json` a few times a second, so a
 * release and a waiter's read do collide. The collision lasts as long as one
 * read, which is why retrying is what resolves it, on the same jitter the
 * acquire loop uses. Measured on a Windows runner against the Python port of
 * this file: one release in fifty was refused this way, and the lock it failed
 * to give back stayed held for the full thirty seconds, refusing every save in
 * that window.
 *
 * Whatever is still there when the budget is spent is handed back rather than
 * dropped. A lock this process holds and cannot give back is one every other
 * writer waits the staleness window for, and this process is the only one in a
 * position to say so.
 */
function releaseLockDirectory(dir: string): unknown {
  const deadline = Date.now() + RETRY_BUDGET_MS;
  for (;;) {
    const failure = removeLockDirectory(dir);
    if (failure === undefined || Date.now() >= deadline) return failure;
    sleepMs(3 + Math.floor(Math.random() * 9));
  }
}

/**
 * Break a lock that looks abandoned, but only the exact one that was seen to be
 * abandoned: the holder id is re-read immediately before the removal, so a lock
 * that changed hands in between is left alone.
 *
 * A removal that fails here is left to the acquire loop, which comes back
 * within milliseconds and tries again. That is the difference between this path
 * and the release path: here the caller is about to look, so nothing is being
 * told that the lock is gone.
 */
function breakIfStale(dir: string, seen: Holder): void {
  const again = readHolder(dir);
  if (again?.holder !== seen.holder) return;
  removeLockDirectory(dir);
}

/**
 * Run `body` while holding the named lock.
 *
 * `locksDir` must sit on the same volume as the data it guards, because that
 * is the only thing two processes are guaranteed to share. Two callers use it:
 * {@link HandoverStore} passes `<store root>/.locks`, since a store is the only
 * directory it knows about, and the server passes `<home>/.locks` for the
 * wider sections it owns. A store directory is still the same layout as a local
 * `~/.soil` store, because a local store now carries the same `.locks`
 * directory: `.locks` is runtime state that both sides create and neither side
 * reads as content.
 *
 * @throws {LockBusyError} if the lock could not be taken in time. Nothing ran.
 */
export function withLock<T>(
  locksDir: string,
  name: string,
  body: () => T,
  options: LockOptions = {},
): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const dir = join(locksDir, `${name}.lock`);
  const holder: Holder = {
    holder: randomUUID(),
    acquiredAt: Date.now(),
    host: hostname(),
    pid: process.pid,
  };

  mkdirSync(locksDir, { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let taken = false;
  // When the first create was refused for a reason other than `EEXIST`. Reset
  // the moment a create is refused for `EEXIST`, because that is the name
  // becoming visible again: whatever the earlier refusal was, it is over.
  let refusedAt = 0;
  for (;;) {
    try {
      mkdirSync(dir);
      taken = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        refusedAt = 0;
      } else {
        // Not `EEXIST`, and not necessarily fatal either. See "Two refusals,
        // one rule" above: this is how one platform says a name is on its way
        // out. Give it the budget, then let it speak.
        if (!existsSync(dirname(dir))) {
          // Except when there is nothing to wait for. No amount of waiting
          // makes a name creatable inside a directory that is not there, and
          // the caller should hear that at once.
          throw error;
        }
        if (refusedAt === 0) refusedAt = Date.now();
        if (Date.now() - refusedAt >= RETRY_BUDGET_MS) throw error;
        sleepMs(3 + Math.floor(Math.random() * 9));
        continue;
      }
    }
    const now = Date.now();
    const current = readHolder(dir);
    if (current !== undefined) {
      if (now - current.acquiredAt > staleMs) {
        breakIfStale(dir, current);
        continue;
      }
    } else if (now - directoryAge(dir) > staleMs) {
      // A lock directory with no readable holder file is either one created a
      // microsecond ago, or one whose owner died between the `mkdir` and the
      // write. Without this branch the second case would be a lock nothing can
      // ever break, so the directory's own mtime stands in for the holder.
      removeLockDirectory(dir);
      continue;
    }
    if (now >= deadline) break;
    // A little jitter, so two waiters do not wake in lockstep forever.
    sleepMs(3 + Math.floor(Math.random() * 9));
  }

  if (!taken) {
    throw new LockBusyError(name);
  }

  writeFileSync(join(dir, "holder.json"), JSON.stringify(holder), "utf8");
  let failure: unknown;
  let result: T;
  try {
    result = body();
  } finally {
    // Release only what is still ours. If the lock was broken as stale while
    // this body ran, the directory now belongs to somebody else and removing it
    // would hand a third process a lock two processes think they hold.
    const current = readHolder(dir);
    if (current === undefined || current.holder === holder.holder) {
      failure = releaseLockDirectory(dir);
    }
  }

  // Reached only when the body returned. A body that threw carries the more
  // informative failure, and it has already left this function.
  if (failure !== undefined) throw failure;
  return result;
}
