#!/usr/bin/env python3
"""LangGraph + Soil: export a checkpointed graph's project state as a handover.

What this example does, end to end and without any API key:

1. Runs a real LangGraph `StateGraph` twice on one thread. The graph is a
   deterministic support-triage pipeline with no model call anywhere, and an
   `InMemorySaver` checkpointer accumulates state across the two invocations.
2. Reads the final checkpoint back through `graph.get_state`, which is the
   framework's own view of the thread's state.
3. Builds a Soil handover from that state with the official Python SDK,
   validates it, and saves it to a scratch store.
4. Runs the reference CLI against the stored document: `soil validate`,
   `soil check` (the deterministic grading baseline, exit 0 required), and
   `soil load`, then asserts that facts from the live graph state survived
   into the restore prompt.

LangGraph can retain graph checkpoints inside its runtime. Soil exports the
current project state so another agent or platform can continue without
running the same graph.

Everything here is real: the framework side runs the actual `langgraph`
package, and the Soil side runs the actual SDK and CLI. The handover text is
assembled by this script from live graph state so the run is deterministic
and keyless; in normal use a model writes the handover from the extraction
recipe instead.
"""

from __future__ import annotations

import json
import operator
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, TypedDict

# The official Python SDK, imported straight from the repository tree. The
# package is standard library only, so a path entry is a complete install.
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "packages" / "sdk-py"))

from soil_handover import (  # noqa: E402
    HandoverStore,
    SECTION_KEYS,
    normalize_handover,
    validate_handover,
)

from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402
from langgraph.graph import END, START, StateGraph  # noqa: E402


# --------------------------------------------------------------------------
# Part 1: the framework side. A deterministic triage pipeline, checkpointed.
# --------------------------------------------------------------------------

QUEUES = ("payments", "logistics", "general")

# Keyword routing, locked as data so the pipeline needs no model call.
ROUTING_RULES: tuple[tuple[str, str], ...] = (
    ("refund", "payments"),
    ("charge", "payments"),
    ("delivery", "logistics"),
    ("courier", "logistics"),
)


class TriageState(TypedDict):
    """The graph state. Reducers accumulate across invocations on a thread."""

    tickets: Annotated[list[dict], operator.add]
    routed: Annotated[list[dict], operator.add]
    decisions: Annotated[list[dict], operator.add]


def route(ticket: dict) -> str:
    for keyword, queue in ROUTING_RULES:
        if keyword in ticket["text"].lower():
            return queue
    return "general"


def classify(state: TriageState) -> dict:
    """Route every ticket that has not been routed yet."""
    done = {r["id"] for r in state["routed"]}
    pending = [t for t in state["tickets"] if t["id"] not in done]
    return {"routed": [{**t, "queue": route(t)} for t in pending]}


def record_policy(state: TriageState) -> dict:
    """Record the routing policy into state once, as decisions with reasons."""
    if state["decisions"]:
        return {"decisions": []}
    return {
        "decisions": [
            {
                "what": "Refund and charge tickets route to the payments queue"
                " ahead of everything else",
                "because": "a refund that waits a day tends to become a"
                " chargeback",
            },
            {
                "what": "Routing is a fixed keyword table, not a model call",
                "because": "the pipeline must give the same answer on every"
                " run and must run without credentials",
            },
            {
                "what": "Unmatched tickets fall through to the general queue"
                " rather than erroring",
                "because": "a stuck ticket is worse than a broadly routed one",
            },
        ]
    }


def build_graph():
    graph = StateGraph(TriageState)
    graph.add_node("classify", classify)
    graph.add_node("record_policy", record_policy)
    graph.add_edge(START, "classify")
    graph.add_edge("classify", "record_policy")
    graph.add_edge("record_policy", END)
    return graph.compile(checkpointer=InMemorySaver())


BATCH_ONE = [
    {"id": "T-101", "text": "Double charge on my last order"},
    {"id": "T-102", "text": "Courier never arrived on Tuesday"},
    {"id": "T-103", "text": "How do I change my address?"},
]

BATCH_TWO = [
    {"id": "T-104", "text": "Requesting a refund for a damaged box"},
    {"id": "T-105", "text": "Delivery window was missed twice"},
]


def run_pipeline():
    """Two invocations on one thread; the checkpointer carries the state."""
    app = build_graph()
    config = {"configurable": {"thread_id": "triage-main"}}
    app.invoke({"tickets": BATCH_ONE, "routed": [], "decisions": []}, config)
    app.invoke({"tickets": BATCH_TWO}, config)
    return app.get_state(config)


# --------------------------------------------------------------------------
# Part 2: the Soil side. Build a handover from the checkpoint state.
# --------------------------------------------------------------------------


def queue_counts(routed: list[dict]) -> dict[str, int]:
    counts = {q: 0 for q in QUEUES}
    for r in routed:
        counts[r["queue"]] += 1
    return counts


def build_handover(snapshot) -> dict:
    state = snapshot.values
    step = snapshot.metadata.get("step")
    counts = queue_counts(state["routed"])
    n_routed = len(state["routed"])
    decisions_text = "Every decision locked so far, with why:\n\n" + "\n".join(
        f"{i}. {d['what']}. Locked because {d['because']}."
        for i, d in enumerate(state["decisions"], start=1)
    )
    count_line = ", ".join(f"{counts[q]} to {q}" for q in QUEUES)

    sections = {
        "projectIdentity": (
            "Harbor triage is the support-ticket routing pipeline for a small"
            " subscription box service. Tickets arrive in batches and every"
            " ticket must end up in exactly one of 3 queues: payments,"
            " logistics or general. The pipeline is implemented as a LangGraph"
            " state graph whose thread checkpoint is the single source of"
            " truth for what has been routed."
        ),
        "decisions": decisions_text,
        "workflow": (
            "Batches of tickets are fed to the graph as invocations on one"
            " thread, thread id triage-main. Each invocation routes only the"
            " tickets the checkpoint does not already hold, so re-running a"
            " batch is safe. The routing policy itself lives in graph state,"
            " recorded once by the record_policy node, so the state alone"
            " explains why tickets land where they land."
        ),
        "architecture": (
            "A LangGraph StateGraph with 2 nodes, classify then record_policy,"
            " compiled with an InMemorySaver checkpointer. State has 3"
            " channels, tickets, routed and decisions, each accumulating with"
            " an add reducer. The routing table has 4 keyword rules mapping to"
            " 2 named queues plus a general fallback. Pinned framework:"
            " langgraph 1.2.9 on Python 3.12."
        ),
        "constraints": (
            "Routing must stay deterministic: same tickets in, same queues"
            " out, on every run, because the pipeline runs in continuous"
            " integration without credentials and a flaky route would be"
            " invisible until a customer complains. Ticket ids are unique and"
            " never reused. The checkpoint is the only store; no side channel"
            " may record routing results."
        ),
        "rejectedPaths": (
            "A model-based classifier node was rejected because it cannot run"
            " keyless and its answers drift between runs. Storing routed"
            " tickets in an external table was rejected because the checkpoint"
            " would stop being the single source of truth. Routing whole"
            " batches as one unit was rejected because a single bad ticket"
            " would block its whole batch."
        ),
        "executiveSummary": (
            f"At capture, {n_routed} tickets had been routed across 2 batches"
            f" on thread triage-main: {count_line}. The routing policy, 3"
            " locked decisions, is recorded inside the graph state itself."
            f" The checkpoint stood at step {step}."
        ),
        "currentTask": (
            "At capture the second batch of 2 tickets had just been routed"
            " and the checkpoint held the combined state of both batches."
            " The task in motion is carrying this pipeline state to another"
            " agent so batch three can be triaged without this runtime."
        ),
        "latestUserIntent": (
            "Produce a portable handover of the triage pipeline state so"
            " another agent or platform can continue the work without"
            " replaying the graph or holding its checkpointer in memory."
        ),
        "sessionDelta": (
            f"This session ran the graph twice on one thread: batch one with 3"
            f" tickets, batch two with 2, for {n_routed} routed in total."
            " The routing policy was recorded into state during the first"
            " invocation and left untouched by the second."
        ),
        "blockers": (
            "No blockers were open at capture. Both batches routed cleanly"
            " and no ticket fell outside the keyword table plus fallback."
        ),
        "nextSteps": (
            "Triage batch three when it arrives, watching the general queue:"
            " if it keeps growing, extend the keyword table. Add a rule for"
            " address-change requests, which route to general at capture but"
            " probably deserve their own queue."
        ),
        "openQuestions": (
            "Whether the 4-rule keyword table is complete enough for the"
            " address-change traffic. Whether batches stay small enough,"
            " under roughly 50 tickets, for single-invocation routing to"
            " remain the right shape."
        ),
        "sessionActivity": (
            "This handover was produced by a deterministic example script:"
            " it built the graph, ran 2 invocations on thread triage-main,"
            " read the final checkpoint through get_state, and assembled"
            " this document from those values plus fixed fixture prose."
        ),
        "restoreInstructions": (
            "You are continuing the Harbor triage pipeline, a deterministic"
            " support-ticket router. Hold these locked decisions: refund and"
            " charge tickets go to payments first, because a waiting refund"
            " tends to become a chargeback; routing is a fixed keyword table"
            " and never a model call, because answers must be identical on"
            " every run and need no credentials; unmatched tickets fall"
            " through to general, because a stuck ticket is worse than a"
            f" broadly routed one. State at capture: {n_routed} tickets"
            f" routed, {count_line}, checkpoint step {step}. Do not"
            " reintroduce a model classifier and do not create any store"
            " outside the graph checkpoint. Start by triaging the next batch"
            " with the same keyword table, and if general keeps growing,"
            " extend the table rather than loosening the rules."
        ),
        "provenanceMap": (
            "Ticket counts, queue totals, the checkpoint step and the thread"
            " id were read from the live LangGraph checkpoint by the example"
            " script. The decision entries were read from the decisions"
            " channel of that same state. The project description prose is"
            " fixture text written for this example and is marked as such."
        ),
        "safetySummary": (
            "Nothing was withheld. The example runs keyless by design, so no"
            " credential existed to leak, and ticket texts are invented"
            " fixture strings with no personal data in them."
        ),
    }

    return {
        "soilHandover": "1.0",
        "projectId": "harbor-triage",
        "title": "Triage pipeline: 5 tickets routed over 2 batches,"
        " policy locked in state",
        "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "client": "langgraph-example",
            "provider": "none",
            "model": "none",
        },
        "sections": {
            key: {"status": "available", "summary": sections[key]}
            for key in SECTION_KEYS
        },
        "quality": {
            "missingInputs": [
                "The checkpoint retains state values but not per-invocation"
                " wall-clock timing, so batch durations are unknown."
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
    snapshot = run_pipeline()
    assert len(snapshot.values["routed"]) == 5, "pipeline state is off"
    assert queue_counts(snapshot.values["routed"]) == {
        "payments": 2,
        "logistics": 2,
        "general": 1,
    }, "routing is not deterministic"
    print("framework: 2 invocations checkpointed, 5 tickets routed")

    document = normalize_handover(build_handover(snapshot))

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
            "harbor-triage",
            "5 tickets",
            "2 to payments, 2 to logistics, 1 to general",
            "tends to become a chargeback",
            "never a model call",
            "Do not reintroduce a model classifier",
        ):
            assert fact in prompt, f"restore prompt lost the fact: {fact}"
        print("cli: load produced a restore prompt carrying the graph state")

    print("PASS: LangGraph state survived the full keyless round trip")


if __name__ == "__main__":
    main()
