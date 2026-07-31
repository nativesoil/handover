import { describe, expect, it } from "vitest";

import { SECTION_KEYS } from "./sections.js";
import type { Handover } from "./types.js";
import {
  HandoverValidationError,
  assertHandover,
  validateHandover,
} from "./validate.js";

function sections(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const key of SECTION_KEYS) {
    base[key] = { status: "missing", summary: null };
  }
  return { ...base, ...overrides };
}

function handover(overrides: Record<string, unknown> = {}): unknown {
  return {
    soilHandover: "1.0",
    handoverId: "019f7e89-fc00-7000-8000-000000000000",
    projectId: "test-project",
    title: "A handover",
    createdAt: "2026-07-20T08:00:00Z",
    sections: sections(),
    ...overrides,
  };
}

describe("validateHandover", () => {
  it("accepts a handover where every section is missing", () => {
    expect(validateHandover(handover()).valid).toBe(true);
  });

  it("accepts an offset timestamp, not only Z", () => {
    expect(
      validateHandover(handover({ createdAt: "2026-07-20T08:00:00+02:00" }))
        .valid,
    ).toBe(true);
  });

  it("reports every problem at once, not just the first", () => {
    const result = validateHandover({
      soilHandover: "1.0",
      handoverId: "019f7e89-fc00-7000-8000-000000000000",
      title: "",
      createdAt: "yesterday",
      sections: sections(),
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path).sort()).toEqual([
      "/createdAt",
      "/projectId",
      "/title",
    ]);
  });

  it("rejects a dropped section, because a gap is stated not omitted", () => {
    const doc = handover() as { sections: Record<string, unknown> };
    delete doc.sections["decisions"];
    const result = validateHandover(doc);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.path).toBe("/sections/decisions");
  });

  it("rejects a section key nobody has heard of", () => {
    const result = validateHandover(
      handover({
        sections: sections({ vibes: { status: "missing", summary: null } }),
      }),
    );
    expect(result.issues.map((i) => i.path)).toContain("/sections/vibes");
  });

  it("rejects available with no content", () => {
    const result = validateHandover(
      handover({
        sections: sections({
          decisions: { status: "available", summary: "  " },
        }),
      }),
    );
    expect(result.issues[0]?.path).toBe("/sections/decisions/summary");
  });

  it("rejects a status outside the four-word vocabulary", () => {
    const result = validateHandover(
      handover({
        sections: sections({
          decisions: { status: "partial", summary: "half" },
        }),
      }),
    );
    expect(result.issues[0]?.path).toBe("/sections/decisions/status");
  });

  it("accepts a section that does not apply, when it says why", () => {
    const result = validateHandover(
      handover({
        sections: sections({
          architecture: {
            status: "not_applicable",
            summary: "A one-author manuscript has no system to describe.",
          },
        }),
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a section that does not apply and does not say why", () => {
    for (const summary of [null, "", "   "]) {
      const result = validateHandover(
        handover({
          sections: sections({
            architecture: { status: "not_applicable", summary },
          }),
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.issues[0]?.path).toBe("/sections/architecture/summary");
    }
  });

  it("refuses a near neighbour of the fourth status rather than reading it as one", () => {
    for (const status of [
      "notApplicable",
      "not applicable",
      "NOT_APPLICABLE",
    ]) {
      const result = validateHandover(
        handover({
          sections: sections({
            architecture: { status, summary: "There is no system here." },
          }),
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.issues[0]?.path).toBe("/sections/architecture/status");
    }
  });

  it("rejects an unknown provenance label", () => {
    const result = validateHandover(
      handover({
        sections: sections({
          decisions: {
            status: "available",
            summary: "one",
            provenance: ["model_reported", "vibes_based"],
          },
        }),
      }),
    );
    expect(result.issues[0]?.path).toBe("/sections/decisions/provenance/1");
  });

  it("rejects a duplicated provenance label", () => {
    const result = validateHandover(
      handover({
        sections: sections({
          decisions: {
            status: "available",
            summary: "one",
            provenance: ["inferred", "inferred"],
          },
        }),
      }),
    );
    expect(result.issues[0]?.message).toContain("duplicate");
  });

  it("rejects an unknown top-level field, including a grade", () => {
    const result = validateHandover(handover({ grade: "A" }));
    expect(result.issues.map((i) => i.path)).toContain("/grade");
  });

  it("supports exact versions and refuses everything else", () => {
    // Support is a set, not a pattern. A reader that accepts 1.4 because the
    // string starts with "1." is claiming to implement a version nobody has
    // written, and version one is a closed world: whatever that minor allowed
    // would arrive here unrecognised.
    expect(validateHandover(handover({ soilHandover: "1.0" })).valid).toBe(
      true,
    );
    for (const unsupported of [
      "0.9",
      "1.1",
      "1.4",
      "1.10",
      "2.0",
      "1",
      "1.0.0",
      "v1.0",
      "",
    ]) {
      const result = validateHandover(handover({ soilHandover: unsupported }));
      expect(result.valid, unsupported).toBe(false);
      expect(result.issues.map((i) => i.path)).toContain("/soilHandover");
    }
  });

  it("requires a handoverId on a document claiming validity", () => {
    const doc = handover() as Record<string, unknown>;
    delete doc["handoverId"];
    const result = validateHandover(doc);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.path).toBe("/handoverId");
    expect(result.issues[0]?.kind).toBe("structure");
  });

  it("rejects a handoverId that is not a UUID rather than replace it", () => {
    const result = validateHandover(handover({ handoverId: "handover-42" }));
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.path).toBe("/handoverId");
  });

  it("rejects a project id with spaces", () => {
    const result = validateHandover(handover({ projectId: "two words" }));
    expect(result.issues[0]?.path).toBe("/projectId");
  });

  it("accepts a store-assigned code and rejects a malformed one", () => {
    expect(validateHandover(handover({ code: "#004" })).valid).toBe(true);
    expect(validateHandover(handover({ code: "4" })).valid).toBe(false);
  });

  it("accepts stated gaps and safety omissions", () => {
    const result = validateHandover(
      handover({
        quality: { missingInputs: ["the deploy logs"], contradictions: [] },
        safety: {
          unsafeOmissions: ["an API key exists in the platform config"],
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a note that is not text", () => {
    const result = validateHandover(
      handover({ quality: { missingInputs: [7] } }),
    );
    expect(result.issues[0]?.path).toBe("/quality/missingInputs/0");
  });

  it("rejects something that is not an object at all", () => {
    expect(validateHandover("a handover, honest").valid).toBe(false);
    expect(validateHandover(null).valid).toBe(false);
  });
});

describe("assertHandover", () => {
  it("narrows a valid document", () => {
    const doc: unknown = handover();
    assertHandover(doc);
    const typed: Handover = doc;
    expect(typed.projectId).toBe("test-project");
  });

  it("throws with every issue attached", () => {
    try {
      assertHandover({ soilHandover: "1.0" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HandoverValidationError);
      expect((error as HandoverValidationError).issues.length).toBeGreaterThan(
        1,
      );
    }
  });
});
