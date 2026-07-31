/**
 * The README's JSON example is a subset of a document the real validator
 * accepts, byte for byte.
 *
 * The check itself lives in `scripts/check-readme-example.mjs`, so the same
 * code runs from a shell and from the test suite. This file is the seat belt,
 * for the same reason `cards.test.ts` is one: the front page shows a piece of
 * a handover, and a piece that nothing validates is a picture that drifts the
 * first time the schema moves.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(ROOT, "scripts/check-readme-example.mjs");

describe("the README's JSON example", () => {
  it("matches the validating document it is derived from", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(`${result.stdout}${result.stderr}`.trimEnd()).toContain(
      "which validates",
    );
    expect(result.status).toBe(0);
  });
});
