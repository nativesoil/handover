# Claude Desktop

The desktop app reads `claude_desktop_config.json` at launch. Settings, then
Developer, then Edit Config opens it; the file lives at
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS
and `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

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

Quit the app completely and start it again; the configuration is read only at
launch.

The vendor also documents a second route, desktop extensions installed from
Settings, then Extensions. That route takes servers packaged as `.mcpb`
extension files, and this repository does not ship one, so the JSON route
above is the one that fits this server.

## What you should see

After the restart, the connectors list behind the plus button in the chat box
shows `soil` with the three tools: `soil_save`, `soil_load` and `soil_list`.
A save, once you approve the tool call, ends in the receipt card with a
`#NNN` load code.

## Where the evidence stands

The file paths, the configuration shape and the restart step come from
[the MCP project's page on connecting Claude Desktop to local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers),
and the desktop-extension route from
[Anthropic's page on local MCP servers in Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop),
both read on 2026-07-30. No run through the desktop app is recorded in this
repository, so this page claims none; what has run for Claude on its other
surfaces is on the client's rows on
[the compatibility page](../../../docs/compatibility.md#client-surfaces).
