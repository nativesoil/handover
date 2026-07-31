"""The single-writer guarantee.

Every state change that touches a store is a read-modify-write: read
``index.json``, write a document, write ``index.json`` back. Inside one
process that is safe enough; across two processes on one directory it is not
safe at all, and the failure is silent. Both processes read the same index,
both write a document at the same load code, and the second index write
erases the first one's row. Both callers were told "saved".

Two processes on one directory is not a hypothetical. It is two containers on
one volume, and it is two saves against one ``~/.soil`` — an agent saving
beside a person doing the same.

## The mechanism

An advisory lock directory, taken with ``os.mkdir``. ``mkdir`` either creates
the directory or fails with ``FileExistsError``, in one indivisible step, on
every filesystem this code can run on including NFS, where ``O_EXCL`` on a
plain file historically could not be trusted. No dependency: the standard
library expresses every part of this.

A ``holder.json`` inside the directory records who holds it. The holder id is
random, never a process id. Two containers that both run as pid 1 must not be
able to look like each other; that also rules out any "is that pid alive"
stale check, which would be wrong across containers anyway.

## What happens when the lock cannot be taken

The write is refused. Nothing is written and nothing is half-written: the
caller gets :class:`LockBusyError`. A refusal a caller can retry is the honest
outcome; the thing that must never happen is an acknowledgement for a write
that did not survive.

## What it costs

Waiting blocks the calling thread. That is deliberate and matches the
TypeScript reference in ``packages/sdk-ts/src/lock.ts``: the held section is a
few file writes, so a wait only ever happens when another *process* holds the
lock, and the timeout is short for the same reason.

A stale lock, left by a process that was killed mid-write, is broken after
:data:`DEFAULT_STALE_MS`. Breaking a lock is the one unsound moment in any
advisory scheme, so it is deliberately far beyond any honest hold time.

## Two refusals, one rule

Both ends of the lock are a filesystem call that can be refused for a reason
that passes, and both are held to the same rule: retry for
:data:`_RETRY_BUDGET_MS`, then report the refusal as itself.

Releasing is a directory removal. It is refused on Windows when another
process holds a file inside the directory open, which is exactly what every
waiter is doing to ``holder.json``. A release whose outcome is discarded is
worse than one that fails loudly: the holder carries on believing it released,
and every other writer waits the whole staleness window for a lock that nobody
holds.

Taking is a directory create. ``mkdir`` says already-exists when somebody else
holds the lock, and that is the ordinary answer, but it is not the only way a
platform says the name is unavailable. Windows refuses a create on a name
whose deletion has been accepted and not yet finished, with access-denied,
while a lookup of that same name already reports it as gone: for a few
milliseconds the name is neither present nor creatable. Measured on a Windows
runner over 180 repetitions of two races: 38 refused creates, all of them
access-denied, all of them with a lookup reporting the name absent, and every
one resolving into a taken lock between 4 and 121 milliseconds.

So a create refused for anything but already-exists is treated as contention
for as long as the budget, and reported as itself once the budget is spent. It
is never turned into :class:`LockBusyError`, because a directory that cannot
be created is not a busy lock, and the difference has to reach the caller.

The on-disk shape — the ``<name>.lock`` directory, the ``holder.json`` inside
it and the fields it carries — is the same in all five SDKs, so a Python
writer and a Go writer on one store wait for each other.
"""

from __future__ import annotations

import json
import os
import random
import shutil
import socket
import time
import uuid
from pathlib import Path
from typing import Any, Callable, TypeVar

__all__ = [
    "DEFAULT_TIMEOUT_MS",
    "DEFAULT_STALE_MS",
    "LockBusyError",
    "with_lock",
]

T = TypeVar("T")

#: How long an acquire waits before giving up.
DEFAULT_TIMEOUT_MS = 5_000

#: How old a lock must be before it is treated as abandoned.
DEFAULT_STALE_MS = 30_000

#: How long either side of the lock keeps trying a filesystem call that was
#: refused for a reason that passes, before reporting the refusal as itself.
#: Well inside :data:`DEFAULT_TIMEOUT_MS`, so a retry never itself becomes the
#: reason a waiter is refused, and far short of :data:`DEFAULT_STALE_MS`.
_RETRY_BUDGET_MS = 1_000

_HOLDER_FILE = "holder.json"


class LockBusyError(Exception):
    """Raised when a lock could not be taken. Nothing was written."""

    def __init__(self, lock_name: str) -> None:
        super().__init__(
            f"another process is writing and the {lock_name} lock could not "
            "be taken; nothing was written, try again"
        )
        #: The lock that was contended, as a short name, never a path.
        self.lock_name = lock_name


def _now_ms() -> int:
    return int(time.time() * 1000)


def _read_holder(directory: Path) -> dict[str, Any] | None:
    """The holder record, or ``None`` when there is not a readable one.

    A lock directory with no readable holder file is one that was created a
    moment ago, or one whose holder died between the two steps. Both are
    handled by the staleness path in :func:`with_lock`.
    """
    try:
        parsed = json.loads((directory / _HOLDER_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if (
        isinstance(parsed, dict)
        and isinstance(parsed.get("holder"), str)
        and isinstance(parsed.get("acquiredAt"), (int, float))
        and not isinstance(parsed.get("acquiredAt"), bool)
    ):
        return parsed
    return None


def _directory_age(directory: Path) -> int:
    """When the lock directory itself was last written, or now if unreadable."""
    try:
        return int(directory.stat().st_mtime * 1000)
    except OSError:
        return _now_ms()


def _remove_lock_directory(directory: Path) -> OSError | None:
    """Remove the lock directory and whatever is inside it, once.

    Hands back ``None`` when the directory is gone afterwards, and the failure
    when it is still there. Nobody may assume the removal happened: that
    assumption is what turns one refused delete into a lock held for the whole
    staleness window.
    """
    try:
        (directory / _HOLDER_FILE).unlink()
    except OSError:
        # Left to the removal below, which is the call whose outcome is read.
        pass
    try:
        shutil.rmtree(directory)
    except FileNotFoundError:
        return None
    except OSError as error:
        return error
    return None


def _release_lock_directory(directory: Path) -> OSError | None:
    """Give the lock back, retrying a removal that failed for a passing reason.

    Deleting a file another process holds open is refused outright on some
    platforms, and every waiter reads ``holder.json`` a few times a second, so
    a release and a waiter's read do collide. The collision lasts as long as
    one read, which is why retrying is what resolves it, on the same jitter
    the acquire loop uses. Measured on a Windows runner: one release in fifty
    was refused this way, and the lock it failed to give back stayed held for
    the full thirty seconds, refusing every save in that window.

    Whatever is still there when the budget is spent is handed back rather
    than dropped. A lock this process holds and cannot give back is one every
    other writer waits the staleness window for, and this process is the only
    one in a position to say so.
    """
    deadline = _now_ms() + _RETRY_BUDGET_MS
    while True:
        failure = _remove_lock_directory(directory)
        if failure is None or _now_ms() >= deadline:
            return failure
        time.sleep((3 + random.randrange(9)) / 1000.0)


def _break_if_stale(directory: Path, seen: dict[str, Any]) -> None:
    """Break a lock that looks abandoned, but only the exact one seen so.

    The holder id is re-read immediately before the removal, so a lock that
    changed hands in between is left alone.

    A removal that fails here is left to the acquire loop, which comes back
    within milliseconds and tries again. That is the difference between this
    path and the release path: here the caller is about to look, so nothing is
    being told that the lock is gone.
    """
    again = _read_holder(directory)
    if again is None or again.get("holder") != seen.get("holder"):
        return
    _remove_lock_directory(directory)


def with_lock(
    locks_dir: str | os.PathLike[str],
    name: str,
    body: Callable[[], T],
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    stale_ms: int = DEFAULT_STALE_MS,
) -> T:
    """Run ``body`` while holding the named lock.

    ``locks_dir`` must sit on the same volume as the data it guards, because
    that is the only thing two processes are guaranteed to share.
    :class:`~soil_handover.store.HandoverStore` passes ``<store root>/.locks``,
    which is where every SDK puts it, so the layout stays identical.

    :raises LockBusyError: if the lock could not be taken in time. Nothing ran
        and nothing was written.
    """
    locks = Path(locks_dir)
    directory = locks / f"{name}.lock"
    holder = {
        "holder": str(uuid.uuid4()),
        "acquiredAt": _now_ms(),
        "host": socket.gethostname(),
        # Informational only. Nothing is ever decided from this.
        "pid": os.getpid(),
    }

    locks.mkdir(parents=True, exist_ok=True)

    deadline = _now_ms() + timeout_ms
    taken = False
    # The first create refused for a reason other than already-exists, and
    # when. Cleared the moment a create is refused for already-exists, because
    # that is the name becoming visible again: whatever the earlier refusal
    # was, it is over.
    refused: OSError | None = None
    refused_at = 0
    while True:
        try:
            os.mkdir(directory)
            taken = True
            break
        except FileExistsError:
            refused = None
            refused_at = 0
        except OSError as error:
            # Not already-exists, and not necessarily fatal either. See "Two
            # refusals, one rule" above: this is how one platform says a name
            # is on its way out. Give it the budget, then let it speak.
            if not directory.parent.is_dir():
                # Except when there is nothing to wait for. No amount of
                # waiting makes a name creatable inside a directory that is
                # not there, and the caller should hear that at once.
                raise
            if refused is None:
                refused_at = _now_ms()
            refused = error
            if _now_ms() - refused_at >= _RETRY_BUDGET_MS:
                raise
            time.sleep((3 + random.randrange(9)) / 1000.0)
            continue

        now = _now_ms()
        current = _read_holder(directory)
        if current is not None:
            if now - int(current["acquiredAt"]) > stale_ms:
                _break_if_stale(directory, current)
                continue
        elif now - _directory_age(directory) > stale_ms:
            # A lock directory with no readable holder file is either one
            # created a microsecond ago, or one whose owner died between the
            # mkdir and the write. Without this branch the second case would
            # be a lock nothing can ever break, so the directory's own mtime
            # stands in for the holder.
            _remove_lock_directory(directory)
            continue

        if now >= deadline:
            break
        # A little jitter, so two waiters do not wake in lockstep forever.
        time.sleep((3 + random.randrange(9)) / 1000.0)

    if not taken:
        raise LockBusyError(name)

    (directory / _HOLDER_FILE).write_text(
        json.dumps(holder, separators=(",", ":")), encoding="utf-8"
    )
    failure: OSError | None = None
    try:
        result = body()
    finally:
        # Release only what is still ours. If the lock was broken as stale
        # while this body ran, the directory now belongs to somebody else and
        # removing it would hand a third process a lock two processes think
        # they hold.
        current = _read_holder(directory)
        if current is None or current.get("holder") == holder["holder"]:
            failure = _release_lock_directory(directory)

    # Reached only when the body returned. A body that raised carries the more
    # informative failure, and it has already left this function.
    if failure is not None:
        raise failure
    return result
