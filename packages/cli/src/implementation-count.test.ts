/**
 * How many official implementations there are, said the same way everywhere.
 *
 * The check itself lives in `scripts/check-implementation-count.mjs`, so the
 * same code runs from a shell and from the test suite, exactly as the link
 * check does.
 *
 * This is the last member of a class this repository has now been through
 * three times: a number in prose that nothing derives. The per-runner check
 * counts were wrong by half, the conformance diagram's five figures were right
 * and held by nothing, and a figure hardcoded inside a generator looked bound
 * because a job compared the generated pages to the generator. This one hid
 * better than any of them, behind ten different nouns for one set — five
 * implementations, five SDKs, five runners, five runtimes, five languages,
 * five surfaces, five parsers, five writers, five adapters, five toolchains —
 * so a sweep for any one phrasing came back clean and was believed.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(ROOT, "scripts/check-implementation-count.mjs");

describe("the number of official implementations", () => {
  it("is the number every shipped file states", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(`${result.stdout}${result.stderr}`.trimEnd()).toContain("all agree");
    expect(result.status).toBe(0);
  });
});
