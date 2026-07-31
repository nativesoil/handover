/**
 * The argument about package registries has one home.
 *
 * The check itself lives in `scripts/check-registry-status.mjs`, so the same
 * code runs from a shell and from the test suite, exactly as the link check and
 * the implementation-count check do. This file is the seat belt: nothing is
 * published, so every page that tells a reader how to install something has a
 * reason to explain what to write instead, and prose that every page has a
 * reason to carry is prose every page ends up carrying.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(ROOT, "scripts/check-registry-status.mjs");

describe("the package-registry status", () => {
  it("is argued on one page and stated on the others", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(`${result.stdout}${result.stderr}`.trimEnd()).toContain(
      "and nowhere else under docs/",
    );
    expect(result.status).toBe(0);
  });
});
