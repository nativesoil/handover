"""One saving writer process for the Python concurrency test.

The failure this file exists to reproduce cannot be written inside one
process. Documents are only lost when two *processes* share one store, which
is not exotic: it is an agent saving into ``~/.soil`` while a person does the
same, or two containers on one volume.

Usage:
  python3 concurrent_save.py <soilHome> <startAtMs> <count> <out> <docDir>

Every acknowledgement the store hands back is appended to <out> as one JSON
line, together with the marker the document carried, so the test can check
each receipt against the disk. A save that raised is recorded as one line
too, carrying the exception's name: a refusal is a legitimate answer under
contention, an acknowledgement for a write that did not survive is not.

Nothing here identifies a writer by its process id. Markers are random ids:
two containers on one volume both run as pid 1, so a test that told writers
apart by pid would agree with itself for the wrong reason.
"""

from __future__ import annotations

import json
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from soil_handover import SECTION_KEYS, HandoverStore  # noqa: E402


def handover(marker: str) -> dict:
    sections = {key: {"status": "missing", "summary": None} for key in SECTION_KEYS}
    sections["projectIdentity"] = {"status": "available", "summary": marker}
    return {
        "soilHandover": "1.0",
        "projectId": "billing-rework",
        "title": marker,
        "createdAt": "2026-07-24T10:00:00.000Z",
        "sections": sections,
    }


def main(argv: list[str]) -> int:
    home, start_at_raw, count_raw, out_raw, _doc_dir = argv
    start_at = int(start_at_raw) / 1000.0
    count = int(count_raw)
    out = Path(out_raw)

    worker_id = str(uuid.uuid4())
    store = HandoverStore(home)

    # A deliberate busy wait, so the processes collide instead of queueing.
    while time.time() < start_at:
        pass

    for i in range(count):
        marker = f"{worker_id}-{i}"
        try:
            entry = store.save(handover(marker))
            line = {"ok": True, "code": entry["code"], "marker": marker}
        except Exception as error:  # noqa: BLE001 - recorded, never swallowed
            line = {
                "ok": False,
                "marker": marker,
                "error": f"{type(error).__name__}: {error}",
            }
        with out.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(line) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
