/**
 * The extension point, tested from the angle that matters: a reader meeting a
 * producer it has never heard of.
 */
import { describe, expect, it } from "vitest";

import { normalizeHandover } from "./normalize.js";
import { buildRestorePrompt } from "./restore.js";
import { findSecretMaterial } from "./safety.js";
import { validateHandover } from "./validate.js";

const AT = "2026-07-22T10:00:00.000Z";

function withObservations(observations: unknown): unknown {
  return normalizeHandover({
    handoverId: "019f7e89-fc00-7000-8000-000000000000",
    projectId: "extension-test",
    title: "Extension point",
    createdAt: AT,
    sections: { executiveSummary: "A project." },
    observations,
  });
}

describe("observations", () => {
  it("are optional: a handover without any is complete", () => {
    const doc = normalizeHandover({
      handoverId: "019f7e89-fc00-7000-8000-000000000000",
      projectId: "none",
      title: "None",
      createdAt: AT,
      sections: { decisions: "one" },
    });
    expect(doc.observations).toBeUndefined();
    expect(validateHandover(doc).valid).toBe(true);
  });

  it("accept a kind this implementation has never heard of", () => {
    const doc = withObservations([
      { kind: "com.example.kind.from.the.future", data: { anything: [1, 2] } },
    ]);
    expect(validateHandover(doc).valid).toBe(true);
  });

  it("carry unknown entries through normalization unchanged", () => {
    const entries = [
      {
        kind: "com.example.measurement",
        producedBy: "example-service 3.2",
        producedAt: "2026-07-20T09:00:00Z",
        data: { nested: { deeply: { value: 4 } } },
      },
      { kind: "dev.example.annotation", data: {} },
    ];
    const doc = withObservations(entries) as { observations: unknown };
    expect(doc.observations).toEqual(entries);
  });

  it("do not change how the sections are read", () => {
    const base = normalizeHandover({
      projectId: "extension-test",
      title: "Extension point",
      createdAt: "2026-07-22T10:00:00Z",
      sections: {
        executiveSummary: "A project.",
        decisions: "One decision.",
      },
    });
    const observed = {
      ...base,
      observations: [{ kind: "com.example.anything", data: { score: 11 } }],
    };
    // A fixed boundary token, because production takes a fresh one from the
    // platform's cryptographic source on every render and the point here is
    // the sections, not the boundary.
    const token = "0123456789abcdef0123456789abcdef";
    expect(buildRestorePrompt(observed, { boundaryToken: token })).toBe(
      buildRestorePrompt(base, { boundaryToken: token }),
    );
  });

  it("reject an entry with a key outside the envelope", () => {
    const result = validateHandover(
      withObservations([{ kind: "a.kind", data: {}, extra: "no" }]),
    );
    expect(result.issues[0]?.path).toBe("/observations/0/extra");
  });

  it("reject an entry with no kind or no data", () => {
    expect(
      validateHandover(withObservations([{ data: {} }])).issues[0]?.path,
    ).toBe("/observations/0/kind");
    expect(
      validateHandover(withObservations([{ kind: "a.kind" }])).issues[0]?.path,
    ).toBe("/observations/0/data");
  });

  it("reject a producedAt that is not a timestamp", () => {
    const result = validateHandover(
      withObservations([{ kind: "a.kind", producedAt: "recently", data: {} }]),
    );
    expect(result.issues[0]?.path).toBe("/observations/0/producedAt");
  });

  it("reject observations that are not an array", () => {
    expect(
      validateHandover(withObservations({ kind: "a.kind", data: {} })).valid,
    ).toBe(false);
  });

  it("are covered by the secret scan, however deep the payload goes", () => {
    const doc = withObservations([
      {
        kind: "com.example.measurement",
        data: {
          call: {
            header: "Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e",
          },
        },
      },
    ]);
    expect(findSecretMaterial(doc)[0]?.path).toBe(
      "/observations/0/data/call/header",
    );
    const result = validateHandover(doc);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.kind).toBe("safety");
  });
});
