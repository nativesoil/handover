# Cursor

In `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` inside one
project:

```json
{
  "mcpServers": {
    "soil": {
      "command": "node",
      "args": ["<checkout>/packages/mcp/bin/soil-mcp.js"]
    }
  }
}
```

Save the file, then open the editor's MCP settings, where `soil` appears with
its tools listed, and toggle it on.

## What you should see

`soil` in the MCP settings with its tools listed and the toggle on, and in
chat the three tools available: `soil_save`, `soil_load` and `soil_list`. A
save ends in the receipt card with a `#NNN` load code.

## Where the evidence stands

The file locations and the configuration shape above come from
[Cursor's MCP documentation](https://cursor.com/docs/mcp), read on
2026-07-30. No run through Cursor's local path is recorded in this
repository, so this page claims none; what has run in Cursor, a project
handover flow through the hosted connector resting on the maintainers'
internal log, is on the client's rows on
[the compatibility page](../../../docs/compatibility.md#client-surfaces).
