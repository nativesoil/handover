# Soil in your client

One page per client surface. Each carries the configuration in that client's
own format and file location, the steps that attach the local MCP server from
this repository, one line on what a working attach looks like, and where the
evidence for that client stands. Every page says where its configuration shape
comes from and whether a run is recorded in this repository; the row-by-row
evidence lives on [the compatibility page](../../docs/compatibility.md).

The local pages all assume a built checkout. From the root of this repository:

```bash
pnpm install && pnpm build
```

`<checkout>` on every page means that checkout's absolute path, and the server
every page attaches is `<checkout>/packages/mcp/bin/soil-mcp.js`.

Pick your client:

- [claude-code/](claude-code/README.md): one command, with recorded runs
  behind it.
- [codex-cli/](codex-cli/README.md): one command or a `config.toml` block,
  with a recorded run behind it.
- [cursor/](cursor/README.md): `mcp.json` in the editor's own location, shape
  from the vendor's documentation.
- [gemini-cli/](gemini-cli/README.md): `settings.json` with an `mcpServers`
  block, shape from the vendor's documentation.
- [vscode/](vscode/README.md): `.vscode/mcp.json`, shape from the vendor's
  documentation.
- [claude-desktop/](claude-desktop/README.md): `claude_desktop_config.json`,
  shape from documentation, no run recorded here.
- [chatgpt-desktop/](chatgpt-desktop/README.md): a settings form rather than
  a file, from the vendor's documentation.
- [windsurf/](windsurf/README.md): `mcp_config.json`, shape from the vendor's
  documentation.
- [zed/](zed/README.md): `context_servers` in the editor's settings, shape
  from the vendor's documentation.
- [browser-and-phone/](browser-and-phone/README.md): ChatGPT and Claude in a
  browser or on a phone, Grok, Lovable, v0 and Base44. Nothing local to
  configure, so they share one page.

Any other client that runs on your machine and speaks MCP over stdio: command
`node`, single argument `<checkout>/packages/mcp/bin/soil-mcp.js`. The server
exposes exactly three tools: `soil_save`, `soil_load` and `soil_list`.

The self-hostable server ([docs/server.md](../../docs/server.md)) draws one
more line through this list. It authenticates with a static bearer token in
an `Authorization` header, deliberately, with no OAuth authorization server
behind it. Claude Code, Codex CLI, Cursor, VS Code, Windsurf, Zed and the
Gemini CLI can carry that header in a configured MCP server entry, so they
can attach it. ChatGPT and Claude connect a remote server through a
connector flow that requires OAuth, so as built they cannot; those surfaces
reach the format through the hosted Native Soil connector instead.
