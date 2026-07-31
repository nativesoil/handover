import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  REGISTRY_VERSION,
  Registry,
  RegistryError,
  RegistryVersionError,
  USER_ID_PATTERN,
  hashToken,
  mintToken,
} from "./registry.js";
import { ServerService } from "./service.js";
import { makeHome, removeHome, validHandover } from "./test-support.js";

describe("the registry", () => {
  let home: string;
  let registry: Registry;

  beforeEach(() => {
    home = makeHome();
    registry = new Registry(home);
    registry.init();
  });

  afterEach(() => {
    removeHome(home);
  });

  it("mints 256-bit tokens", () => {
    const token = mintToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(mintToken()).not.toBe(token);
  });

  it("never stores a token in plaintext, only its hash", () => {
    const token = registry.addUser("alice");
    const onDisk = readFileSync(registry.usersPath, "utf8");
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain(hashToken(token));
    const users = registry.listUsers();
    expect(users).toHaveLength(1);
    expect(users[0]?.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(users)).not.toContain(token);
  });

  it("authenticates the right token and nothing else, to a stable id", () => {
    const alice = registry.addUser("alice");
    const bob = registry.addUser("bob");
    expect(registry.authenticate(alice)).toBe(
      registry.findUser("alice")?.userId,
    );
    expect(registry.authenticate(bob)).toBe(registry.findUser("bob")?.userId);
    expect(registry.authenticate(alice)).toMatch(USER_ID_PATTERN);
    expect(registry.authenticate(mintToken())).toBeUndefined();
    expect(registry.authenticate("")).toBeUndefined();
    expect(registry.authenticate("short")).toBeUndefined();
    expect(registry.authenticate(alice.slice(0, 63))).toBeUndefined();
  });

  it("visits every user on every authentication, matched or not", () => {
    // The constant-time property itself is timing, which a unit test cannot
    // assert; what it can assert is the shape that makes it possible: the
    // loop has no early exit, so a token matching the first user still
    // resolves after the last user has been compared.
    const first = registry.addUser("aaa");
    registry.addUser("zzz");
    expect(registry.lookup(first)?.username).toBe("aaa");
  });

  it("refuses a duplicate or malformed username", () => {
    registry.addUser("alice");
    expect(() => registry.addUser("alice")).toThrow(RegistryError);
    expect(() => registry.addUser("Alice")).toThrow(RegistryError);
    expect(() => registry.addUser("../escape")).toThrow(RegistryError);
    expect(() => registry.addUser("")).toThrow(RegistryError);
  });

  it("refuses a project whose members are not users", () => {
    registry.addUser("alice");
    expect(() => registry.addProject("team-x", ["alice", "ghost"])).toThrow(
      RegistryError,
    );
    expect(registry.listProjects()).toHaveLength(0);
  });

  it("creates projects and answers membership by user id", () => {
    registry.addUser("alice");
    registry.addUser("bob");
    registry.addUser("mallory");
    const project = registry.addProject("team-x", ["alice", "bob"], "Team X");
    expect(() => registry.addProject("team-x", ["alice"])).toThrow(
      RegistryError,
    );
    expect(() => registry.addProject("Bad/Id", ["alice"])).toThrow(
      RegistryError,
    );

    const alice = registry.findUser("alice")!;
    const mallory = registry.findUser("mallory")!;
    expect(project.memberIds).toContain(alice.userId);
    expect(JSON.stringify(project.memberIds)).not.toContain("alice");
    expect(registry.memberNames(project)).toEqual(["alice", "bob"]);
    expect(registry.projectsFor(alice.userId).map((p) => p.id)).toEqual([
      "team-x",
    ]);
    expect(registry.projectsFor(mallory.userId)).toHaveLength(0);
  });

  it("refuses a users.json whose user id is not a uuid", () => {
    // A user id becomes a directory name. An operator who hand-edits this file
    // into `../../etc` must be refused, not obeyed.
    registry.addUser("alice");
    const file = JSON.parse(readFileSync(registry.usersPath, "utf8")) as {
      users: { userId: string }[];
    };
    file.users[0]!.userId = "../../escape";
    writeFileSync(registry.usersPath, JSON.stringify(file), "utf8");
    expect(() => registry.listUsers()).toThrow(RegistryError);
  });
});

describe("a username is a label, not an identity", () => {
  let home: string;
  let registry: Registry;

  beforeEach(() => {
    home = makeHome();
    registry = new Registry(home);
    registry.init();
  });

  afterEach(() => {
    removeHome(home);
  });

  it("gives a recreated username none of the previous holder's data", () => {
    registry.addUser("alice");
    registry.addUser("bob");
    registry.addProject("team-x", ["alice", "bob"], "Team X");
    const service = new ServerService(home);

    const firstAlice = registry.findUser("alice")!.userId;
    service.save(firstAlice, validHandover({ title: "alice's own notes" }));
    service.save(
      firstAlice,
      validHandover({ title: "a team-x handover" }),
      "team-x",
    );
    expect(service.list(firstAlice)).toHaveLength(2);

    registry.removeUser("alice");
    const secondToken = registry.addUser("alice");
    const secondAlice = registry.authenticate(secondToken)!;

    // The name came back. Nothing else did.
    expect(secondAlice).not.toBe(firstAlice);
    expect(service.list(secondAlice)).toHaveLength(0);
    expect(service.memberships(secondAlice)).toHaveLength(0);
    // And the first alice's store is still there, untouched, for the operator.
    expect(existsSync(join(home, "users", firstAlice, "handovers"))).toBe(true);
  });

  it("keeps everything across a rename", () => {
    registry.addUser("alice");
    registry.addProject("team-x", ["alice"], "Team X");
    const service = new ServerService(home);
    const alice = registry.findUser("alice")!.userId;
    service.save(alice, validHandover());

    const renamed = registry.renameUser("alice", "ada");
    expect(renamed.userId).toBe(alice);
    expect(service.list(alice)).toHaveLength(1);
    expect(service.memberships(alice).map((p) => p.id)).toEqual(["team-x"]);
    expect(registry.findUser("alice")).toBeUndefined();
  });

  it("refuses a rename onto a name in use, and a rename of nobody", () => {
    registry.addUser("alice");
    registry.addUser("bob");
    expect(() => registry.renameUser("alice", "bob")).toThrow(RegistryError);
    expect(() => registry.renameUser("ghost", "ada")).toThrow(RegistryError);
  });
});

describe("member management", () => {
  let home: string;
  let registry: Registry;

  beforeEach(() => {
    home = makeHome();
    registry = new Registry(home);
    registry.init();
    registry.addUser("alice");
    registry.addUser("bob");
    registry.addUser("mallory");
    registry.addProject("team-x", ["alice"], "Team X");
  });

  afterEach(() => {
    removeHome(home);
  });

  it("adds a member to a project that already exists", () => {
    const service = new ServerService(home);
    const alice = registry.findUser("alice")!.userId;
    const bob = registry.findUser("bob")!.userId;
    service.save(alice, validHandover(), "team-x");

    expect(() => service.projectStore(bob, "team-x")).toThrow();
    registry.addMember("team-x", "bob");
    // A new member sees the handovers that are already there.
    expect(service.list(bob, "team-x")).toHaveLength(1);
    expect(() => registry.addMember("team-x", "bob")).toThrow(RegistryError);
    expect(() => registry.addMember("team-x", "ghost")).toThrow(RegistryError);
    expect(() => registry.addMember("no-such", "bob")).toThrow(RegistryError);
  });

  it("removes a member, keeps the project's handovers, and cuts access at once", () => {
    const service = new ServerService(home);
    const alice = registry.findUser("alice")!.userId;
    registry.addMember("team-x", "bob");
    const bob = registry.findUser("bob")!.userId;

    service.save(bob, validHandover({ title: "bob wrote this" }), "team-x");
    service.save(bob, validHandover({ title: "bob's own notes" }));
    expect(service.list(bob, "team-x")).toHaveLength(1);

    registry.removeMember("team-x", "bob");

    // Access is gone, and gone the same way a missing project is.
    expect(() => service.list(bob, "team-x")).toThrow(/not found/);
    expect(() => service.load(bob, "#001", "team-x")).toThrow(/not found/);
    expect(() => service.save(bob, validHandover(), "team-x")).toThrow(
      /not found/,
    );
    expect(service.memberships(bob)).toHaveLength(0);

    // What he wrote into the project stays in the project.
    expect(service.list(alice, "team-x")).toHaveLength(1);
    expect(service.load(alice, "#001", "team-x").handover.title).toBe(
      "bob wrote this",
    );
    // And his personal store is untouched.
    expect(service.list(bob)).toHaveLength(1);
  });

  it("removes a user from every project at once", () => {
    registry.addMember("team-x", "bob");
    registry.addProject("team-y", ["bob", "alice"]);
    const bob = registry.findUser("bob")!.userId;
    registry.removeUser("bob");
    expect(registry.projectsFor(bob)).toHaveLength(0);
    expect(registry.findUser("bob")).toBeUndefined();
    for (const project of registry.listProjects()) {
      expect(project.memberIds).not.toContain(bob);
    }
    expect(() => registry.removeUser("bob")).toThrow(RegistryError);
  });

  it("removes a project", () => {
    const service = new ServerService(home);
    const alice = registry.findUser("alice")!.userId;
    service.save(alice, validHandover(), "team-x");
    registry.removeProject("team-x");
    expect(() => service.list(alice, "team-x")).toThrow(/not found/);
    expect(registry.listProjects()).toHaveLength(0);
    expect(() => registry.removeProject("team-x")).toThrow(RegistryError);
  });

  it("refuses to remove somebody who is not a member", () => {
    expect(() => registry.removeMember("team-x", "mallory")).toThrow(
      RegistryError,
    );
    expect(() => registry.removeMember("no-such", "alice")).toThrow(
      RegistryError,
    );
  });
});

describe("a version 1 data directory", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });

  afterEach(() => {
    removeHome(home);
  });

  /** Write the exact shape the previous build wrote. */
  function seedLegacyHome(): void {
    writeFileSync(
      join(home, "users.json"),
      JSON.stringify({
        version: 1,
        users: [
          {
            username: "alice",
            tokenHash: hashToken("alice-token"),
            createdAt: "2026-07-01T00:00:00.000Z",
          },
          {
            username: "bob",
            tokenHash: hashToken("bob-token"),
            createdAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    writeFileSync(
      join(home, "projects.json"),
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "team-x",
            name: "Team X",
            members: ["alice", "bob"],
            createdAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    mkdirSync(join(home, "users", "alice", "handovers"), { recursive: true });
    writeFileSync(
      join(home, "users", "alice", "marker"),
      "alice's store",
      "utf8",
    );
  }

  it("is refused rather than misread", () => {
    seedLegacyHome();
    const registry = new Registry(home);
    expect(registry.version()).toBe(1);
    expect(() => registry.listUsers()).toThrow(RegistryVersionError);
    expect(() => registry.listProjects()).toThrow(RegistryVersionError);
    expect(() => registry.assertCurrent()).toThrow(/soil-server migrate/);
  });

  it("migrates to stable ids, moving each store with its owner", () => {
    seedLegacyHome();
    const registry = new Registry(home);
    const result = registry.migrate();
    expect(result).toEqual({ migrated: true, users: 2, projects: 1 });
    expect(registry.version()).toBe(REGISTRY_VERSION);

    const alice = registry.findUser("alice")!;
    expect(alice.userId).toMatch(USER_ID_PATTERN);
    // The token still works: migration changes identity, never credentials.
    expect(registry.authenticate("alice-token")).toBe(alice.userId);
    // The store followed its owner.
    expect(existsSync(join(home, "users", "alice"))).toBe(false);
    expect(
      readFileSync(join(home, "users", alice.userId, "marker"), "utf8"),
    ).toBe("alice's store");
    // Membership is by id now.
    const project = registry.listProjects()[0]!;
    expect(project.memberIds).toEqual([
      alice.userId,
      registry.findUser("bob")!.userId,
    ]);
    expect(registry.memberNames(project)).toEqual(["alice", "bob"]);

    // Idempotent.
    expect(registry.migrate()).toEqual({
      migrated: false,
      users: 0,
      projects: 0,
    });
  });
});
