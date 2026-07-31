/**
 * The recipe as a model receives it.
 *
 * The bytes are held identical across the five SDKs and the two canonical
 * files by the conformance suite, so this file does not repeat that. What it
 * asserts is what the text ASKS FOR, in the one place where asking for less
 * produced a section that recorded a verdict and taught nothing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RECIPE_VERSION, SECTION_GUIDANCE, renderRecipe } from "./recipe.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const canonical = readFileSync(
  join(ROOT, "recipes/handover-recipe-v1.txt"),
  "utf8",
);

describe("the rejected-paths guidance", () => {
  const guidance = SECTION_GUIDANCE.rejectedPaths;

  it("asks how the path failed, not only that it was rejected", () => {
    // A verdict preserves THAT a path is closed and teaches nothing: a later
    // reader cannot tell whether their own idea is the same dead end, or
    // whether the thing that broke has since been fixed. What answers both is
    // the observable failure.
    expect(guidance).toContain("HOW it failed in observable terms");
    for (const observable of [
      "the symptom",
      "the measurement",
      "the error",
      "the cost that appeared",
    ]) {
      expect(guidance).toContain(observable);
    }
  });

  it("keeps the verdict-only case honest rather than blocking the save", () => {
    // The guard the ask cannot ship without. An invented symptom is worse than
    // a missing one, and it is RULE 3 that says so by name.
    expect(guidance).toContain("Where only the verdict is genuinely known");
    expect(guidance).toContain("honest gap never blocks a save");
    expect(guidance).toContain("a gap to note, not a blank to fill (RULE 3)");
  });

  it("reaches the canonical text a model is actually handed", () => {
    expect(canonical).toContain(`rejectedPaths: ${guidance}`);
  });
});

describe("the recipe version", () => {
  it("is printed on the first line, where the model can report it back", () => {
    // The version's only job is to identify which text produced a save, so a
    // text that asks for more than the last one did carries a new number.
    expect(canonical.split("\n")[0]).toContain(`recipe v${RECIPE_VERSION}`);
    expect(renderRecipe()).toBe(canonical);
  });
});
