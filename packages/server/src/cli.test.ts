/**
 * The admin CLI, exercised as an operator would: add people, move them between
 * projects, and take them off the server again, with no hand-editing of JSON
 * anywhere in the story.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";
import { Registry, hashToken } from "./registry.js";
import { ServerService } from "./service.js";
import { makeHome, removeHome, validHandover } from "./test-support.js";

describe("the admin CLI", () => {
  let home: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    home = makeHome();
    out = [];
    err = [];
  });

  afterEach(() => {
    removeHome(home);
  });

  async function cli(...argv: string[]): Promise<number> {
    return runCli(argv, {
      env: { SOIL_SERVER_HOME: home, SOIL_SERVER_LOG: "none" },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
  }

  it("initialises, adds users, and prints a stable id with the token", async () => {
    expect(await cli("init", "--admin", "ada")).toBe(0);
    expect(out.join("\n")).toContain("Created user ada.");
    expect(await cli("user", "add", "grace")).toBe(0);
    expect(out.join("\n")).toContain("User id:");

    out = [];
    expect(await cli("user", "list")).toBe(0);
    const registry = new Registry(home);
    expect(out.join("\n")).toContain(registry.findUser("grace")!.userId);
  });

  it("adds and removes project members after the project exists", async () => {
    await cli("init", "--admin", "ada");
    await cli("user", "add", "grace");
    await cli("user", "add", "mallory");
    expect(await cli("project", "add", "team-x", "--members", "ada")).toBe(0);

    const registry = new Registry(home);
    const service = new ServerService(home);
    const ada = registry.findUser("ada")!.userId;
    const grace = registry.findUser("grace")!.userId;
    service.save(ada, validHandover(), "team-x");

    // Before: grace cannot see the project at all.
    expect(() => service.list(grace, "team-x")).toThrow(/not found/);

    out = [];
    expect(await cli("project", "member", "add", "team-x", "grace")).toBe(0);
    expect(out.join("\n")).toContain("is now a member");
    expect(service.list(grace, "team-x")).toHaveLength(1);

    out = [];
    expect(await cli("project", "member", "remove", "team-x", "grace")).toBe(0);
    expect(out.join("\n")).toContain("no longer a member");
    // Access is gone; the project keeps what is in it.
    expect(() => service.list(grace, "team-x")).toThrow(/not found/);
    expect(service.list(ada, "team-x")).toHaveLength(1);

    // And the refusals are refusals, with an exit code.
    expect(await cli("project", "member", "add", "team-x", "ghost")).toBe(1);
    expect(await cli("project", "member", "remove", "team-x", "mallory")).toBe(
      1,
    );
  });

  it("removes a user, keeps their handovers unless told to purge", async () => {
    await cli("init", "--admin", "ada");
    await cli("user", "add", "grace");
    await cli("project", "add", "team-x", "--members", "ada,grace");

    const registry = new Registry(home);
    const service = new ServerService(home);
    const grace = registry.findUser("grace")!.userId;
    service.save(grace, validHandover({ title: "grace's own notes" }));

    out = [];
    expect(await cli("user", "remove", "grace")).toBe(0);
    expect(registry.findUser("grace")).toBeUndefined();
    expect(registry.projectsFor(grace)).toHaveLength(0);
    expect(existsSync(join(home, "users", grace, "handovers"))).toBe(true);
    expect(out.join("\n")).toContain("no longer authenticates");

    // The name is free, and the next holder inherits nothing.
    expect(await cli("user", "add", "grace")).toBe(0);
    const second = registry.findUser("grace")!.userId;
    expect(second).not.toBe(grace);
    expect(service.list(second)).toHaveLength(0);
    expect(service.memberships(second)).toHaveLength(0);
  });

  it("purges on request", async () => {
    await cli("init", "--admin", "ada");
    const registry = new Registry(home);
    const service = new ServerService(home);
    const ada = registry.findUser("ada")!.userId;
    service.save(ada, validHandover());
    expect(existsSync(join(home, "users", ada, "handovers"))).toBe(true);

    expect(await cli("user", "remove", "ada", "--purge")).toBe(0);
    expect(existsSync(join(home, "users", ada))).toBe(false);
  });

  it("renames without moving anything", async () => {
    await cli("init", "--admin", "ada");
    const registry = new Registry(home);
    const service = new ServerService(home);
    const ada = registry.findUser("ada")!.userId;
    service.save(ada, validHandover());

    expect(await cli("user", "rename", "ada", "augusta")).toBe(0);
    expect(registry.findUser("augusta")!.userId).toBe(ada);
    expect(service.list(ada)).toHaveLength(1);
  });

  it("removes a project, with and without its store", async () => {
    await cli("init", "--admin", "ada");
    await cli("project", "add", "team-x", "--members", "ada");
    const service = new ServerService(home);
    const ada = new Registry(home).findUser("ada")!.userId;
    service.save(ada, validHandover(), "team-x");

    expect(await cli("project", "remove", "team-x")).toBe(0);
    expect(existsSync(join(home, "projects", "team-x", "handovers"))).toBe(
      true,
    );

    await cli("project", "add", "team-y", "--members", "ada");
    service.save(ada, validHandover(), "team-y");
    expect(await cli("project", "remove", "team-y", "--purge")).toBe(0);
    expect(existsSync(join(home, "projects", "team-y"))).toBe(false);
  });

  it("refuses to serve a data directory that predates stable ids, and names the fix", async () => {
    writeFileSync(
      join(home, "users.json"),
      JSON.stringify({
        version: 1,
        users: [
          {
            username: "ada",
            tokenHash: hashToken("ada-token"),
            createdAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    expect(await cli("user", "list")).toBe(1);
    expect(err.join("\n")).toContain("soil-server migrate");

    err = [];
    expect(await cli("serve", "--port", "0")).toBe(1);
    expect(err.join("\n")).toContain("soil-server migrate");

    out = [];
    expect(await cli("migrate")).toBe(0);
    expect(out.join("\n")).toContain("stable id");
    expect(new Registry(home).authenticate("ada-token")).toBeDefined();

    out = [];
    expect(await cli("migrate")).toBe(0);
    expect(out.join("\n")).toContain("already up to date");
  });
});
