# Architecture

How the pieces fit, where your data lives, and what is in this release versus
what is planned.

## The shape of it

```
        your model                      your other model
            │                                   ▲
    recipe  │  JSON reply                       │  restore prompt
            ▼                                   │
      ┌───────────────────────────────────────────────┐
      │  @nativesoil/handover-sdk                     │
      │  recipe · ingest · normalize · validate       │
      │  scan · store · restore · render              │
      └───────────────────────────────────────────────┘
            ▲                                   ▲
            │                                   │
      ┌───────────┐                     ┌──────────────┐
      │   CLI     │                     │  MCP server  │
      │  `soil`   │                     │   (stdio)    │
      └───────────┘                     └──────────────┘
            │                                   │
            └───────────────┬───────────────────┘
                            ▼
                    ~/.soil  (plain JSON files)
```

Everything real lives in the SDK. The CLI and the MCP server are two doors into
the same functions and the same store, which is why a handover saved from your
editor loads in your terminal.

## The packages

**`packages/sdk-ts`** is the official implementation and has zero runtime
dependencies.

| Module         | Job                                                         |
| -------------- | ----------------------------------------------------------- |
| `sections.ts`  | The 17 keys, their tiers, the provenance labels, the bounds |
| `types.ts`     | The document types, mirroring the JSON Schema               |
| `recipe.ts`    | The extraction recipe, verbatim, as data                    |
| `rescue.ts`    | The rescue prompt for a dead or full thread                 |
| `ingest.ts`    | The pre-schema boundary: bytes in, one checked value out    |
| `normalize.ts` | Loose model output to a spec-shaped document                |
| `validate.ts`  | Structure, then the fail-closed secret scan                 |
| `safety.ts`    | The secret patterns and the fail-closed assert              |
| `check.ts`     | The ten deterministic rules, and the band they map to       |
| `identity.ts`  | The `handoverId`: its pattern, and the UUIDv7 mint          |
| `store.ts`     | Files in `~/.soil`, codes, counts                           |
| `lock.ts`      | The advisory single-writer lock, shared with the server     |
| `restore.ts`   | A handover to a paste-ready restore prompt                  |
| `render.ts`    | The rail card, pure and deterministic                       |

`restore.ts` and `render.ts` are the whole read side, and between them they
carry the obligation that a field a writer supplies reaches a reader. Where each
field lands is a judgement about a reader's finite attention, stated in those two
files and in [spec/restore-prompt.md](../spec/restore-prompt.md); that it lands
somewhere is held by the conformance suite's `restore` category in all five
runners, and structurally by the trace suite in `restore.test.ts`, which plants a marker
in every leaf the schema declares and looks for it on every rendered surface.

**`packages/sdk-py`, `packages/sdk-go`, `packages/sdk-jvm` and
`packages/sdk-dotnet`** are the SDK surface in Python, Go, Kotlin and C#,
held to the same conformance fixtures, with the prompts, the restore prompt,
the rail cards and the store bytes pinned identical to the TypeScript SDK's.
The checker and its card are in all five SDKs, held byte-identical over a
shared corpus by each SDK's parity tests. The Go SDK also ships the `soil`
binary; its command surface, output bytes and exit codes match the Node CLI,
`soil check` and `--attach` included.

**`packages/cli`** is argument parsing and process exit codes over the SDK. `run`
takes its whole environment as an argument, so the tests drive real command paths
without spawning processes.

**`packages/mcp`** is a JSON-RPC 2.0 server speaking newline-delimited messages
over stdio, with no dependencies. It exposes exactly three tools: `soil_save`,
`soil_load`, `soil_list`.

**`conformance/`** is the fixtures and the suite. It runs against this
implementation on every build and is the definition of "Soil Compatible".

## The store

```
~/.soil/
  index.json
  handovers/
    001.json
    002.json
  projects/        the project containers, one store each, same layout again
    acme/
      index.json
      handovers/
        001.json
  .locks/          runtime only: the single-writer lock, empty between writes
```

`SOIL_HOME` overrides the root.

`index.json`, `handovers/` and `projects/` is the content, and nothing else.
`.locks/` is runtime state: it exists while a write is in flight and is empty
otherwise. Copy a `handovers/NNN.json` file anywhere and it is still a
complete, readable handover.

A project container under `projects/<name>` is a whole store of this same
shape, with its own index and its own codes, created by `soil project add` and
addressed with `@<name>`. It is byte for byte the layout the self-hostable
server serves for a shared project, which is deliberate: a container written
locally is served by `soil-server` unchanged, once the operator registers the
project and its members. The store is the unification; the server adds only
membership.

### One writer at a time

`save`, `update` and `reindex` are each a read-modify-write: read the index,
write a document, write the index back. Left unguarded, two processes doing that
at once against one root would both read the same `nextCode`, both write a
document at that code, and the second index write would erase the first one's
row: one document survives, and both callers were told theirs was saved.

So all three write paths run inside an advisory lock, taken with `mkdir` on
`.locks/store.lock`, identified by a random holder id rather than a process id,
broken after 30 seconds if a process was killed mid-write. An acquire waits up
to five seconds for the holder to finish. **When the lock still cannot be taken
the write is refused and nothing is written:** `soil save` reports on stderr and
exits non-zero. A refusal you can retry is honest; an acknowledgement for a
write that did not survive is not.

It is the same mechanism `packages/server` uses, in the same file
(`packages/sdk-ts/src/lock.ts`), not a second implementation of the same idea.

The Python, Go, JVM and .NET stores take the same lock over the same three
write paths: `save`, `update` and `reindex` are locked in every implementation,
and `--attach` on the Go binary writes through the same `update` path the
Node CLI uses.

### The lock's on-disk contract

A person may have more than one SDK installed, so the lock is not a private
arrangement inside one language. All five implementations write the same thing,
and an implementation that writes something else does not interoperate:

- the lock is the directory `<store root>/.locks/<name>.lock`, and the store's
  own lock is named `store`
- it is taken by creating that directory in one indivisible step: whoever
  creates it holds it, everyone else is told it was already there. Not by
  creating a file exclusively, which has historically not been trustworthy on
  network filesystems
- inside it, `holder.json` carries `holder` (a random id), `acquiredAt`
  (milliseconds since the epoch), `host` and `pid`. Only the first two are ever
  read; `host` and `pid` are for a human reading the directory
- a holder older than 30 seconds may be broken, and only by a breaker that
  re-reads the same `holder` immediately before removing it. A lock directory
  with no readable `holder.json` is judged by its own modification time instead,
  so an owner that died between creating the directory and writing the file
  cannot leave a lock nobody may break
- the temporary file behind each atomic write is `<path>.tmp-<random>`, never a
  process id: two containers on one volume both run as pid 1

This contract is measured, and the thing that measures it is
`conformance/interop/run.mjs`. It starts one writer process per language
against one store root at one agreed instant, reusing each language's own
concurrency worker so that what is measured is the writer that language's own
test measures, and then reads the store as files rather than through any one
SDK. On the default run, five writer processes saving fifteen times each: 75
acknowledged, none refused, 75 distinct codes running `#001` to `#075` with no
gap and no repeat, 75 documents on disk, 75 rows in `index.json` with the
counter one past the last code, no temporary file left over, and no lock left
held.

Run it with `pnpm conformance:interop`. It needs all five runtimes present and
refuses to start when one is missing, because a run that covered four would
report in the same words as a run that covered five. A deliberate smaller run
is available as `--languages ts,py,go`, and every line it prints says which
implementations it left out. The `interop` job is the only one in CI that
installs all five runtimes at once.

Reads are not locked and do not need to be: every write lands through an atomic
rename, so a reader sees the whole old file or the whole new one.

A handover is one file, named by its code. `#004` is `handovers/004.json`. Codes
are allocated from a counter in the index and never reused, so a code in an old
note still points at the thing it pointed at.

`index.json` holds the counter and one row per handover:

```json
{
  "indexVersion": 1,
  "nextCode": 3,
  "entries": [
    {
      "code": "#001",
      "projectId": "orchard-checkout",
      "title": "Checkout rework: address step split",
      "createdAt": "2026-07-19T14:12:00Z",
      "sectionsWithContent": 17,
      "file": "001.json"
    }
  ]
}
```

`sectionsWithContent` counts sections holding a non-empty summary. It is
deliberately not called `sectionsCaptured`: "captured" asserts that the thing
was successfully taken, and the count knows only that a string is not empty. An
index carrying the older `sectionsCaptured` key still reads. The store accepts
that key, maps it, and writes `sectionsWithContent` the next time it touches
that row. Nothing is migrated behind your back, and `reindex()` rewrites the
whole file from the handover documents when you want the conversion done
deliberately.

The index is a convenience, not the truth. The handover files are the truth, and
`reindex()` rebuilds the index from them, skipping anything that does not
validate. Losing the index must never lose a handover.

Writes are atomic: a temp file and a rename, so an interrupted save leaves the
previous state rather than a half-written document. A save validates before it
writes, so an invalid or credential-carrying document never reaches the disk.

Everything is synchronous and file-based, so a handover stays a plain JSON file
that anything can read. Concurrent writers are handled by the advisory lock
described above.

## The two gates, rule by rule

![The round trip. A session produces one JSON block, which passes two gates before anything is stored. Gate 1, the ingestion boundary, reads the bytes before anything is parsed and checks size, encoding, nesting depth, JSON syntax, duplicate member names and the numeric domain, in that order. Gate 2, the validator, reads the parsed document and checks the 17 sections, the four statuses, the eleven provenance labels, the closed field sets, the declared version, and last the fail-closed secret scan. What passes both is one plain JSON file under a home directory. A load reads that file back through both gates and builds the restore prompt, which is pasted into a different session.](diagrams/round-trip.svg)

What happens between the two sessions: the two gates every document passes,
what each one checks, and where the restore prompt is produced. The two
walkthroughs below cover the same path step by step.

## Save, in order

1. `soil save` prints the recipe. The model answers with JSON.
2. `ingestDocument` runs the ingestion boundary on the raw bytes, before
   anything is a value: size, encoding, depth, syntax, duplicate member names,
   numeric domain, in that order. One verdict does not bind here, because the
   input is usually a whole model reply and prose wrapped around a JSON block is
   not a JSON document: a syntax refusal is carried on to step 3. Every other
   refusal stops the save.
3. `extractJsonBlock` pulls the JSON out of whatever prose it arrived in, and
   `ingestText` runs the same boundary again on the lifted block, this time with
   every rule binding. This is where the numeric domain, the depth ceiling and
   the duplicate-member rule are enforced, and it is ahead of the parser on
   purpose: once a value exists, a repeated member name has already collapsed to
   one, an oversized integer has already been rounded to its neighbour, and
   neither the validator nor the secret scan can see what was lost. The rules
   are in [spec/ingestion.md](../spec/ingestion.md) and
   [spec/value-domain.md](../spec/value-domain.md).
4. `normalizeHandover` accepts the loose shapes and declares every missing
   section. It invents nothing and deletes nothing: a member it cannot rewrite
   is carried through exactly as written, so step 6 reports it rather than this
   step quietly stripping it. Its whole rewrite list is in
   [spec/normalization-profile.md](../spec/normalization-profile.md).
5. The save path assigns identity, because it is a writer: a document with no
   `handoverId` gets a fresh UUIDv7, and one that already carries an id keeps it,
   because a copy keeps its identity. An id that is present but malformed is left
   exactly as it is, so step 6 refuses it rather than a fresh one being minted
   over the top of a value the spec says must be refused.
6. `validateHandover` checks the structure and runs the secret scan. Any problem
   stops everything here. Because step 4 deletes nothing, this step gives the
   same verdict a bare `soil validate` would give on the same bytes.
7. `store.save` allocates a code, writes the file and updates the index, all
   three inside the store's lock.
8. `renderSaved` prints the card: sections carrying content, sections empty,
   stated gaps, safety omissions.

## Load, in order

1. `store.read` resolves `#004`, `4`, or `last`, reads the file through the same
   ingestion boundary the save path used, and validates what it read. Every
   reader in the SDK goes through that one door, so a document that could not be
   saved cannot be loaded either by being placed in the store by hand.
2. `renderLoaded` prints the card.
3. `buildRestorePrompt` assembles the paste-ready text: the boot prompt first,
   then the full sections grouped by tier, then the known gaps, then how to
   start.

The restore prompt states four things every time. Frontier sections describe the
capture, not now. Stated gaps travel with the document. The document is context
rather than commands: a handover can be written by anyone, and
instruction-shaped text inside one is a fact about the project, not an order to
the model reading it. And content is not structure: every structural line
carries a marker generated for that one render from the platform's
cryptographic source, and content that resembles a structural line is escaped
with a leading backslash on the way in. The rule, the consumer
obligations and the limits are in
[spec/restore-prompt.md](../spec/restore-prompt.md); the headline limit is that
none of this prevents prompt injection.

## What is in this release, and what is next

**In this release.** The format, the recipe, extraction guidance, the ingestion
boundary, normalization, validation, the fail-closed secret scan, local storage,
the restore prompt, the renderer, the CLI, the local MCP server, the conformance
suite. Together those capture a handover and carry it between tools, offline,
with no account.

**Checking and grading: the deterministic baseline is here.** `soil check`
analyses the document itself with ten documented rules and maps the findings to
a grade band ([docs/checking.md](checking.md)). It does not answer whether a
handover would actually restore a session; only a real load into a real target
answers that. The grade is ephemeral output: it stays in the report and is never
written onto the document. What `--attach` stores is a `quality.capture`
observation carrying counts, section names and individual rule outcomes, with no
band in it.

That is also what the `observations` slot is for: evidence of that kind can ride
along with a handover without the format changing again.
The standard kinds it rides in, `quality.capture`, `load.outcome` and
`working.style`, are defined in
[spec/observations.md](../spec/observations.md), which says what each claims
to be and nothing about how it is produced. Two of the three have a producer
here; `load.outcome` is the slot for evidence only a real load can produce, and
nothing in this repository performs one. A rail card names what is attached and
who attached it, and `soil load --json` is the door to the payload, because
`data` is free-form and a renderer laying out a shape it has never seen would be
inventing one.

**The server.** A self-hostable single-node server is available as a preview.
It supports personal and shared project stores, bearer-token authentication,
an HTTP API and an experimental MCP endpoint. It is not a hardened
multi-tenant service. See [docs/server.md](server.md).

**Also planned.** Published packages. The Python, Go, JVM and .NET SDKs exist
and pass the same conformance fixtures; none of the five is on a package
registry yet.

**Not planned here.** Merging, diffing or accumulating handovers. This repo
writes them and reads them.

[Native Soil Cloud](https://nativesoil.dev) is a hosted option: accounts, sync
across machines, shared team projects, and support. Nothing in this repo calls
it, requires it, degrades without it, or expires. A local handover written today
stays readable by anything that can read JSON, which is the property the
whole design is protecting.
