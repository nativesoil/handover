import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeHandover } from "./normalize.js";
import {
  HandoverNotFoundError,
  HandoverStore,
  countSections,
  formatCode,
  parseCode,
  resolveStoreHome,
} from "./store.js";
import type { Handover } from "./types.js";

const AT = "2026-07-22T10:00:00.000Z";

function handover(
  title: string,
  sections: Record<string, string> = {},
): Handover {
  return normalizeHandover({
    projectId: "store-test",
    title,
    createdAt: AT,
    sections,
  });
}

describe("codes", () => {
  it("pads to three digits", () => {
    expect(formatCode(1)).toBe("#001");
    expect(formatCode(42)).toBe("#042");
    expect(formatCode(1234)).toBe("#1234");
  });

  it("parses the shapes a person actually types", () => {
    expect(parseCode("#004")).toBe(4);
    expect(parseCode("004")).toBe(4);
    expect(parseCode(" 4 ")).toBe(4);
    expect(parseCode("#abc")).toBeUndefined();
    expect(parseCode("#000")).toBeUndefined();
  });
});

describe("resolveStoreHome", () => {
  it("prefers SOIL_HOME", () => {
    expect(resolveStoreHome({ SOIL_HOME: "/tmp/elsewhere" })).toBe(
      "/tmp/elsewhere",
    );
  });

  it("falls back to a .soil directory in the home directory", () => {
    expect(resolveStoreHome({})).toMatch(/\.soil$/);
  });
});

describe("countSections", () => {
  it("counts by status and never scores", () => {
    const doc = normalizeHandover({
      createdAt: AT,
      sections: {
        decisions: "one",
        workflow: "two",
        architecture: { status: "blocked", summary: "withheld" },
      },
    });
    expect(countSections(doc)).toEqual({
      withContent: 2,
      missing: 14,
      blocked: 1,
      notApplicable: 0,
      total: 17,
    });
  });

  it("counts a section that does not apply on its own, never as missing", () => {
    const doc = normalizeHandover({
      createdAt: AT,
      sections: {
        decisions: "one",
        architecture: {
          status: "not_applicable",
          summary: "A manuscript has no system to describe.",
        },
        safetySummary: {
          status: "not_applicable",
          summary: "Nothing here holds a value that could be withheld.",
        },
      },
    });
    expect(countSections(doc)).toEqual({
      withContent: 1,
      missing: 14,
      blocked: 0,
      notApplicable: 2,
      total: 17,
    });
  });
});

describe("HandoverStore", () => {
  let home: string;
  let store: HandoverStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "soil-store-test-"));
    store = new HandoverStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("starts empty", () => {
    expect(store.list()).toEqual([]);
  });

  it("hands out codes in order and never reuses one", () => {
    expect(store.save(handover("first")).code).toBe("#001");
    expect(store.save(handover("second")).code).toBe("#002");
    expect(store.save(handover("third")).code).toBe("#003");
  });

  it("writes one readable JSON file per handover", () => {
    store.save(handover("readable", { decisions: "We chose files." }));
    const raw = readFileSync(join(home, "handovers", "001.json"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      code: "#001",
      sections: { decisions: { status: "available" } },
    });
  });

  it("reads a handover back by code, by bare number, and by last", () => {
    store.save(handover("first"));
    store.save(handover("second"));
    expect(store.read("#001").title).toBe("first");
    expect(store.read("1").title).toBe("first");
    expect(store.read("last").title).toBe("second");
  });

  it("lists newest first with the section count", () => {
    store.save(handover("first", { decisions: "one" }));
    store.save(handover("second"));
    const entries = store.list();
    expect(entries.map((entry) => entry.code)).toEqual(["#002", "#001"]);
    expect(entries[1]?.sectionsWithContent).toBe(1);
  });

  it("assigns a UUIDv7 at save time and keeps an id that is already there", () => {
    const assigned = store.save(handover("fresh"));
    const stored = store.read(assigned.code);
    expect(stored.handoverId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const copied = store.save(stored);
    expect(store.read(copied.code).handoverId).toBe(stored.handoverId);
  });

  it("refuses to store an invalid document", () => {
    expect(() => store.save({ title: "nope" } as never)).toThrow(
      /not a valid Soil handover/,
    );
  });

  it("says so when a code does not exist", () => {
    expect(() => store.read("#404")).toThrow(HandoverNotFoundError);
    expect(() => store.read("last")).toThrow(HandoverNotFoundError);
  });

  it("updates a stored handover in place, keeping identity and code", () => {
    store.save(handover("original", { decisions: "We chose files." }));
    const stored = store.read("#001");
    const observation = {
      kind: "quality.capture",
      producedBy: "soil-cli/0.1.0",
      producedAt: "2026-07-22T10:00:00Z",
      data: { sectionsWithContent: 1 },
    };
    const entry = store.update("#001", {
      ...stored,
      observations: [observation],
    });
    expect(entry.code).toBe("#001");
    const updated = store.read("#001");
    expect(updated.handoverId).toBe(stored.handoverId);
    expect(updated.code).toBe("#001");
    expect(updated.observations).toEqual([observation]);
    expect(updated.sections).toEqual(stored.sections);
    expect(store.readIndex().nextCode).toBe(2);
  });

  it("refreshes the index row on update", () => {
    store.save(handover("original", { decisions: "We chose files." }));
    const stored = store.read("#001");
    store.update("#001", { ...stored, title: "retitled" });
    expect(store.list()[0]?.title).toBe("retitled");
    expect(store.list()).toHaveLength(1);
  });

  it("refuses an update that changes the handoverId", () => {
    store.save(handover("original"));
    const stored = store.read("#001");
    expect(() =>
      store.update("#001", {
        ...stored,
        handoverId: "019f7e89-fc00-7000-8000-00000000ffff",
      }),
    ).toThrow(/handoverId never changes/);
  });

  it("refuses an update that does not validate", () => {
    store.save(handover("original"));
    const stored = store.read("#001");
    expect(() =>
      store.update("#001", { ...stored, title: "" } as never),
    ).toThrow(/not a valid Soil handover/);
  });

  it("says so when updating a code that does not exist", () => {
    expect(() => store.update("#404", handover("nowhere"))).toThrow(
      HandoverNotFoundError,
    );
  });

  it("rebuilds the index from the files, because the files are the truth", () => {
    store.save(handover("first"));
    store.save(handover("second"));
    writeFileSync(
      join(home, "index.json"),
      JSON.stringify({ indexVersion: 1, nextCode: 1, entries: [] }),
    );
    const rebuilt = store.reindex();
    expect(rebuilt.entries.map((entry) => entry.code)).toEqual([
      "#001",
      "#002",
    ]);
    expect(rebuilt.nextCode).toBe(3);
  });

  it("skips unreadable files when rebuilding rather than giving up", () => {
    store.save(handover("good"));
    writeFileSync(join(home, "handovers", "099.json"), '{"not":"a handover"}');
    expect(store.reindex().entries).toHaveLength(1);
  });
});
