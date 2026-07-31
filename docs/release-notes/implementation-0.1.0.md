# Implementation 0.1.0

Draft release notes for the `v0.1.0` tag. The implementation and the
specification are versioned separately; the format contract's own notes are
in [specification-1.0.0.md](specification-1.0.0.md).

The first public version of the official Soil Handover implementation: the
complete local round trip, from source, under Apache 2.0. Save a project's
working state in one AI tool, load it in another. Once built, the local
round trip needs no account, network or telemetry.

## What is in it

- **TypeScript SDK, the `soil` CLI and a local MCP stdio server.** The CLI
  covers save, load, list, validate, check, render, rescue and where; the
  MCP server exposes `soil_save`, `soil_load` and `soil_list` with strict
  schemas, sharing the same store as the CLI.
- **Python, Go, JVM (Kotlin) and .NET SDKs**, all passing the shared
  conformance fixtures. Conformant previews until their packages are
  published. The Go SDK includes the `soil` CLI as one static binary.
- **A conformance suite with five runners**, golden and adversarial
  fixtures, and the two conformance classes (document, secure writer)
  reported separately, never as one green blob.
- **A local store**: one plain JSON file per handover plus a rebuildable
  index, `#NNN` load codes, `~/.soil` by default, `SOIL_HOME` to move it.
- **Save-time checking and grading**, the open deterministic baseline:
  `soil check` runs ten documented rules, maps findings to a grade band and
  exits with CI-friendly codes, and `--attach` records the report on the
  handover as a `quality.capture` observation. Documented in
  [docs/checking.md](../checking.md).
- **Working-style capture in the local save flow.** The MCP server's
  `soil_save` asks four fixed questions about how the project actually
  worked in the thread being saved: how the last blocker was handled, how
  conflicting instructions were resolved, how new work was checked before
  it was trusted, and an assumption the thread made and how it was caught.
  The answers travel as one `working.style` observation attributed to the
  server, and `soil_load` and the CLI's `soil load` present the recorded
  instances after the restore prompt as attributed evidence. Optional and
  fail-soft: a save without answers is stored exactly as before, and
  nothing turns the answers into a score.
- **The self-hostable single-node server preview**, `packages/server`:
  shared projects, bearer auth with hashed tokens, the fail-closed write
  path, an HTTP API and an experimental MCP endpoint, on the same on-disk
  layout as the local store. A preview, not a hardened multi-tenant
  service. Documented in [docs/server.md](../server.md).
- **Documentation**: quickstart, concepts, the format for humans, checking,
  compatibility, the server preview, architecture, related work and an FAQ.

## What is not in it

Nothing is on a package registry yet; you clone and build. Editing and
merging handovers are out of scope for this release.

## Trying it

Two minutes from source: the [README](../../README.md) has the round trip,
[docs/quickstart.md](../quickstart.md) the full walkthrough, and
[docs/install-with-an-agent.md](../install-with-an-agent.md) the instruction
a coding agent can follow end to end.
