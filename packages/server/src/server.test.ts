import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkHandover } from "@nativesoil/handover-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  makeHome,
  personalHandoversDir,
  removeHome,
  requestJson,
  seedHome,
  startTestServer,
  validHandover,
  type SeededTokens,
  type TestServer,
} from "./test-support.js";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe("object");
  return value as Record<string, unknown>;
}

describe("the HTTP API", () => {
  let home: string;
  let tokens: SeededTokens;
  let ts: TestServer;

  beforeEach(async () => {
    home = makeHome();
    tokens = seedHome(home);
    ts = await startTestServer(home);
  });

  afterEach(async () => {
    await ts.close();
    removeHome(home);
  });

  describe("auth", () => {
    it("rejects a request with no token", async () => {
      const { status, json, headers } = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers",
      );
      expect(status).toBe(401);
      expect(asRecord(json)["error"]).toBe("unauthorized");
      expect(headers.get("www-authenticate")).toBe("Bearer");
    });

    it("rejects a wrong token", async () => {
      const { status } = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers",
        "0".repeat(64),
      );
      expect(status).toBe(401);
    });

    it("rejects a malformed authorization header", async () => {
      const response = await fetch(`${ts.base}/v1/handovers`, {
        headers: { authorization: `Basic ${tokens.alice}` },
      });
      expect(response.status).toBe(401);
      await response.text();
    });
  });

  describe("check at save", () => {
    // The strong document is the install guide's own inline test document,
    // read out of the guide rather than copied, so the `strong` this test
    // expects and the `strong` the guide promises are one claim. The guide's
    // executed test already holds that document to the grade.
    const strongDocument = (): Record<string, unknown> => {
      const guide = readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../../..",
          "docs/install-with-an-agent.md",
        ),
        "utf8",
      );
      const block = [...guide.matchAll(/```json\n([\s\S]*?)```/g)]
        .map((match) => match[1] ?? "")
        .find((body) => body.includes("install-smoke-test"));
      expect(block).toBeDefined();
      return JSON.parse(block as string) as Record<string, unknown>;
    };

    it("reports the grade and finding counts on the receipt, for a strong document", async () => {
      const saved = await requestJson(
        ts.base,
        "POST",
        "/v1/handovers",
        tokens.alice,
        strongDocument(),
      );
      expect(saved.status).toBe(201);
      const check = asRecord(asRecord(saved.json)["check"]);
      expect(check["grade"]).toBe("strong");
      expect(check["problems"]).toBe(0);
      expect(check["cautions"]).toBe(0);
      expect(typeof check["advice"]).toBe("number");
    });

    it("reports a poor grade on a thin document without changing the status", async () => {
      // A finished document through this door declares all 17 sections, so
      // the thin fixture starts from the valid one and empties it down to a
      // single one-line section.
      const document = validHandover();
      const sections = document["sections"] as Record<string, unknown>;
      sections["projectIdentity"] = { status: "missing", summary: null };
      sections["decisions"] = { status: "missing", summary: null };
      sections["executiveSummary"] = {
        status: "available",
        summary: "Some work happened.",
      };
      const saved = await requestJson(
        ts.base,
        "POST",
        "/v1/handovers",
        tokens.alice,
        document,
      );
      // The grade never touches the status: an honest gap never blocks a
      // save, so a poorly graded document is stored and answered 201 exactly
      // like a strong one.
      expect(saved.status).toBe(201);
      const receipt = asRecord(saved.json);
      expect(receipt["code"]).toBe("#001");
      const check = asRecord(receipt["check"]);
      expect(["thin", "failing"]).toContain(check["grade"]);

      // The wire grade is the deterministic checker's verdict on the stored
      // document itself, not a second opinion: recompute it from what a load
      // hands back and the two must agree.
      const loaded = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers/%23001",
        tokens.alice,
      );
      const stored = asRecord(loaded.json)["handover"];
      const report = checkHandover(stored as never);
      expect(check["grade"]).toBe(report.grade);
      expect(check["problems"]).toBe(report.counts.problems);
      expect(check["cautions"]).toBe(report.counts.cautions);
      expect(check["advice"]).toBe(report.counts.advice);
    });

    it("writes nothing from the report onto the stored document", async () => {
      await requestJson(
        ts.base,
        "POST",
        "/v1/handovers",
        tokens.alice,
        validHandover(),
      );
      const loaded = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers/%23001",
        tokens.alice,
      );
      const stored = asRecord(asRecord(loaded.json)["handover"]);
      expect(stored["check"]).toBeUndefined();
      expect(stored["grade"]).toBeUndefined();
    });
  });

  describe("personal handovers", () => {
    it("saves, lists and loads over real HTTP", async () => {
      const saved = await requestJson(
        ts.base,
        "POST",
        "/v1/handovers",
        tokens.alice,
        validHandover(),
      );
      expect(saved.status).toBe(201);
      const receipt = asRecord(saved.json);
      expect(receipt["code"]).toBe("#001");
      expect(receipt["project"]).toBeNull();
      // The receipt's counts carry the honest name only: `withContent`, with
      // no `captured` mirror beside it.
      expect(asRecord(receipt["sections"])["withContent"]).toBe(2);
      expect(asRecord(receipt["sections"])["captured"]).toBeUndefined();

      const listed = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers",
        tokens.alice,
      );
      expect(listed.status).toBe(200);
      const rows = asRecord(listed.json)["handovers"] as Record<
        string,
        unknown
      >[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["scope"]).toBe("personal");
      expect(rows[0]?.["code"]).toBe("#001");
      // The list row too: the old `sectionsCaptured` key is gone from the wire.
      expect(rows[0]?.["sectionsWithContent"]).toBe(2);
      expect(rows[0]?.["sectionsCaptured"]).toBeUndefined();

      const loaded = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers/%23001",
        tokens.alice,
      );
      expect(loaded.status).toBe(200);
      const body = asRecord(loaded.json);
      expect(asRecord(body["handover"])["title"]).toBe(
        "Billing rework, midpoint",
      );
      expect(String(body["restorePrompt"])).toContain("billing-rework");
      expect(String(body["restorePrompt"])).toContain("outbox pattern");

      const last = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers/last",
        tokens.alice,
      );
      expect(last.status).toBe(200);
    });

    it("keeps personal stores apart", async () => {
      await requestJson(
        ts.base,
        "POST",
        "/v1/handovers",
        tokens.alice,
        validHandover(),
      );
      const bobs = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers",
        tokens.bob,
      );
      expect(asRecord(bobs.json)["handovers"]).toHaveLength(0);
      const load = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers/1",
        tokens.bob,
      );
      expect(load.status).toBe(404);
    });
  });

  describe("identity rules", () => {
    it("assigns a UUIDv7 when the document has none", async () => {
      const saved = await requestJson(
        ts.base,
        "POST",
        "/v1/handovers",
        tokens.alice,
        validHandover(),
      );
      expect(String(asRecord(saved.json)["handoverId"])).toMatch(UUID_V7);
    });

    it("keeps the id of a copied document", async () => {
      const id = "01234567-89ab-7cde-8f01-23456789abcd";
      const saved = await requestJson(
        ts.base,
        "POST",
        "/v1/handovers",
        tokens.alice,
        validHandover({ handoverId: id }),
      );
      expect(saved.status).toBe(201);
      expect(asRecord(saved.json)["handoverId"]).toBe(id);
    });

    it("refuses a malformed id rather than replacing it", async () => {
      const saved = await requestJson(
        ts.base,
        "POST",
        "/v1/handovers",
        tokens.alice,
        validHandover({ handoverId: "not-a-uuid" }),
      );
      expect(saved.status).toBe(422);
    });
  });

  describe("the fail-closed secret scan", () => {
    it("refuses and stores nothing", async () => {
      const doc = validHandover();
      (doc["sections"] as Record<string, unknown>)["architecture"] = {
        status: "available",
        summary: "The key sk-abc123def is exported in the shell profile.",
      };
      const saved = await requestJson(
        ts.base,
        "POST",
        "/v1/handovers",
        tokens.alice,
        doc,
      );
      expect(saved.status).toBe(422);
      const body = asRecord(saved.json);
      expect(String(body["error"])).toContain("nothing was stored");
      const issues = body["issues"] as Record<string, unknown>[];
      expect(issues.some((issue) => issue["kind"] === "safety")).toBe(true);
      // The refusal must never echo the value it matched.
      expect(JSON.stringify(body)).not.toContain("sk-abc123def");

      const aliceDir = personalHandoversDir(home, "alice");
      expect(!existsSync(aliceDir) || readdirSync(aliceDir).length === 0).toBe(
        true,
      );
      const listed = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers",
        tokens.alice,
      );
      expect(asRecord(listed.json)["handovers"]).toHaveLength(0);
    });

    it("refuses a structurally broken document the same way", async () => {
      const saved = await requestJson(
        ts.base,
        "POST",
        "/v1/handovers",
        tokens.alice,
        { soilHandover: "1.0", title: 42 },
      );
      expect(saved.status).toBe(422);
    });
  });

  describe("projects and membership", () => {
    it("lists only the caller's memberships", async () => {
      const alice = await requestJson(
        ts.base,
        "GET",
        "/v1/projects",
        tokens.alice,
      );
      const aliceProjects = asRecord(alice.json)["projects"] as Record<
        string,
        unknown
      >[];
      expect(aliceProjects.map((p) => p["id"])).toEqual(["team-x"]);

      const mallory = await requestJson(
        ts.base,
        "GET",
        "/v1/projects",
        tokens.mallory,
      );
      expect(asRecord(mallory.json)["projects"]).toHaveLength(0);
    });

    it("shares a project save between members", async () => {
      const saved = await requestJson(
        ts.base,
        "POST",
        "/v1/handovers",
        tokens.alice,
        { handover: validHandover(), project: "team-x" },
      );
      expect(saved.status).toBe(201);
      expect(asRecord(saved.json)["project"]).toBe("team-x");

      const bobLoad = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers/%23001?project=team-x",
        tokens.bob,
      );
      expect(bobLoad.status).toBe(200);

      const bobList = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers",
        tokens.bob,
      );
      const rows = asRecord(bobList.json)["handovers"] as Record<
        string,
        unknown
      >[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["scope"]).toBe("project");
      expect(rows[0]?.["project"]).toBe("team-x");
    });

    it("gives a non-member 404, never 403, on every project operation", async () => {
      await requestJson(ts.base, "POST", "/v1/handovers", tokens.alice, {
        handover: validHandover(),
        project: "team-x",
      });

      const load = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers/%23001?project=team-x",
        tokens.mallory,
      );
      expect(load.status).toBe(404);

      const save = await requestJson(
        ts.base,
        "POST",
        "/v1/handovers",
        tokens.mallory,
        {
          handover: validHandover(),
          project: "team-x",
        },
      );
      expect(save.status).toBe(404);

      const list = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers?project=team-x",
        tokens.mallory,
      );
      expect(list.status).toBe(404);

      // A project that does not exist answers identically.
      const ghost = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers?project=no-such-project",
        tokens.mallory,
      );
      expect(ghost.status).toBe(404);
      expect(asRecord(ghost.json)["error"]).toContain("not found");

      const mallorysView = await requestJson(
        ts.base,
        "GET",
        "/v1/handovers",
        tokens.mallory,
      );
      expect(asRecord(mallorysView.json)["handovers"]).toHaveLength(0);
    });
  });

  describe("edges", () => {
    it("answers 404 for unknown paths and 400 for broken JSON", async () => {
      const missing = await requestJson(
        ts.base,
        "GET",
        "/v1/nothing",
        tokens.alice,
      );
      expect(missing.status).toBe(404);

      const response = await fetch(`${ts.base}/v1/handovers`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.alice}`,
          "content-type": "application/json",
        },
        body: "{not json",
      });
      expect(response.status).toBe(400);
      await response.text();
    });
  });
});
