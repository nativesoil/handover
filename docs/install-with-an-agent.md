# Installing Soil Handover with an agent

This page is the normative instruction for an AI agent installing Soil
Handover on a user's machine. `AGENTS.md` and every other agent briefing in
this repository point here; if they ever disagree with this page, this page
wins.

You are probably reading this because a user asked you to install Soil Handover in
their repository. The short version: the install lives outside their
application code, the smoke test runs against a scratch store, and you report
every command you ran and how each check came out.

For a user reading this instead: if a coding agent already works in your
repository, you do not have to do the install yourself. Ask your agent:

> Install Soil Handover in this repository. Read AGENTS.md and
> docs/install-with-an-agent.md. Choose the appropriate local integration:
> CLI or MCP. Run the documented smoke test. Create one handover and load it
> in a fresh session. Do not expose secrets or modify application code.
> Report every command you ran and whether each check passed.

## Ground rules

1. **Do not modify the host project's application code.** No new dependencies
   in the project's manifest, no source edits, no build config changes.
   Soil Handover is installed beside the project, not into it. The only files you may
   create or change are the agent client's own configuration (an MCP config
   file, a shell alias) and only after telling the user which file you are
   about to touch.
2. **Never expose secrets.** Do not paste keys, tokens or credentials into a
   handover, a config file or your report. The official writers refuse
   credential-shaped material anyway (the save fails closed and stores
   nothing), but that is a net, not a licence: keep secrets out of everything
   you write.
3. **Report every command you run**, with each check's result as pass or
   fail. The report format is at the end of this page.
4. **Clean up test material when the user asks.** The smoke test below is
   designed so cleanup is one deleted directory.

## 1. Identify the platform

Establish the operating system and the available runtimes before choosing a
path:

```bash
uname -a          # or: ver / systeminfo on Windows
node --version    # need 20 or newer for the Node paths
pnpm --version    # need pnpm for the from-source build
go version        # need 1.22 or newer for the single binary
```

## 2. Choose the integration

Nothing is on a package registry yet (npm, PyPI, brew, Maven, NuGet are all
planned), so every path today builds from source, from a checkout of this
repository. Work in the checkout you are reading this page from, at a tools
location of the user's choosing, never inside the host project. Below,
`<checkout>` means that directory's absolute path.

Pick the first row that matches the machine:

| The machine has                         | Choose                                  |
| --------------------------------------- | --------------------------------------- |
| Node 20+ and pnpm, client speaks MCP    | Node CLI plus the local MCP server      |
| Node 20+ and pnpm, no MCP client        | Node CLI only                           |
| Go 1.22+, and the user wants one binary | Go single binary (CLI only, note below) |

### Node CLI and MCP server, from source

From the root of the checkout:

```bash
pnpm install
pnpm build
```

After the build:

- the CLI is `node <checkout>/packages/cli/bin/soil.js`
- the MCP server is `node <checkout>/packages/mcp/bin/soil-mcp.js`

Both share the same store (`~/.soil`, or `SOIL_HOME` when set), so a
handover saved from the editor loads in the terminal and the other way
round.

For a `soil` command on the PATH, offer the user an alias:

```bash
alias soil="node <checkout>/packages/cli/bin/soil.js"
```

### Go single binary

From the root of the checkout:

```bash
go build -C packages/sdk-go -o soil ./cmd/soil
```

One static binary, no runtime, no dependencies. Its command surface, output
bytes and exit codes match the Node CLI, with one exception: the Go binary
does not include `soil check` yet. Run the checking step of the smoke test
with the Node CLI instead, or skip that step and say so in your report.

### Packaged CLI

There is no packaged install today, and no `npx` or `pip` line you can
substitute. Do not invent one: the bare names `soil`, `soil-mcp` and
`soil-server` are unclaimed on the public registries, so an instruction naming
one points a user's machine at a package this project does not control.

That stays true after publication, because a runner resolves a package name and
those are not package names. The packages will be the `@nativesoil/…` ones;
`soil-server`, for instance, is the name of an executable inside
`@nativesoil/handover-server`.

Use one of the two from-source paths above, and say in your report that the
install was from source.

This section is the one place this repository argues the point. Other pages
state the status in a line and link here.

## 3. Connect the client

Use the section that matches the user's client. Replace
`/absolute/path/to/handover` with the checkout's real absolute path in every
block.

**Claude Code**

```bash
claude mcp add soil -- node /absolute/path/to/handover/packages/mcp/bin/soil-mcp.js
```

**Codex CLI**

```bash
codex mcp add soil -- node /absolute/path/to/handover/packages/mcp/bin/soil-mcp.js
```

**Cursor**, in `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "soil": {
      "command": "node",
      "args": ["/absolute/path/to/handover/packages/mcp/bin/soil-mcp.js"]
    }
  }
}
```

**VS Code**, in `.vscode/mcp.json`:

```json
{
  "servers": {
    "soil": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/handover/packages/mcp/bin/soil-mcp.js"]
    }
  }
}
```

**Any other MCP client over stdio**: command `node`, single argument
`/absolute/path/to/handover/packages/mcp/bin/soil-mcp.js`. The server
speaks JSON-RPC 2.0, newline-delimited, and exposes exactly three tools:
`soil_save`, `soil_load`, `soil_list`.

**Local CLI only**: no client config at all. The alias from section 2 is
enough; the save and load round trip runs by pasting, as documented in
[quickstart.md](quickstart.md).

**Self-hosted server**: for a team sharing handovers on one machine, the
server preview is a separate piece with its own setup page. Follow
[server.md](server.md); do not improvise its configuration from here.

## 4. The smoke test

Run the whole test against a scratch store, so the user's real store is
never touched and cleanup is trivial. Every step lists its expected
outcome; anything else is a fail. Set the scratch store first:

```bash
export SOIL_HOME=$(mktemp -d)
```

(In the examples below, `soil` means the CLI you installed: the alias, the
`node .../soil.js` form, or the Go binary.)

**Step 1: the store answers.**

```bash
soil where
```

Expected: prints the scratch directory path, exit 0.

**Step 2: create the test document.** Write exactly this to
`soil-install-test.json` in the scratch directory (not in the host
project). It is a minimal valid handover, disposable by design, with four
of the seventeen sections carrying content:

```json
{
  "soilHandover": "1.0",
  "handoverId": "019f7e89-fc00-7e76-92a3-f4671b02fd51",
  "projectId": "install-smoke-test",
  "title": "Install smoke test",
  "createdAt": "2026-07-24T12:00:00Z",
  "sections": {
    "projectIdentity": {
      "status": "available",
      "summary": "A disposable test project that exists only to confirm a fresh Soil Handover install. It carries no real project state and should be deleted after the test."
    },
    "decisions": { "status": "missing", "summary": null },
    "workflow": { "status": "missing", "summary": null },
    "architecture": { "status": "missing", "summary": null },
    "constraints": { "status": "missing", "summary": null },
    "rejectedPaths": { "status": "missing", "summary": null },
    "executiveSummary": {
      "status": "available",
      "summary": "This handover was created as of its capture date to test the save, validate, check and load commands on a new machine. Nothing in it describes real work."
    },
    "currentTask": {
      "status": "available",
      "summary": "At capture, the task was to confirm that the store accepts a save, that validation and checking pass, and that the restore prompt renders in a fresh session."
    },
    "latestUserIntent": { "status": "missing", "summary": null },
    "sessionDelta": { "status": "missing", "summary": null },
    "blockers": { "status": "missing", "summary": null },
    "nextSteps": { "status": "missing", "summary": null },
    "openQuestions": { "status": "missing", "summary": null },
    "sessionActivity": { "status": "missing", "summary": null },
    "restoreInstructions": {
      "status": "available",
      "summary": "This is an install test, not a real project. Confirm that this text arrived intact, tell the user the load worked, and take no further action on the fictional task it describes."
    },
    "provenanceMap": { "status": "missing", "summary": null },
    "safetySummary": { "status": "missing", "summary": null }
  },
  "quality": {
    "missingInputs": [
      "Every section without content is empty by design: this document is an install test, not a capture of real work."
    ]
  }
}
```

The fixed `handoverId` is fine for a disposable test document. A real save
assigns a fresh UUIDv7.

**Step 3: validate.**

```bash
soil validate "$SOIL_HOME/soil-install-test.json"
```

Expected: a "valid handover" card, exit 0.

**Step 4: save.**

```bash
soil save "$SOIL_HOME/soil-install-test.json"
```

Expected: a "handover saved" card reporting `4 / 17 sections carrying
content` and a load code (`#001` in a fresh scratch store), followed by a
`checked at save` line reporting grade `strong`, exit 0.

Four, because exactly four sections of the document above carry a summary:
project identity, executive summary, current task and restore instructions.
The count is structural content presence, never a measure of how good the
capture is, and the grade is the deterministic document check run at save:
the same rules step 5 prints in full, informing and never blocking a save.

**Step 5: check.** Node CLI only; with the Go binary, skip and report the
skip.

```bash
soil check '#001'
```

Expected: grade `strong`, `0 problems`, exit 0. Quote the code, or the
shell treats `#` as a comment.

**Step 6: load in a fresh session.**

```bash
soil load '#001'
```

Expected: a "handover loaded" card followed by the restore prompt, exit 0.
Then complete the round trip: open a fresh model session (one with no
memory of this install), paste the restore prompt, and confirm the model
acknowledges the install test as its own restore instructions ask. Run the
load from a new terminal if you can, with `SOIL_HOME` set to the same
scratch directory.

If the MCP server was configured in section 3, also confirm the client
lists the three `soil_*` tools.

## 5. Report

End with a report the user can read in one glance:

- every command you ran, in order
- each smoke-test step: pass or fail, with the observed exit code
- which integration you chose and why
- anything you skipped (for example `soil check` under the Go binary) and
  anything that needs the user (for example restarting the client so it
  picks up new MCP config)

## 6. Cleanup

On request, delete the scratch store and nothing else:

```bash
rm -rf "$SOIL_HOME"   # the mktemp directory from section 4
unset SOIL_HOME
```

The user's real store (`~/.soil`) was never involved. The clone itself
stays; it is the install.
