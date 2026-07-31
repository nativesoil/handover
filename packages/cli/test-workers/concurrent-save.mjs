/**
 * One `soil save` writer process for the CLI concurrency test.
 *
 * The failure this file exists to reproduce cannot be written inside one
 * process. Node runs a synchronous handler to completion, so two saves in one
 * process never interleave; documents are only lost when two *processes* share
 * one store. Two processes on one `~/.soil` is not exotic: it is an agent
 * running `soil save` while a person runs it too, or a shell loop.
 *
 * It runs the built CLI (`packages/cli/dist`) through the same `run()` that
 * `bin/soil.js` calls, in a real separate process, because a child process
 * cannot run TypeScript. The test builds before it spawns anything.
 *
 * Usage:
 *   node concurrent-save.mjs <soilHome> <startAtMs> <count> <out> <docDir>
 *
 * Every acknowledgement the CLI hands back is appended to <out> as one JSON
 * line, together with the marker the document carried, so the test can check
 * each receipt against the disk. A refused save is recorded as one too: a
 * refusal is a legitimate answer under contention, an acknowledgement for a
 * write that did not survive is not.
 */

import { SECTION_KEYS } from "@nativesoil/handover-sdk";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../dist/index.js";

const [home, startAtRaw, countRaw, out, docDir] = process.argv.slice(2);
const startAt = Number(startAtRaw);
const count = Number(countRaw);

/**
 * This worker's identity, for the markers it writes.
 *
 * Random, never `process.pid`. Two containers on one volume both run as pid 1,
 * so a test that told two writers apart by pid would agree with itself for the
 * wrong reason.
 */
const workerId = randomUUID();

/** Spin until the agreed instant, so the processes collide instead of queueing. */
function waitForStart() {
  while (Date.now() < startAt) {
    // A deliberate busy wait: a timer would hand the loop back and blur the start.
  }
}

function record(line) {
  appendFileSync(out, `${JSON.stringify(line)}\n`, "utf8");
}

function handover(marker) {
  const sections = {};
  for (const key of SECTION_KEYS) {
    sections[key] = { status: "missing", summary: null };
  }
  sections["projectIdentity"] = { status: "available", summary: marker };
  return {
    soilHandover: "1.0",
    projectId: "billing-rework",
    title: marker,
    createdAt: "2026-07-24T10:00:00.000Z",
    sections,
  };
}

waitForStart();

for (let i = 0; i < count; i += 1) {
  const marker = `${workerId}-${i}`;
  const path = join(docDir, `${marker}.json`);
  writeFileSync(path, JSON.stringify(handover(marker)), "utf8");

  let stdout = "";
  let stderr = "";
  const code = await run(["save", path, "--quiet"], {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => Buffer.alloc(0),
    readFile: (file) => readFileSync(file),
    env: { SOIL_HOME: home },
    now: () => new Date(),
  });

  if (code === 0) {
    record({ ok: true, code: stdout.trim(), marker });
  } else {
    record({ ok: false, marker, stderr: stderr.trim() });
  }
}
