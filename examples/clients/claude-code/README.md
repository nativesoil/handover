# Claude Code

One command attaches the local server, using the real store under `~/.soil`:

```bash
claude mcp add soil -- node <checkout>/packages/mcp/bin/soil-mcp.js
```

For a headless run, or to pin the store to a directory you can delete
afterwards, the same server in Claude Code's `mcp.json` format, exactly as
[the client-switch walkthrough](../../../docs/switch-clients.md) ran it:

```json
{
  "mcpServers": {
    "soil": {
      "command": "node",
      "args": ["<checkout>/packages/mcp/bin/soil-mcp.js"],
      "env": { "SOIL_HOME": "<store>" }
    }
  }
}
```

```bash
claude -p "Save this project's working state with the soil_save tool." \
  --mcp-config mcp.json --strict-mcp-config
```

Drop the `SOIL_HOME` line to use the real store.

## What you should see

`claude mcp list` reports `soil` connected, and in a session three tools
appear: `soil_save`, `soil_load` and `soil_list`. A save ends in the receipt
card with a `#NNN` load code, and `soil load '#NNN'` brings the same handover
back in the CLI or in any other client on the same store.

## Where the evidence stands

This client has recorded runs against this repository's local server, and the
`mcp.json` block above is the one those runs used: a headless session driving
all three tools ([session report](../../../compatibility/reports/local-mcp-claude-code.md)),
and both Claude Code legs of
[the client-switch walkthrough](../../../docs/switch-clients.md), whose stored
handovers are committed beside that page and held byte for byte to the
receipts it shows. The client's rows, with the limits of those runs, are on
[the compatibility page](../../../docs/compatibility.md#client-surfaces).
