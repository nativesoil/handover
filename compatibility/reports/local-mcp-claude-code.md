# Local MCP server in a headless Claude Code session

- Date: 2026-07-24
- Client: Claude Code, headless session
- Surface: local MCP server over stdio, wired through a project-scoped
  `.mcp.json`
- Operating system: macOS
- Store: a scratch store created for the session

## What ran

A real headless Claude Code session drove the three tools end to end
against the scratch store: `soil_list`, `soil_save` and `soil_load`. The
save produced a receipt, the load brought the saved handover back, and the
list reflected the store before and after. The session completed the full
save/load/list round trip.

Separately from this session, the protocol round trip runs in the root test
suite on every push, on ubuntu, macos and windows, through
[the CI workflow](../../.github/workflows/ci.yml).

## Limitations

- The headless client session ran on macOS, on one machine. Only the
  protocol-level round trip in the test suite covers the other operating
  systems.
- One client. Other MCP clients speak to the same server surface but are
  tracked as their own rows with their own evidence.
