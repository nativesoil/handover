# An agent installing from the public files, Codex CLI

Recorded from the operator's own run log rather than from a session run in
this repository. Every command, outcome and version below is as the
operator's agent reported it.

- Date: 2026-07-31
- Agent: Codex CLI 0.145.0, which had not seen this project before and
  worked only from the public repository
- Source: built from source at the tagged release `v0.1.0`, public commit
  `8d3c2fec0c088180778f758b86079a91601b222d`, which predates the fixes
  landed on the main line since
- Surface: the command line tool and the local MCP server over stdio, wired
  into Codex CLI and into Claude Code
- Versions: Node v20.20.2, pnpm 11.9.0, Codex CLI 0.145.0, Claude Code
  2.1.210
- Operating system: macOS
- Store: an isolated temporary store created for the run, never the user's
  own

## What ran

The agent was asked to install Soil Handover into a clean project and given
nothing but the public repository. It read the repository before running
anything and restated the product's stated limits back: a handover is not a
whole conversation transfer and not long term memory, the secret scan is
pattern based and cannot find every secret, and the restore framing reduces
structural confusion without preventing prompt injection. It cited
[docs/install-with-an-agent.md](../../docs/install-with-an-agent.md),
[docs/switch-clients.md](../../docs/switch-clients.md) and
[spec/restore-prompt.md](../../spec/restore-prompt.md) as it worked.

`pnpm install` and `pnpm build` both exited 0, the working tree was clean
afterwards, and the tool reported version 0.1.0 against specification 1.0.

Then the smoke test from the install page, against the isolated store, every
step exiting 0:

1. `soil where` printed the isolated store.
2. `soil validate` accepted the disposable document that page carries
   inline.
3. `soil save` stored it as `#001`, reporting content in the four of the 17
   sections that document fills in.
4. `soil list` listed it back.
5. `soil check '#001'` graded it strong, with no problems and no warnings.
6. `soil load '#001'` rendered the restore prompt in full.
7. The MCP server answered `tools/list` with exactly `soil_save`,
   `soil_load` and `soil_list`.
8. A newly started MCP process called `soil_load` against the same store and
   brought back the title, the project id and the restore instructions.

The client wiring in section 3 of [AGENTS.md](../../AGENTS.md) was exercised
in both clients it documents for this machine: Codex CLI, as a global stdio
entry, and Claude Code, at user scope, which then listed the server as
connected. A hosted connector configured earlier was removed from the Codex
configuration first, so the local server was the only route left.

## What the machine did

Recorded because a real install meets a real environment, and none of it was
caused by the project: a clone into a protected working directory root was
refused, the sandbox denied network access first to the code host and then
to the package registry until each was granted, the managed environment
printed a warning about a PATH alias that blocked nothing, and an unrelated
third party MCP server reported a connection failure in the same client
listing. No step's outcome changed.

## What was not run

- The repository's full verify, and the five conformance runners.
- Any handover in the user's own store. The run stayed in the isolated one.
- A save in one live model session followed by a load in another live model
  session. A newly started server process exercised the load path instead,
  which shows the store and the server rather than two models.
- A shell alias, and any client beyond the two named above.

## Limitations

- One agent, one machine, macOS.
- The versions in play are the same ones this repository's own client switch
  walkthrough was run on, so the session shows nothing about version
  tolerance.
- The run was against the released tag, so what it holds for is `v0.1.0`,
  not whatever the main line has become since.
- What the session shows is that an agent working only from the public files
  could install the thing and drive it end to end. It does not show a model
  picking the work up from the restore prompt, because that step was not
  performed here.
