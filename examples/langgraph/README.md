# LangGraph + Soil

LangGraph can retain graph checkpoints inside its runtime. Soil exports the
current project state so another agent or platform can continue without
running the same graph.

This example runs a real LangGraph `StateGraph`: a deterministic
support-triage pipeline with no model call anywhere, checkpointed with
`InMemorySaver` across two invocations on one thread. It then reads the
final checkpoint back through `graph.get_state`, builds a Soil handover from
that state with the Python SDK, and pushes the document through the full
round trip: `soil validate`, `soil check` and `soil load`, asserting that
facts from the live graph state survive into the restore prompt.

## What is real and what is not

Everything runs for real and keyless: the actual `langgraph` package
executes the graph, the actual Python SDK writes the store, and the actual
reference CLI validates, checks and loads the stored document. One thing is
arranged for determinism: the handover text is assembled by the script from
live graph state, where in normal use a model writes the handover from the
extraction recipe. The facts inside the document, ticket counts, queue
totals, checkpoint step, thread id and the recorded decisions, are read from
the framework's own checkpoint at run time.

## Run it

From the repository root:

```bash
pnpm install && pnpm build
python3 -m venv .venv && .venv/bin/pip install -r examples/langgraph/requirements.txt
.venv/bin/python examples/langgraph/main.py
```

The script exits non-zero if any step of the round trip fails, which is what
continuous integration gates on.

## Why a handover and not just the checkpoint

The checkpoint is the right tool for resuming this graph in this runtime: it
holds channel values keyed to a thread and a checkpointer instance. The
handover is for the other direction: a bounded, self-contained document that
names the decisions with their reasons, the constraints, the rejected paths
and the state at capture, so an agent with no LangGraph runtime, or a person,
can pick the project up cold. The two complement each other; neither replaces
the other.
