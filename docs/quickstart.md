# Quickstart

Install, connect your assistant, save, switch tools, load, continue. This page
is Soil Handover run locally: one person, one machine, plain files. After the
install, nothing here touches the network or asks you to sign in. For a team
on hardware you run, see [server.md](server.md); for the hosted service, see
[Native Soil Cloud](https://nativesoil.dev).

## Install

Node 20 or newer, and pnpm. Run these from the root of a checkout of this
repository.

```bash
pnpm install
pnpm build
```

Nothing from this repository is on a package registry yet, so there is no `npx`
line to run instead and the commands below call the binaries directly. An alias
makes the rest of this page read the way you will type it:

```bash
alias soil="node $PWD/packages/cli/bin/soil.js"
```

Check it:

```bash
soil --version     # 0.1.0 (spec 1.0)
soil where         # ~/.soil
```

## Connect your assistant

The MCP server lets the model save and load on its own, so you stop copying
text around. It speaks stdio and runs locally; `/absolute/path/to/handover`
below means the directory you cloned this repository into.

Claude Code:

```bash
claude mcp add soil -- node /absolute/path/to/handover/packages/mcp/bin/soil-mcp.js
```

Check it: `claude mcp list` now lists `soil` and reports it connected.

Codex CLI:

```bash
codex mcp add soil -- node /absolute/path/to/handover/packages/mcp/bin/soil-mcp.js
```

Cursor, in `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project), and
anything else that reads a JSON MCP config:

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

In Cursor, check it in the editor's MCP settings: the `soil` server appears
there with its tools listed, and can be toggled on.

Which of these paths have a recorded run is on
[compatibility.md](compatibility.md); the configuration shapes for the others
come from each vendor's own documentation. One page per client, with the
configuration in each client's own format and location, is in
[examples/clients/](../examples/clients/README.md).

This works for any client that runs on your machine and can start a process.
A client that lives only in a browser or a phone app cannot, so those clients
connect through [Native Soil Cloud](https://nativesoil.dev) instead; which
clients that covers is in [compatibility.md](compatibility.md). The
connection steps for those clients live in the hosted service's own
onboarding, not in this repository, because there is nothing local to
configure.

Three tools appear: `soil_save`, `soil_load`, `soil_list`. Then:

> Save the project state.

> Load handover #001 and pick up where we left off.

The MCP server and the CLI share `~/.soil`, so a handover saved from your
editor loads in your terminal, and the other way round.

When the model saves this way, the server also asks it four short questions
about how the project actually worked in that thread: how the last blocker was
handled, how conflicting instructions were resolved, how new work was checked
before it was trusted, and an assumption the thread made and how it was
caught. The answers travel on the handover as evidence attributed to the
server, and a load shows them beside the sections
([concepts.md](concepts.md) explains the idea). They are optional, and nothing
turns them into a score.

## Save, by hand

No MCP, or a plain chat window? The same round trip runs from the terminal, in
two steps.

**1. Print the recipe and paste it into the session you want to keep.**

```bash
soil save
```

That prints the extraction recipe: the rules, the anti-drift lens, and guidance
for each of the 17 sections. Paste all of it into your assistant, in the thread
that holds the work. The model does the extraction; the CLI does the filing.

**2. Paste the answer back.**

The model replies with one JSON block. Copy the reply and pipe it in:

```bash
soil save -
# paste, then Ctrl-D
```

You do not need to strip the prose or the code fence. The CLI finds the JSON.

The card below is an illustration, not the output of a real run: the shape is
exact, the numbers are invented to show a partial capture.

<!-- card: illustration -->

```
  ┌─ SOIL · handover saved ──────────────────── #001 ─
  │
  │   Checkout rework: address step split
  │   orchard-checkout
  │
  ├─ written by ──────────────────────────────────────
  │
  │   client      claude-code
  │   model       opus-4.8
  │   provider    anthropic
  │   recipe      1.0.0
  │
  ├─ what this document carries ──────────────────────
  │
  │   14 / 17 sections carrying content
  │   no content  rejected paths, open questions,
  │               provenance map
  │   provenance  repo_verified, model_reported
  │
  └─ load it in another thread, model, or tool

          ❯ soil load #001
```

`14 / 17` counts sections carrying content, not quality: a section holding one
line counts the same as a section holding a page. The card names the empty ones,
so you can decide whether that is fine or whether the thread had more in it than
the model found.

`written by` is what the document says about its own origin, and the load card
carries the same block, so the next reader learns it too. The `provenance` row
names the kinds of claim the document holds; which section carries which label
is a per-section mapping, and it travels in the restore prompt where a reader
can act on it section by section.

If the model wrote a credential into a section, the save is refused and nothing
is stored. The message names the section and what kind of material it was, never
the value. Fix the section and paste again.

## Load

Anywhere else. A different terminal, a different editor, a different model, a
different vendor, a week later.

```bash
soil load '#001'
```

Quote the code, or your shell will treat `#` as a comment.

That prints a card and then the restore prompt. Paste the restore prompt into the
new session and keep working. The prompt opens with what the document is and
what wrote it, leads with the model-authored boot prompt, carries the full
sections behind it, separates what still holds from what was only true at the
capture, says under `WHERE THE CLAIMS CAME FROM` which claims were checked and
which were reported or concluded, and lists the gaps the capture stated. Three
of those gaps are different answers and it says which is which: a section
nobody could see, a section withheld on purpose whose subject still exists, and
a section this project has no subject for at all.

Its headings look like `=== soil:a1b2... BOOT PROMPT ===`. That marker is 128
random bits, generated fresh for each `soil load`, so a handover's own text
cannot pass itself off as the prompt's structure. Content that looks like a
heading is escaped with a leading backslash on the way in; read such a line with
one backslash removed. None of this prevents prompt injection:
[spec/restore-prompt.md](../spec/restore-prompt.md) states the limits.

Other ways to address it:

```bash
soil load           # the most recent handover
soil load last      # the same thing, said out loud
soil load 1         # bare numbers work too
soil load '#001' --json   # the raw document
```

## Look around

```bash
soil list                    # what is stored, newest first
soil render '#001'           # the card, without the restore prompt
soil validate handover.json  # check a document against the spec
```

## When the thread is already dead

Sometimes there is no room left to run anything, or the assistant has no tools
wired up at all. That is what the rescue prompt is for:

```bash
soil rescue
```

Paste it into the dying thread. It asks for the same JSON, in a shape a model
with no tools can produce. Paste the reply into `soil save -` and you have a
normal handover with a normal load code.

## Where things are

```
~/.soil/
  index.json          the code counter and one row per handover
  handovers/001.json  the documents
```

Plain JSON. Read them with `cat`, back them up with anything, keep them in a
private git repo if you want a history. Set `SOIL_HOME` to put the store
somewhere else.

## Check a capture

```bash
soil check '#001'
```

That grades the capture against deterministic, documented rules
([checking.md](checking.md)): completeness, self-containment, time anchoring,
decisions carrying their reasons. The grade is printed, never stored on the
handover. It does not tell you whether the handover would actually restore a
session; only a real load into a real target answers that.
