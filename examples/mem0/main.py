#!/usr/bin/env python3
"""Mem0 + Soil: turn accumulated memories into a bounded project handover.

Mem0 can retain user or agent memory. Soil creates a bounded project handover
that can move to another session, tool or provider.

What is real here and what is not, exactly:

- REAL: the whole Soil side. The official Python SDK builds, validates and
  stores the handover, and the reference CLI runs `soil validate`,
  `soil check` (exit 0 required) and `soil load` against the stored document.
- STUB: the Mem0 client. `mem0ai` 2.0.13 initialises an embedder and a
  language model provider inside `Memory()`, so it cannot run keyless: with
  no key in the environment the constructor raises OpenAIError before any
  memory call. `StubMemory` below mirrors the small slice of the `Memory`
  surface this example uses (`add` with `infer=False`, `search`, `get_all`)
  so the integration shape is the same and the swap to the real client is
  mechanical. Nothing about Mem0 itself is being exercised or claimed.

The scenario: a person plans a neighborhood tool-lending library with an
assistant over two sessions. Memory accumulates facts and preferences. At
handover time, the project truth is exported as a bounded Soil document, and
the purely personal preferences deliberately stay behind in memory: that
boundary is asserted at the end.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "packages" / "sdk-py"))

from soil_handover import (  # noqa: E402
    HandoverStore,
    SECTION_KEYS,
    normalize_handover,
    validate_handover,
)


# --------------------------------------------------------------------------
# Part 1: the framework side. A clearly labeled stand-in for mem0.Memory.
# --------------------------------------------------------------------------


class StubMemory:
    """A keyless stand-in for `mem0.Memory`, and only for this example.

    It mirrors the call and return shapes of the three methods the example
    uses, in their `infer=False` form where the text is stored as given
    rather than distilled by a model. It is a plain in-process list with
    keyword-overlap search. It is not Mem0 and it demonstrates nothing about
    Mem0's quality; it exists so the Soil side of this example can run in
    continuous integration without credentials.
    """

    def __init__(self) -> None:
        self._rows: list[dict] = []

    def add(self, text: str, *, user_id: str, metadata: dict | None = None, infer: bool = False) -> dict:
        row = {
            "id": f"mem-{len(self._rows) + 1:03d}",
            "memory": text,
            "user_id": user_id,
            "metadata": metadata or {},
        }
        self._rows.append(row)
        return {"results": [{"id": row["id"], "memory": text, "event": "ADD"}]}

    def search(self, query: str, *, user_id: str, limit: int = 5) -> dict:
        terms = {t for t in query.lower().split() if len(t) > 2}
        scored = []
        for row in self._rows:
            if row["user_id"] != user_id:
                continue
            words = set(row["memory"].lower().split())
            score = len(terms & words)
            if score:
                scored.append({**row, "score": score})
        scored.sort(key=lambda r: (-r["score"], r["id"]))
        return {"results": scored[:limit]}

    def get_all(self, *, user_id: str) -> dict:
        return {"results": [r for r in self._rows if r["user_id"] == user_id]}


USER = "alex"


def run_sessions(memory: StubMemory) -> None:
    """Two planning sessions leave their trace in memory, as Mem0 usage does."""
    # Session one: the project takes shape.
    memory.add(
        "The Toolshed is a neighborhood tool-lending library being set up in"
        " the housing co-op's basement workshop",
        user_id=USER,
        metadata={"kind": "identity"},
    )
    memory.add(
        "Lending is deposit-free, because the deposit scheme at the nearby"
        " book swap cut sign-ups roughly in half",
        user_id=USER,
        metadata={"kind": "decision"},
    )
    memory.add(
        "Loans are capped at 7 days with one renewal, because longer loans"
        " at comparable libraries turned into de facto ownership",
        user_id=USER,
        metadata={"kind": "decision"},
    )
    memory.add(
        "The inventory lives in one ledger with 4 columns, tool, member,"
        " out-date and due-date, because two lists drifted apart during the"
        " pilot week",
        user_id=USER,
        metadata={"kind": "decision"},
    )
    memory.add(
        "Commercial rental software was rejected because the yearly fee"
        " exceeds the entire 400 euro startup budget",
        user_id=USER,
        metadata={"kind": "rejected"},
    )
    memory.add(
        "Alex prefers metric units everywhere",
        user_id=USER,
        metadata={"kind": "preference"},
    )
    # Session two: progress and an open question.
    memory.add(
        "62 tools are catalogued as of the second planning session",
        user_id=USER,
        metadata={"kind": "status"},
    )
    memory.add(
        "Open question: whether the co-op's insurance covers power tools"
        " lent to members, the board has not answered yet",
        user_id=USER,
        metadata={"kind": "question"},
    )
    memory.add(
        "Alex likes replies kept short and direct",
        user_id=USER,
        metadata={"kind": "preference"},
    )


def by_kind(memory: StubMemory, kind: str) -> list[str]:
    rows = memory.get_all(user_id=USER)["results"]
    return [r["memory"] for r in rows if r["metadata"].get("kind") == kind]


# --------------------------------------------------------------------------
# Part 2: the Soil side. A bounded project handover from the memory layer.
# --------------------------------------------------------------------------


def build_handover(memory: StubMemory) -> dict:
    decisions = by_kind(memory, "decision")
    rejected = by_kind(memory, "rejected")
    status = by_kind(memory, "status")
    questions = by_kind(memory, "question")
    identity = by_kind(memory, "identity")

    decisions_text = "Every decision locked so far, with why:\n\n" + "\n".join(
        f"{i}. {text}." for i, text in enumerate(decisions, start=1)
    )

    sections = {
        "projectIdentity": (
            f"{identity[0]}. Members borrow tools with a card, volunteers"
            " staff two opening evenings per week, and the whole thing must"
            " run on paper plus one very small ledger."
        ),
        "decisions": decisions_text,
        "workflow": (
            "Planning happens in assistant sessions; durable facts are"
            " written to a memory layer as they are agreed, tagged by kind,"
            " so each new session starts by reading memory rather than"
            " re-asking. At a boundary, the project truth is exported as a"
            " Soil handover, and personal preferences stay in the memory"
            " layer where they belong."
        ),
        "architecture": (
            "One inventory ledger with 4 columns: tool, member, out-date and"
            " due-date. One member card per household. Loans capped at 7 days"
            " with 1 renewal. No software beyond the ledger; the 400 euro"
            " budget is reserved for shelving and engraving tools with id"
            " numbers."
        ),
        "constraints": (
            "The startup budget is 400 euro in total and recurring fees are"
            " out, because the co-op board approved a one-off amount only."
            " Power tools may not be lent until the insurance question is"
            " settled, because an uncovered injury would end the project."
        ),
        "rejectedPaths": " ".join(f"{text}." for text in rejected)
        + " A deposit scheme was rejected as well; the deposit-free decision"
        " above records the reason.",
        "executiveSummary": (
            f"At capture: {status[0]}. The lending rules are locked, 3"
            " decisions with their reasons, and the one open question is"
            " insurance coverage for power tools. Opening night is planned"
            " for when shelving is built."
        ),
        "currentTask": (
            "At capture the task in motion was cataloguing donated tools,"
            " with 62 done, and chasing the co-op board for the insurance"
            " answer before any power tool goes on the shelf."
        ),
        "latestUserIntent": (
            "Export the project state as a bounded handover so the planning"
            " can continue in another tool or with another assistant without"
            " re-deriving the rules or losing the reasons behind them."
        ),
        "sessionDelta": (
            "Across two sessions the memory layer accumulated 9 entries:"
            " 1 identity fact, 3 decisions, 1 rejected path, 1 status count,"
            " 1 open question and 2 personal preferences. The handover"
            " exports the project entries and leaves the preferences behind."
        ),
        "blockers": (
            "One blocker at capture: power-tool lending waits on the co-op"
            " board's insurance answer, and the board meets monthly."
        ),
        "nextSteps": (
            "Finish cataloguing the remaining donations, build the shelving"
            " within the 400 euro budget, and put the insurance question on"
            " the board's next agenda so power tools can be shelved or"
            " formally excluded."
        ),
        "openQuestions": " ".join(f"{q}." for q in questions),
        "sessionActivity": (
            "This handover was produced by a deterministic example script:"
            " it wrote 9 memory entries across two scripted sessions, read"
            " them back by kind, and assembled this document from those"
            " entries plus fixture prose. A stand-in memory client was used;"
            " the memory entries themselves are the source of every fact."
        ),
        "restoreInstructions": (
            "You are continuing planning for The Toolshed, a neighborhood"
            " tool-lending library in a housing co-op basement. Hold these"
            " locked decisions: lending is deposit-free, because a deposit"
            " scheme halved sign-ups at a comparable library; loans are 7"
            " days with one renewal, because longer loans became de facto"
            " ownership elsewhere; the inventory is one ledger with 4"
            " columns, because parallel lists drifted during the pilot."
            " Constraints: 400 euro one-off budget, no recurring fees, and"
            " no power-tool lending until insurance is confirmed. State at"
            " capture: 62 tools catalogued, insurance question open with the"
            " board. Start by finishing the catalogue and keep the ledger as"
            " the only inventory record."
        ),
        "provenanceMap": (
            "The decisions, the rejected path, the tool count and the open"
            " question were read back from the memory layer's entries, as"
            " stored. The surrounding prose, member cards and opening"
            " evenings, is fixture text written for this example. The memory"
            " client is a stand-in, so entry storage and retrieval shapes"
            " follow its contract rather than a live Mem0 instance."
        ),
        "safetySummary": (
            "Nothing was withheld. The scenario contains no credentials and"
            " no personal data beyond a first name, and the two personal"
            " preference entries were deliberately left out of this document"
            " as out of scope rather than unsafe."
        ),
    }

    return {
        "soilHandover": "1.0",
        "projectId": "toolshed-library",
        "title": "Tool library planning: rules locked, 62 tools catalogued,"
        " insurance open",
        "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "client": "mem0-example",
            "provider": "none",
            "model": "none",
        },
        "sections": {
            key: {"status": "available", "summary": sections[key]}
            for key in SECTION_KEYS
        },
        "quality": {
            "missingInputs": [
                "The co-op board's answer on insurance coverage did not exist"
                " at capture, so power-tool lending policy is unresolved."
            ],
            "contradictions": [],
        },
        "safety": {"unsafeOmissions": []},
    }


# --------------------------------------------------------------------------
# Part 3: the round trip. Python SDK writes, the reference CLI reads.
# --------------------------------------------------------------------------


def run_cli(args: list[str], soil_home: str) -> subprocess.CompletedProcess:
    cli = REPO_ROOT / "packages" / "cli" / "bin" / "soil.js"
    if not (REPO_ROOT / "packages" / "cli" / "dist" / "index.js").exists():
        sys.exit("The CLI is not built. Run: pnpm install && pnpm build")
    return subprocess.run(
        ["node", str(cli), *args],
        capture_output=True,
        text=True,
        env={**os.environ, "SOIL_HOME": soil_home},
    )


def main() -> None:
    memory = StubMemory()
    run_sessions(memory)
    assert len(memory.get_all(user_id=USER)["results"]) == 9
    found = memory.search("insurance power tools", user_id=USER)
    assert found["results"], "memory search came back empty"
    print("framework stub: 9 memories over 2 sessions, search answering")

    document = normalize_handover(build_handover(memory))

    with tempfile.TemporaryDirectory() as soil_home:
        store = HandoverStore(soil_home)
        entry = store.save(document)
        code = entry["code"]
        stored_path = store.path_for(code)
        print(f"sdk-py: saved as {code}, {entry['sectionsWithContent']}/17 sections carrying content")

        result = validate_handover(store.read(code))
        assert result.valid, f"sdk-py validation failed: {result.issues}"

        validated = run_cli(["validate", str(stored_path)], soil_home)
        assert validated.returncode == 0, f"soil validate failed:\n{validated.stdout}{validated.stderr}"

        checked = run_cli(["check", str(stored_path), "--json"], soil_home)
        assert checked.returncode == 0, f"soil check gated:\n{checked.stdout}{checked.stderr}"
        grade = json.loads(checked.stdout)["grade"]
        assert grade in ("strong", "adequate"), grade
        print(f"cli: validate passed, check grade {grade}")

        loaded = run_cli(["load", code], soil_home)
        assert loaded.returncode == 0, f"soil load failed:\n{loaded.stderr}"
        prompt = loaded.stdout
        for fact in (
            "toolshed-library",
            "62 tools catalogued",
            "halved sign-ups",
            "de facto ownership",
            "400 euro",
            "insurance",
        ):
            assert fact in prompt, f"restore prompt lost the fact: {fact}"
        # The boundary this example exists to show: memory keeps the person,
        # the handover carries the project. Preferences stay behind.
        assert "metric units" not in prompt, "a personal preference leaked"
        assert "short and direct" not in prompt, "a personal preference leaked"
        print("cli: load carried the project and left the preferences behind")

    print("PASS: memories became a bounded handover in a keyless round trip")


if __name__ == "__main__":
    main()
