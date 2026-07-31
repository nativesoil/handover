# @nativesoil/handover-mcp

A local MCP server over stdio, so your assistant can save and load a project's
state without you copying text around. JSON-RPC 2.0, newline-delimited, no
dependencies beyond the SDK.

## Wire it up

Claude Code:

```bash
claude mcp add soil -- node /absolute/path/to/handover/packages/mcp/bin/soil-mcp.js
```

Codex CLI:

```bash
codex mcp add soil -- node /absolute/path/to/handover/packages/mcp/bin/soil-mcp.js
```

Cursor (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project) and anything
else that reads a JSON MCP config:

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

## The tools

Exactly three, on purpose.

**`soil_save`** takes `projectId`, `title`, and `sections` (the 17 keys, each a
prose string), plus optional `project`, `sectionStatus`, `sectionProvenance`,
`soilHandover`, `quality`, `safety`, `source`, `observations` and
`workingStyle`. It stores the handover in `~/.soil` and returns the load code
with an honest section count, and the receipt carries the grade and finding
counts from the open deterministic check of the stored document. The grade
informs and never refuses a save, and it is never written onto the handover. A
section the model cannot fill honestly should be left out, and the save
records it as a gap.

`project` addresses a project: a shared container of handovers inside the
same store, in exactly the layout the self-hostable server serves for a shared
project. The reference follows the product's one grammar, `@` says where and
`#` says which, so `"@acme"` and `"acme"` name the same container. A save
never creates a project and a stated reference never falls back to the
personal store: an unknown project is refused, and the refusal names
`soil project add <name>`, which is where containers are created. Removal is
`soil project remove` at a terminal too; deletion is a human decision, so
these tools deliberately cannot create or remove a project, only save into,
load from and list one.

`sectionStatus` and `sectionProvenance` are keyed by the same 17 section keys
as `sections`, and they are what lets a model say through the tool interface
what the recipe asks it to say: that a section was withheld for safety
(`blocked`), and where each section's claims came from. They are three flat
parallel objects rather than one section object per key with a union type,
because a union is a loose shape and some clients flatten a loose schema to no
parameters at all. Values come from the format's fixed sets: four statuses,
eleven provenance labels.

`observations` attaches evidence beyond the 17 sections. The caller states the
`kind` and the payload, as named text entries; this server stamps `producedBy`
and `producedAt`, because it is the thing writing the entry and an attribution
it cannot check is not one it should repeat. Observations are attached before
validation, so the fail-closed secret scan reaches inside them exactly as it
reaches a section.

The `workingStyle` object holds the answers to four fixed questions about how
the project actually works: how the last blocker was handled, how conflicting
instructions were resolved, how new work was checked before it was trusted, and
an assumption the thread made and how it was caught. Each answer is a recorded
instance from the thread, a few sentences about one real moment, never an
adjective. The answers are stored on the handover as a single `working.style`
observation attributed to this server (see
[spec/observations.md](../../spec/observations.md)). All of it is optional and
fail-soft: a save without answers is stored exactly as before, an unusable
answer is dropped rather than failing the save, and nothing anywhere turns the
answers into a score.

**`soil_load`** takes an optional `code` and an optional `project`, and
returns the restore prompt: the durable truth, the state as of the capture,
the stated gaps, and how to read them. Defaults to the most recent handover in
the addressed store. When the handover carries
`working.style` observations, the recorded instances come last in the prompt,
as a labelled block of attributed evidence whose heading carries the same
per-render marker every other heading does. Evidence, not instructions: where
an instance disagrees with the workflow section, the section wins.

**`soil_list`** takes an optional `project` and lists what is stored: with a
reference, that container; without one, the personal store and every project
container, each row saying where it lives.

## Design notes

**Strict schemas.** Every input schema declares every property and sets
`additionalProperties: false`. This is not pedantry: a client that meets a loose
schema is free to flatten it to "no parameters", and then the model calls the
tool with nothing and the save captures nothing.

**Honest descriptions.** The tool descriptions say what the tools do, including
what they do not do. A save is a local file write and nothing is sent
anywhere. The save runs the open deterministic rules from
[docs/checking.md](../../docs/checking.md) on the stored document and reports
the grade; the grade informs, never blocks a save, and is never written onto
the handover, because the format has no grade field and will not get one.
Whether a handover actually restores a session is answered only by a real
load, and nothing here claims otherwise.

**Fail closed on secrets.** A save carrying credential-shaped material is
refused, nothing is stored, and the message tells the model to say that the thing
exists and where it is configured instead. It never repeats the value back.

**Working-style answers are evidence, never a grade.** The four questions exist
because a stated description of how a project works can be complied with
superficially, while a recorded instance gives the next session something
concrete to anchor against. That is a design rationale, not a measured result:
whether recorded evidence helps a cold model has not been measured here, and
this server claims nothing about it. What it does guarantee is narrower: at
most one `working.style` observation per save, the same fail-closed secret
scan inside the answers as everywhere else, and a presentation at load that
names the producer and never counts, scores or grades.

**Same store as the CLI.** `~/.soil`, or `SOIL_HOME`. Save from your editor, load
in your terminal.
