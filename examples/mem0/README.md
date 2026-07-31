# Mem0 + Soil

Mem0 can retain user or agent memory. Soil creates a bounded project handover
that can move to another session, tool or provider.

The scenario: a person plans a neighborhood tool-lending library with an
assistant over two sessions. Facts and preferences accumulate in a memory
layer as they are agreed. At a boundary, the project truth is exported as a
Soil handover and pushed through the full round trip: `soil validate`,
`soil check` and `soil load`. The example then asserts the boundary that is
the whole point: the project's decisions, constraints and status travel in
the handover, while the purely personal preference entries deliberately stay
behind in memory.

## What is real and what is not

Real: the entire Soil side. The official Python SDK builds, validates and
stores the handover, and the reference CLI validates, checks and loads the
stored document, with facts asserted end to end.

Stubbed: the Mem0 client. `mem0ai` 2.0.13 initialises an embedder and a
language model provider inside the `Memory()` constructor, so it cannot run
keyless: with no key in the environment, construction fails before any
memory call is possible. This example therefore uses `StubMemory`, a small
in-process stand-in that mirrors the slice of the `Memory` surface the
example needs (`add` with `infer=False`, `search`, `get_all`, same call and
return shapes). It is clearly labeled in the code, it demonstrates nothing
about Mem0 itself, and swapping it for `mem0.Memory` with a configured
provider is mechanical: the calls are the same.

Because the framework side is a stub, the Mem0 row on the compatibility map
carries maturity `partial`: the Soil side is real and reproducible in this
repository, the framework side is a labelled stand-in.

## Run it

From the repository root:

```bash
pnpm install && pnpm build
python3 examples/mem0/main.py
```

No Python dependencies are needed: the stand-in is standard library and the
Soil SDK in `packages/sdk-py` has no dependencies. The script exits non-zero
if any step of the round trip fails, which is what continuous integration
gates on.

## Why a handover and not just the memory store

Memory answers "what do we know about this user and their work", open-ended
and always growing. A handover answers "what must the next session hold to
continue this project", bounded and self-contained: decisions with reasons,
constraints, rejected paths, state at capture, and a boot prompt that stands
alone. The two complement each other; neither replaces the other.
