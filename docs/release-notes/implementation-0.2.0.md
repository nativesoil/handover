# Implementation 0.2.0

Draft release notes for the `v0.2.0` tag. The implementation and the
specification are versioned separately, and the specification does not move
in this release: the format contract stays at 1.0.0, with its own notes in
[specification-1.0.0.md](specification-1.0.0.md). The previous
implementation notes are in
[implementation-0.1.0.md](implementation-0.1.0.md).

The second public version of the official Soil Handover implementation: one
level of capability everywhere. Shared project containers on every surface
under the one command grammar, the deterministic check run at every save,
and three honesty corrections in what the tools print and ask for.

## What is in it

- **Projects, as first-class containers.** A project is a shared container
  of handovers inside the one store, created and removed at the terminal by
  `soil project add` and `soil project remove`, and addressed everywhere
  with the product's one grammar: `@` says where, `#` says which. A save
  without `@` is personal, always. A reference to a project that does not
  exist is refused with the exact command that creates it, never
  auto-created and never quietly read as personal. Removing a project
  refuses while the container still holds handovers unless `--purge` says
  to delete those too. The model-facing tools take a project argument on
  `soil_save`, `soil_load` and `soil_list`, locally and on the served
  endpoint, and can save into, load from and list a container; they
  deliberately cannot create or remove one. That stays a person's decision
  at the terminal.
- **The check at every save, on every surface.** Every save now runs the
  open deterministic baseline, the same ten documented rules `soil check`
  runs, on the document it just stored, and reports the grade band with the
  finding counts: the CLI and the local MCP server in their receipts, and
  both of the self-hosted server's surfaces in theirs. The grade informs
  and never blocks. A poorly graded save is still a save, because an honest
  gap never blocks one, and nothing from the report is written onto the
  handover.
- **A local project container and a served team project are the same
  files.** The container the local tools write at `projects/<name>` inside
  the store is byte for byte the store the self-hosted server serves for a
  shared project, held to it by a test in both directions. So taking solo
  work to a team is registering people around the same files, not migrating
  them, and the reference a client learned locally, `@acme`, says the same
  thing to the served endpoint.
- **Three honesty corrections**, found by a cold reading from outside the
  project. The provenance block under a loaded section now closes with its
  own scope: its labels grade the claims, and the block now says that which
  claims were gathered into a section, and in which words, is the writing
  model's synthesis even where every claim was checked. The extraction
  recipe's guidance for rejected paths asks how a path failed in observable
  terms, the symptom, the measurement, the error or the cost, because a
  bare verdict preserves that a path is closed and teaches nothing a later
  reader can check against; where only the verdict is known, the recipe
  says to say exactly that, and the recipe version moves to **1.5.0** for
  it. And the frame around a loaded document now names the boot prompt's
  voice: the prompt is phrased as a prompt on purpose, the frame says so,
  and recovered working shape is no longer left to be read as current
  authority.
- **A recorded install run from the public files alone.** An agent that had
  not seen the project before installed the tooling working only from the
  public repository at the `v0.1.0` tag, wired the local server into two
  clients, and ran the documented smoke test end to end against an isolated
  store. The report, transcribed from the operator's run log and saying so
  on its first line, is committed at
  [compatibility/reports/agents-md-codex.md](../../compatibility/reports/agents-md-codex.md),
  and what it does and does not establish is stated on the row it backs in
  [docs/compatibility.md](../compatibility.md).

## What is not in it

The Python package `soil-handover` is on PyPI; the npm packages are not published yet, so the Node route is clone and build. Editing and
merging handovers stay out of scope, and so does accumulated project
knowledge: groundwork for a future accumulation landed in the TypeScript
SDK and the shared fixtures, and no user-facing behaviour rests on it yet.

## Trying it

Two minutes from source: the [README](../../README.md) has the round trip,
[docs/quickstart.md](../quickstart.md) the full walkthrough, now with a
Projects section, and
[docs/install-with-an-agent.md](../install-with-an-agent.md) the
instruction a coding agent can follow end to end.
