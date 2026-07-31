# VS Code

In `.vscode/mcp.json` in your workspace; the "MCP: Open User Configuration"
command opens the user-level file for servers you want everywhere:

```json
{
  "servers": {
    "soil": {
      "type": "stdio",
      "command": "node",
      "args": ["<checkout>/packages/mcp/bin/soil-mcp.js"]
    }
  }
}
```

Save the file. "MCP: List Servers" in the command palette shows the server;
VS Code discovers its tools and makes them available in chat, in agent mode,
behind the tools picker in the chat input.

## What you should see

`soil` under "MCP: List Servers", and the three tools in the chat tools
picker: `soil_save`, `soil_load` and `soil_list`. A save ends in the receipt
card with a `#NNN` load code.

## Where the evidence stands

The file locations and the configuration shape above come from
[VS Code's MCP documentation](https://code.visualstudio.com/docs/copilot/chat/mcp-servers),
read on 2026-07-30. No run through VS Code's local path is recorded in this
repository, so this page claims none; what has run in VS Code, a project
handover flow through the hosted connector resting on the maintainers'
internal log, is on the client's rows on
[the compatibility page](../../../docs/compatibility.md#client-surfaces).
