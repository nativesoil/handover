# Windsurf

In `~/.codeium/windsurf/mcp_config.json`:

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

Save the file, then open the MCP list from the top menu of the Cascade panel,
find `soil`, and enable its tools.

## What you should see

`soil` in the Cascade panel's MCP list with its tools enabled: `soil_save`,
`soil_load` and `soil_list`. A save ends in the receipt card with a `#NNN`
load code.

## Where the evidence stands

The file path and the configuration shape above come from
[Windsurf's MCP documentation](https://docs.windsurf.com/windsurf/cascade/mcp),
read on 2026-07-30; that address currently redirects to the vendor's new
documentation host and serves the same page. No run in Windsurf is recorded
in this repository, and the client has no row of its own on
[the compatibility page](../../../docs/compatibility.md#client-surfaces); the
only row that covers it is the reading behind "Any other MCP client", and
only a real recorded run would earn it more.
