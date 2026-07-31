#!/usr/bin/env python3
"""Letta + Soil: a portable handover out of a stateful agent's memory.

A Letta agent can remain stateful in its own environment. Soil creates a
portable handover for a cold external agent.

What is real here and what is not, exactly:

- REAL: the whole Soil side. The official Python SDK builds, validates and
  stores the handover, and the reference CLI runs `soil validate`,
  `soil check` (exit 0 required) and `soil load` against the stored document.
- STUB: the Letta client. A Letta agent lives behind a server, and creating
  or messaging an agent requires a configured language model provider, so
  the framework side cannot run keyless in continuous integration.
  `StubLettaClient` below mirrors the slice of the `letta-client` surface
  this example uses (`agents.create` with memory blocks, `agents.blocks`
  retrieve and modify, `agents.passages` create and list) so the integration
  shape is the same and the swap to a live server is mechanical. Nothing
  about Letta itself is being exercised or claimed.

The scenario: a stateful agent has been tending a school greenhouse project,
editing its own memory blocks and appending archival events as the weeks
pass. Its environment is about to be unavailable, so the project state is
exported as a Soil handover that a cold agent anywhere can load. The agent's
persona block deliberately stays behind: it belongs to the agent, not to the
project, and that boundary is asserted at the end.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "packages" / "sdk-py"))

from soil_handover import (  # noqa: E402
    HandoverStore,
    SECTION_KEYS,
    normalize_handover,
    validate_handover,
)


# --------------------------------------------------------------------------
# Part 1: the framework side. A clearly labeled stand-in for letta-client.
# --------------------------------------------------------------------------


class _Blocks:
    def __init__(self, store: dict) -> None:
        self._store = store

    def retrieve(self, agent_id: str, block_label: str) -> SimpleNamespace:
        value = self._store[agent_id]["blocks"][block_label]
        return SimpleNamespace(label=block_label, value=value)

    def modify(self, agent_id: str, block_label: str, value: str) -> None:
        self._store[agent_id]["blocks"][block_label] = value


class _Passages:
    def __init__(self, store: dict) -> None:
        self._store = store

    def create(self, agent_id: str, text: str) -> SimpleNamespace:
        rows = self._store[agent_id]["passages"]
        rows.append(text)
        return SimpleNamespace(id=f"passage-{len(rows):03d}", text=text)

    def list(self, agent_id: str) -> list[SimpleNamespace]:
        rows = self._store[agent_id]["passages"]
        return [
            SimpleNamespace(id=f"passage-{i:03d}", text=t)
            for i, t in enumerate(rows, start=1)
        ]


class _Agents:
    def __init__(self, store: dict) -> None:
        self._store = store
        self.blocks = _Blocks(store)
        self.passages = _Passages(store)

    def create(self, name: str, memory_blocks: list[dict]) -> SimpleNamespace:
        agent_id = f"agent-{len(self._store) + 1:03d}"
        self._store[agent_id] = {
            "name": name,
            "blocks": {b["label"]: b["value"] for b in memory_blocks},
            "passages": [],
        }
        return SimpleNamespace(id=agent_id, name=name)


class StubLettaClient:
    """A keyless stand-in for `letta_client.Letta`, only for this example.

    Memory blocks and archival passages are plain in-process data. A real
    Letta agent would edit its own blocks through tool calls decided by a
    model; here the script performs those edits directly so the run is
    deterministic and needs no server and no provider. It demonstrates
    nothing about Letta itself.
    """

    def __init__(self) -> None:
        self._store: dict = {}
        self.agents = _Agents(self._store)


def run_agent_weeks(client: StubLettaClient) -> str:
    """Script the trace a stateful greenhouse agent would leave over weeks."""
    agent = client.agents.create(
        name="greenhouse-keeper",
        memory_blocks=[
            {
                "label": "persona",
                "value": "I am a patient greenhouse keeper. I answer briefly"
                " and never guess sensor numbers.",
            },
            {
                "label": "human",
                "value": "The biology teacher checks in on Mondays and"
                " prefers a one-paragraph status.",
            },
            {
                "label": "project",
                "value": "The school greenhouse grows tomatoes and basil for"
                " the autumn market. Watering runs at dawn because midday"
                " watering lost roughly a third to evaporation in week 1."
                " Vent opens above 26 degrees, because 28 wilted the basil."
                " The east bed drains poorly, so it gets half volume.",
            },
        ],
    )
    events = [
        "Week 1: moved watering from midday to dawn after roughly a third"
        " of the water was lost to evaporation at midday.",
        "Week 2: vent threshold lowered from 28 to 26 degrees after the"
        " basil wilted on two hot afternoons.",
        "Week 2: east bed waterlogged; halved its watering volume and it"
        " recovered within four days.",
        "Week 3: aphids on two tomato plants; introduced ladybirds rather"
        " than spraying, because the produce is sold to families.",
        "Week 4: circulation fan started rattling; bearing suspected, spare"
        " ordered, expected within a week of the capture date.",
    ]
    for text in events:
        client.agents.passages.create(agent.id, text)
    # The agent keeps its project block current as things change.
    client.agents.blocks.modify(
        agent.id,
        "project",
        client.agents.blocks.retrieve(agent.id, "project").value
        + " Aphids are handled with ladybirds, never spray, because the"
        " produce is sold to families.",
    )
    return agent.id


# --------------------------------------------------------------------------
# Part 2: the Soil side. Blocks and passages become a bounded handover.
# --------------------------------------------------------------------------


def build_handover(client: StubLettaClient, agent_id: str) -> dict:
    project_block = client.agents.blocks.retrieve(agent_id, "project").value
    human_block = client.agents.blocks.retrieve(agent_id, "human").value
    passages = client.agents.passages.list(agent_id)
    events_text = "\n".join(f"- {p.text}" for p in passages)

    sections = {
        "projectIdentity": (
            "The school greenhouse project grows tomatoes and basil for the"
            " autumn market, tended day to day by a stateful agent that"
            " watches sensors and keeps its own memory current. This"
            " handover exists so the project can continue when that agent's"
            " environment is unavailable."
        ),
        "decisions": (
            "Every decision locked so far, with why:\n\n"
            "1. Watering runs at dawn, locked because midday watering lost"
            " roughly a third of the volume to evaporation in week 1.\n"
            "2. The vent opens above 26 degrees, locked because at the"
            " previous 28-degree threshold the basil wilted twice.\n"
            "3. The east bed gets half watering volume, locked because it"
            " drains poorly and waterlogged in week 2.\n"
            "4. Pests are handled biologically, ladybirds and never spray,"
            " locked because the produce is sold to families."
        ),
        "workflow": (
            "The agent checks sensors each morning, adjusts vents and"
            " watering, appends notable events to archival memory, and keeps"
            " a project memory block current as rules change. "
            + human_block
        ),
        "architecture": (
            "Agent memory in 3 core blocks, persona, human and project, plus"
            " an archival log of dated events, 5 at capture. Greenhouse"
            " hardware: 1 circulation fan, 1 vent servo with a 26 degree"
            " threshold, drip lines on 3 beds with the east bed at half"
            " volume."
        ),
        "constraints": (
            "No chemical spraying under any circumstance, because the"
            " produce is sold to families at the autumn market. Vent and"
            " watering thresholds change only after an observed failure,"
            " never speculatively, because each change costs a week of"
            " comparable readings."
        ),
        "rejectedPaths": (
            "Spraying the aphids was rejected in week 3 because the produce"
            " is eaten by families; ladybirds worked. Raising watering"
            " volume on the east bed was rejected in week 2 because the"
            " bed drains poorly; halving it was what worked."
        ),
        "executiveSummary": (
            "At capture the greenhouse was healthy and 4 husbandry rules"
            " were locked. One piece of hardware was degraded: the"
            " circulation fan rattles, bearing suspected, spare ordered."
            " The archival log held 5 events across 4 weeks."
        ),
        "currentTask": (
            "At capture the task in motion was watching the rattling"
            " circulation fan and swapping the bearing when the spare"
            " arrives, expected within a week of the capture date."
        ),
        "latestUserIntent": (
            "Produce a portable handover of the greenhouse project so a cold"
            " agent, on any platform, can take over the husbandry rules and"
            " the pending fan repair without access to the original agent's"
            " memory."
        ),
        "sessionDelta": (
            "Since the project began, the agent recorded 5 archival events"
            " and updated its project block once, folding the week 3 pest"
            " rule into the durable memory. This export changes nothing in"
            " the agent's own memory."
        ),
        "blockers": (
            "One degraded component at capture: the circulation fan rattles"
            " and its replacement bearing had not yet arrived."
        ),
        "nextSteps": (
            "Swap the fan bearing when the spare arrives, then confirm the"
            " vent threshold still holds at 26 degrees with the fan back to"
            " full speed. Keep the east bed at half volume unless it dries"
            " out for 4 consecutive days."
        ),
        "openQuestions": (
            "Whether the fan rattle is the bearing or the mount, undetermined"
            " at capture. Whether basil volume justifies a fourth drip line"
            " before the autumn market."
        ),
        "sessionActivity": (
            "This handover was produced by a deterministic example script:"
            " it created a stand-in agent with 3 memory blocks, appended 5"
            " archival events, applied 1 block update, then read blocks and"
            " passages back and assembled this document from them. The"
            " archival log follows verbatim:\n" + events_text
        ),
        "restoreInstructions": (
            "You are taking over the school greenhouse project cold, without"
            " the original agent's memory. Hold these locked rules: water at"
            " dawn, because midday watering lost a third to evaporation;"
            " vent above 26 degrees, because 28 wilted the basil; east bed"
            " at half volume, because it drains poorly; ladybirds and never"
            " spray, because families eat the produce. State at capture: 5"
            " logged events over 4 weeks, greenhouse healthy, circulation"
            " fan rattling with a bearing spare on the way. First action:"
            " check whether the spare arrived and swap the bearing. Report"
            " to the biology teacher in one paragraph on Mondays. Do not"
            " change any threshold without an observed failure."
        ),
        "provenanceMap": (
            "The husbandry rules and their reasons were read from the"
            " agent's project memory block; the event history was read from"
            " its archival passages; the reporting rhythm was read from the"
            " human block. The stand-in client stored these values, so no"
            " live agent behavior stands behind them; the surrounding prose"
            " is fixture text written for this example."
        ),
        "safetySummary": (
            "Nothing was withheld. The scenario carries no credentials and"
            " no personal data beyond a role, the biology teacher. The"
            " agent's persona block was deliberately left out: it describes"
            " the agent, not the project, and the next agent brings its own."
        ),
    }

    return {
        "soilHandover": "1.0",
        "projectId": "school-greenhouse",
        "title": "Greenhouse handover: 4 husbandry rules locked, fan bearing"
        " swap pending",
        "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "client": "letta-example",
            "provider": "none",
            "model": "none",
        },
        "sections": {
            key: {"status": "available", "summary": sections[key]}
            for key in SECTION_KEYS
        },
        "quality": {
            "missingInputs": [
                "Whether the fan rattle is the bearing or the mount was"
                " undetermined at capture; the log records the symptom only."
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
    client = StubLettaClient()
    agent_id = run_agent_weeks(client)
    assert len(client.agents.passages.list(agent_id)) == 5
    assert "ladybirds" in client.agents.blocks.retrieve(agent_id, "project").value
    print("framework stub: agent with 3 blocks and 5 archival events")

    document = normalize_handover(build_handover(client, agent_id))

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
            "school-greenhouse",
            "26 degrees",
            "third to evaporation",
            "east bed at half volume",
            "ladybirds and never spray",
            "bearing",
            "one paragraph on Mondays",
        ):
            assert fact in prompt, f"restore prompt lost the fact: {fact}"
        # The boundary this example exists to show: the persona block stays
        # with the agent. A cold agent brings its own way of working.
        assert "patient greenhouse keeper" not in prompt, "persona leaked"
        print("cli: load carried the project and left the persona behind")

    print("PASS: agent memory became a portable handover, keyless end to end")


if __name__ == "__main__":
    main()
