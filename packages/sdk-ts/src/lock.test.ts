import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LockBusyError, withLock } from "./lock.js";

/** A throwaway root, the way the other suites in this package make one. */
const makeHome = (): string => mkdtempSync(join(tmpdir(), "soil-lock-test-"));
const removeHome = (home: string): void =>
  rmSync(home, { recursive: true, force: true });

describe("the write lock", () => {
  let home: string;
  let locks: string;

  beforeEach(() => {
    home = makeHome();
    locks = join(home, ".locks");
  });

  afterEach(() => {
    removeHome(home);
  });

  /** Leave behind exactly what another process holding the lock leaves. */
  function holdFromElsewhere(name: string, holder: Record<string, unknown>) {
    const dir = join(locks, `${name}.lock`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "holder.json"), JSON.stringify(holder), "utf8");
    return dir;
  }

  it("runs the body and leaves nothing behind", () => {
    const value = withLock(locks, "store", () => 42);
    expect(value).toBe(42);
    expect(existsSync(join(locks, "store.lock"))).toBe(false);
  });

  it("releases when the body throws", () => {
    expect(() =>
      withLock(locks, "store", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(join(locks, "store.lock"))).toBe(false);
  });

  it("refuses rather than running the body while somebody else holds it", () => {
    holdFromElsewhere("store", {
      holder: "11111111-1111-4111-8111-111111111111",
      acquiredAt: Date.now(),
      host: "elsewhere",
      pid: 1,
    });
    let ran = false;
    expect(() =>
      withLock(
        locks,
        "store",
        () => {
          ran = true;
        },
        { timeoutMs: 60 },
      ),
    ).toThrow(LockBusyError);
    // The point of the refusal: nothing was written, not even partly.
    expect(ran).toBe(false);
  });

  it("does not decide anything from a process id", () => {
    // Two containers on one volume both run as pid 1. A lock whose holder
    // carries *this* process's own pid must still be treated as somebody
    // else's, or a fix that leans on pids being distinct silently opens the
    // race it was meant to close.
    holdFromElsewhere("store", {
      holder: "22222222-2222-4222-8222-222222222222",
      acquiredAt: Date.now(),
      host: "elsewhere",
      pid: process.pid,
    });
    expect(() =>
      withLock(locks, "store", () => undefined, { timeoutMs: 60 }),
    ).toThrow(LockBusyError);
  });

  it("takes over a lock whose holder died", () => {
    holdFromElsewhere("store", {
      holder: "33333333-3333-4333-8333-333333333333",
      acquiredAt: Date.now() - 120_000,
      host: "elsewhere",
      pid: 1,
    });
    expect(
      withLock(locks, "store", () => "taken", {
        timeoutMs: 500,
        staleMs: 1_000,
      }),
    ).toBe("taken");
  });

  it("takes over a lock directory whose owner died before writing a holder", () => {
    // The window between `mkdir` and the holder write. Without a fallback this
    // would be a lock nothing could ever break.
    const dir = join(locks, "store.lock");
    mkdirSync(dir, { recursive: true });
    expect(
      withLock(locks, "store", () => "taken", { timeoutMs: 500, staleMs: 0 }),
    ).toBe("taken");
  });

  it("keeps different names apart", () => {
    holdFromElsewhere("personal-a", {
      holder: "44444444-4444-4444-8444-444444444444",
      acquiredAt: Date.now(),
      host: "elsewhere",
      pid: 1,
    });
    // A held personal store must not block a different store's writer.
    expect(withLock(locks, "personal-b", () => "fine", { timeoutMs: 60 })).toBe(
      "fine",
    );
  });

  it("writes a random holder id, never a predictable one", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      withLock(locks, "store", () => {
        const holder = JSON.parse(
          readFileSync(join(locks, "store.lock", "holder.json"), "utf8"),
        ) as { holder: string };
        seen.add(holder.holder);
      });
    }
    expect(seen.size).toBe(3);
  });

  it("fails at once, saying why, on a name that cannot be created", () => {
    // A create refused for something other than EEXIST is treated as
    // contention, because on Windows that is how a name on its way out is
    // reported. That must not swallow a create that will never work: a lock
    // inside a directory that is not there is not a busy lock, and the caller
    // has to be told the difference, immediately and in the platform's own
    // words.
    const started = Date.now();
    let thrown: unknown;
    try {
      withLock(locks, "missing/child", () => "never");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).not.toBe("LockBusyError");
    // Fast, not after the retry budget and not after the acquire timeout.
    expect(Date.now() - started).toBeLessThan(500);
  });
});

/**
 * The five locks classify a refused filesystem call the same way.
 *
 * The lock is one mechanism written five times against one on-disk shape, and
 * every filesystem call in it has exactly two outcomes that matter: the one
 * that means another writer is here, and the one that means this will not work.
 * Three defects in a row were the same mistake about that boundary.
 *
 * A removal that failed was treated as a removal that happened, so a lock
 * nobody held stayed held for the whole staleness window. Then, once removals
 * started succeeding, a create refused for anything but already-exists was
 * treated as fatal, so a name that was merely on its way out became a save
 * refused for a reason that was not real. Release side and acquire side of one
 * assumption: that a filesystem call fails in exactly one interesting way and
 * the rest is impossible.
 *
 * The second was reachable only behind the fix for the first, and it cost a run
 * on the platform to see, twice. What follows is the cheap version: it reads the
 * five sources and checks that both decisions are named, shaped alike, and
 * spelled in none of the ways that shipped. It runs in a fraction of a second
 * with no runtime but this one, which is the point. It is a guard against a
 * regression and against one language drifting from the other four; it is not a
 * way to discover what a platform does. Only a run on the platform does that.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The five implementations of one mechanism, by the language that carries it. */
const LOCKS: Readonly<Record<string, string>> = {
  typescript: "packages/sdk-ts/src/lock.ts",
  python: "packages/sdk-py/soil_handover/lock.py",
  go: "packages/sdk-go/lock.go",
  jvm: "packages/sdk-jvm/src/main/kotlin/dev/nativesoil/handover/Lock.kt",
  dotnet: "packages/sdk-dotnet/SoilHandover/Lock.cs",
};

const SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LOCKS).map(([language, path]) => [
    language,
    readFileSync(join(ROOT, path), "utf8"),
  ]),
);

/**
 * The removal reports its outcome, in the signature.
 *
 * A helper that hands nothing back cannot be asked whether the lock was given
 * up, and every caller of a helper like that is guessing. This is the exact
 * spelling in each language, so a return to a void removal fails here rather
 * than on a platform months later.
 */
const REMOVAL_REPORTS: Readonly<Record<string, string>> = {
  typescript: "function removeLockDirectory(dir: string): unknown",
  python: "def _remove_lock_directory(directory: Path) -> OSError | None:",
  go: "func removeLockDirectory(dir string) error {",
  jvm: "private fun removeLockDirectory(directory: Path): IOException? {",
  dotnet: "private static Exception? RemoveLockDirectory(string directory)",
};

/** And the retrying release is built on it, under one shared budget name. */
const RELEASE_RETRIES: Readonly<Record<string, readonly string[]>> = {
  typescript: [
    "function releaseLockDirectory(dir: string): unknown",
    "RETRY_BUDGET_MS",
  ],
  python: [
    "def _release_lock_directory(directory: Path) -> OSError | None:",
    "_RETRY_BUDGET_MS",
  ],
  go: ["func releaseLockDirectory(dir string) error {", "retryBudget"],
  jvm: [
    "private fun releaseLockDirectory(directory: Path): IOException? {",
    "RETRY_BUDGET_MS",
  ],
  dotnet: [
    "private static Exception? ReleaseLockDirectory(string directory)",
    "RetryBudgetMs",
  ],
};

/**
 * The acquire side spends the same budget on a refused create, and asks the one
 * question that makes waiting pointless before it waits.
 */
const ACQUIRE_WAITS: Readonly<Record<string, readonly string[]>> = {
  typescript: ["refusedAt", "RETRY_BUDGET_MS", "existsSync(dirname(dir))"],
  python: ["refused_at", "_RETRY_BUDGET_MS", "directory.parent.is_dir()"],
  go: ["refusedAt", "retryBudget", "os.Stat(filepath.Dir(dir))"],
  jvm: ["refusedAt", "RETRY_BUDGET_MS", "Files.isDirectory(directory.parent)"],
  dotnet: [
    "refusedAt",
    "RetryBudgetMs",
    "Directory.Exists(Path.GetDirectoryName(directory))",
  ],
};

/**
 * The spellings that shipped, and must not come back.
 *
 * Each of these was live in this tree. The first three are a removal whose
 * outcome nobody can read; the rest are a create classified against one
 * condition with the residue leaving the loop as a failure.
 */
const SHIPPED_DEFECTS: readonly (readonly [string, string, RegExp])[] = [
  [
    "python",
    "a removal that reports nothing",
    /rmtree\([^)]*ignore_errors\s*=\s*True/,
  ],
  ["go", "a removal that reports nothing", /_\s*=\s*os\.RemoveAll\(dir\)\s*$/m],
  [
    "typescript",
    "a create classified on one condition",
    /!==\s*"EEXIST"\)\s*throw/,
  ],
  [
    "go",
    "a create classified on one condition",
    /fs\.ErrExist\)\s*\{\s*\n\s*return mkdirErr/,
  ],
  [
    "python",
    "a create classified on one condition",
    /except FileExistsError:\s*\n\s*pass\s*\n\s*\n\s*now\s*=/,
  ],
  [
    "dotnet",
    "a create classified on one condition",
    /if \(NativeDirectory\.TryCreateExclusive\(directory\)\)/,
  ],
];

describe("the five locks classify a refused filesystem call the same way", () => {
  it("reads all five implementations", () => {
    expect(Object.keys(SOURCES).sort()).toEqual([
      "dotnet",
      "go",
      "jvm",
      "python",
      "typescript",
    ]);
    for (const [language, source] of Object.entries(SOURCES)) {
      expect(source.length, language).toBeGreaterThan(1_000);
    }
  });

  it("hands back the outcome of a removal, in every language", () => {
    for (const [language, signature] of Object.entries(REMOVAL_REPORTS)) {
      expect(
        SOURCES[language],
        `${language}: the removal no longer reports whether the lock was given back`,
      ).toContain(signature);
    }
  });

  it("retries a release on one shared budget, in every language", () => {
    for (const [language, needed] of Object.entries(RELEASE_RETRIES)) {
      for (const fragment of needed) {
        expect(
          SOURCES[language],
          `${language} is missing ${fragment}`,
        ).toContain(fragment);
      }
    }
  });

  it("spends that same budget on a refused create, in every language", () => {
    for (const [language, needed] of Object.entries(ACQUIRE_WAITS)) {
      for (const fragment of needed) {
        expect(
          SOURCES[language],
          `${language} is missing ${fragment}`,
        ).toContain(fragment);
      }
    }
  });

  it("carries none of the spellings that shipped", () => {
    for (const [language, what, pattern] of SHIPPED_DEFECTS) {
      expect(pattern.test(SOURCES[language]), `${language}: ${what}`).toBe(
        false,
      );
    }
  });

  it("decides from the filesystem, never from the name of the platform", () => {
    // A lock that branches on the operating system encodes the two answers
    // known on the day it was written, and is wrong on the third. The one
    // exception is the .NET interop shim, which has to pick which system call
    // to make and says so out loud.
    const PLATFORM_TESTS = [
      /runtime\.GOOS/,
      /sys\.platform/,
      /os\.name\s*==/,
      /process\.platform/,
      /System\.getProperty\(\s*"os\.name"/,
      /RuntimeInformation\.IsOSPlatform/,
    ];
    for (const [language, source] of Object.entries(SOURCES)) {
      for (const pattern of PLATFORM_TESTS) {
        expect(
          pattern.test(source),
          `${language} decides something from the platform's name`,
        ).toBe(false);
      }
    }
    expect(
      (SOURCES["dotnet"].match(/OperatingSystem\.IsWindows\(\)/g) ?? []).length,
      "the only platform test left is the one that picks a system call",
    ).toBe(1);
  });
});
