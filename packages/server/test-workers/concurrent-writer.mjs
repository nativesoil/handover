/**
 * One writer process for the concurrency tests.
 *
 * The failures this file exists to reproduce cannot be written inside one
 * process. Node runs a synchronous handler to completion, so two saves in one
 * process never interleave; the data loss only happens when two *processes*
 * share one data directory, which is exactly what two containers on one volume
 * are. So the test spawns real processes, and this is what they run.
 *
 * It imports the built server (`packages/server/dist`), because a child process
 * cannot run TypeScript. The test builds before it spawns anything.
 *
 * Usage:
 *   node concurrent-writer.mjs save    <home> <startAtMs> <count> <out> <token> [project]
 *   node concurrent-writer.mjs adduser <home> <startAtMs> <count> <out> <name-prefix>
 *
 * Every acknowledgement the server hands back is appended to <out> as one JSON
 * line. The test then checks those acknowledgements against the disk.
 */

import { SECTION_KEYS } from "@nativesoil/handover-sdk";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

import { Registry, ServerService } from "../dist/index.js";

const [mode, home, startAtRaw, countRaw, out, arg, project] =
  process.argv.slice(2);

/**
 * This worker's identity, for the markers it writes.
 *
 * Random, never `process.pid`. Two containers on one volume both run as pid 1,
 * so a test that told two writers apart by pid would agree with itself for the
 * wrong reason.
 */
const workerId = randomUUID();
const startAt = Number(startAtRaw);
const count = Number(countRaw);

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

if (mode === "save") {
  const service = new ServerService(home);
  const caller = service.registry.authenticate(arg);
  if (caller === undefined) {
    record({ ok: false, threw: "the token did not authenticate" });
    process.exit(2);
  }
  for (let i = 0; i < count; i += 1) {
    const marker = `${workerId}-${i}`;
    try {
      const outcome = service.save(
        caller,
        handover(marker),
        project === undefined || project === "-" ? undefined : project,
      );
      if (outcome.ok) {
        record({
          ok: true,
          code: outcome.entry.code,
          marker,
          handoverId: outcome.handover.handoverId,
        });
      } else {
        record({ ok: false, marker, issues: outcome.issues.length });
      }
    } catch (error) {
      record({ ok: false, marker, threw: String(error?.name ?? error) });
    }
  }
} else if (mode === "adduser") {
  const registry = new Registry(home);
  for (let i = 0; i < count; i += 1) {
    const username = `${arg}${i}`;
    try {
      const token = registry.addUser(username);
      record({ ok: true, username, token });
    } catch (error) {
      record({ ok: false, username, threw: String(error?.name ?? error) });
    }
  }
} else {
  record({ ok: false, threw: `unknown mode: ${mode}` });
  process.exit(2);
}
