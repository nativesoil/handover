"""Four saving processes, one store.

``HandoverStore.save`` was an unlocked read-modify-write, so two processes
against one ``~/.soil`` both read the same ``nextCode``, both wrote a document
at that code, and the second index write erased the first one's row. Both
callers were told "saved".

Measured on the unlocked store, four processes saving fifteen times each:
60 acknowledged and 18, 18 and 17 documents on disk over three runs, so 42, 42
and 43 acknowledgements for documents that no longer existed. The store now
takes the lock in ``soil_handover/lock.py``, and this file is what says so.

The checks are the ones the TypeScript CLI's concurrency test makes, because
it is the same defect:

  1. every save the store acknowledged is on disk afterwards
  2. no two acknowledgements carry the same load code
  3. every acknowledged code still holds the document that receipt named
  4. no half-written temporary file survived the race

Nothing here identifies a writer by its process id. Markers are random ids
(see ``test-workers/concurrent_save.py``): two containers on one volume both
run as pid 1, and a test that told writers apart by pid would agree with
itself for the wrong reason.

Slow by the standards of the rest of this package, and the only test here that
can fail for a reason a reader would call "a race", so it gets its own file.
"""

import json
import subprocess
import sys
import time
from pathlib import Path

from soil_handover import HandoverStore

WORKER = Path(__file__).resolve().parent.parent / "test-workers" / "concurrent_save.py"

PROCESSES = 4
PER_PROCESS = 15

#: How long the workers get before the test gives up on them.
WORKER_TIMEOUT_S = 120


def race(store_root, docs, acks):
    """Run the worker processes, all beginning to save at the same instant.

    Each worker is given its own file to write, rather than one file that all
    four append to. An append is only indivisible if the platform makes it so,
    and here it is not: CPython opens a file in append mode through the C
    runtime, which seeks to the end and then writes, so two processes can
    settle on the same offset and one overwrites the other. Measured on a
    Windows runner over 90 repetitions of this race, 5 of them lost between one
    and three acknowledgements exactly that way, with every worker exiting
    cleanly and the store itself intact. The count that was supposed to prove
    the store lost nothing was the only thing losing anything, which is the
    worst way round for it to fail.

    The worker is unchanged and still writes wherever it is told, because the
    cross-language harness in ``conformance/interop`` runs these same workers
    and hands all of them one file.
    """
    start_at = int(time.time() * 1000) + 1500
    written = [acks / f"{worker}.jsonl" for worker in range(PROCESSES)]
    children = [
        subprocess.Popen(
            [
                sys.executable,
                str(WORKER),
                str(store_root),
                str(start_at),
                str(PER_PROCESS),
                str(out),
                str(docs),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        for out in written
    ]
    exits = []
    for child in children:
        _, stderr = child.communicate(timeout=WORKER_TIMEOUT_S)
        assert child.returncode == 0, stderr.decode("utf-8", "replace")
        exits.append(child.returncode)
    lines = [
        json.loads(line)
        for out in written
        for line in out.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return lines, exits


def test_loses_nothing_when_four_processes_save_into_one_store(tmp_path):
    store_root = tmp_path / "store"
    docs = tmp_path / "docs"
    acks = tmp_path / "acks"
    store_root.mkdir()
    docs.mkdir()
    acks.mkdir()

    lines, exits = race(store_root, docs, acks)
    assert exits == [0] * PROCESSES
    assert len(lines) == PROCESSES * PER_PROCESS

    acknowledged = [row for row in lines if row["ok"]]

    # A save that was refused under contention is honest, and this store is
    # uncontended enough that none should be. Either way the invariants below
    # are about what was acknowledged, never about what was tried.
    refused = [row for row in lines if not row["ok"]]
    assert [row["error"] for row in refused] == []
    assert len(acknowledged) == PROCESSES * PER_PROCESS

    store = HandoverStore(str(store_root))

    # 1. Nothing the store handed a code back for may be missing afterwards.
    on_disk = sorted(
        path.name for path in store.handovers_dir.iterdir() if path.suffix == ".json"
    )
    assert len(on_disk) == len(acknowledged)
    assert len(store.list()) == len(acknowledged)

    # 2. No two receipts may carry the same load code.
    codes = [row["code"] for row in acknowledged]
    assert len(set(codes)) == len(codes)

    # 3. Every receipt's code must still hold the document it named.
    for row in acknowledged:
        assert store.read(row["code"])["title"] == row["marker"]

    # 4. No half-written temporary file survived the race.
    assert [name for name in on_disk if ".tmp-" in name] == []
