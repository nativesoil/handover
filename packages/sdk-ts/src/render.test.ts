import { describe, expect, it } from "vitest";

import { normalizeHandover } from "./normalize.js";
import {
  renderList,
  renderLoaded,
  renderSaved,
  renderValidation,
  wrap,
} from "./render.js";
import { validateHandover } from "./validate.js";

const NOW = new Date("2026-07-22T10:00:00Z");

const doc = normalizeHandover({
  handoverId: "019f7e89-fc00-7000-8000-000000000000",
  projectId: "render-test",
  title: "A short title",
  createdAt: "2026-07-22T10:00:00Z",
  source: { client: "claude-code", model: "opus-4.8" },
  sections: {
    executiveSummary: "What this is.",
    decisions: "What was decided.",
    architecture: { status: "blocked", summary: "Host names withheld." },
  },
  quality: { missingInputs: ["the deploy logs were not available"] },
  safety: { unsafeOmissions: ["an API key exists in the platform config"] },
});

describe("wrap", () => {
  it("breaks on words and never mid-word", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  it("keeps a word longer than the width on its own line", () => {
    expect(wrap("supercalifragilistic", 5)).toEqual(["supercalifragilistic"]);
  });
});

describe("renderSaved", () => {
  const card = renderSaved(doc, "#004");

  it("leads with the load code", () => {
    expect(card.split("\n")[0]).toContain("#004");
  });

  it("reports counts and never a score", () => {
    expect(card).toContain("2 / 17 sections carrying content");
    expect(card).not.toMatch(/\d+\s*%/);
    expect(card).not.toMatch(/score|grade|readiness/i);
    expect(card).not.toMatch(/captured|complete|sufficient/i);
  });

  it("names what did not survive", () => {
    expect(card).toContain("no content");
    expect(card).toContain("held back   architecture");
  });

  it("names a section that does not apply on its own row, not among the empty ones", () => {
    const withNotApplicable = renderSaved(
      normalizeHandover({
        handoverId: "019f7e89-fc00-7000-8000-000000000001",
        projectId: "render-test",
        title: "A short title",
        createdAt: "2026-07-22T10:00:00Z",
        sections: {
          executiveSummary: "What this is.",
          architecture: {
            status: "not_applicable",
            summary: "A manuscript has no system to describe.",
          },
        },
      }),
      "#005",
    );
    expect(withNotApplicable).toContain("no subject  architecture");
    expect(withNotApplicable).not.toMatch(/no content.*architecture/);
  });

  it("shows the stated gaps and the safety omissions", () => {
    expect(card).toContain("stated gaps");
    expect(card).toContain("the deploy logs were not available");
    expect(card).toContain("held back · by design");
  });

  it("shows the unresolved contradictions beside the gaps", () => {
    const withContradiction = renderSaved(
      normalizeHandover({
        ...JSON.parse(JSON.stringify(doc)),
        quality: { contradictions: ["the ceiling is 180 KB and also 175 KB"] },
      }),
      "#006",
    );
    expect(withContradiction).toContain("unresolved contradictions");
    expect(withContradiction).toContain(
      "the ceiling is 180 KB and also 175 KB",
    );
  });

  it("names what wrote the document, each field under its own label", () => {
    // A dot-joined origin line cannot say which token is the tool and which is
    // the model, so each field gets a label and the value sits beside it.
    expect(card).toContain("written by");
    expect(card).toContain("client      claude-code");
    expect(card).toContain("model       opus-4.8");
    const withEverything = renderSaved(
      normalizeHandover({
        ...JSON.parse(JSON.stringify(doc)),
        source: {
          client: "chatgpt",
          model: "gpt-5",
          provider: "openai",
          recipeVersion: "1.2.3",
        },
      }),
      "#007",
    );
    expect(withEverything).toContain("provider    openai");
    expect(withEverything).toContain("recipe      1.2.3");
  });

  it("leaves the written-by block out when the document names no source", () => {
    const noSource = renderSaved(
      normalizeHandover({
        projectId: "no-source",
        title: "No source",
        createdAt: "2026-07-22T10:00:00Z",
        sections: { executiveSummary: "One line." },
      }),
      "#008",
    );
    expect(noSource).not.toContain("written by");
  });

  it("names the kinds of claim and the evidence attached", () => {
    const labelled = renderSaved(
      normalizeHandover({
        ...JSON.parse(JSON.stringify(doc)),
        sections: {
          executiveSummary: {
            status: "available",
            summary: "What this is.",
            provenance: ["repo_verified", "model_reported"],
          },
        },
        observations: [
          {
            kind: "quality.capture",
            producedBy: "soil-cli/0.1.0",
            data: { sectionsWithContent: 1 },
          },
        ],
      }),
      "#009",
    );
    expect(labelled).toContain("provenance  repo_verified, model_reported");
    expect(labelled).toContain("evidence    quality.capture");
    expect(labelled).toContain("recorded    soil-cli/0.1.0");
  });

  it("ends with the command that loads it back", () => {
    expect(card.trimEnd().endsWith("❯ soil load #004")).toBe(true);
  });

  it("is deterministic", () => {
    expect(renderSaved(doc, "#004")).toBe(card);
  });

  it("keeps every line inside the card width", () => {
    for (const line of card.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(70);
    }
  });
});

describe("renderLoaded", () => {
  it("says which sections are empty and how to read the rest", () => {
    const card = renderLoaded({ ...doc, code: "#004" });
    expect(card).toContain("what this document carries");
    expect(card).toContain("2 / 17 sections carrying content");
    expect(card).toContain("no content");
    expect(card).toContain("moment of capture");
  });

  it("says a withheld section was withheld, not that it is empty", () => {
    // The save card always said so. This one did not, which left a reader of
    // the load door unable to tell a section nobody could see from one somebody
    // decided not to move.
    const card = renderLoaded({ ...doc, code: "#004" });
    expect(card).toContain("held back   architecture");
    expect(card).not.toMatch(/no content.*architecture/);
  });

  it("carries the same written-by block as the save card", () => {
    const card = renderLoaded({ ...doc, code: "#004" });
    expect(card).toContain("written by");
    expect(card).toContain("client      claude-code");
    expect(card).toContain("model       opus-4.8");
  });
});

describe("renderList", () => {
  it("says so when nothing is stored", () => {
    expect(renderList([])).toContain("nothing saved yet");
  });

  it("shows a code, a title and a count per row", () => {
    const card = renderList([
      {
        code: "#002",
        projectId: "render-test",
        title: "A very long title that will not fit in the column at all",
        createdAt: "2026-07-22T10:00:00Z",
        sectionsWithContent: 9,
        file: "002.json",
        sectionsCaptured: 9,
      },
    ]);
    expect(card).toContain("#002");
    expect(card).toContain("…");
    expect(card).toContain("9/17");
    expect(card).toContain("the ratio counts sections carrying content");
  });
});

describe("renderValidation", () => {
  it("says structure only when a document is valid", () => {
    const card = renderValidation(validateHandover(doc), "the document");
    expect(card).toContain("valid handover");
    expect(card).toContain("says nothing about how good the content is");
  });

  it("lists every problem when it is not", () => {
    const card = renderValidation(
      validateHandover({ soilHandover: "1.0" }),
      "x",
    );
    expect(card).toContain("not a handover");
    expect(card).toContain("/projectId");
  });
});
