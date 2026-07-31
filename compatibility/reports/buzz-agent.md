# buzz-agent driving the soil MCP server, live session

- Date: 2026-07-24
- Agent: `buzz-agent` 0.1.0, built with `cargo build --release -p buzz-agent`
  from [block/buzz](https://github.com/block/buzz) at commit `cfdea818`
- Model: Claude Sonnet 5, behind a local Anthropic-Messages-compatible shim
  backed by a headless Claude Code session
  ([`examples/buzz/claude-shim.mjs`](../../examples/buzz/claude-shim.mjs))
- Surface: soil MCP server attached in ACP `session/new`, spawned by
  buzz-agent as a stdio subprocess
- Operating system: macOS
- Store: a scratch store created for the run (`SOIL_HOME`)

## What ran

[`examples/buzz/acp-driver.mjs`](../../examples/buzz/acp-driver.mjs) drove
two real buzz-agent processes over stdio in `claude-shim` mode, and every
assertion held:

1. Session A: `initialize` reported `mcpCapabilities` http and sse false;
   `session/new` accepted the soil server spec and buzz-agent spawned the
   real soil MCP server. Prompted to save, the model called
   `soil__soil_save` with the 17-section payload it wrote itself, and the
   save landed as `#001` in the scratch store.
2. The stored handover held the project id and both locked decisions word
   for word.
3. Session B: a completely fresh buzz-agent process with a fresh soil
   subprocess against the same store. The model called `soil__soil_load`,
   and the restore prompt carried the project id and both decisions.

Four model calls in total, each a real completion; the model chose the
tools, wrote the sections, and produced the final replies. The same driver
runs keyless in [the examples workflow](../../.github/workflows/examples.yml)
with a scripted model stand-in.

## What was arranged

- The model reached buzz-agent through the local shim rather than a raw API
  key: buzz-agent spoke its normal Anthropic Messages dialect to the shim,
  and the shim ran each request as one headless Claude Code call. The shim
  carries no judgment; every decision in the session was the model's.
- The prompt spelled out the 17 section names, because buzz-agent replaces
  any tool input schema larger than 4096 bytes with an empty object and
  `soil_save`'s schema is about 4.5 KB, so the model never sees it.

## Limitations

- The `buzz-acp` harness (relay, channels, mentions) was not run; it needs
  a running relay stack. Its single `BUZZ_ACP_MCP_COMMAND` slot is
  documented from source in
  [`examples/buzz/README.md`](../../examples/buzz/README.md), not from a
  live harness run.
- One agent (`buzz-agent`), one machine, one model. The other agents buzz
  can drive (goose, Codex, Claude Code over their ACP adapters) receive the
  same `session/new` MCP spec but were not run here.
