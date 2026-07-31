"""The local store: plain JSON files under ``~/.soil``.

One handover is one file. The index is one more file. There is no database,
no account, no network call, and no format you cannot read with ``cat``. If
this repo disappeared tomorrow your handovers would still be readable, which
is the whole point of writing them down.

Layout (documented in ``docs/architecture.md``):

    ~/.soil/
      index.json                 the code counter and one row per handover
      handovers/001.json         the handover documents
      .locks/                    runtime only: the single-writer lock

``SOIL_HOME`` overrides the root, which is how the tests and the conformance
suite run without touching a real home directory. The layout, the code
allocation and the file bytes match ``packages/sdk-ts/src/store.ts``, so the
two SDKs read and write the same store.

## Why the writes are locked

``save``, ``update`` and ``reindex`` are each a read-modify-write: read the
index, write a document, write the index back. Two processes doing that at the same time
against one root both read the same ``nextCode``, both write a document at
that code, and the second index write erases the first one's row. One document
survives and both callers were told it was saved.

That is not a server-only story. It is two saves against one ``~/.soil``: an
agent saving while a person saves, or a shell loop. Measured on this store
before the lock, four processes saving fifteen times each acknowledged 60
saves and left 18, 18 and 17 documents on disk across three runs.

So every write path runs inside the advisory lock in ``lock.py``, keyed on
this store's own root, with the same on-disk shape every other SDK uses. A
write that cannot take the lock raises
:class:`~soil_handover.lock.LockBusyError` and writes nothing, because a
refusal the caller can retry is honest and an acknowledgement for a lost write
is not. Reads are not locked and do not need to be: every write lands through
an atomic rename, so a reader sees the whole old file or the whole new one.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any, Callable, Mapping, TypeVar

from .identity import uuidv7
from .ingest import ingest_document, ingest_document_or_raise
from .lock import DEFAULT_STALE_MS, DEFAULT_TIMEOUT_MS, with_lock
from .sections import SECTION_KEYS
from .types import Handover, SectionCounts, StoreEntry, StoreIndex
from .validate import assert_handover

_T = TypeVar("_T")

# The number of digits in a load code, e.g. `#004`.
_CODE_DIGITS = 3


def resolve_store_home(env: Mapping[str, str] | None = None) -> str:
    """Resolve the store root: ``SOIL_HOME``, else ``~/.soil``."""
    if env is None:
        env = os.environ
    override = env.get("SOIL_HOME")
    if isinstance(override, str) and len(override.strip()) > 0:
        return override.strip()
    return str(Path.home() / ".soil")


def format_code(n: int) -> str:
    """Format a numeric code as a load code, e.g. ``4`` becomes ``#004``."""
    return f"#{str(n).rjust(_CODE_DIGITS, '0')}"


def parse_code(code: str) -> int | None:
    """Parse a load code into its number. Accepts ``#004``, ``004`` and ``4``."""
    stripped = code.strip()
    if stripped.startswith("#"):
        stripped = stripped[1:]
    if not stripped.isdigit():
        return None
    n = int(stripped)
    return n if n > 0 else None


def count_sections(handover: Handover) -> SectionCounts:
    """Count sections by status.

    Structural content presence, never a grade: a section holding two
    characters counts exactly like one holding two pages.
    """
    with_content = 0
    missing = 0
    blocked = 0
    not_applicable = 0
    sections = handover.get("sections", {})
    for key in SECTION_KEYS:
        section = sections.get(key)
        status = section.get("status") if isinstance(section, dict) else None
        if status == "available":
            with_content += 1
        elif status == "blocked":
            blocked += 1
        elif status == "not_applicable":
            not_applicable += 1
        else:
            missing += 1
    return SectionCounts(
        with_content=with_content,
        missing=missing,
        blocked=blocked,
        not_applicable=not_applicable,
        total=len(SECTION_KEYS),
    )


def _entry_from_index(row: Any) -> StoreEntry:
    """Read one index row, accepting an index written before the rename.

    Pre-existing indexes are not migrated on read and not rewritten: a row
    carrying only the old ``sectionsCaptured`` key is understood, and the
    honest name is what gets written the next time that row is touched.
    ``reindex()`` rewrites the whole file from the handover documents, which
    is the one-step way to convert an old index deliberately.
    """
    record = row if isinstance(row, dict) else {}
    with_content = record.get("sectionsWithContent")
    if not isinstance(with_content, int):
        legacy = record.get("sectionsCaptured")
        with_content = legacy if isinstance(legacy, int) else 0
    return {
        "code": str(record.get("code", "")),
        "projectId": str(record.get("projectId", "")),
        "title": str(record.get("title", "")),
        "createdAt": str(record.get("createdAt", "")),
        "sectionsWithContent": with_content,
        "file": str(record.get("file", "")),
    }


def _empty_index() -> StoreIndex:
    return {"indexVersion": 1, "nextCode": 1, "entries": []}


def _write_json_atomic(path: Path, value: Any) -> None:
    # Same bytes as the TypeScript store: two-space indent, unescaped
    # non-ASCII, a trailing newline, and an atomic rename into place.
    #
    # The temporary name carries a random id, never ``os.getpid()``. Two
    # containers on one volume both run as pid 1, so a pid makes two different
    # writers look like one writer resuming, and the second would silently
    # rename the first's half-written bytes into place.
    tmp = Path(f"{path}.tmp-{uuid.uuid4()}")
    tmp.write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp, path)


class HandoverNotFoundError(Exception):
    """Raised when a load code does not resolve to a stored handover."""

    def __init__(self, code: str) -> None:
        super().__init__(f"no handover stored as {code}")


class HandoverStore:
    """A local handover store rooted at one directory."""

    def __init__(
        self,
        root: str | None = None,
        lock_timeout_ms: int = DEFAULT_TIMEOUT_MS,
        lock_stale_ms: int = DEFAULT_STALE_MS,
    ) -> None:
        self.root = Path(root if root is not None else resolve_store_home())
        self.handovers_dir = self.root / "handovers"
        self.index_path = self.root / "index.json"
        #: Where the single-writer lock lives. Runtime state, never content.
        self.locks_dir = self.root / ".locks"
        self._lock_timeout_ms = lock_timeout_ms
        self._lock_stale_ms = lock_stale_ms

    def _locked(self, body: Callable[[], _T]) -> _T:
        """Run one read-modify-write as this store's only writer, across processes.

        The lock is keyed on the store root, so two stores under one home never
        wait on each other, and two processes on one root always do.

        :raises LockBusyError: if the lock could not be taken. Nothing ran, and
            nothing was written.
        """
        return with_lock(
            self.locks_dir,
            "store",
            body,
            timeout_ms=self._lock_timeout_ms,
            stale_ms=self._lock_stale_ms,
        )

    def init(self) -> None:
        """Create the directories if they are not there yet."""
        self.handovers_dir.mkdir(parents=True, exist_ok=True)

    def read_index(self) -> StoreIndex:
        """Read the index, rebuilding an empty one when the store is new."""
        if not self.index_path.exists():
            return _empty_index()
        parsed = ingest_document_or_raise(self.index_path.read_bytes())
        if not isinstance(parsed, dict) or not isinstance(
            parsed.get("entries"), list
        ):
            raise ValueError(f"the index at {self.index_path} is not readable")
        parsed["entries"] = [_entry_from_index(row) for row in parsed["entries"]]
        return parsed

    def list(self) -> list[StoreEntry]:
        """Every stored handover, newest code first."""
        return sorted(
            self.read_index()["entries"],
            key=lambda entry: parse_code(entry["code"]) or 0,
            reverse=True,
        )

    def path_for(self, code: str) -> Path:
        """The path a handover with this code lives at."""
        n = parse_code(code)
        if n is None:
            raise HandoverNotFoundError(code)
        return self.handovers_dir / f"{str(n).rjust(_CODE_DIGITS, '0')}.json"

    def read(self, code: str) -> Handover:
        """Read one handover.

        ``code`` accepts ``#004``, ``004``, ``4``, or ``last`` for the most
        recently saved one.
        """
        wanted = code.strip().lower()
        if wanted in ("last", "latest"):
            entries = self.list()
            if not entries:
                raise HandoverNotFoundError("last")
            return self.read(entries[0]["code"])
        path = self.path_for(code)
        if not path.exists():
            raise HandoverNotFoundError(format_code(parse_code(code) or 0))
        # Through the ingestion boundary, not ``json.loads``: a file on disk
        # is bytes, and the encoding, duplicate-member and depth rules can
        # only be enforced before a value exists. See ``ingest.py``.
        parsed = ingest_document_or_raise(path.read_bytes())
        assert_handover(parsed)
        return parsed

    def save(self, handover: Handover) -> StoreEntry:
        """Store a handover and hand back its index row.

        The document is validated first: an invalid document is never
        written, because a store that accepts anything is a store you cannot
        trust to load.

        The store is a writer, so it assigns identity: a document that
        arrives without a ``handoverId`` gets a fresh UUIDv7 here, and a
        document that already carries one keeps it, because a copy keeps its
        identity. An id that is present but malformed is a validation error,
        never silently replaced.

        Reading the index, claiming the code and writing both files is one
        section under this store's lock. Validation and identity assignment
        stay outside it: they touch no disk, and a document that is going to be
        refused should never make another writer wait.

        :raises LockBusyError: if another process holds the lock. Nothing was
            written, and the caller has not been told otherwise.
        """
        if isinstance(handover, dict) and "handoverId" not in handover:
            identified: Handover = {**handover, "handoverId": uuidv7()}
        else:
            identified = handover
        assert_handover(identified)
        self.init()

        def claim() -> StoreEntry:
            index = self.read_index()
            next_code = index["nextCode"]
            code = format_code(next_code)
            stored: Handover = {**identified, "code": code}
            file = f"{str(next_code).rjust(_CODE_DIGITS, '0')}.json"

            _write_json_atomic(self.handovers_dir / file, stored)

            entry: StoreEntry = {
                "code": code,
                "projectId": stored["projectId"],
                "title": stored["title"],
                "createdAt": stored["createdAt"],
                "sectionsWithContent": count_sections(stored).with_content,
                "file": file,
            }
            _write_json_atomic(
                self.index_path,
                {
                    "indexVersion": 1,
                    "nextCode": next_code + 1,
                    "entries": [*index["entries"], entry],
                },
            )
            return entry

        return self._locked(claim)

    def update(self, code: str, next_handover: Handover) -> StoreEntry:
        """Update a stored handover in place, e.g. to attach an observation.

        This is the one write path that touches an existing file, and it
        holds two rules absolutely: the ``handoverId`` never changes, because
        identity survives every edit, and the load code never changes,
        because a code in an old note must keep pointing at the thing it
        pointed at. The updated document is validated before anything is
        written, and the index row is refreshed to match.

        The whole section is locked, the read of the current document
        included: an update that decided what to write from a document
        another process replaced in the meantime would write back a merge
        nobody made.

        :raises LockBusyError: if another process holds the lock. Nothing was
            written.
        """

        def apply() -> StoreEntry:
            current = self.read(code)
            stored_code = current.get("code") or format_code(
                parse_code(code) or 0
            )
            if next_handover.get("handoverId") != current.get("handoverId"):
                raise ValueError(
                    "the handoverId never changes: an update to"
                    f" {stored_code} must keep its identity"
                )
            stored: Handover = {**next_handover, "code": stored_code}
            assert_handover(stored)

            n = parse_code(stored_code)
            if n is None:
                raise HandoverNotFoundError(code)
            file = f"{str(n).rjust(_CODE_DIGITS, '0')}.json"
            _write_json_atomic(self.handovers_dir / file, stored)

            entry: StoreEntry = {
                "code": stored_code,
                "projectId": stored["projectId"],
                "title": stored["title"],
                "createdAt": stored["createdAt"],
                "sectionsWithContent": count_sections(stored).with_content,
                "file": file,
            }
            index = self.read_index()
            _write_json_atomic(
                self.index_path,
                {
                    "indexVersion": 1,
                    "nextCode": index["nextCode"],
                    "entries": [
                        entry if row["code"] == stored_code else row
                        for row in index["entries"]
                    ],
                },
            )
            return entry

        return self._locked(apply)

    def reindex(self) -> StoreIndex:
        """Rebuild the index from the handover files on disk.

        The files are the truth; the index is a convenience, so losing it
        should never lose a handover.

        Locked like ``save``: a rebuild that scanned the directory while a save
        was landing would write an index missing the document that save just
        wrote, and hand the next save a code that is already taken.

        :raises LockBusyError: if another process holds the lock. The existing
            index is left exactly as it was.
        """
        self.init()
        return self._locked(self._reindex_locked)

    def _reindex_locked(self) -> StoreIndex:
        entries: list[StoreEntry] = []
        highest = 0
        for file in sorted(os.listdir(self.handovers_dir)):
            if not file.endswith(".json"):
                continue
            # A rebuilt index never silently promotes a document nothing has
            # checked, so a file the boundary refuses is skipped exactly as a
            # structurally invalid one is.
            parsed, issue = ingest_document(
                (self.handovers_dir / file).read_bytes()
            )
            if issue is not None:
                continue
            document = _validate_for_reindex(parsed)
            if document is None:
                continue
            n = parse_code(document.get("code") or file.removesuffix(".json"))
            if n is None:
                continue
            highest = max(highest, n)
            entries.append(
                {
                    "code": format_code(n),
                    "projectId": document["projectId"],
                    "title": document["title"],
                    "createdAt": document["createdAt"],
                    "sectionsWithContent": count_sections(
                        document
                    ).with_content,
                    "file": file,
                }
            )
        index: StoreIndex = {
            "indexVersion": 1,
            "nextCode": highest + 1,
            "entries": entries,
        }
        _write_json_atomic(self.index_path, index)
        return index


def _validate_for_reindex(parsed: Any) -> Handover | None:
    try:
        assert_handover(parsed)
    except Exception:
        return None
    return parsed
