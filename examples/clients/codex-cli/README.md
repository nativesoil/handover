# Codex CLI

One command attaches the local server, using the real store under `~/.soil`:

```bash
codex mcp add soil -- node <checkout>/packages/mcp/bin/soil-mcp.js
```

Or in Codex's own configuration format in `~/.codex/config.toml`, exactly as
[the client-switch walkthrough](../../../docs/switch-clients.md) ran it:

```toml
[mcp_servers.soil]
command = "node"
args = ["<checkout>/packages/mcp/bin/soil-mcp.js"]

[mcp_servers.soil.env]
SOIL_HOME = "<store>"
```

Drop the `env` table to use the real store. In an interactive session Codex
asks before an MCP tool call; approve it and the call runs.

## What you should see

Three tools appear: `soil_save`, `soil_load` and `soil_list`. A save ends in
the receipt card with a `#NNN` load code, and `soil load '#NNN'` brings the
same handover back in the CLI or in any other client on the same store.

## Where the evidence stands

This client has a recorded run against this repository's local server, and
the `config.toml` block above is the one that run used: the Codex leg of
[the client-switch walkthrough](../../../docs/switch-clients.md) loaded a
handover saved by a different client into a cold session, answered questions
whose answers only the handover carried, and stored its own continuation,
committed beside that page as
[saved-by-codex.json](../../../docs/switch-clients/saved-by-codex.json). The
client's rows, with the limits of that run, are on
[the compatibility page](../../../docs/compatibility.md#client-surfaces).
