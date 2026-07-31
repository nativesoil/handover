/**
 * The registry: who can talk to this server, and which projects exist.
 *
 * Two plain JSON files. `users.json` holds one row per user: a stable user id,
 * the username, and the SHA-256 hash of that user's bearer token. The token
 * itself is printed exactly once, at creation, and is never written to disk.
 * `projects.json` holds one row per project: its id, a display name, and the
 * *user ids* of its members.
 *
 * ## The user id, and why membership does not reference a name
 *
 * A username is what a person is called. It is not who they are. If membership
 * and the store directory are keyed on the name, then removing a user and
 * creating the same name again hands the second person the first person's
 * entire personal store and every project they belonged to. That is not a
 * theoretical leak; it is one `user add` away in a team where somebody leaves
 * and their replacement asks for the same handle.
 *
 * So every user gets a UUIDv7 at creation. The store directory is that id, the
 * project member lists are those ids, and the username is a label that can be
 * changed with `user rename` without moving a single byte. A name released by
 * `user remove` is free for the next person, and it carries nothing with it.
 *
 * Registries written before this rule exist as `version: 1`. They are not read
 * silently: every path refuses them with a message naming `soil-server
 * migrate`, because guessing an identity for an existing row is exactly the
 * mistake this change is about.
 *
 * ## Concurrency
 *
 * Every mutation here is a read-modify-write, and every one of them runs inside
 * the registry lock (see `lock.ts`), which is what stops a second process from
 * reading the same file, appending its own row, and erasing the first one's
 * user. The lock covers the read as well as the write; a lock taken only around
 * the write would preserve nothing.
 *
 * ## Tokens
 *
 * Tokens are 256 bits from the platform CSPRNG. Authentication hashes the
 * presented token and compares it against every stored hash with a
 * constant-time comparison, without an early exit, so the time taken does not
 * depend on which user matched or whether any did.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { uuidv7, withLock, type LockOptions } from "@nativesoil/handover-sdk";

/** Usernames are labels, so they are strictly shaped but freely reusable. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Project ids are directory names, same discipline. */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * User ids are directory names too, and they arrive from a file an operator can
 * edit, so they are checked on the way in as well as on the way out. A `..` that
 * reached a `join` here would be a path traversal with the operator's own hand
 * on it.
 */
export const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The registry file version this build reads and writes. */
export const REGISTRY_VERSION = 2;

/** One user: a stable id, a name, and a token hash. Never a token. */
export interface UserRecord {
  /** Stable for the life of the account. Survives a rename. */
  readonly userId: string;
  readonly username: string;
  /** SHA-256 of the bearer token, hex. The token itself is never stored. */
  readonly tokenHash: string;
  readonly createdAt: string;
}

/** One project: an id, a display name, and its members, by user id. */
export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  /** User ids, never usernames. */
  readonly memberIds: readonly string[];
  readonly createdAt: string;
}

interface UsersFile {
  readonly version: number;
  readonly users: readonly UserRecord[];
}

interface ProjectsFile {
  readonly version: number;
  readonly projects: readonly ProjectRecord[];
}

/** Hash a bearer token for storage or lookup. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mint a fresh bearer token: 256 random bits, hex. */
export function mintToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Write through a temporary file and rename, so a reader sees the old file or
 * the new one and never a half-written one.
 *
 * The temporary name is random, not the process id. Two containers on one
 * volume both running as pid 1 would otherwise pick the same temporary path,
 * which turns the atomic rename into two processes writing one file. Nothing
 * here may depend on process ids being distinct.
 */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Thrown when a registry operation cannot proceed. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** Thrown when the data directory predates stable user ids. */
export class RegistryVersionError extends RegistryError {
  readonly found: number;

  constructor(found: number) {
    super(
      `this data directory is registry version ${found}, and this server writes version ${REGISTRY_VERSION}. ` +
        `Version 1 keyed every store and every project membership on the username, so a removed name could be recreated and inherit the previous holder's data. ` +
        `Run "soil-server migrate" once to give each user a stable id; it is safe to run twice.`,
    );
    this.name = "RegistryVersionError";
    this.found = found;
  }
}

/** The user and project registry rooted at one server home directory. */
export class Registry {
  readonly home: string;
  readonly usersPath: string;
  readonly projectsPath: string;
  readonly locksDir: string;
  private readonly lockOptions: LockOptions;

  constructor(home: string, lockOptions: LockOptions = {}) {
    this.home = home;
    this.usersPath = join(home, "users.json");
    this.projectsPath = join(home, "projects.json");
    this.locksDir = join(home, ".locks");
    this.lockOptions = lockOptions;
  }

  /** Has `init` run here? */
  isInitialized(): boolean {
    return existsSync(this.usersPath);
  }

  /** Run `body` as the only writer of this registry, across processes. */
  private locked<T>(body: () => T): T {
    return withLock(this.locksDir, "registry", body, this.lockOptions);
  }

  /** Create the data directory and empty registries. */
  init(): void {
    mkdirSync(this.home, { recursive: true });
    this.locked(() => {
      if (!existsSync(this.usersPath)) {
        writeJsonAtomic(this.usersPath, {
          version: REGISTRY_VERSION,
          users: [],
        } satisfies UsersFile);
      }
      if (!existsSync(this.projectsPath)) {
        writeJsonAtomic(this.projectsPath, {
          version: REGISTRY_VERSION,
          projects: [],
        } satisfies ProjectsFile);
      }
    });
  }

  /**
   * The registry file version on disk, or `undefined` for an empty home.
   * `1` means the home predates stable user ids.
   */
  version(): number | undefined {
    if (!existsSync(this.usersPath)) return undefined;
    const parsed = readJson(this.usersPath) as UsersFile;
    return typeof parsed.version === "number" ? parsed.version : 1;
  }

  /** Refuse to touch a home this build would misread. */
  assertCurrent(): void {
    const found = this.version();
    if (found !== undefined && found !== REGISTRY_VERSION) {
      throw new RegistryVersionError(found);
    }
  }

  /** Every user, in creation order. */
  listUsers(): readonly UserRecord[] {
    if (!existsSync(this.usersPath)) return [];
    const parsed = readJson(this.usersPath) as UsersFile;
    if (parsed.version !== REGISTRY_VERSION) {
      throw new RegistryVersionError(
        typeof parsed.version === "number" ? parsed.version : 1,
      );
    }
    const rows = Array.isArray(parsed.users) ? parsed.users : [];
    for (const row of rows) {
      if (!USER_ID_PATTERN.test(row.userId ?? "")) {
        throw new RegistryError(
          `users.json holds a row whose user id is not a UUID; the store directory is that id, so this file is not safe to read`,
        );
      }
    }
    return rows;
  }

  /** Every project, in creation order. */
  listProjects(): readonly ProjectRecord[] {
    if (!existsSync(this.projectsPath)) return [];
    const parsed = readJson(this.projectsPath) as ProjectsFile;
    if (parsed.version !== REGISTRY_VERSION) {
      throw new RegistryVersionError(
        typeof parsed.version === "number" ? parsed.version : 1,
      );
    }
    const rows = Array.isArray(parsed.projects) ? parsed.projects : [];
    for (const row of rows) {
      if (!PROJECT_ID_PATTERN.test(row.id ?? "")) {
        throw new RegistryError(
          `projects.json holds a row whose project id is not a valid id; the store directory is that id, so this file is not safe to read`,
        );
      }
    }
    return rows;
  }

  /** One user by name, or `undefined`. */
  findUser(username: string): UserRecord | undefined {
    return this.listUsers().find((user) => user.username === username);
  }

  /** One user by id, or `undefined`. */
  findUserById(userId: string): UserRecord | undefined {
    return this.listUsers().find((user) => user.userId === userId);
  }

  /** The usernames of a project's members, for display. Unknown ids are dropped. */
  memberNames(project: ProjectRecord): readonly string[] {
    const byId = new Map(
      this.listUsers().map((user) => [user.userId, user.username]),
    );
    return project.memberIds
      .map((id) => byId.get(id))
      .filter((name): name is string => name !== undefined);
  }

  /**
   * Add a user and hand back the token, once. The token is returned to the
   * caller and its hash is written to disk; after this call returns there is
   * no way to read the token out of the server again.
   */
  addUser(username: string, now: Date = new Date()): string {
    if (!USERNAME_PATTERN.test(username)) {
      throw new RegistryError(
        `usernames are 1-32 characters of lowercase letters, digits, hyphen or underscore, starting with a letter or digit`,
      );
    }
    this.init();
    const token = mintToken();
    this.locked(() => {
      const users = this.listUsers();
      if (users.some((user) => user.username === username)) {
        throw new RegistryError(`the user ${username} already exists`);
      }
      this.writeUsers([
        ...users,
        {
          userId: uuidv7(now),
          username,
          tokenHash: hashToken(token),
          createdAt: now.toISOString(),
        },
      ]);
    });
    return token;
  }

  /**
   * Remove a user: the token stops authenticating at once, and they are dropped
   * from every project they belonged to.
   *
   * Their personal store is left on disk, keyed by the user id, and is
   * unreachable from then on. Nothing here deletes a handover: removing a
   * person from a team and destroying what they wrote are different decisions,
   * and only the operator gets to make the second one (`--purge` in the CLI).
   *
   * @returns the removed row, so a caller can report the directory.
   */
  removeUser(username: string): UserRecord {
    return this.locked(() => {
      const users = this.listUsers();
      const user = users.find((row) => row.username === username);
      if (user === undefined) {
        throw new RegistryError(`no such user: ${username}`);
      }
      this.writeUsers(users.filter((row) => row.userId !== user.userId));
      this.writeProjects(
        this.listProjects().map((project) =>
          project.memberIds.includes(user.userId)
            ? {
                ...project,
                memberIds: project.memberIds.filter((id) => id !== user.userId),
              }
            : project,
        ),
      );
      return user;
    });
  }

  /**
   * Rename a user. The user id, the store and every membership stay exactly
   * where they are, which is the whole reason the id exists.
   */
  renameUser(username: string, nextName: string): UserRecord {
    if (!USERNAME_PATTERN.test(nextName)) {
      throw new RegistryError(
        `usernames are 1-32 characters of lowercase letters, digits, hyphen or underscore, starting with a letter or digit`,
      );
    }
    return this.locked(() => {
      const users = this.listUsers();
      const user = users.find((row) => row.username === username);
      if (user === undefined) {
        throw new RegistryError(`no such user: ${username}`);
      }
      if (users.some((row) => row.username === nextName)) {
        throw new RegistryError(`the user ${nextName} already exists`);
      }
      const renamed: UserRecord = { ...user, username: nextName };
      this.writeUsers(
        users.map((row) => (row.userId === user.userId ? renamed : row)),
      );
      return renamed;
    });
  }

  /** Add a project with its members, named by username. */
  addProject(
    id: string,
    members: readonly string[],
    name?: string,
    now: Date = new Date(),
  ): ProjectRecord {
    if (!PROJECT_ID_PATTERN.test(id)) {
      throw new RegistryError(
        `project ids are 1-64 characters of lowercase letters, digits or hyphen, starting with a letter or digit`,
      );
    }
    if (members.length === 0) {
      throw new RegistryError(`a project needs at least one member`);
    }
    this.init();
    return this.locked(() => {
      const byName = new Map(
        this.listUsers().map((user) => [user.username, user]),
      );
      const memberIds: string[] = [];
      for (const member of members) {
        const user = byName.get(member);
        if (user === undefined) {
          throw new RegistryError(`no such user: ${member}`);
        }
        if (!memberIds.includes(user.userId)) memberIds.push(user.userId);
      }
      const projects = this.listProjects();
      if (projects.some((project) => project.id === id)) {
        throw new RegistryError(`the project ${id} already exists`);
      }
      const record: ProjectRecord = {
        id,
        name: name ?? id,
        memberIds,
        createdAt: now.toISOString(),
      };
      this.writeProjects([...projects, record]);
      return record;
    });
  }

  /**
   * Add a member to an existing project. Until this existed, a project's
   * membership was fixed at creation and the only way to change it was to edit
   * `projects.json` by hand on a running server.
   */
  addMember(projectId: string, username: string): ProjectRecord {
    return this.locked(() => {
      const user = this.listUsers().find((row) => row.username === username);
      if (user === undefined) {
        throw new RegistryError(`no such user: ${username}`);
      }
      const projects = this.listProjects();
      const project = projects.find((row) => row.id === projectId);
      if (project === undefined) {
        throw new RegistryError(`no such project: ${projectId}`);
      }
      if (project.memberIds.includes(user.userId)) {
        throw new RegistryError(
          `${username} is already a member of ${projectId}`,
        );
      }
      const next: ProjectRecord = {
        ...project,
        memberIds: [...project.memberIds, user.userId],
      };
      this.writeProjects(
        projects.map((row) => (row.id === projectId ? next : row)),
      );
      return next;
    });
  }

  /**
   * Remove a member from a project.
   *
   * The effect on already-stored handovers is deliberate and documented: the
   * project's handovers stay in the project's store, including the ones this
   * member wrote, because a shared project's knowledge belongs to the project
   * and not to whoever typed it. What the removed member loses is all access,
   * immediately and completely: membership is re-read from disk on every single
   * request, so there is no session to expire and no cache to clear. From the
   * next request onward the project answers them exactly like a project that
   * does not exist.
   *
   * Their personal store is untouched.
   */
  removeMember(projectId: string, username: string): ProjectRecord {
    return this.locked(() => {
      const user = this.listUsers().find((row) => row.username === username);
      if (user === undefined) {
        throw new RegistryError(`no such user: ${username}`);
      }
      const projects = this.listProjects();
      const project = projects.find((row) => row.id === projectId);
      if (project === undefined) {
        throw new RegistryError(`no such project: ${projectId}`);
      }
      if (!project.memberIds.includes(user.userId)) {
        throw new RegistryError(`${username} is not a member of ${projectId}`);
      }
      const next: ProjectRecord = {
        ...project,
        memberIds: project.memberIds.filter((id) => id !== user.userId),
      };
      this.writeProjects(
        projects.map((row) => (row.id === projectId ? next : row)),
      );
      return next;
    });
  }

  /**
   * Remove a project. Its store is left on disk and becomes unreachable; the
   * CLI's `--purge` is the only thing that deletes handovers.
   */
  removeProject(projectId: string): ProjectRecord {
    return this.locked(() => {
      const projects = this.listProjects();
      const project = projects.find((row) => row.id === projectId);
      if (project === undefined) {
        throw new RegistryError(`no such project: ${projectId}`);
      }
      this.writeProjects(projects.filter((row) => row.id !== projectId));
      return project;
    });
  }

  /** The projects this user id is a member of. */
  projectsFor(userId: string): readonly ProjectRecord[] {
    return this.listProjects().filter((project) =>
      project.memberIds.includes(userId),
    );
  }

  /**
   * Resolve a bearer token to the caller's **user id**, or `undefined`.
   *
   * The presented token is hashed and compared against every stored hash with
   * `timingSafeEqual`, visiting every row on every call, so the comparison
   * takes the same time whether the token matches the first user, the last
   * user, or nobody.
   */
  authenticate(token: string): string | undefined {
    return this.lookup(token)?.userId;
  }

  /** As {@link authenticate}, but hands back the whole row (for logging). */
  lookup(token: string): UserRecord | undefined {
    const presented = Buffer.from(hashToken(token), "hex");
    let matched: UserRecord | undefined;
    for (const user of this.listUsers()) {
      const stored = Buffer.from(user.tokenHash, "hex");
      if (
        stored.length === presented.length &&
        timingSafeEqual(stored, presented)
      ) {
        matched = user;
      }
    }
    return matched;
  }

  /**
   * Bring a version 1 home up to version 2: give every user a stable id, move
   * each personal store from `users/<name>` to `users/<id>`, and rewrite every
   * project's members from names to ids.
   *
   * Idempotent: on a home that is already current it does nothing and says so.
   * It runs inside the registry lock, so a server serving the same directory
   * cannot interleave with it, though stopping the server first is still the
   * sane way to do this.
   */
  migrate(now: Date = new Date()): {
    migrated: boolean;
    users: number;
    projects: number;
  } {
    if (!existsSync(this.usersPath)) {
      this.init();
      return { migrated: false, users: 0, projects: 0 };
    }
    return this.locked(() => {
      const usersFile = readJson(this.usersPath) as UsersFile;
      const found =
        typeof usersFile.version === "number" ? usersFile.version : 1;
      if (found === REGISTRY_VERSION) {
        return { migrated: false, users: 0, projects: 0 };
      }
      if (found !== 1) {
        throw new RegistryError(
          `this data directory is registry version ${found}, which is newer than this build understands`,
        );
      }

      const legacyUsers = Array.isArray(usersFile.users) ? usersFile.users : [];
      const idByName = new Map<string, string>();
      const users: UserRecord[] = legacyUsers.map((row) => {
        const userId = uuidv7(now);
        idByName.set(row.username, userId);
        return {
          userId,
          username: row.username,
          tokenHash: row.tokenHash,
          createdAt: row.createdAt,
        };
      });

      // Move each personal store to its owner's id before anything points at it.
      for (const user of users) {
        const from = join(this.home, "users", user.username);
        const to = join(this.home, "users", user.userId);
        if (existsSync(from) && !existsSync(to)) {
          renameSync(from, to);
        }
      }

      const legacyProjects = existsSync(this.projectsPath)
        ? ((readJson(this.projectsPath) as ProjectsFile).projects ?? [])
        : [];
      const projects: ProjectRecord[] = legacyProjects.map((row) => {
        const legacyMembers = (row as unknown as { members?: string[] })
          .members;
        const names = Array.isArray(legacyMembers) ? legacyMembers : [];
        return {
          id: row.id,
          name: row.name,
          memberIds: names
            .map((name) => idByName.get(name))
            .filter((id): id is string => id !== undefined),
          createdAt: row.createdAt,
        };
      });

      this.writeUsers(users);
      this.writeProjects(projects);
      return { migrated: true, users: users.length, projects: projects.length };
    });
  }

  private writeUsers(users: readonly UserRecord[]): void {
    writeJsonAtomic(this.usersPath, {
      version: REGISTRY_VERSION,
      users,
    } satisfies UsersFile);
  }

  private writeProjects(projects: readonly ProjectRecord[]): void {
    writeJsonAtomic(this.projectsPath, {
      version: REGISTRY_VERSION,
      projects,
    } satisfies ProjectsFile);
  }
}
