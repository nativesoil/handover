/**
 * The format's closed sets, said the same way everywhere.
 *
 * The check itself lives in `scripts/check-format-constants.mjs`, so the same
 * code runs from a shell and from the test suite, exactly as the link check
 * and the implementation-count check do.
 *
 * This is the seat belt for the family that every earlier sweep set aside on
 * purpose. 17 sections, four statuses, eleven provenance labels, three tools
 * were all excluded from every count sweep on the reasoning that changing one
 * is a version bump rather than silent drift. The reasoning was half right,
 * and the wrong half cost a defect the same week: a fourth section status was
 * added, the schema and ten shipped mentions moved with it, and one comment
 * was left saying three. A frozen constant is only frozen until a version
 * bump, and when one moves, the prose that stated it does not move with it.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(ROOT, "scripts/check-format-constants.mjs");

describe("the format's closed sets", () => {
  it("are the numbers every mention in the tree states", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(`${result.stdout}${result.stderr}`.trimEnd()).toContain(
      "mention(s) checked against",
    );
    expect(result.status).toBe(0);
  });
});
