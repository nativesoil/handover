/**
 * The recipes say everything a valid document needs them to say.
 *
 * The check itself lives in `scripts/check-recipe-sufficiency.mjs`, so the
 * same code runs from a shell and from the test suite, exactly as the link
 * check, the card check and the format-constants check do.
 *
 * This is the gap the install guide's smoke test never covered and could not:
 * that test feeds `examples/orchard-checkout.json`, a document that already
 * exists and already validates, so it exercises the CLI and never travels the
 * recipe-to-model-to-save path at all. It proves the tool works on a good
 * document. It proves nothing about whether the instruction that PRODUCES
 * documents can be followed by a model that has only the printed text — which
 * is the entire intended flow, and which failed on its first cold attempt:
 * the recipe named the three gap statuses and never `available`, and named
 * four of eleven provenance labels while never saying `provenance` is a list.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(ROOT, "scripts/check-recipe-sufficiency.mjs");

describe("the recipes a model is handed", () => {
  it("state every requirement the schema imposes on the reply", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(`${result.stdout}${result.stderr}`.trimEnd()).toContain(
      "requirement(s) checked against spec/handover.schema.json",
    );
    expect(result.status).toBe(0);
  });
});
