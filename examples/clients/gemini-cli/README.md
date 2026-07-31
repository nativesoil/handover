# Gemini CLI

In `~/.gemini/settings.json` for every project, or `.gemini/settings.json`
inside one project:

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

Save the file, start the CLI, and the `/mcp` command lists the configured
servers with their connection status and the tools each one offers.

## What you should see

`/mcp` shows `soil` as connected with its three tools: `soil_save`,
`soil_load` and `soil_list`. In a session the CLI asks before an MCP tool
call; approve it and the call runs. A save ends in the receipt card with a
`#NNN` load code.

## Where the evidence stands

The file locations and the configuration shape above come from
[the Gemini CLI's MCP documentation](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html),
read on 2026-07-30. No run in the Gemini CLI is recorded in this repository,
and the client has no row of its own on
[the compatibility page](../../../docs/compatibility.md#client-surfaces); the
only row that covers it is the reading behind "Any other MCP client", and
only a real recorded run would earn it more.

## Recording a run

A recorded run is a session report under
[compatibility/reports/](../../../compatibility/reports/README.md), in the
shape of the reports already committed there: the exact commands the session
drove, the receipt as the model saw it, the date and the versions involved,
and what the session does not show. That committed report is what moves a
client onto
[the compatibility page](../../../docs/compatibility.md#client-surfaces).
