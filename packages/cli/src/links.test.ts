/**
 * Every relative link and image reference in the repository's markdown points
 * at a file that is there.
 *
 * The check itself lives in `scripts/check-links.mjs`, so the same code runs
 * from a shell (`node scripts/check-links.mjs`) and from the test suite. This
 * file is the seat belt, for the same reason `cards.test.ts` is one: the two
 * dead links this repository has found so far were both found by a person
 * reading, one of them on a phone, while the checks that did run stayed green.
 * A reader who follows a link into nothing has spent their first impression,
 * and that is not something a later commit gets to redo.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(ROOT, "scripts/check-links.mjs");

describe("relative links in the documentation", () => {
  it("each resolve to a file in the tree", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(`${result.stdout}${result.stderr}`.trimEnd()).toContain(
      "all resolve",
    );
    expect(result.status).toBe(0);
  });
});
