#!/usr/bin/env node
/**
 * The cross-language store harness: five writer processes, one store.
 *
 * Every implementation already has its own concurrency test, and each one
 * proves the same thing about one language: four processes of that language
 * saving into one store lose nothing. None of them proves the sentence the
 * architecture page makes about the lock's on-disk contract, which is a
 * claim about five implementations at once. A person who wants to know
 * whether a Go writer and a .NET writer can share one `~/.soil` cannot
 * learn it from five single-language runs, because the thing that could go
 * wrong is precisely the disagreement between two of them.
 *
 * So this drives all five as separate writer processes against ONE store
 * root, started at one agreed instant, and checks the invariants the
 * single-language tests already encode. It reuses their worker programs
 * rather than writing new ones: what is measured has to be the same writer
 * the language's own test measures, or the two runs are about different
 * code.
 *
 *   packages/cli/test-workers/concurrent-save.mjs         through the CLI
 *   packages/sdk-py/test-workers/concurrent_save.py       through the store
 *   packages/sdk-go/test-workers/concurrentsave           through the CLI
 *   packages/sdk-jvm .. ConcurrentSaveWorker.kt           through the store
 *   packages/sdk-dotnet/SoilHandover.ConcurrentSave       through the store
 *
 * The invariants are the four the single-language tests make, carried over
 * unchanged, plus three that only have meaning once more than one
 * implementation is writing:
 *
 *   1. every save a writer was told succeeded is on disk afterwards
 *   2. no two acknowledgements carry the same load code
 *   3. every acknowledged code still holds the document that receipt named
 *   4. no half-written temporary file survived the race
 *   5. the index holds one row for every acknowledged code, and its counter
 *      stands one past the last one handed out. The original defect was an
 *      index write erasing another writer's row, so the index is checked as
 *      itself and not only through a count of files
 *   6. the codes handed out are exactly the contiguous run from the first,
 *      with no gap and no repeat. A code is allocated from a counter that is
 *      never reused, and five implementations agreeing on the counter is
 *      what makes a code mean the same thing whichever tool wrote it
 *   7. no lock directory is left behind. A writer that takes the lock and
 *      never releases it does not fail its own test, and stops every other
 *      implementation on that store 30 seconds at a time
 *
 * Nothing here is read through any one SDK. The store is judged from its
 * files, because the contract this measures is the on-disk one, and a check
 * that went through one language's reader would be that language's opinion
 * of what the other four wrote.
 *
 * Honesty about coverage. The claim is about five implementations, so the
 * default run demands five runtimes and FAILS if one is missing, rather
 * than skipping it. A run that quietly covered three would report a
 * five-language result in the same words as a five-language run, which is
 * the defect this harness exists to remove, one level up. A deliberate
 * partial run is available and says so in every line it prints:
 *
 *   node conformance/interop/run.mjs --languages ts,py,go
 *
 * Held to a known failure, because a concurrency harness that passes against
 * a broken store is worthless. With `HandoverStore._locked` in the Python SDK
 * reduced to calling its body directly, and nothing else in the tree changed,
 * the default run reported 75 acknowledged and 69 documents on disk, six load
 * codes handed to both the TypeScript writer and the Python writer, six codes
 * holding another writer's marker, 69 rows in the index, and exited 1. The
 * lock went straight back; that state is not committed anywhere. Observed
 * 2026-07-29 on arm64 macOS (Darwin 25.3.0) with Node 20.20.2, Python 3.12.8,
 * Go 1.26.5, OpenJDK 17.0.20 and .NET SDK 8.0.423, alongside five passing
 * runs of the same command on the same machine, each of them 75 acknowledged,
 * 75 distinct codes, 75 documents, 75 index rows, nothing refused and nothing
 * left behind. That is one machine and one operating system; the `interop`
 * job in CI is what runs it anywhere else.
 *
 * Usage:
 *
 *   node conformance/interop/run.mjs [--languages a,b,c] [--saves N]
 *                                    [--lead MS] [--keep]
 *
 * Runtimes are found at JAVA_HOME/bin/java, then `java` on the PATH; at
 * `dotnet` on the PATH, then ~/.dotnet/dotnet; and at `go`, `python3` and
 * this Node. It exits 0 only when every invariant held for every language
 * that ran, and it prints what it observed rather than a word for it.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** How long a worker gets to finish before the harness gives up on it. */
const WORKER_TIMEOUT_MS = 300_000;

/** How long a build step gets. Gradle's first run fetches Kotlin. */
const BUILD_TIMEOUT_MS = 900_000;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function argument(name, fallback) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`${flag} needs a value`);
  }
  return value;
}

function fail(message) {
  console.error(`interop: ${message}`);
  process.exit(2);
}

const SAVES_PER_PROCESS = Number(argument("saves", "15"));
if (!Number.isInteger(SAVES_PER_PROCESS) || SAVES_PER_PROCESS < 1) {
  fail("--saves must be a positive integer");
}

/**
 * How long the workers get to reach their busy wait before the agreed start.
 * A JVM and a .NET host both have to come up first, so this is longer than
 * any of the single-language tests use.
 */
const LEAD_MS = Number(argument("lead", "4000"));
if (!Number.isInteger(LEAD_MS) || LEAD_MS < 0) {
  fail("--lead must be a non-negative integer");
}

const KEEP = process.argv.includes("--keep");

/** The saves-per-process a plain run uses, and the one the page describes. */
const DEFAULT_SAVES = 15;

/**
 * The page that states what a default run produces, held to what this run
 * actually observed.
 *
 * docs/architecture.md says a default run acknowledges 75, hands out 75
 * distinct codes running #001 to #075, and leaves 75 documents and 75 index
 * rows. Those figures were written by hand. Binding them to the arithmetic —
 * one process per implementation times the saves each — would have been the
 * easy fix and the wrong one: it would still pass for a harness that never
 * started, or one that quietly covered four languages, because a product of
 * two constants is true whatever the run did. So the page is held to the
 * OBSERVATION instead, and only on a run entitled to make it: every
 * implementation present, the default saves-per-process, nothing refused.
 *
 * A partial run, or one at another --saves, legitimately produces other
 * numbers and says so rather than checking.
 */
function checkThePageAgainst(observed, note) {
  const page = "docs/architecture.md";
  const text = readFileSync(join(ROOT, page), "utf8");
  // The claim is one sentence; wrapped prose splits it, so it is flattened
  // before anything is read out of it.
  const flat = text.replace(/\s+/g, " ");

  // Anchored to the sentence that makes the claim, not to the page. The page
  // also records what the DEFECT produced before the lock existed — "left 26
  // documents on disk" — and an unanchored search for a figure found that one
  // first and reported the harness as wrong. Those older numbers are a record
  // of a state the tree no longer has and must not be updated to match a run.
  const ANCHOR = "On the default run,";
  const from = flat.indexOf(ANCHOR);
  if (from < 0) {
    note(`${page} no longer states what a default run produces`);
    return;
  }
  const sentence = flat.slice(from, flat.indexOf("Run it with", from));
  const stated = {};
  const claims = [
    ["acknowledged", /(\d+) acknowledged, none refused/],
    ["distinct", /(\d+) distinct codes running/],
    ["documents", /(\d+) documents on disk/],
    ["rows", /(\d+) rows in `index\.json`/],
    ["first", /running `#(\d+)` to `#\d+`/],
    ["last", /running `#\d+` to `#(\d+)`/],
  ];
  for (const [key, pattern] of claims) {
    const found = pattern.exec(sentence);
    if (found === null) {
      note(`${page} no longer states the ${key} figure a default run produces`);
      return;
    }
    stated[key] = Number(found[1]);
  }
  for (const [key, value] of Object.entries(stated)) {
    if (value !== observed[key]) {
      note(
        `${page} says ${key} is ${value}; this run observed ${observed[key]}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Finding the runtimes
// ---------------------------------------------------------------------------

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function onPath(binary) {
  try {
    const found = run(process.platform === "win32" ? "where" : "which", [
      binary,
    ]);
    const first = found.split("\n")[0].trim();
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/**
 * The first candidate that answers `args` with exit 0, and what it said.
 *
 * Both streams are read, because `java -version` writes its version to
 * stderr. Presence on the PATH is not taken as an answer on its own: macOS
 * ships a `/usr/bin/java` stub that exists whether or not a JDK does.
 */
function firstThatAnswers(candidates, args) {
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const answer = spawnSync(candidate, args, { encoding: "utf8" });
    if (answer.error || answer.status !== 0) continue;
    const said = `${answer.stdout ?? ""}${answer.stderr ?? ""}`
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)[0];
    return { path: candidate, said: said ?? candidate };
  }
  return null;
}

function findJava() {
  const fromHome = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, "bin", "java")
    : null;
  return firstThatAnswers([fromHome, onPath("java")], ["-version"]);
}

function findDotnet() {
  const perUser = join(homedir(), ".dotnet", "dotnet");
  return firstThatAnswers(
    [
      process.env.DOTNET_HOST_PATH ?? null,
      onPath("dotnet"),
      existsSync(perUser) ? perUser : null,
    ],
    ["--version"],
  );
}

function findPython() {
  return firstThatAnswers([onPath("python3"), onPath("python")], ["--version"]);
}

// ---------------------------------------------------------------------------
// The five writers
// ---------------------------------------------------------------------------

/**
 * Each entry finds its runtime, builds whatever the worker needs, and then
 * returns the argv that starts one writer process. `prepare` runs before the
 * clock starts, so no build time lands inside the race.
 */
const LANGUAGES = [
  {
    id: "ts",
    label: "TypeScript",
    find: () => ({ path: process.execPath, said: `node ${process.version}` }),
    prepare(work, runtime) {
      // The compiler is reached through Node's own module resolution and run
      // with this Node, never through `node_modules/.bin/tsc`. That path is a
      // launcher a package manager writes for a shell: on Unix a `#!/bin/sh`
      // script with the exec bit, on Windows a sibling `.cmd`, so the
      // extensionless name has no executable image and spawning it answers
      // ENOENT. This harness runs on Linux today, and that is the only reason
      // the launcher has held.
      run(process.execPath, [
        createRequire(import.meta.url).resolve("typescript/bin/tsc"),
        "-b",
        join(ROOT, "packages", "cli", "tsconfig.json"),
      ]);
      const worker = join(
        ROOT,
        "packages",
        "cli",
        "test-workers",
        "concurrent-save.mjs",
      );
      return (store, startAt, acks, docs) => [
        runtime.path,
        [worker, store, startAt, String(SAVES_PER_PROCESS), acks, docs],
      ];
    },
  },
  {
    id: "py",
    label: "Python",
    find: findPython,
    prepare(work, runtime) {
      const worker = join(
        ROOT,
        "packages",
        "sdk-py",
        "test-workers",
        "concurrent_save.py",
      );
      return (store, startAt, acks, docs) => [
        runtime.path,
        [worker, store, startAt, String(SAVES_PER_PROCESS), acks, docs],
      ];
    },
  },
  {
    id: "go",
    label: "Go",
    find: () => firstThatAnswers([onPath("go")], ["version"]),
    prepare(work, runtime) {
      const sdk = join(ROOT, "packages", "sdk-go");
      const soil = join(work, "soil-go");
      const worker = join(work, "concurrentsave");
      run(runtime.path, ["build", "-o", soil, "./cmd/soil"], { cwd: sdk });
      run(
        runtime.path,
        ["build", "-o", worker, "./test-workers/concurrentsave"],
        {
          cwd: sdk,
        },
      );
      // The Go worker runs the published binary, one process per save, so
      // what it measures is `soil save` and not a library call underneath it.
      return (store, startAt, acks, docs) => [
        worker,
        [soil, store, startAt, String(SAVES_PER_PROCESS), acks, docs],
      ];
    },
  },
  {
    id: "jvm",
    label: "JVM",
    find: findJava,
    prepare(work, runtime) {
      const sdk = join(ROOT, "packages", "sdk-jvm");
      const gradlew = join(
        sdk,
        process.platform === "win32" ? "gradlew.bat" : "gradlew",
      );
      // `printTestClasspath` exists in the Gradle build for exactly this: the
      // worker is a `main` on the test classpath, and `java.class.path` is not
      // dependable once Gradle shortens a long classpath into a manifest jar.
      const printed = run(gradlew, ["-q", "-p", sdk, "printTestClasspath"], {
        cwd: ROOT,
        env: {
          ...process.env,
          JAVA_HOME:
            process.env.JAVA_HOME ?? resolve(dirname(runtime.path), ".."),
        },
        timeout: BUILD_TIMEOUT_MS,
      });
      const classpath = printed
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .pop();
      if (!classpath) fail("gradle printTestClasspath printed nothing");
      return (store, startAt, acks, docs) => [
        runtime.path,
        [
          "-cp",
          classpath,
          "dev.nativesoil.handover.ConcurrentSaveWorkerKt",
          store,
          startAt,
          String(SAVES_PER_PROCESS),
          acks,
          docs,
        ],
      ];
    },
  },
  {
    id: "dotnet",
    label: ".NET",
    find: findDotnet,
    prepare(work, runtime) {
      const project = join(
        ROOT,
        "packages",
        "sdk-dotnet",
        "SoilHandover.ConcurrentSave",
        "SoilHandover.ConcurrentSave.csproj",
      );
      const into = join(work, "dotnet-worker");
      run(runtime.path, ["build", project, "-c", "Release", "-o", into], {
        cwd: ROOT,
        timeout: BUILD_TIMEOUT_MS,
      });
      const dll = join(into, "Soil.Handover.ConcurrentSave.dll");
      if (!existsSync(dll)) fail(`the .NET worker was not built at ${dll}`);
      return (store, startAt, acks, docs) => [
        runtime.path,
        [dll, store, startAt, String(SAVES_PER_PROCESS), acks, docs],
      ];
    },
  },
];

const ALL_IDS = LANGUAGES.map((language) => language.id);
const requested = argument("languages", ALL_IDS.join(","))
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);
for (const id of requested) {
  if (!ALL_IDS.includes(id)) {
    fail(`unknown language ${id}; known: ${ALL_IDS.join(", ")}`);
  }
}
const PARTIAL = requested.length !== ALL_IDS.length;

// ---------------------------------------------------------------------------
// The race
// ---------------------------------------------------------------------------

function spawnWorker(command, args) {
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectWorker(new Error("a worker process did not finish in time"));
    }, WORKER_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectWorker);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveWorker({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Every file under a directory tree, as paths relative to it. */
function walk(directory, prefix = "") {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      found.push(...walk(full, relative));
    } else {
      found.push(relative);
    }
  }
  return found;
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), "soil-interop-"));
  const failures = [];
  const note = (message) => failures.push(message);

  try {
    // 1. Find every requested runtime, and refuse the run if one is absent.
    const runtimes = new Map();
    const missing = [];
    for (const language of LANGUAGES) {
      if (!requested.includes(language.id)) continue;
      const found = language.find();
      if (found === null) {
        missing.push(language.label);
        continue;
      }
      runtimes.set(language.id, found);
    }
    if (missing.length > 0) {
      // The suggestion is drawn from every language, not only the ones asked
      // for, so that a refusal names a run the person can actually make.
      const answering = LANGUAGES.filter(
        (language) => runtimes.has(language.id) || language.find() !== null,
      ).map((language) => language.id);
      console.error("");
      console.error(`interop: ${missing.join(" and ")} did not answer here.`);
      console.error(
        "interop: this harness measures five implementations sharing one",
      );
      console.error(
        "interop: store, so it refuses a run that would cover fewer and",
      );
      console.error(
        "interop: report it in the same words. Install the runtime, or ask",
      );
      console.error(
        answering.length > 0
          ? `interop: for the languages you have: --languages ${answering.join(",")}`
          : "interop: for a smaller set with --languages once one is installed.",
      );
      process.exit(2);
    }

    console.log("");
    console.log(
      PARTIAL
        ? `A PARTIAL cross-language store run: ${requested.length} of ${ALL_IDS.length} implementations.`
        : "The cross-language store run: all five implementations, one store.",
    );
    console.log("");
    for (const language of LANGUAGES) {
      if (!runtimes.has(language.id)) continue;
      const runtime = runtimes.get(language.id);
      console.log(`  ${language.label.padEnd(11)} ${runtime.said}`);
    }
    console.log("");

    // 2. Build every worker before the clock starts.
    const starters = new Map();
    for (const language of LANGUAGES) {
      if (!runtimes.has(language.id)) continue;
      process.stdout.write(`  preparing ${language.label} ... `);
      try {
        starters.set(
          language.id,
          language.prepare(work, runtimes.get(language.id)),
        );
      } catch (error) {
        console.log("failed");
        fail(
          `could not prepare the ${language.label} writer: ${String(error)}\n` +
            `${error.stdout ?? ""}${error.stderr ?? ""}`,
        );
      }
      console.log("ready");
    }
    console.log("");

    // 3. One store, one agreed instant, one writer process per language.
    //    Each language writes its acknowledgements to its own file: five
    //    processes appending to one file would put a shared-file question
    //    inside a measurement that is about the store.
    const store = join(work, "store");
    mkdirSync(store, { recursive: true });
    const startAt = String(Date.now() + LEAD_MS);
    const running = [];
    for (const language of LANGUAGES) {
      if (!starters.has(language.id)) continue;
      const acks = join(work, `acks-${language.id}.jsonl`);
      const docs = join(work, `docs-${language.id}`);
      mkdirSync(docs, { recursive: true });
      const [command, args] = starters.get(language.id)(
        store,
        startAt,
        acks,
        docs,
      );
      running.push(
        spawnWorker(command, args).then((result) => ({
          language,
          acks,
          ...result,
        })),
      );
    }
    console.log(
      `  ${running.length} writer processes, ${SAVES_PER_PROCESS} saves each, one store`,
    );
    const results = await Promise.all(running);
    console.log("");

    // 4. What each writer was told.
    const lines = [];
    for (const result of results) {
      if (result.code !== 0) {
        note(
          `the ${result.language.label} writer exited ${result.code}: ` +
            `${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      if (!existsSync(result.acks)) {
        note(`the ${result.language.label} writer wrote no acknowledgements`);
        continue;
      }
      const written = readFileSync(result.acks, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => ({
          language: result.language,
          ...JSON.parse(line),
        }));
      if (written.length !== SAVES_PER_PROCESS) {
        note(
          `the ${result.language.label} writer recorded ${written.length} attempts, not ${SAVES_PER_PROCESS}`,
        );
      }
      lines.push(...written);
    }

    // A save refused under contention is an honest answer, and this store is
    // uncontended enough that none should be. Either way every invariant
    // below is about what was acknowledged, never about what was tried.
    const refused = lines.filter((line) => !line.ok);
    for (const line of refused) {
      note(
        `the ${line.language.label} writer was refused a save: ` +
          `${line.error ?? line.stderr ?? "no reason recorded"}`,
      );
    }
    const acknowledged = lines.filter((line) => line.ok);

    // 5. What the store holds.
    const handoversDir = join(store, "handovers");
    const documents = existsSync(handoversDir) ? readdirSync(handoversDir) : [];
    const jsonDocuments = documents.filter((name) => name.endsWith(".json"));

    // Invariant 1: every acknowledged save is present.
    for (const line of acknowledged) {
      const file = join(handoversDir, `${line.code.replace("#", "")}.json`);
      if (!existsSync(file)) {
        note(
          `${line.language.label} was acknowledged ${line.code}, and ${file} does not exist`,
        );
      }
    }
    if (jsonDocuments.length !== acknowledged.length) {
      note(
        `${acknowledged.length} saves acknowledged, ${jsonDocuments.length} documents on disk`,
      );
    }

    // Invariant 2: no two acknowledgements carry the same code.
    const seen = new Map();
    for (const line of acknowledged) {
      if (seen.has(line.code)) {
        note(
          `the load code ${line.code} was handed to ${seen.get(line.code).label} and to ${line.language.label}`,
        );
      }
      seen.set(line.code, line.language);
    }

    // Invariant 3: every acknowledged code still holds the document that
    // receipt named. Read as a file, not through any one SDK.
    for (const line of acknowledged) {
      const file = join(handoversDir, `${line.code.replace("#", "")}.json`);
      if (!existsSync(file)) continue;
      let title;
      try {
        title = JSON.parse(readFileSync(file, "utf8")).title;
      } catch (error) {
        note(`${line.code} is not readable JSON: ${String(error)}`);
        continue;
      }
      if (title !== line.marker) {
        note(
          `${line.code} was acknowledged to ${line.language.label} for ${line.marker}, and holds ${String(title)}`,
        );
      }
    }

    // Invariant 4: no half-written temporary file survived, anywhere under
    // the store root rather than only beside the documents.
    const strays = walk(store).filter((name) => name.includes(".tmp-"));
    for (const stray of strays) {
      note(`a temporary file survived the race: ${stray}`);
    }

    // Invariant 5: the index holds one row per acknowledged code, and its
    // counter stands one past the last code handed out. The defect this
    // whole mechanism exists for was an index write erasing another
    // writer's row, so the index is read as itself.
    const indexPath = join(store, "index.json");
    let index = null;
    if (!existsSync(indexPath)) {
      note("the store has no index.json");
    } else {
      try {
        index = JSON.parse(readFileSync(indexPath, "utf8"));
      } catch (error) {
        note(`index.json is not readable JSON: ${String(error)}`);
      }
    }
    let codesInOrder = [];
    if (index !== null) {
      const rows = Array.isArray(index.entries) ? index.entries : [];
      if (rows.length !== acknowledged.length) {
        note(
          `${acknowledged.length} saves acknowledged, ${rows.length} rows in index.json`,
        );
      }
      const indexed = new Set(rows.map((row) => row.code));
      for (const line of acknowledged) {
        if (!indexed.has(line.code)) {
          note(
            `${line.language.label} was acknowledged ${line.code}, and index.json has no row for it`,
          );
        }
      }
      codesInOrder = rows
        .map((row) => Number(String(row.code).replace("#", "")))
        .filter((n) => Number.isInteger(n))
        .sort((a, b) => a - b);
      const highest = codesInOrder[codesInOrder.length - 1];
      if (
        codesInOrder.length > 0 &&
        index.nextCode !== undefined &&
        index.nextCode !== highest + 1
      ) {
        note(
          `the highest code is #${String(highest).padStart(3, "0")} and nextCode is ${String(index.nextCode)}`,
        );
      }
    }

    // Invariant 6: the codes are the contiguous run, no gap and no repeat.
    // Five implementations allocating from one counter is what makes a code
    // mean the same thing whichever tool wrote it.
    if (refused.length === 0 && codesInOrder.length > 0) {
      const expected = Array.from(
        { length: codesInOrder.length },
        (_, i) => i + 1,
      );
      const gaps = expected.filter((n) => !codesInOrder.includes(n));
      if (gaps.length > 0) {
        note(
          `the codes are not contiguous: missing ${gaps
            .slice(0, 8)
            .map((n) => `#${String(n).padStart(3, "0")}`)
            .join(", ")}`,
        );
      }
    }

    // Invariant 7: no lock is left behind. A writer that takes the lock and
    // never gives it back passes its own test and stops everybody else.
    const heldLocks = walk(join(store, ".locks")).filter((name) =>
      name.includes(".lock"),
    );
    for (const held of heldLocks) {
      note(`a lock was left behind: .locks/${held}`);
    }

    // 6. The report, in the terms the checks above actually assert.
    const distinct = new Set(acknowledged.map((line) => line.code)).size;
    const firstCode = codesInOrder.length > 0 ? codesInOrder[0] : null;
    const lastCode =
      codesInOrder.length > 0 ? codesInOrder[codesInOrder.length - 1] : null;

    console.log(`  acknowledged        ${acknowledged.length}`);
    console.log(`  refused             ${refused.length}`);
    console.log(`  distinct codes      ${distinct}`);
    console.log(`  documents on disk   ${jsonDocuments.length}`);
    console.log(`  rows in index.json  ${index?.entries?.length ?? 0}`);
    if (firstCode !== null) {
      console.log(
        `  code range          #${String(firstCode).padStart(3, "0")} to #${String(lastCode).padStart(3, "0")}`,
      );
    }
    console.log(`  temporary files     ${strays.length}`);
    console.log(`  locks held          ${heldLocks.length}`);
    console.log("");

    // The page that describes this run, held to the run. Only a full run at
    // the default saves-per-process is entitled to make that claim; anything
    // else says why it is not checking rather than checking the wrong thing.
    if (!PARTIAL && SAVES_PER_PROCESS === DEFAULT_SAVES) {
      checkThePageAgainst(
        {
          acknowledged: acknowledged.length,
          distinct,
          documents: jsonDocuments.length,
          rows: index?.entries?.length ?? 0,
          first: firstCode,
          last: lastCode,
        },
        note,
      );
    } else {
      console.log(
        `  docs/architecture.md not checked: it describes a full run at ` +
          `${DEFAULT_SAVES} saves each, and this run was ` +
          `${PARTIAL ? "partial" : `at ${SAVES_PER_PROCESS} saves each`}`,
      );
      console.log("");
    }
    for (const language of LANGUAGES) {
      if (!runtimes.has(language.id)) continue;
      const mine = acknowledged.filter(
        (line) => line.language.id === language.id,
      );
      console.log(`  ${language.label.padEnd(11)} ${mine.length} acknowledged`);
    }
    console.log("");

    if (failures.length > 0) {
      console.error("FAILED");
      for (const failure of failures) console.error(`  ${failure}`);
      console.error("");
      console.error(
        `  ${failures.length} problem${failures.length === 1 ? "" : "s"} across ` +
          `${requested.length} implementation${requested.length === 1 ? "" : "s"} sharing one store.`,
      );
      console.error("");
      process.exitCode = 1;
      return;
    }

    const covered = requested
      .map((id) => LANGUAGES.find((language) => language.id === id).label)
      .join(", ");
    if (PARTIAL) {
      console.log(
        `PARTIAL: ${requested.length} of ${ALL_IDS.length} implementations shared one store and lost nothing.`,
      );
      console.log(`  ran: ${covered}`);
      console.log(
        `  not run: ${ALL_IDS.filter((id) => !requested.includes(id))
          .map((id) => LANGUAGES.find((language) => language.id === id).label)
          .join(", ")}. This run says nothing about them.`,
      );
    } else {
      console.log(
        `PASS: ${requested.length} implementations shared one store and lost nothing.`,
      );
      console.log(`  ran: ${covered}`);
    }
    console.log("");
  } finally {
    if (KEEP) {
      console.log(`  kept the working directory: ${work}`);
    } else {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

await main();
