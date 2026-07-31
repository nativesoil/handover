# buzz + Soil

[buzz](https://github.com/block/buzz) is Block's open-source workspace where
humans and agents share signed channels on a relay. Its agent side runs
sessions through ACP: the `buzz-acp` harness listens for mentions and drives
an agent (goose, Codex, Claude Code, or Block's own `buzz-agent`), and each
session gets its own MCP servers. Continuity inside buzz is deliberate and
minimal: when context fills, the agent "summarizes its own history and
continues" (context handoff, `crates/buzz-agent/README.md` in block/buzz),
and nothing persists across sessions.

That mechanism is reasonable for staying alive inside one session. Soil is
the complement for everything that has to survive the session: buzz keeps
humans and agents in one shared, signed workspace, and Soil gives a
session's working state a portable form that survives session resets, agent
restarts, and work leaving the relay, as structured decisions with reasons
instead of a narrative summary. A later session, or a different agent on a
different model, loads it cold.

## The configuration, checked against block/buzz

Checked against block/buzz at commit `cfdea818` (2026-07-24). Two places can
attach the soil MCP server.

**Per session over ACP.** The client passes MCP servers in `session/new`;
`buzz-agent` spawns each as a stdio subprocess and namespaces its tools as
`server__tool` (`crates/buzz-agent/src/types.rs`, `McpServerStdio`;
`crates/buzz-agent/src/mcp.rs`):

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/work",
    "mcpServers": [
      {
        "name": "soil",
        "command": "node",
        "args": ["/absolute/path/to/handover/packages/mcp/bin/soil-mcp.js"],
        "env": [{ "name": "SOIL_HOME", "value": "/home/agent/.soil" }]
      }
    ]
  }
}
```

The tools then appear to the model as `soil__soil_save`, `soil__soil_load`
and `soil__soil_list`.

**Through the buzz-acp harness.** The harness has one MCP slot, the
`BUZZ_ACP_MCP_COMMAND` environment variable (`crates/buzz-acp/src/config.rs`).
`build_mcp_servers` in `crates/buzz-acp/src/lib.rs` passes it as a bare
command with an empty argument list and injects `BUZZ_RELAY_URL` and
`BUZZ_PRIVATE_KEY` into its environment. So the slot takes a no-args
wrapper, [`soil-mcp-buzz.sh`](soil-mcp-buzz.sh) here:

```bash
export BUZZ_ACP_MCP_COMMAND=/absolute/path/to/handover/examples/buzz/soil-mcp-buzz.sh
buzz-acp
```

Because it is a single slot, pointing it at soil means not pointing it at
another server; sessions opened over ACP directly have no such limit
(`buzz-agent` accepts up to 16 servers per session).

**A real caveat, found by running it:** `buzz-agent` replaces any tool input
schema larger than 4096 bytes with an empty object
(`crates/buzz-agent/src/mcp.rs`), and `soil_save`'s strict schema is about
4.5 KB. The call still works, but the model no longer learns the argument
shape from the schema, so the session's prompt or system prompt should
spell out that `sections` maps the 17 section names to prose strings. The
driver here does exactly that. The other buzz-supported agents (goose,
Codex, Claude Code via their ACP adapters) have their own schema handling;
this caveat is specifically `buzz-agent`'s.

## What runs here

[`acp-driver.mjs`](acp-driver.mjs) is an ACP client that drives a real
`buzz-agent` binary, built from block/buzz, through the whole claim:

1. Session A: `initialize`, `session/new` with the soil server attached,
   then a prompt asking the session to save its working state. The agent
   spawns the real soil MCP server, the model calls `soil__soil_save`, and
   a handover lands in a scratch store.
2. The driver asserts the store holds exactly one handover for the project
   and that two locked decisions survived word for word.
3. Session B: a completely fresh `buzz-agent` process, fresh soil
   subprocess, same store. The model calls `soil__soil_load` and the driver
   asserts the restore prompt carries the project id and both decisions.

The model behind the session is the one arranged part, chosen with
`--model`:

- `stand-in` (what continuous integration runs, keyless): a scripted
  OpenAI-compatible endpoint, [`model-stand-in.mjs`](model-stand-in.mjs),
  plays the model deterministically. Everything else is real: the
  `buzz-agent` binary, its MCP spawning and namespacing, the soil server,
  the store.
- `claude-shim` (local only): a real model behind
  [`claude-shim.mjs`](claude-shim.mjs), a local Anthropic-Messages endpoint
  backed by a headless Claude Code session. The model makes every decision;
  the shim is transport. The live run is recorded in
  [the session report](../../compatibility/reports/buzz-agent.md).
- `env`: bring your own provider variables (`BUZZ_AGENT_PROVIDER` and
  friends) for a direct API-backed run.

Not run anywhere here: the `buzz-acp` harness itself, because it needs a
running relay (Docker, Postgres). Its MCP slot is documented above from its
source, not from a live harness run.

## Run it

From the repository root:

```bash
pnpm install && pnpm build

git clone https://github.com/block/buzz && cd buzz
git checkout cfdea818dbd0a38ca6077de2bfafba755a6c7853
cargo build --release -p buzz-agent
cd ..

node examples/buzz/acp-driver.mjs --agent buzz/target/release/buzz-agent --model stand-in
```

The driver exits non-zero unless every assertion holds, which is what
continuous integration gates on.
