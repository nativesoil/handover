# For the agent reading this

This is the entry point, and it is written to be enough on its own for the
two things an agent does here: install Soil Handover for somebody, or work on
this repository. Rationale and depth live in `docs/` and `spec/`. What you
have to DO is here.

## What this project is

Soil Handover is an open JSON format for a project's working state, so work
saved in one AI tool can be continued in another. A handover carries the
decisions with their reasons, the constraints and why they bind, the
approaches already rejected, the task in flight and the next step, in a
document a person can read and any conformant implementation can parse.

What it solves is a boundary. A session fills up, compacts or ends. The work
moves to another agent, another tool, another model provider, or to a
colleague. A transcript preserves what was said, but not which decisions are
current, which approaches were already abandoned, or what should happen next.
A summary is smaller, and compression usually takes the reasons with it. "Use
X" survives. "Use X because Y failed under load, and do not reopen Z" often
does not, and a decision without its reason is a decision waiting to be
relitigated.

This repository holds the whole thing: the specification (1.0.0), five
independent implementations of it (TypeScript, Python, Go, JVM and .NET), a
`soil` command line tool, a local MCP server over stdio, a self-hostable
server preview, and a conformance suite that every implementation is held to.
Apache 2.0, copyright Mastodont AB.

The local round trip needs no account, no network and no telemetry.
Handovers are plain JSON files under `~/.soil` (or `$SOIL_HOME`), one file
per handover, readable with `cat`. Nothing in this repository calls a hosted
service, needs one, or degrades without one.

Nothing here is published to a package registry yet, so every install today
builds from a checkout.

## The boundary that is easy to get wrong

A memory system helps an agent remember inside one system. Soil Handover
moves the current working state between systems. If you catch yourself explaining this
as "so your assistant remembers things", you have described something else.

---

# Job one: install Soil Handover for somebody

Read the section above before running anything. An install done as a file
format, with no idea what the file is for, ends in a working command that
nobody uses.

`docs/install-with-an-agent.md` is the normative long form: platform
selection, per client configuration, the report format, and a smoke test
built on a disposable document it carries inline. Where that page and this
file disagree, that page wins. What follows is enough to do the job.

## Ground rules

1. **Install beside the host project, never into it.** No new dependency in
   the user's manifest, no source edits, no build configuration changes. The
   only files you may create or change are the agent client's own
   configuration, and only after telling the user which file you are about to
   touch.
2. **Keep secrets out of everything you write.** The official writers refuse
   credential shaped material and store nothing when they do, but that is a
   net, not a licence.
3. **Report every command you ran**, with each check's outcome as pass or
   fail.
4. **Run the smoke test against a scratch store**, so the user's real store is
   never involved and cleanup is one deleted directory.

## 1. Check the machine

```bash
node --version    # 20 or newer for the Node paths
pnpm --version    # needed for the from-source build
go version        # 1.22 or newer, only if the user wants a single binary
```

## 2. Build from source

Work in the checkout you are reading this file from, at a tools location of
the user's choosing, never inside the host project. Below, `<checkout>` is
that directory's absolute path.

```bash
pnpm install
pnpm build
```

After that build:

- the CLI is `node <checkout>/packages/cli/bin/soil.js`
- the MCP server is `node <checkout>/packages/mcp/bin/soil-mcp.js`

Both share the same store, so a handover saved in the editor loads in the
terminal and the other way round. For a `soil` command on the PATH, offer an
alias:

```bash
alias soil="node <checkout>/packages/cli/bin/soil.js"
```

If the user would rather have one static binary and has Go:

```bash
go build -C packages/sdk-go -o soil ./cmd/soil
```

Its command surface, output bytes and exit codes match the Node CLI, with one
exception: the Go binary has no `soil check`. Run that step of the smoke test
with the Node CLI, or skip it and say so in your report.

There is no packaged install and no `npx` line to substitute. Do not invent
one: a runner resolves a package name, the package names will be the
`@nativesoil/…` ones when they exist, and the bare names are unclaimed today,
so a bare-name one-liner would point the user's machine at something this
project does not control.

## 3. Connect the client

Replace `<checkout>` with the real absolute path in every block.

**Claude Code**

```bash
claude mcp add soil -- node <checkout>/packages/mcp/bin/soil-mcp.js
```

**Codex CLI**

```bash
codex mcp add soil -- node <checkout>/packages/mcp/bin/soil-mcp.js
```

**Cursor**, in `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "soil": {
      "command": "node",
      "args": ["/absolute/path/to/checkout/packages/mcp/bin/soil-mcp.js"]
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
      "args": ["/absolute/path/to/checkout/packages/mcp/bin/soil-mcp.js"]
    }
  }
}
```

**Any other client over stdio**: command `node`, single argument
`<checkout>/packages/mcp/bin/soil-mcp.js`. The server speaks JSON-RPC 2.0,
newline delimited, and exposes exactly three tools: `soil_save`, `soil_load`
and `soil_list`.

**CLI only**: no client configuration at all. The alias above is the whole
install, and the round trip runs by pasting.

The self-hostable server is a separate piece with its own setup page. Follow
`docs/server.md` rather than improvising its configuration from here.

## 4. The smoke test

Every step states its expected outcome. Anything else is a fail. Run the
sequence from `<checkout>`, with the store pointed somewhere disposable:

```bash
export SOIL_HOME=$(mktemp -d)
```

Below, `soil` means the CLI you installed: the alias, the `node .../soil.js`
form, or the Go binary. The document under test is
`examples/orchard-checkout.json`, the worked example this repository already
carries, so there is nothing to write and nothing to clean up but the scratch
directory.

**Step 1: the store answers.**

```bash
soil where
```

Expected: prints the scratch directory path, exit 0.

**Step 2: the document validates.**

```bash
soil validate examples/orchard-checkout.json
```

Expected: a "valid handover" card, exit 0.

**Step 3: the store accepts a save.**

```bash
soil save examples/orchard-checkout.json
```

Expected: a "handover saved" card reporting `17 / 17 sections carrying
content` and a load code (`#001` in a fresh scratch store), exit 0. That
count is structural content presence, never a measure of how good a capture
is.

**Step 4: the store lists it back.**

```bash
soil list
```

Expected: a "handovers" card carrying the code from step 3, exit 0.

**Step 5: the checker runs.** Node CLI only; with the Go binary, skip this
step and report the skip.

```bash
soil check '#001'
```

Expected: grade `adequate`, `0 problems`, exit 0. Quote the code, or the
shell treats `#` as the start of a comment.

**Step 6: the load renders.**

```bash
soil load '#001'
```

Expected: a "handover loaded" card followed by the restore prompt, exit 0.
Then finish the round trip by hand: open a session with no memory of this
install, paste the restore prompt, and confirm the model can describe the
project it has just been handed.

**Step 7: the MCP server answers**, if you configured one in section 3. This
drives the server directly over stdio, so it does not depend on the client
being restarted yet.

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node <checkout>/packages/mcp/bin/soil-mcp.js > "$SOIL_HOME/mcp-tools.json" && grep -o '"name":"soil_[a-z]*"' "$SOIL_HOME/mcp-tools.json" | sort -u
```

Expected: three lines, naming exactly `soil_list`, `soil_load` and
`soil_save`, exit 0. In the user's own client the same three tools appear
after a restart.

The reply lands in a file before anything reads it, rather than going
straight down a pipe into `grep`. Keep it that way. The tools listing is the
largest thing the server writes, a redirect is the one form that behaves the
same whatever the checkout you are installing from does when its input ends,
and it leaves the raw answer in the scratch store so your report can quote
what the server actually said rather than what your `grep` made of it. The
file goes when the scratch directory does, in section 5.

## 5. Report, then clean up

End with every command you ran in order, each step's pass or fail with the
exit code you observed, which integration you chose and why, anything you
skipped, and anything that still needs the user. Then, on request:

```bash
rm -rf "$SOIL_HOME"
unset SOIL_HOME
```

The user's real store was never involved. The checkout stays; it is the
install.

---

# Job two: work on this repository

## The map

| Path                  | What it is                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `spec/`               | The specification: the normative rules, the JSON Schema, the versioning promise, the rules the schema cannot state, and the value domain |
| `recipes/`            | The canonical prompt texts, byte for byte. Every implementation is held to these files                                                   |
| `packages/sdk-ts`     | TypeScript SDK, the official source implementation. Zero runtime dependencies                                                            |
| `packages/sdk-py`     | Python SDK, standard library only                                                                                                        |
| `packages/sdk-go`     | Go SDK plus the `soil` single binary                                                                                                     |
| `packages/sdk-jvm`    | JVM SDK: Kotlin on JVM 17, with a Java friendly API                                                                                      |
| `packages/sdk-dotnet` | .NET SDK: C# on .NET 8                                                                                                                   |
| `packages/cli`        | The `soil` command over the TypeScript SDK: save, load, list, validate, check, render, rescue, where                                     |
| `packages/mcp`        | The local MCP stdio server: `soil_save`, `soil_load`, `soil_list`                                                                        |
| `packages/server`     | The self-hostable multi-user server, a preview                                                                                           |
| `conformance/`        | The fixtures, and the five runners that hold every implementation to them                                                                |
| `examples/`           | The worked handover, plus runnable integration examples                                                                                  |
| `compatibility/`      | The source data behind the compatibility map, and the session reports it cites                                                           |
| `scripts/`            | The card check, the link check, the compatibility generator, the boundary fixture generator, and the release export                      |
| `docs/`               | Concepts, quickstart, the format for humans, checking, compatibility, architecture, the server preview, FAQ, related work                |

Everything real lives in the SDKs. The CLI and the MCP server are two doors
into the same functions and the same store.

## Build, test, check

```bash
pnpm install
pnpm build        # every TypeScript project, including the conformance runner
pnpm test         # the root vitest suite
pnpm test:py      # the Python SDK tests
pnpm conformance  # all five conformance runners
pnpm conformance:interop  # all five writing into one store at once
pnpm verify       # build, test, test:py, conformance and interop, in order
```

`pnpm build` alone is enough for the Node CLI, the MCP server, and anything
that imports the built TypeScript SDK. `pnpm conformance` additionally needs
Go, a JDK 17 or newer and .NET 8 on the PATH; each runner can also be invoked
on its own, and `conformance/README.md` says how.

`pnpm conformance:interop` is the cross-language store harness
(`conformance/interop/run.mjs`): one writer process per language against one
store root, checking that nothing acknowledged is lost, no code is handed out
twice, no document holds another writer's content, and no temporary file or
lock is left behind. It needs the same five runtimes and refuses to start when
one is missing, rather than covering four and reporting it in the words of
five. `--languages ts,py,go` runs a smaller set deliberately and labels every
line of the result as partial.

Five more things CI enforces, and they apply to a documentation change as
much as to a code change:

```bash
pnpm exec prettier --check .
node scripts/check-cards.mjs
node scripts/check-links.mjs
node scripts/check-recipe-sufficiency.mjs
node scripts/generate-compatibility.mjs
```

`pnpm format` rewrites where `prettier --check` only reports, and neither one
looks at the SVG diagrams; the house rules below say what that means.
`scripts/check-cards.mjs` needs `pnpm build` first, because it renders
through the built SDK, and `pnpm test` runs it again from inside the suite.
`scripts/check-links.mjs` needs nothing built: it resolves every relative link
and image reference in the tracked markdown against the tree and names the
file, the line and the target it could not find. `pnpm test` runs it too.
`scripts/check-recipe-sufficiency.mjs` needs nothing built either: it reads
every requirement out of `spec/handover.schema.json` and holds both recipe
texts to it, because the printed recipe is the only thing the model in the
intended flow ever sees, and a requirement the text omits is one the model has
to guess. If you change the schema's required fields or either closed set, it
fails until the recipes say so. `pnpm test` runs it as well.
The compatibility generator has to leave the tree unchanged; if it does not,
commit what it wrote.

Before opening a pull request, `pnpm build`, `pnpm test` and `pnpm
conformance` all have to be green.

## The conformance suite is the contract, not a test suite

The suite is not there to test this repository's code. It is the contract an
implementation in any language meets in order to claim compatibility, and the
official implementations run it too, so that they are held to the same bar as
anybody else's.

`conformance/fixtures/manifest.json` is the contract itself. Every fixture
has an entry saying what it is, whether it must be accepted or rejected, and
where the problem must be reported: an abstract semantic location, a sequence
of member names and array indices, never a particular spelling of a pointer
and never a particular message. The fixtures are language neutral JSON, and
they are what a port reads.

A run reports two claims on two separate lines, never as one number: a
DOCUMENT claim about schema and semantics, and a SECURE WRITER claim about
behaviour, which is held by refusing the fixtures that must be refused and
storing nothing. A reader-only implementation can honestly hold the first
without the second.

Changing that manifest obliges three things: the fixture file itself, an
entry carrying its reason in plain language, and all five runners still
passing, because every runner reads that one manifest. A fixture showing that
a RULE is wrong rather than an implementation is a specification discussion
and is welcome as one; open an issue before writing code.

## The document shape

A handover always declares all 17 sections, in a fixed order, frozen for the
whole 1.x line. They fall in three tiers, and the tiers are the point:
durable project truth outlives the session (`projectIdentity`, `decisions`,
`workflow`, `architecture`, `constraints`, `rejectedPaths`), frontier state
was only true at the capture (`executiveSummary`, `currentTask`,
`latestUserIntent`, `sessionDelta`, `blockers`, `nextSteps`,
`openQuestions`), and the last four describe the capture itself
(`sessionActivity`, `restoreInstructions`, `provenanceMap`,
`safetySummary`).

Every section carries a `status` from a closed set of four: `available` when
the content is there, `missing` when the extractor could not see it,
`blocked` when it was withheld for safety, and `not_applicable` when the
project genuinely has no such subject. The two that assert something,
`available` and `not_applicable`, require a non-empty summary. A section may
also carry `provenance`, a list drawn from a closed set of eleven labels that
says whether a claim was checked against the project itself, reported from
the conversation, inferred, or not seen at all. Both sets are frozen for 1.x:
adding to either takes a major version. They are enumerated in
`spec/handover.schema.json`, and `spec/sections.md` says what belongs in each
section and what does not.

The format has no grade, no score and no quality field, and it will not get
one. Scoring a document from inside the same file that wrote it is marking
your own homework, and a format that offers the field will get the field
filled in. A conformance fixture exists to keep it out.

The extension point is `observations`: an optional array of entries, each
with a `kind` and a `data` payload, optionally attributed with `producedBy`
and `producedAt`. A reader that does not recognise a kind ignores that entry
and carries it forward unchanged, rather than rejecting or dropping it.
Observations never change how the 17 sections are read, and where an entry
disagrees with a section, the section wins. Anything new that could be an
observation kind instead of a specification change probably should be;
`spec/observations.md` is the registry.

## The rules you will break by accident

These are the ones that actually bite. Every one of them fails a check.

- **A count is derived or it is absent, and the two ways round that are
  silent.** Numbers saying how many of something this repository has are held
  to the tree by checks that run in `pnpm test`. Two gaps you can fall into
  without anything going red: a count whose noun no check knows is unchecked
  from the moment you write it, because the checks match a fixed vocabulary and
  "five backends" is not in it; and a self-enumerating phrase like "three
  fixtures: just under it, exactly at it, and just over it" is safe only while
  the list stays in the sentence, so deleting the list while keeping the number
  turns tidying into an unchecked claim. `CONTRIBUTING.md` has the long version
  under "Prose style".

- **A newly tracked file has to be classified before a release can carry
  it.** The release artefact is built by copying an explicit list of paths
  and nothing else, never by filtering, because a filter only removes the
  things somebody thought of. A file on no list fails the release sweep,
  which the maintainers run on every pull request in the repository the
  artefact is exported from. The list and the sweep are maintainer tooling and
  are not part of the published artefact, so you will not find them in a
  public checkout; the fix is one classification with the reasoning attached,
  and the sweep's own failure message says where it goes.
- **Sign every commit off**: `git commit -s`. A pull request carrying an
  unsigned commit fails the DCO job.
- **Prettier is the formatter, and it does not cover the SVG diagrams.** Run
  `pnpm format` before committing; CI runs `prettier --check .`. Prettier has
  no parser for SVG, so the eight files under `docs/diagrams/` are skipped
  without a word by both `--write` and `--check`: the check stays green over a
  diagram in any state at all. Naming one on the command line does not format
  it either, it errors with "No parser could be inferred". Those files are
  hand-formatted and stay that way, which is the trade the group takes for
  having no diagram toolchain. Keep the indentation and the attribute order
  you found, and keep the diff to the thing you changed, because a reflowed
  drawing is a diff a reviewer cannot read.
- **Every relative link and image reference has to resolve.**
  `node scripts/check-links.mjs` walks the tracked markdown and fails on a
  target that is not in the tree, naming the file, the line and the target.
  `pnpm test` runs it. A link to a path the release manifest withholds is a
  separate failure, caught by the export sweep and not by this one.
- **A rail card in markdown has to be marked.** Either
  `<!-- card: bound <id> -->`, in which case its bytes must equal what the
  command behind that id prints, or `<!-- card: illustration -->` with a
  visible sentence above it saying it is an illustration. An unmarked card
  fails, and so does a bound card whose bytes have drifted. Regenerate the
  bound ones with `node scripts/check-cards.mjs --write`.
- **`docs/compatibility.md`, `compatibility/readme-snippet.md` and the
  generated block in `README.md` are generated.** Edit
  `compatibility/*.yaml` and rerun the generator. Hand-editing any of the
  three is caught as drift.
- **Some artefacts are pinned byte for byte and are regenerated, never
  hand-edited**: the Go SDK's embedded copies of `recipes/`, the .NET golden
  files under `packages/sdk-dotnet/SoilHandover.Tests/golden/`, and the JVM
  parity resources under `packages/sdk-jvm/src/test/resources/parity/`.
  `CONTRIBUTING.md` names the generator for each. Change `recipes/` without
  regenerating and the tests fail loudly, which is the intended outcome.
- **Line endings are LF everywhere**, enforced by `.gitattributes`, because
  the recipe comparisons are byte comparisons. The byte fixtures under
  `conformance/fixtures/boundary/` are excluded from that rule and from
  Prettier on purpose: their bytes are the thing under test, and several of
  them are not valid UTF-8.
- **The recipe in `packages/sdk-ts/src/recipe.ts` is authored text, not code
  to tidy.** Rule wording is load-bearing, and the phrasings that look
  redundant are usually there because a model exploited the gap. A change
  needs a reason grounded in what a model did with the old wording and what
  it did with the new.
- **Two prose rules, and a reviewer will check both.** No em-dashes. And
  never describe anything in this repository as verified: nothing here checks
  a handover's content, so the word would be a lie in a place where lies are
  expensive. Say checked and graded.
- **`pnpm -r` skips the root vitest suite**, which is where most of the
  TypeScript tests live. `pnpm test` at the root is the one that runs them.
- **Quote a load code in a shell**: `soil load '#001'`. Unquoted, `#` starts a
  comment and the command loads the most recent handover instead.

Keep a pull request to one thing, and let the body say why. Conventional-ish
subjects are appreciated and not enforced.

## Why there is more than one of this file

`AGENTS.md` is the real document. `CLAUDE.md` and
`.github/copilot-instructions.md` exist only because some hosts read one
filename and not another, and each of them is a short pointer to this file.
Do not let either grow back into a copy: two documents kept in step by hand
drift, and this project has been bitten by exactly that more than once.

## See also

`README.md` for the project as a reader meets it, `CONTRIBUTING.md` for what
is most useful to contribute, `spec/README.md` for the normative rules,
`conformance/README.md` for claiming compatibility in another language,
`docs/concepts.md` for the design rationale, and
`docs/install-with-an-agent.md` for the normative install.
