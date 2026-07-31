/**
 * A heading on a page that promises a command is close to the command.
 *
 * The check itself lives in `scripts/check-command-distance.mjs`, so the same
 * code runs from a shell and from the test suite, exactly as the link check and
 * the implementation-count check do. This file is the seat belt: prose grows one
 * true sentence at a time, and the reader who came to run something reads every
 * one of them before reaching anything they can paste.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(ROOT, "scripts/check-command-distance.mjs");

describe("the distance from a heading to its first command", () => {
  it("is within the cap on every page whose job is a command", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(`${result.stdout}${result.stderr}`.trimEnd()).toContain(
      "reach a command within",
    );
    expect(result.status).toBe(0);
  });
});
