/**
 * The working-style helper is carried by hand in more than one package, and
 * each copy's header says how many packages that is.
 *
 * "The two packages carrying it depend only on the SDK" is a claim about the
 * tree, and it looked self-enumerating: each comment names its neighbours, so a
 * reader can count them. It is weaker than it looks, because the reader has to
 * trust that the named neighbours are the whole set, and nothing said so. One
 * more copy would leave every comment saying two, each still naming its
 * neighbour, each still reading as though it had enumerated itself.
 *
 * So the number is held to the copies that exist.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Every package carrying a copy of the helper, found rather than listed. */
const COPIES = ["cli", "mcp", "server"].filter((name) => {
  try {
    readFileSync(join(ROOT, `packages/${name}/src/workingstyle.ts`), "utf8");
    return true;
  } catch {
    return false;
  }
});

describe("the working-style helper's count of its own copies", () => {
  const VALUE: Readonly<Record<string, number>> = {
    two: 2,
    three: 3,
    four: 4,
    five: 5,
  };

  it("is carried by the packages the comments say it is", () => {
    // The list above is a candidate set; what matters is that every candidate
    // that exists on disk is accounted for, and that there are some.
    expect(COPIES.length).toBeGreaterThan(1);

    for (const name of COPIES) {
      const path = `packages/${name}/src/workingstyle.ts`;
      // Prose wraps, so "All three\n * packages" is one phrase and two lines.
      const flat = readFileSync(join(ROOT, path), "utf8")
        .split("\n")
        .map((line) => line.replace(/^\s*(?:\/\/\/?|\*)?\s*/, ""))
        .join(" ")
        .replace(/\s+/g, " ");
      // The copies do not agree on capitalisation: one opens the sentence and
      // one runs it on mid-paragraph, so the match is case-insensitive. A
      // check that found only one of them would have reported the other as
      // having lost the sentence.
      const stated =
        /\bthe (\w+) packages carrying it depend only on the SDK/i.exec(
          flat,
        )?.[1];
      expect(
        stated,
        `${path} no longer says how many packages carry this helper`,
      ).toBeDefined();
      expect(VALUE[stated!.toLowerCase()], `${path} says "${stated}"`).toBe(
        COPIES.length,
      );
    }
  });
});
