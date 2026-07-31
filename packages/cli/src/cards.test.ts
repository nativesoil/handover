/**
 * Every rail card printed in the documentation is bound to a real command or
 * marked as an illustration.
 *
 * The check itself lives in `scripts/check-cards.mjs`, so the same code runs
 * from a shell (`node scripts/check-cards.mjs`) and from the test suite. This
 * file is the seat belt: a card that drifts from what the renderer prints
 * fails `pnpm test`, not just a workflow somebody forgot to look at.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(ROOT, "scripts/check-cards.mjs");

describe("documented rail cards", () => {
  it("are each bound to a command or marked as an illustration", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(`${result.stdout}${result.stderr}`.trimEnd()).toContain(
      "all bound or marked",
    );
    expect(result.status).toBe(0);
  });
});
