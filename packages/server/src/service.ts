/**
 * The service: every operation the HTTP API and the MCP endpoint share.
 *
 * One instance owns one server home. Each user has a personal handover store
 * and each project has a shared one, all in the same on-disk format as the
 * local `~/.soil` store, via the SDK's `HandoverStore`. Load codes are per
 * store: `#004` in your personal store and `#004` in a project store are two
 * different handovers, addressed by naming the project.
 *
 * The caller is always a **user id**, never a username. A personal store lives
 * at `users/<userId>`, so a username that is released and taken by somebody
 * else carries nothing with it. See `registry.ts` for why.
 *
 * Membership is enforced here, once, for every caller. A project the caller
 * is not a member of behaves exactly like a project that does not exist: the
 * caller gets "not found", never "forbidden", so probing the server does not
 * reveal which project ids are in use. Membership is read from disk on every
 * call, so removing a member takes effect on their next request.
 *
 * ## Writes are serialised
 *
 * `HandoverStore.save` is a read-modify-write: read the index, write the
 * document, write the index back. Two processes on one volume doing that at the
 * same time lose documents and hand two callers the same load code, silently.
 *
 * The store takes its own lock around that now, so this service is not what
 * makes a save safe. What this service adds is a wider section: the save and
 * the read-back that proves the receipt, held together, so the document a
 * caller is handed back is the document that is on disk at that code. Same
 * mechanism, different scope, and the store's lock is always taken inside this
 * one, so the two cannot deadlock.
 *
 * Reads are not locked and do not need to be: every write lands through an
 * atomic rename, so a reader sees the whole old file or the whole new one.
 */

import {
  HandoverNotFoundError,
  HandoverStore,
  buildRestorePrompt,
  countSections,
  uuidv7,
  validateHandover,
  withLock,
  type Handover,
  type LockOptions,
  type StoreEntry,
  type ValidationIssue,
} from "@nativesoil/handover-sdk";
import { join } from "node:path";

import { Registry, type ProjectRecord } from "./registry.js";

/**
 * Thrown when a code, a handover or a project is not visible to the caller.
 * Deliberately the same error whether the thing is absent or merely not
 * theirs.
 */
export class NotVisibleError extends Error {
  constructor(what: string) {
    super(`not found: ${what}`);
    this.name = "NotVisibleError";
  }
}

/** One row in a listing, annotated with where it lives. */
export interface ListedHandover {
  readonly scope: "personal" | "project";
  /** The project id, or `null` for a personal handover. */
  readonly project: string | null;
  readonly code: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: string;
  /**
   * How many of the 17 sections hold a non-empty summary. Structural content
   * presence, never a claim that the capture succeeded, which is why it is not
   * called `sectionsCaptured` any more. This is a wire field on
   * `GET /v1/handovers`, so the rename is visible to clients.
   */
  readonly sectionsWithContent: number;
}

/** A save that was refused. Nothing was stored. */
export interface SaveRefusal {
  readonly ok: false;
  readonly issues: readonly ValidationIssue[];
}

/** A save that was stored. */
export interface SaveSuccess {
  readonly ok: true;
  readonly entry: StoreEntry;
  readonly handover: Handover;
  readonly project: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** All server operations, per calling user. */
export class ServerService {
  readonly home: string;
  readonly registry: Registry;
  readonly locksDir: string;
  private readonly lockOptions: LockOptions;

  constructor(home: string, lockOptions: LockOptions = {}) {
    this.home = home;
    this.registry = new Registry(home, lockOptions);
    this.locksDir = join(home, ".locks");
    this.lockOptions = lockOptions;
  }

  /** The caller's personal store, keyed by user id. */
  personalStore(userId: string): HandoverStore {
    return new HandoverStore(join(this.home, "users", userId));
  }

  /**
   * A project's store, for a member. A non-member, or a project that does not
   * exist, gets {@link NotVisibleError} either way.
   */
  projectStore(caller: string, projectId: string): HandoverStore {
    const project = this.registry
      .listProjects()
      .find((candidate) => candidate.id === projectId);
    if (!project || !project.memberIds.includes(caller)) {
      throw new NotVisibleError(`project ${projectId}`);
    }
    return new HandoverStore(join(this.home, "projects", projectId));
  }

  /**
   * Run a section against one store as its only writer, across processes. The
   * lock name identifies the store and lives in `<home>/.locks`, beside the
   * data rather than inside any one store, because the sections it covers span
   * more than the store does.
   */
  private lockedStore<T>(
    scope: "personal" | "project",
    key: string,
    body: () => T,
  ): T {
    return withLock(this.locksDir, `${scope}-${key}`, body, this.lockOptions);
  }

  /** The projects the caller belongs to. */
  memberships(caller: string): readonly ProjectRecord[] {
    return this.registry.projectsFor(caller);
  }

  /**
   * Validate and store one handover document, personally or into a project.
   *
   * Validation includes the SDK's fail-closed secret scan; a document that
   * fails either is refused and nothing is written. Identity follows the spec:
   * a document that arrives without a `handoverId` is assigned a fresh UUIDv7
   * here, and a document that already carries one keeps it, because a copy
   * keeps its identity. A malformed id is a validation error, never silently
   * replaced.
   */
  save(
    caller: string,
    document: unknown,
    projectId?: string,
  ): SaveSuccess | SaveRefusal {
    // Resolve the store first: a non-member learns nothing about the project,
    // not even whether their document would have validated.
    const store =
      projectId !== undefined
        ? this.projectStore(caller, projectId)
        : this.personalStore(caller);

    const record = isRecord(document) ? document : {};
    const candidate =
      record["handoverId"] === undefined
        ? { ...record, handoverId: uuidv7() }
        : record;

    const result = validateHandover(candidate);
    if (!result.valid) {
      return { ok: false, issues: result.issues };
    }

    // The whole read-modify-write, index included, under one lock. Reading the
    // document back inside the lock too, so the receipt this call returns is
    // proven against the disk before another writer can touch that code.
    return this.lockedStore(
      projectId === undefined ? "personal" : "project",
      projectId ?? caller,
      () => {
        const entry = store.save(candidate as unknown as Handover);
        const stored = store.read(entry.code);
        return {
          ok: true as const,
          entry,
          handover: stored,
          project: projectId ?? null,
        };
      },
    );
  }

  /**
   * Everything the caller can see: their personal handovers plus every
   * handover in each project they are a member of. Pass `projectId` to list
   * just that project. Newest first within each scope, personal scope first.
   */
  list(caller: string, projectId?: string): readonly ListedHandover[] {
    if (projectId !== undefined) {
      return this.projectStore(caller, projectId)
        .list()
        .map((entry) => toListed(entry, projectId));
    }
    const rows: ListedHandover[] = this.personalStore(caller)
      .list()
      .map((entry) => toListed(entry, null));
    for (const project of this.memberships(caller)) {
      for (const entry of new HandoverStore(
        join(this.home, "projects", project.id),
      ).list()) {
        rows.push(toListed(entry, project.id));
      }
    }
    return rows;
  }

  /**
   * Read one handover back, with its restore prompt. `code` accepts `#004`,
   * `004`, `4`, or `last`; with `projectId` it addresses that project's store,
   * otherwise the caller's personal store.
   */
  load(
    caller: string,
    code: string,
    projectId?: string,
  ): { handover: Handover; restorePrompt: string } {
    const store =
      projectId !== undefined
        ? this.projectStore(caller, projectId)
        : this.personalStore(caller);
    try {
      const handover = store.read(code);
      // The recorded working-style instances ride inside the prompt the
      // assembler builds, rather than being appended to it afterwards: only the
      // assembler holds this render's marker, so only the assembler can write a
      // heading a document cannot spell.
      return {
        handover,
        restorePrompt: buildRestorePrompt(handover, {
          workingStyleEvidence: true,
        }),
      };
    } catch (error) {
      if (error instanceof HandoverNotFoundError) {
        throw new NotVisibleError(`handover ${code.trim()}`);
      }
      throw error;
    }
  }

  /** Section counts for a stored handover, for receipts. */
  counts(handover: Handover): ReturnType<typeof countSections> {
    return countSections(handover);
  }
}

function toListed(entry: StoreEntry, project: string | null): ListedHandover {
  return {
    scope: project === null ? "personal" : "project",
    project,
    code: entry.code,
    projectId: entry.projectId,
    title: entry.title,
    createdAt: entry.createdAt,
    sectionsWithContent: entry.sectionsWithContent,
  };
}
