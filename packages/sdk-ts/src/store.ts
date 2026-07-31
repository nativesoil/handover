/**
 * The local store: plain JSON files under `~/.soil`.
 *
 * One handover is one file. The index is one more file. There is no database,
 * no account, no network call, and no format you cannot read with `cat`. If
 * this repo disappeared tomorrow your handovers would still be readable, which
 * is the whole point of writing them down.
 *
 * Layout (documented in `docs/architecture.md`):
 *
 *   ~/.soil/
 *     index.json                 the code counter and one row per handover
 *     handovers/001.json         the handover documents
 *     .locks/                    runtime only: the single-writer lock
 *
 * `SOIL_HOME` overrides the root, which is how the tests and the conformance
 * suite run without touching a real home directory.
 *
 * ## Why the writes are locked
 *
 * `save`, `update` and `reindex` are each a read-modify-write: read the index,
 * write a document, write the index back. Two processes doing that at the same
 * time against one root both read the same `nextCode`, both write a document at
 * that code, and the second index write erases the first one's row. One
 * document survives and both callers were told it was saved.
 *
 * That is not a server-only story. It is two `soil save` invocations against one
 * `~/.soil`: an agent running the CLI while a person runs it too, or a shell
 * loop. Measured on this store before the lock, four processes saving fifteen
 * times each acknowledged 60 saves and left 26 documents on disk.
 *
 * So every write path runs inside the advisory lock in `lock.ts`, keyed on this
 * store's own root. It is the same mechanism the server uses, not a second one.
 * A write that cannot take the lock throws {@link LockBusyError} and writes
 * nothing, because a refusal the caller can retry is honest and an
 * acknowledgement for a lost write is not. Reads are not locked and do not need
 * to be: every write lands through an atomic rename, so a reader sees the whole
 * old file or the whole new one.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { uuidv7 } from "./identity.js";
import { withLock, type LockOptions } from "./lock.js";
import { ingestDocument, ingestDocumentOrThrow } from "./ingest.js";
import { SECTION_KEYS } from "./sections.js";
import { assertHandover } from "./validate.js";
import type {
  Handover,
  SectionCounts,
  StoreEntry,
  StoreIndex,
} from "./types.js";

/** The number of digits in a load code, e.g. `#004`. */
const CODE_DIGITS = 3;

/** Resolve the store root: `SOIL_HOME`, else `~/.soil`. */
export function resolveStoreHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["SOIL_HOME"];
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  return join(homedir(), ".soil");
}

/** Format a numeric code as a load code, e.g. `4` becomes `#004`. */
export function formatCode(n: number): string {
  return `#${String(n).padStart(CODE_DIGITS, "0")}`;
}

/** Parse a load code into its number. Accepts `#004`, `004` and `4`. */
export function parseCode(code: string): number | undefined {
  const match = /^#?(\d+)$/.exec(code.trim());
  if (!match?.[1]) return undefined;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Count sections by status. Structural content presence, never a grade: a
 * section holding two characters counts exactly like one holding two pages.
 */
export function countSections(handover: Handover): SectionCounts {
  let withContent = 0;
  let missing = 0;
  let blocked = 0;
  let notApplicable = 0;
  for (const key of SECTION_KEYS) {
    const status = handover.sections[key]?.status;
    if (status === "available") withContent += 1;
    else if (status === "blocked") blocked += 1;
    else if (status === "not_applicable") notApplicable += 1;
    else missing += 1;
  }
  return {
    withContent,
    missing,
    blocked,
    notApplicable,
    total: SECTION_KEYS.length,
  };
}

/** Build an index row. */
function entryOf(code: string, handover: Handover, file: string): StoreEntry {
  return {
    code,
    projectId: handover.projectId,
    title: handover.title,
    createdAt: handover.createdAt,
    sectionsWithContent: countSections(handover).withContent,
    file,
  };
}

/**
 * What one index row looks like on disk. Spelled out rather than written
 * straight through, so a field added to {@link StoreEntry} for a caller's
 * convenience cannot reach `index.json` without somebody deciding it should.
 */
function persistableEntry(entry: StoreEntry): Record<string, unknown> {
  return {
    code: entry.code,
    projectId: entry.projectId,
    title: entry.title,
    createdAt: entry.createdAt,
    sectionsWithContent: entry.sectionsWithContent,
    file: entry.file,
  };
}

/**
 * Read one index row back, accepting an index written before the rename.
 *
 * Pre-existing indexes are not migrated on read and not rewritten: a row
 * carrying only the old `sectionsCaptured` key is understood, and the honest
 * name is what gets written the next time that row is touched. `reindex()`
 * rewrites the whole file from the handover documents, which is the one-step
 * way to convert an old index deliberately.
 */
function entryFromIndex(row: unknown): StoreEntry {
  const record = (row ?? {}) as Record<string, unknown>;
  const withContent =
    typeof record["sectionsWithContent"] === "number"
      ? record["sectionsWithContent"]
      : typeof record["sectionsCaptured"] === "number"
        ? record["sectionsCaptured"]
        : 0;
  return {
    code: String(record["code"] ?? ""),
    projectId: String(record["projectId"] ?? ""),
    title: String(record["title"] ?? ""),
    createdAt: String(record["createdAt"] ?? ""),
    sectionsWithContent: withContent,
    file: String(record["file"] ?? ""),
  };
}

const EMPTY_INDEX: StoreIndex = Object.freeze({
  indexVersion: 1,
  nextCode: 1,
  entries: Object.freeze([]),
});

/**
 * Write through a temporary file and rename, so a reader never sees half a
 * document.
 *
 * The temporary name carries a random id, never `process.pid`. Two containers
 * on one volume both run as pid 1, so a pid makes two different writers look
 * like one writer resuming, and the second would silently rename the first's
 * half-written bytes into place.
 */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** Thrown when a load code does not resolve to a stored handover. */
export class HandoverNotFoundError extends Error {
  constructor(code: string) {
    super(`no handover stored as ${code}`);
    this.name = "HandoverNotFoundError";
  }
}

/** A local handover store rooted at one directory. */
export class HandoverStore {
  readonly root: string;
  readonly handoversDir: string;
  readonly indexPath: string;
  /** Where the single-writer lock lives. Runtime state, never content. */
  readonly locksDir: string;
  private readonly lockOptions: LockOptions;

  constructor(
    root: string = resolveStoreHome(),
    lockOptions: LockOptions = {},
  ) {
    this.root = root;
    this.handoversDir = join(root, "handovers");
    this.indexPath = join(root, "index.json");
    this.locksDir = join(root, ".locks");
    this.lockOptions = lockOptions;
  }

  /**
   * Run one read-modify-write as this store's only writer, across processes.
   *
   * The lock is keyed on the store root, so two stores under one home never
   * wait on each other, and two processes on one root always do.
   *
   * @throws {LockBusyError} if the lock could not be taken. Nothing ran, and
   * nothing was written.
   */
  private locked<T>(body: () => T): T {
    return withLock(this.locksDir, "store", body, this.lockOptions);
  }

  /** Create the directories if they are not there yet. */
  init(): void {
    mkdirSync(this.handoversDir, { recursive: true });
  }

  /** Read the index, rebuilding an empty one when the store is new. */
  readIndex(): StoreIndex {
    if (!existsSync(this.indexPath)) {
      return EMPTY_INDEX;
    }
    const parsed: unknown = ingestDocumentOrThrow(readFileSync(this.indexPath));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      throw new Error(`the index at ${this.indexPath} is not readable`);
    }
    const raw = parsed as { nextCode?: unknown; entries: readonly unknown[] };
    return {
      indexVersion: 1,
      nextCode: typeof raw.nextCode === "number" ? raw.nextCode : 1,
      entries: raw.entries.map(entryFromIndex),
    };
  }

  /** Write the index, dropping the deprecated in-memory mirror. */
  private writeIndex(index: StoreIndex): void {
    writeJsonAtomic(this.indexPath, {
      indexVersion: 1,
      nextCode: index.nextCode,
      entries: index.entries.map(persistableEntry),
    });
  }

  /** Every stored handover, newest code first. */
  list(): readonly StoreEntry[] {
    return [...this.readIndex().entries].sort(
      (a, b) => (parseCode(b.code) ?? 0) - (parseCode(a.code) ?? 0),
    );
  }

  /** The path a handover with this code lives at. */
  pathFor(code: string): string {
    const n = parseCode(code);
    if (n === undefined) {
      throw new HandoverNotFoundError(code);
    }
    return join(
      this.handoversDir,
      `${String(n).padStart(CODE_DIGITS, "0")}.json`,
    );
  }

  /**
   * Read one handover. `code` accepts `#004`, `004`, `4`, or `last` for the
   * most recently saved one.
   */
  read(code: string): Handover {
    const wanted = code.trim().toLowerCase();
    if (wanted === "last" || wanted === "latest") {
      const newest = this.list()[0];
      if (!newest) throw new HandoverNotFoundError("last");
      return this.read(newest.code);
    }
    const path = this.pathFor(code);
    if (!existsSync(path)) {
      throw new HandoverNotFoundError(formatCode(parseCode(code) ?? 0));
    }
    // Through the ingestion boundary, not `JSON.parse`: a file on disk is
    // bytes, and the encoding, duplicate-member and depth rules can only be
    // enforced before a value exists. See `ingest.ts`.
    const parsed: unknown = ingestDocumentOrThrow(readFileSync(path));
    assertHandover(parsed);
    return parsed;
  }

  /**
   * Store a handover and hand back its index row. The document is validated
   * first: an invalid document is never written, because a store that accepts
   * anything is a store you cannot trust to load.
   *
   * The store is a writer, so it assigns identity: a document that arrives
   * without a `handoverId` gets a fresh UUIDv7 here, and a document that
   * already carries one keeps it, because a copy keeps its identity. An id
   * that is present but malformed is a validation error, never silently
   * replaced.
   *
   * Reading the index, claiming the code and writing both files is one section
   * under this store's lock. Validation and identity assignment stay outside
   * it: they touch no disk, and a document that is going to be refused should
   * never make another writer wait.
   *
   * @throws {LockBusyError} if another process holds the lock. Nothing was
   * written, and the caller has not been told otherwise.
   */
  save(handover: Handover): StoreEntry {
    const identified: Handover =
      typeof handover === "object" &&
      handover !== null &&
      !Array.isArray(handover) &&
      !("handoverId" in handover)
        ? { ...handover, handoverId: uuidv7() }
        : handover;
    assertHandover(identified);
    this.init();

    return this.locked(() => {
      const index = this.readIndex();
      const code = formatCode(index.nextCode);
      const stored: Handover = { ...identified, code };
      const file = `${String(index.nextCode).padStart(CODE_DIGITS, "0")}.json`;

      writeJsonAtomic(join(this.handoversDir, file), stored);

      const entry = entryOf(code, stored, file);
      this.writeIndex({
        indexVersion: 1,
        nextCode: index.nextCode + 1,
        entries: [...index.entries, entry],
      });

      return entry;
    });
  }

  /**
   * Update a stored handover in place, e.g. to attach an observation. This is
   * the one write path that touches an existing file, and it holds two rules
   * absolutely: the `handoverId` never changes, because identity survives every
   * edit, and the load code never changes, because a code in an old note must
   * keep pointing at the thing it pointed at. The updated document is validated
   * before anything is written, and the index row is refreshed to match.
   *
   * The whole section is locked, the read of the current document included: an
   * update that decided what to write from a document another process replaced
   * in the meantime would write back a merge nobody made.
   *
   * @throws {LockBusyError} if another process holds the lock. Nothing was
   * written.
   */
  update(code: string, next: Handover): StoreEntry {
    return this.locked(() => {
      const current = this.read(code);
      const storedCode = current.code ?? formatCode(parseCode(code) ?? 0);
      if (next.handoverId !== current.handoverId) {
        throw new Error(
          `the handoverId never changes: an update to ${storedCode} must keep its identity`,
        );
      }
      const stored: Handover = { ...next, code: storedCode };
      assertHandover(stored);

      const n = parseCode(storedCode);
      if (n === undefined) {
        throw new HandoverNotFoundError(code);
      }
      const file = `${String(n).padStart(CODE_DIGITS, "0")}.json`;
      writeJsonAtomic(join(this.handoversDir, file), stored);

      const entry = entryOf(storedCode, stored, file);
      const index = this.readIndex();
      this.writeIndex({
        indexVersion: 1,
        nextCode: index.nextCode,
        entries: index.entries.map((row) =>
          row.code === storedCode ? entry : row,
        ),
      });
      return entry;
    });
  }

  /**
   * Rebuild the index from the handover files on disk. The files are the truth;
   * the index is a convenience, so losing it should never lose a handover.
   *
   * Locked like the other two: a rebuild that scanned the directory while a save
   * was landing would write an index missing the document that save just wrote,
   * and hand the next save a code that is already taken.
   *
   * @throws {LockBusyError} if another process holds the lock. The existing
   * index is left exactly as it was.
   */
  reindex(): StoreIndex {
    this.init();
    return this.locked(() => {
      const entries: StoreEntry[] = [];
      let highest = 0;
      for (const file of readdirSync(this.handoversDir).sort()) {
        if (!file.endsWith(".json")) continue;
        const parsed: unknown = ingestForReindex(
          readFileSync(join(this.handoversDir, file)),
        );
        if (parsed === undefined) continue;
        const result = validateForReindex(parsed);
        if (!result) continue;
        const n = parseCode(result.code ?? file.replace(/\.json$/, ""));
        if (n === undefined) continue;
        highest = Math.max(highest, n);
        entries.push(entryOf(formatCode(n), result, file));
      }
      const index: StoreIndex = {
        indexVersion: 1,
        nextCode: highest + 1,
        entries,
      };
      this.writeIndex(index);
      return index;
    });
  }
}

/**
 * Reindex reads whatever is on disk, so a file that the ingestion boundary
 * refuses is skipped the same way a structurally invalid one is: a rebuilt
 * index never silently promotes a document nothing has checked.
 */
function ingestForReindex(bytes: Uint8Array): unknown {
  const result = ingestDocument(bytes);
  return result.ok ? result.value : undefined;
}

function validateForReindex(parsed: unknown): Handover | undefined {
  try {
    assertHandover(parsed);
    return parsed;
  } catch {
    return undefined;
  }
}
