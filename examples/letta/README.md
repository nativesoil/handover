# Letta + Soil

A Letta agent can remain stateful in its own environment. Soil creates a
portable handover for a cold external agent.

The scenario: a stateful agent has been tending a school greenhouse project
for four weeks, editing its own memory blocks and appending archival events
as things happen. Its environment is about to be unavailable, so the project
state is exported as a Soil handover and pushed through the full round trip:
`soil validate`, `soil check` and `soil load`. The example asserts that the
husbandry rules with their reasons, the event history and the pending repair
survive into the restore prompt, and that the agent's persona block
deliberately does not: it describes the agent, not the project, and a cold
agent brings its own.

## What is real and what is not

Real: the entire Soil side. The official Python SDK builds, validates and
stores the handover, and the reference CLI validates, checks and loads the
stored document, with facts asserted end to end.

Stubbed: the Letta client. A Letta agent lives behind a server, and creating
or messaging an agent requires a configured language model provider, so the
framework side cannot run keyless in continuous integration.
`StubLettaClient` mirrors the slice of the `letta-client` surface the
example uses (`agents.create` with memory blocks, `agents.blocks` retrieve
and modify, `agents.passages` create and list, same call and return shapes),
and the memory edits a live agent would make through model-decided tool
calls are performed directly by the script so the run is deterministic. It
is clearly labeled in the code, it demonstrates nothing about Letta itself,
and pointing the same calls at a live server is mechanical.

Because the framework side is a stub, the Letta row on the compatibility map
carries maturity `partial`: the Soil side is real and reproducible in this
repository, the framework side is a labelled stand-in.

## Run it

From the repository root:

```bash
pnpm install && pnpm build
python3 examples/letta/main.py
```

No Python dependencies are needed: the stand-in is standard library and the
Soil SDK in `packages/sdk-py` has no dependencies. The script exits non-zero
if any step of the round trip fails, which is what continuous integration
gates on.

## Why a handover and not just the agent's memory

The agent's memory is the right tool while the agent is running: blocks it
edits itself, archival passages it can search, all inside its environment.
The handover is for the moment that environment is not there: a bounded,
self-contained document carrying the decisions with their reasons, the
constraints, the state at capture and a boot prompt that stands alone, so a
cold agent anywhere can continue. The two complement each other; neither
replaces the other.
