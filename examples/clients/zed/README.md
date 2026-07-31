# Zed

In the editor's `settings.json`; the `zed: open settings file` command opens
it:

```json
{
  "context_servers": {
    "soil": {
      "command": "node",
      "args": ["<checkout>/packages/mcp/bin/soil-mcp.js"],
      "env": {}
    }
  }
}
```

Zed also adds servers through its UI: Settings, then AI, then MCP Servers,
Add Server, Add Local Server, with the same command and arguments.

## What you should see

Under Settings, AI, MCP Servers, the indicator next to `soil` turns green
with "Server is active", and the Agent Panel can call the three tools:
`soil_save`, `soil_load` and `soil_list`. A save ends in the receipt card
with a `#NNN` load code.

## Where the evidence stands

The `context_servers` key and the configuration shape above come from
[Zed's MCP documentation](https://zed.dev/docs/ai/mcp), read on 2026-07-30.
No run in Zed is recorded in this repository, and the client has no row of
its own on
[the compatibility page](../../../docs/compatibility.md#client-surfaces); the
only row that covers it is the reading behind "Any other MCP client", and
only a real recorded run would earn it more.
