import { describe, expect, it } from "vitest";

import { extractJsonBlock, normalizeHandover } from "./normalize.js";
import { SECTION_KEYS } from "./sections.js";
import { validateHandover } from "./validate.js";

const AN_ID = "019f7e89-fc00-7000-8000-000000000000";
const A_TIME = "2026-07-22T10:00:00Z";

/** The one field a loose reply never carries, added so a test can isolate. */
function identified(document: unknown): Record<string, unknown> {
  return { ...(document as Record<string, unknown>), handoverId: AN_ID };
}

describe("normalizeHandover", () => {
  it("declares all 17 sections even from an empty object", () => {
    const doc = normalizeHandover({});
    expect(Object.keys(doc.sections)).toEqual([...SECTION_KEYS]);
    expect(doc.sections.decisions).toEqual({
      status: "missing",
      summary: null,
    });
  });

  it("accepts the loose extractionSections key", () => {
    const doc = normalizeHandover({
      projectId: "loose",
      title: "Loose",
      extractionSections: { decisions: "We picked Postgres." },
    });
    expect(doc.sections.decisions).toEqual({
      status: "available",
      summary: "We picked Postgres.",
    });
    // Consumed, not carried: it IS the source of `sections` here, so leaving
    // it in place would fail the document on a key that was actually read.
    expect("extractionSections" in doc).toBe(false);
  });

  it("turns a bare string into an available section", () => {
    const doc = normalizeHandover({
      sections: { workflow: "  Review before merge.  " },
    });
    expect(doc.sections.workflow).toEqual({
      status: "available",
      summary: "Review before merge.",
    });
  });

  it("treats an empty string as a gap rather than as content", () => {
    const doc = normalizeHandover({ sections: { workflow: "   " } });
    expect(doc.sections.workflow.status).toBe("missing");
  });

  it("infers available when an object has a summary but no status", () => {
    const doc = normalizeHandover({
      sections: { blockers: { summary: "The sandbox is down." } },
    });
    expect(doc.sections.blockers.status).toBe("available");
  });

  it("keeps an explicit blocked status and its note", () => {
    const doc = normalizeHandover({
      sections: {
        architecture: { status: "blocked", summary: "Host names withheld." },
      },
    });
    expect(doc.sections.architecture).toEqual({
      status: "blocked",
      summary: "Host names withheld.",
    });
  });

  it("keeps an unrecognised status so validation refuses it", () => {
    // Wrong capitalisation is the common case. Rewriting it to `available`
    // would let a typo become content that counts as captured, and the
    // author would never be told.
    for (const wrong of ["Available", "AVAILABLE", "partial", "done"]) {
      const doc = normalizeHandover({
        sections: { decisions: { status: wrong, summary: "One decision." } },
      });
      expect(doc.sections.decisions.status).toBe(wrong);
      const result = validateHandover({
        ...doc,
        handoverId: AN_ID,
        projectId: "status-test",
        title: "Status",
        createdAt: A_TIME,
      });
      expect(result.valid).toBe(false);
      expect(
        result.issues.some(
          (issue) =>
            issue.path === "/sections/decisions/status" &&
            issue.kind === "structure",
        ),
      ).toBe(true);
    }
  });
});

/**
 * The closed-world contract, on the normalization path.
 *
 * Version one has no room for an unknown field, and normalization is not
 * allowed to make room by deleting one. Each of these used to be dropped
 * silently, which meant `soil validate` rejected a document and `soil save`
 * stored it, from the same bytes.
 */
describe("normalizeHandover carries unknown content to validation", () => {
  const base = {
    soilHandover: "1.0",
    handoverId: AN_ID,
    projectId: "closed-world",
    title: "Closed world",
    createdAt: A_TIME,
  };

  it("keeps an unknown top-level field", () => {
    const doc = normalizeHandover({ ...base, grade: 0.92 });
    expect((doc as unknown as Record<string, unknown>)["grade"]).toBe(0.92);
    const result = validateHandover(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain("/grade");
  });

  it("keeps an unknown field on a section", () => {
    const doc = normalizeHandover({
      ...base,
      sections: {
        decisions: { status: "available", summary: "One.", confidence: 0.4 },
      },
    });
    const result = validateHandover(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain(
      "/sections/decisions/confidence",
    );
  });

  it("keeps an unknown section key", () => {
    const doc = normalizeHandover({
      ...base,
      sections: { vibes: { status: "available", summary: "Good." } },
    });
    const result = validateHandover(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain(
      "/sections/vibes",
    );
  });

  it("keeps a provenance label it does not recognise", () => {
    // The eleven labels are frozen for the whole of version one, because
    // provenance is the format's only trust mechanism. Quietly deleting a
    // twelfth would leave a section looking better sourced than it is.
    const doc = normalizeHandover({
      ...base,
      sections: {
        decisions: {
          status: "available",
          summary: "one",
          provenance: ["model_reported", "vibe_checked"],
        },
      },
    });
    expect(doc.sections.decisions.provenance).toEqual([
      "model_reported",
      "vibe_checked",
    ]);
    const result = validateHandover(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain(
      "/sections/decisions/provenance/1",
    );
  });

  it("keeps an unknown member of source, quality and safety", () => {
    const doc = normalizeHandover({
      ...base,
      source: { client: "some-tool", temperature: 0.7 },
      quality: { missingInputs: ["the logs"], score: 3 },
      safety: { unsafeOmissions: ["a key exists"], redacted: true },
    });
    const paths = validateHandover(doc).issues.map((issue) => issue.path);
    expect(paths).toContain("/source/temperature");
    expect(paths).toContain("/quality/score");
    expect(paths).toContain("/safety/redacted");
  });

  it("keeps a section value it cannot reshape", () => {
    const doc = normalizeHandover({ ...base, sections: { decisions: 42 } });
    const result = validateHandover(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain(
      "/sections/decisions",
    );
  });

  it("does not upgrade or downgrade a declared version", () => {
    const higher = normalizeHandover({ ...base, soilHandover: "1.7" });
    expect(higher.soilHandover).toBe("1.7");
    expect(validateHandover(higher).valid).toBe(false);
    const major = normalizeHandover({ ...base, soilHandover: "2.0" });
    expect(major.soilHandover).toBe("2.0");
    expect(validateHandover(major).valid).toBe(false);
  });
});

describe("normalizeHandover invents nothing", () => {
  it("does not stamp a createdAt the document never carried", () => {
    // The anchor every frontier section is read against. A wall clock read at
    // save time is indistinguishable, to a consumer, from a time the session
    // actually reported.
    const doc = normalizeHandover({ projectId: "no-time", title: "No time" });
    expect("createdAt" in doc).toBe(false);
    const result = validateHandover(identified(doc));
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain("/createdAt");
  });

  it("keeps a createdAt it cannot parse instead of replacing it", () => {
    const doc = normalizeHandover({
      projectId: "bad-time",
      title: "Bad time",
      createdAt: "last Tuesday",
    });
    expect(doc.createdAt).toBe("last Tuesday");
    expect(
      validateHandover(identified(doc)).issues.map((issue) => issue.path),
    ).toContain("/createdAt");
  });

  it("does not stamp a recipe version onto a document it did not produce", () => {
    const doc = normalizeHandover({ projectId: "recipe", title: "Recipe" });
    expect("source" in doc).toBe(false);
  });

  it("keeps a recipe version the input states", () => {
    const doc = normalizeHandover({
      projectId: "recipe",
      title: "Recipe",
      source: { recipeVersion: "0.9.9" },
    });
    expect(doc.source?.recipeVersion).toBe("0.9.9");
  });

  it("does not invent a project id, so validation can say so", () => {
    const doc = normalizeHandover({ title: "No slug" });
    expect(doc.projectId).toBe("");
    expect(validateHandover(doc).valid).toBe(false);
  });

  it("keeps a malformed handoverId rather than letting a writer replace it", () => {
    // Dropping it is what makes the replacement possible: the writer then sees
    // a document with no id and mints one, and nobody is ever told the id the
    // document arrived with was wrong.
    for (const malformed of [42, "handover-42", "", null]) {
      const doc = normalizeHandover({
        soilHandover: "1.0",
        handoverId: malformed,
        projectId: "identity",
        title: "Identity",
        createdAt: A_TIME,
      });
      expect("handoverId" in doc).toBe(true);
      const result = validateHandover(doc);
      expect(result.valid).toBe(false);
      expect(result.issues.map((issue) => issue.path)).toContain("/handoverId");
    }
  });

  it("keeps an existing handoverId and never mints one", () => {
    const kept = normalizeHandover({
      handoverId: AN_ID,
      projectId: "identified",
      title: "Identified",
    });
    expect(kept.handoverId).toBe(AN_ID);
    const fresh = normalizeHandover({
      projectId: "unidentified",
      title: "Unidentified",
    });
    expect(fresh.handoverId).toBeUndefined();
  });

  it("leaves a complete reply one writer-assigned id from valid", () => {
    const doc = normalizeHandover({
      projectId: "rescue-test",
      title: "Rescued from a full thread",
      createdAt: A_TIME,
      extractionSections: {
        projectIdentity: "A test project.",
        decisions: { status: "available", summary: "One decision." },
        blockers: { status: "missing", summary: null },
      },
    });
    const result = validateHandover(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(["/handoverId"]);
    expect(validateHandover(identified(doc)).valid).toBe(true);
  });

  it("keeps a quality entry it cannot use, rather than deleting it", () => {
    const doc = normalizeHandover({
      projectId: "notes",
      title: "Notes",
      createdAt: A_TIME,
      quality: { missingInputs: ["the logs", "  ", 7] },
      safety: { unsafeOmissions: ["  a key exists in the platform config  "] },
    });
    expect(doc.quality?.missingInputs).toEqual(["the logs", "  ", 7]);
    expect(doc.safety?.unsafeOmissions).toEqual([
      "a key exists in the platform config",
    ]);
    const paths = validateHandover(identified(doc)).issues.map(
      (issue) => issue.path,
    );
    expect(paths).toContain("/quality/missingInputs/1");
    expect(paths).toContain("/quality/missingInputs/2");
  });
});

describe("extractJsonBlock", () => {
  it("pulls JSON out of a fenced block wrapped in prose", () => {
    const text = 'Sure!\n\n```json\n{"a":1}\n```\n\nAnything else?';
    expect(extractJsonBlock(text)).toBe('{"a":1}');
  });

  it("handles a fence with no language tag", () => {
    expect(extractJsonBlock('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("falls back to the outermost braces", () => {
    expect(extractJsonBlock('here you go: {"a":{"b":2}} done')).toBe(
      '{"a":{"b":2}}',
    );
  });

  it("returns undefined when there is no JSON at all", () => {
    expect(extractJsonBlock("I could not do that")).toBeUndefined();
  });
});
