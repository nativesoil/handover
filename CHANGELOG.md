# Changelog

The implementation and repository releases only. The format contract has its
own changelog in [spec/CHANGELOG.md](spec/CHANGELOG.md); the two version lines
move independently. Release tags: `v<implementation>` and
`spec-v<specification>`.

## 0.1.0

The first public release, and the only one this file has ever described.
Everything below ships under the `v0.1.0` tag; there is no earlier public
version for any of it to be unreleased relative to. The format contract moves
on its own version line and is at 1.0.0, in
[spec/CHANGELOG.md](spec/CHANGELOG.md).

In outline, the release is:

- TypeScript SDK, the `soil` CLI and a local MCP stdio server
- Python, Go, JVM (Kotlin) and .NET SDKs, all passing the shared conformance
  fixtures (conformant previews until packaged)
- The self-hostable single-node server preview, `packages/server`: bearer-token
  users, personal and shared project stores, an HTTP API and an experimental
  MCP endpoint, on the same on-disk layout as the local store
- Conformance suite with five runners, two classes reported separately
- The pre-schema ingestion boundary, in all five SDKs and on the CLI's
  raw-document input path
- Local store: one JSON file per handover plus an index, `SOIL_HOME` override
- Documentation: quickstart, concepts, format, architecture, the server,
  checking, related work, FAQ

The rest of this section is the detailed record of how it got there, newest
first.

- Added: **checking and grading in every implementation, and `soil check` in
  the Go binary.** The deterministic baseline existed only in the TypeScript
  SDK; the Python, Go, JVM and .NET SDKs now carry `checkHandover`,
  `checkObservation`, the rule vocabulary and the check card, and the Go
  binary answers `soil check` with `--json` and `--attach`, matching the Node
  CLI's output bytes and exit codes. The four stores gained the lock-guarded
  `update` path the attach write goes through, with the same two absolutes:
  the `handoverId` never changes and the load code never changes. Parity is
  held by a shared 18-document corpus (`scripts/lib/check-corpus.mjs`) whose
  expected cards, reports and observations are generated from the built
  TypeScript reference, never written by hand: every rule firing and none,
  counts on each grade-band edge, thresholds met and missed by one unit, and
  content outside the Basic Multilingual Plane, where a wrong string unit
  changes the numbers a report quotes.
- Fixed: **the .NET store could lose a document it had acknowledged, because
  its lock read a vanished lock directory as an abandoned one.** Every lock in
  the five SDKs breaks a stale lock by the directory's own age when the holder
  file is unreadable. The other four ask their platform with a stat call that
  refuses on a missing path, and map the refusal to now; the .NET port asked
  an API that answers a missing path with a sentinel of 1601, and read
  literally that answer is stale by four centuries. So the ordinary instant
  after a release, when the name is briefly gone between one waiter's failed
  create and its look at the age, read as an abandoned lock: the waiter
  removed the name out from under whichever process had just taken it, and two
  writers were inside one store at once. It surfaced intermittently in the
  concurrency test as sixty acknowledged saves with fifty-nine documents on
  disk, and as refused saves whose lock directory was deleted under the writer
  holding it, which is also what the test had recorded as an unexplained
  failure on 2026-07-29. The sentinel now maps to now, the way the other four
  locks already behaved, and a vanished directory is what it always was: the
  next chance to take the name.

- Fixed: **the compatibility map keyed everything on which path happened to be
  tested, and a generated sentence drew a false client-level conclusion from
  it.** The public pages said that ChatGPT and Claude "do not run on your
  computer at all", which is false of both products' desktop apps: each vendor
  documents attaching local MCP servers there. The root cause was the data
  model, not the sentence. One list mixed a terminal product, a protocol
  surface, programming libraries and a hypothetical client, and `runs_in`
  described a whole client, so a product that is a browser page on one surface
  and a desktop process on another had to be one or the other. The data is now
  two lists. `client_surfaces` carries one row per client surface and claim,
  and each row says whose statement it rests on: the vendor's own
  documentation, cited as a URL, or this repository's record. A
  vendor-documented row is refused by the generator unless it stays `unproven`
  and `source-reviewed`, because documentation supports what a surface can
  attach and never supports a run. `product_surfaces` carries what this
  repository ships, described by who each surface is for, and it alone reaches
  the README table. `runs_in` now describes a surface, never a client, and the
  generator refuses a row pairing `elsewhere` with a local stdio path, so the
  sentence that conflated the two cannot be generated again. Claude Code's
  committed local-server session report now backs a client row of its own as
  `open-integration-observed`. The evidence vocabulary is unchanged and no
  row's evidence moved down; the "What does not work" heading is gone,
  replaced by two sections that keep absence of function and absence of
  evidence out of the same cell.

- Fixed: **the restore prompt's working-style block existed in one language and
  not in the other four**, so the same stored document did not render the same
  way depending on which implementation read it. The TypeScript assembler took
  a `workingStyleEvidence` option and the Python, Go, JVM and .NET assemblers
  took no such option at all, which made the cross-language byte-identity claim
  false for any handover carrying a `working.style` observation. It was visible
  from the command line: `soil load '#001'` in `packages/cli` and the same
  command from the Go single binary printed different documents out of one
  store, and the missing block was the whole diff. All of them now take the
  option, assemble the block inside the builder behind one boundary token per
  render, escape every value out of the document on the way in, and show
  everything the payload carries rather than the two documented fields alone.
  The Go binary's `load` asks for the block, so the two command lines agree
  again. The default is untouched in every implementation: nobody asking for
  the block gets the sections alone, which is what the existing goldens pin,
  and regenerating them changed no committed byte.

  What holds each one to the reference bytes. Python: the parity suite renders
  through the built TypeScript SDK and asserts byte identity over a corpus that
  plants the block's own heading in every field of the payload a document
  controls, with the block asked for and with it left out. Go, JVM and .NET: a
  golden written by the built TypeScript SDK from the conformance fixture
  carrying the kind, and the same adversarial cases asserted as behaviour
  beside the existing boundary tests.

- Fixed: **the working-style block of the restore prompt let a document write
  its own heading.** Every other block of the prompt is assembled with a marker
  drawn for that render alone, so a section summary containing the text of a
  heading renders escaped and reads as content. The working-style block was
  built outside the assembler, with its heading spelled in static text, and
  joined on afterwards. A document whose recorded instance carried that heading
  therefore rendered two of them: the one the prompt wrote and the one the
  document wrote, identical, with a forged entry beneath the second. The block
  now comes from `buildRestorePrompt` like every other block, behind a new
  `workingStyleEvidence` option, so its heading carries the render's marker and
  every value out of the document is escaped on the way in. This matters beyond
  formatting: the prompt is handed to a model and the model is told to apply
  it, and on a shared project the author of a document and its reader are
  different people. All three surfaces that render the block are fixed at once
  (`soil load`, `soil_load` on the local stdio server, `soil_load` on the
  self-hostable server), because all three now get it from the same place: the
  hand-copied render halves in `packages/cli`, `packages/mcp` and
  `packages/server` are gone, and only the capture half is still carried twice.
  No other SDK rendered a working-style block at the time, so none of them was
  ever affected; the entry above is where they gained one. Adversarial tests
  plant a heading in every field of the payload a
  document controls, including the field names, the producer, the timestamp and
  fields this renderer has no name for.
- Fixed: **the working-style reader dropped every field of the payload it was
  not keyed to.** It read `instances[].situation` and `instances[].response` and
  nothing else, so a producer that carried anything more had it silently
  discarded at load: a third field on an instance, a field beside `instances`,
  or an `instances` value in a shape the reader did not expect. The registry
  documents the payload's intent, not a closed field set, and a reader that
  narrows what it shows has lost evidence without saying so. Everything the
  payload carries is now shown, the documented fields under their established
  labels and the rest under their own keys, with values that are not text shown
  as their JSON. An instance carrying only one of the two documented fields used
  to be dropped whole and now shows the field it has.

- Fixed: **two passages of the extraction recipe still widened the source scope
  back to global**, and the recipe version moves to **1.4.0** for it. The 1.3.0
  fix narrowed RULE 1's enumeration to project-scoped sources and named outright
  what must never be surfaced, but two later passages asked for the same class of
  material with no bound on it: the `projectIdentity` guidance asked for "the
  user's working style and their stated preferences and corrections", and the
  `workflow` guidance asked for "the standing user corrections". A model filling
  a section reads that section's own sentence, and a rule stated once several
  paragraphs earlier does not reliably bind a later unqualified request, so the
  defect 1.3.0 closed in RULE 1 stayed open in the two places a model is most
  likely to act on it: a person's global settings are exactly what "their stated
  preferences" and "the standing user corrections" name in ordinary English. Both
  passages now carry the bound inside the sentence a model is actually reading.
  The material is scoped to this project and taken only from project-scoped
  sources, which are this conversation, project material the user supplied, and
  project memory authorised for this project, and never from system or developer
  instructions, hidden platform context, memory from a different project, or
  personal profile material that is not about this project.
- Fixed: **RULE 1 of the extraction recipe told the model to draw on sources
  that are not the project's**, and the recipe version moves to **1.3.0** for
  it. The whole-project sweep is the most valuable thing the recipe does and it
  survives untouched; what was wrong was the list of places it sent the model
  looking. It named "EVERY source available to you (this conversation AND your
  project memory, your custom/standing instructions, and your
  background/system context for this project)", and two of those three classes
  are not project-scoped: custom and standing instructions are a person's
  global settings, and background and system context belongs to the platform.
  The trailing "for this project" does not reliably bind all three. A model
  obeying the text could write a user's personal global settings, or the
  platform's own system prompt, into a stored document — and the secret-shape
  scan does not catch it, because it looks for credential shapes and not
  personal prose. On a shared project save that document is readable by every
  other member, so a personal instruction reaches colleagues through project
  knowledge nobody meant to export. It also contradicted this repository's own
  contract, which holds that raw prompts are never transported (RULE 2) and
  that source material carries no authority (RULE 5). The enumeration is now
  project-scoped — this conversation, project material the user supplied,
  project memory authorised for it, and project sources the session can
  actually inspect — and the rule now says outright what must never be
  surfaced: system or developer instructions, hidden platform context, the
  model's own private reasoning, memory from a different project, and personal
  profile material that is not about this project.
- Fixed: **the extraction recipe asked for a document it never taught anyone to
  write**, and the recipe version moved to **1.2.0** for it. The printed recipe
  is the only thing the model ever sees — the intended flow is a person pasting
  it into a chat window with no repository, no schema and no examples — and it
  named the three GAP statuses while never naming `available`, the one every
  populated section needs, and named four of the eleven provenance labels while
  never saying that `provenance` is a list. A model obeying the text produced a
  document the tool refused, twice over, for reasons the text never covered; a
  cold walkthrough hit it on its first attempt and recovered only because it
  could open the specification, which a real user's model cannot. The closing
  instruction now enumerates both closed sets in full, shows `provenance` and
  the `quality`/`safety` note lists as literal JSON rather than describing
  them, gives `projectId` its slug shape and `createdAt` a worked example,
  states the 20000 code point bound on a `summary`, and says that the top-level
  key set is closed. The rescue prompt gains the same status vocabulary, for
  the narrower case of a section held back for safety. The recipe grew by about
  6%, which is the deliberate trade: a longer prompt costs tokens, and a prompt
  whose output is refused costs the capture.
- Added: `scripts/check-recipe-sufficiency.mjs`, which holds both recipes to
  the requirement that everything a valid document needs is stated in the text
  a model actually receives. Nothing tested this before. The install guide's
  smoke test feeds `examples/orchard-checkout.json`, a document that already
  exists and already validates, so it proves the CLI works and never travels
  the recipe-to-model-to-save path at all. Every requirement is read out of
  `spec/handover.schema.json` at run time rather than listed beside the recipe,
  so a new required field, a fifth status, a twelfth provenance label or an
  eighteenth section fails the check on the commit that adds it. It runs from a
  shell and from `pnpm test`, through
  `packages/cli/src/recipe-sufficiency.test.ts`, on the same pattern as the
  link and card checks. It establishes presence, not comprehension: whether a
  model can actually follow the words is answered by a real first-attempt run
  and by nothing else.
- Fixed: the line the CLI prints under the recipe named a bare command the
  documented install does not create. It said to run the reply back through
  `soil`, and nothing on a from-source checkout puts that on the PATH: the
  documented route builds the repo and invokes the CLI through Node by path,
  and the alias is offered as something the user may decline. So the one
  instruction handed to a reader who has just been given the recipe was the one
  instruction that could not be run. The trailer now echoes the invocation the
  process was actually started with.
- Added: `scripts/check-links.mjs`, which resolves every relative link and
  image reference in the tracked markdown against the tree and fails on a
  target that is not there, naming the file, the line and the target. There was
  no link checking of any kind before it. The two dead references this
  repository and its sibling have found so far were both found by a person
  reading, one of them on a phone, while every check that ran stayed green. It
  runs from a shell and from `pnpm test`, through
  `packages/cli/src/links.test.ts`, on the same pattern as the card check. It
  is deliberately narrow: it answers whether a link's target exists, and
  nothing else, so that one question is stated in exactly one place.
- Fixed: `compatibility/readme-snippet.md` carried a dead link. The snippet is
  generated as the body of the README block, so it inherited the README's
  `docs/compatibility.md`, which resolves from the repository root and not from
  the directory the snippet lives in. The snippet ships and is a file people
  open, so the generator now writes the path that works from where the file is.
  The link check found it.
- Fixed: `docs/architecture.md` contradicted itself and taught the wrong shape
  of the save path. It said all three write paths run inside the advisory lock,
  and four paragraphs later still offered a lock as future work against a
  collision that the lock already prevents; both sentences shipped. Its "Save,
  in order" went straight from the recipe to lifting the JSON block, with no
  ingestion boundary in it at all, so a reader learned a pipeline in which the
  numeric domain, the depth ceiling and the duplicate-member rule have nowhere
  to live. The sequence now runs the boundary where the code runs it, twice,
  once on the raw bytes and once on the lifted block, and says why it sits
  ahead of the parser. `ingest.ts`, `check.ts`, `identity.ts` and `lock.ts`
  were missing from the module table and are in it; the SDK box in the drawing
  was six columns out of true since the package rename; the identity step was
  missing from the save sequence; and a sentence about temporary file names
  appeared twice within ten lines.
- Documented: Prettier has no parser for SVG, so the four diagrams under
  `docs/diagrams/` are skipped in silence by both `pnpm format` and
  `prettier --check .`, which passes over a diagram in any state at all. They
  are formatted by hand. `AGENTS.md` and `CONTRIBUTING.md` say so where they
  introduce the formatter, rather than leaving it to be discovered by a
  contributor whose reflowed drawing nobody can review.
- Fixed: a check that decides everything from the committed tree could report
  on a set nobody was looking at, and said nothing about it. It enumerated
  paths with `git ls-tree HEAD` and read the tree with `git archive HEAD`, so a
  file that was staged, modified, or merely sitting untracked was invisible to
  it; a run made in that state covered a smaller set and printed its ordinary
  success line, which was true about the committed tree and said nothing about
  the tree the person was looking at. It reported one branch green while it was
  red. Checks of that shape now refuse to run against a dirty working tree,
  name every uncommitted path in the refusal, and state the set they covered
  instead of implying one. An inspection mode still runs them on a dirty tree,
  but it banners the state at both ends, words every summary line as a
  statement about the committed tree only, and exits non-zero whatever it
  found, so an inspection run cannot be mistaken for a real one.
- Fixed: the self-hostable server accepted over the network documents every
  other surface refuses. Its ingestion door was a documented stand-in that
  enforced size, byte order marks and strict UTF-8 only, because the shared
  pre-schema boundary was on another branch when it was written; the boundary
  has since landed and nothing noticed. `packages/server/src/ingest.ts` now
  calls `ingestDocument` from the SDK and holds no rules of its own, so the
  depth ceiling, the duplicate-member-name rule and the numeric domain apply on
  the wire exactly as they do in the CLI. Measured before the fix: a complete
  handover carrying `"projectId"` twice was accepted, stored and served back
  with last-wins deciding which value survived, and a document 33 levels deep,
  one carrying `0.92` and one carrying 9007199254740992 were each written to
  disk and then answered `500 internal error`, because the store's own
  read-back goes through the boundary and threw — leaving a row in the index
  whose every later read answered `500` as well. Nineteen of twenty-eight
  measured cases diverged from the boundary before, one after.
- Changed: the server's request-body ceiling is the boundary's own
  `INGEST_LIMITS.maxBytes`, 1048576 bytes, rather than a separate 5 MiB
  constant that happened to carry the same name. A body between 1048577 bytes
  and 5 MiB was accepted before and is answered `413` now. `docs/server.md`
  said 5 MiB and now says 1048576 bytes.
- Added: a wire-level Model A test. `packages/server/src/hardening.test.ts`
  drives every ingestion-boundary fixture from `conformance/fixtures/manifest.json`
  through `POST /v1/handovers` and pins both halves: what the boundary refuses
  is refused with the same stable code, and what the boundary accepts is not
  turned away at the door.
- Added: the numeric domain, at the ingestion boundary, on all five surfaces.
  A number is judged from its TOKEN TEXT before any conversion and refused with
  `number.not_an_integer` or `number.out_of_range`, located by JSON Pointer.
  The check is placed at the boundary because the parsed value cannot answer
  the question: measured on this repository's own runtimes,
  `JSON.parse("9007199254740993")` returns 9007199254740992 and
  `JSON.parse("1e999")` returns `Infinity`, while Python's `json.loads` returns
  the forty-digit integer exactly and reports nothing unusual. Each surface
  uses its own mechanism and no big-integer type: the TypeScript and JVM
  scanners, Go's `Decoder` with `UseNumber`, .NET's `Utf8JsonReader.ValueSpan`,
  and Python's `parse_int` and `parse_float` hooks, which are handed the token
  text and whose refusal is located by one walk of the built tree.
- Fixed: the five implementations counted string lengths in three different
  units, so the same document was valid in one and invalid in another. The
  published JSON Schema's `maxLength` has always been a bound in Unicode code
  points; Python counted code points and agreed with it; TypeScript, Go, the
  JVM and .NET counted UTF-16 code units and refused documents the schema
  accepts. Every length bound is now counted in code points on every surface,
  through a named `textLength` helper rather than the local string type, and
  every message says `code points` instead of `characters`. Nothing that was
  valid became invalid: the code-point count is the smallest of the three
  candidates, so the change only stops four surfaces refusing documents the
  format allows. Go keeps its separate UTF-16 helper for rail-card column
  layout, which is a display concern and deliberately not the format's; the
  two were the same helper, which is how the validator came to bound a title
  in UTF-16 units.
- Added: a `text-unit` category in all five conformance runners, exercising
  every individually bounded string at its limit and one code point past it,
  entirely on non-ASCII input, because on ASCII the three candidate units agree
  and nothing is being tested.
- Added: the fourth section status, `not_applicable`, across all five
  implementations. Every validator refuses it without a reason and refuses its
  near neighbours (`notApplicable`, `not applicable`, `NOT_APPLICABLE`) rather
  than reading them as the value. `SectionCounts` gains a fourth counter, so a
  section that does not apply is no longer counted as missing; the save and load
  cards name those sections on their own `no subject` row; and the restore
  prompt lists them separately from the empty ones, with the reason attached,
  because "there is nothing to find here" is an instruction and "we did not
  capture this" is not.
- Changed: the recipe version moves to **1.1.0**, and both recipe texts now
  print it on their own first line. Nothing in this repository stamps
  `source.recipeVersion` into a document any more, and no writer is in a
  position to attest which recipe produced one, so the field is now reported by
  the only party that observed the recipe: the model. Both recipes ask for it
  back, and the extraction recipe says to leave `source` out entirely if the
  first line carries no version.
- Fixed: the extraction recipe called itself a "drift-free capture", which
  nothing has ever demonstrated. It now says what is true, that a save records
  what the model wrote, that a stored handover can afterwards be checked and
  graded against published deterministic rules that read only its own text, and
  that whether the work survived the move is answered by a real load and by
  nothing else.
- Fixed: the rescue recipe promised that secrets "will be rejected", in
  unqualified present tense. The scan is a net and not a guarantee; a secret
  with no recognisable shape goes straight through it. The prompt now says so
  and puts the job back on the writer.
- Fixed: the rescue recipe asked for exactly `projectId`, `title` and
  `extractionSections`, and never for `createdAt`. Since normalization stopped
  fabricating a capture time, a reply produced from that prompt alone could not
  validate. It now asks for `createdAt`, and for `source.recipeVersion`. Both
  paths, the recipe and the rescue prompt, again produce documents that store.
- Recorded, not fixed and not dismissed: the .NET concurrency test failed once
  during this work, on a tree with no changes to that SDK, at the "nothing was
  refused" assertion rather than at any of the four invariants, and did not
  reproduce on four later runs of the same command on the same machine. The
  observation, what it does and does not license, and what to capture if it
  returns are written at the top of
  `packages/sdk-dotnet/SoilHandover.Tests/ConcurrencyTests.cs`. A failure that
  happened once and then stopped is not proven environmental by not repeating.
- Fixed: a hand-written count that contradicted the list beside it.
  [spec/normalization-profile.md](spec/normalization-profile.md) said an
  implementation claims the profile "by doing all fifteen", when four of the
  fifteen are the removed defects the same document marks as removed a few
  paragraphs earlier. It now says the eleven that remain, and names the four.
  A number written by hand next to a list that later changes is a defect
  class rather than a slip, and this repository has carried it more than once;
  where a count can be derived from the thing it counts, it now is.
- Fixed, at integration: three defects that existed in neither line of work
  alone and appeared only where the producer interface and the closed-world
  change met. (1) Every `soil_save` was refused. The producer surface began
  passing the caller's `soilHandover` through, which always writes the member
  into the document handed to normalization, and normalization began treating a
  STATED member as a statement to keep rather than a default to fill, so a
  caller who said nothing about the version got a document with no version.
  Both surfaces now pass on only the members the caller actually stated
  (`soilHandover`, `quality`, `safety`, `source`), which is what each change
  meant on its own; measured through the real tools, and 20 tests in the merged
  suite had caught it. (2) The Go conformance runner did not compile: the
  location contract changed `hasIssueAt` to take a semantic location, and the
  new closed-world category called it with pointer text. The runner's own
  pointer adapter is applied at those five call sites. (3) The `soilHandover`
  description on both `soil_save` tools promised that a version outside the 1.x
  line is refused, which stopped being the whole truth once support became a set
  of exact versions; it now says what the validator does.
- Fixed: `TestValidateFixtures` in the Go SDK read the conformance manifest's
  `path` field, which the location contract renamed to `location`. Every one of
  its 31 invalid fixtures was being compared against an empty expected location,
  so the test failed on the producer line of work by itself. It now parses its
  own pointers into segments and compares sequences, exactly as the Go
  conformance runner does.
- Fixed: the tool interface could not express the format it saves. Both MCP
  surfaces declared every section as a plain string, so a model going through
  the tool interface could set two of the three section statuses and none of
  the eleven provenance labels, while the recipe it is handed tells it to do
  both: mark a section `blocked` when something was withheld for safety, and
  label each section's provenance honestly. The recipe and the interface
  described two different documents, and the interface is the door most
  callers go through. Measured over the protocol against the real servers, not
  reasoned about. The defect was in the declared schema and not in the logic,
  because an out-of-schema call carrying section objects already landed
  correctly, so the repair is additive: `soil_save` now declares
  `sectionStatus` and `sectionProvenance` beside `sections`, three flat
  parallel objects keyed by the same 17 section keys, plus `soilHandover` and
  `observations`. Flat parallel objects and not a union: a union is the loose
  shape some clients flatten to "no parameters", which is how this class of
  defect reaches production unseen, so every object stays closed, every value
  comes from the format's own closed enumerations, and the conformance runner
  now refuses `anyOf`, `oneOf`, `allOf` and a type list anywhere in either
  schema and walks array items as well as object properties. Both surfaces
  changed, or the defect would merely have changed address.
- Fixed: two public claims were false. `docs/server.md` said the self-hosted
  server's MCP endpoint offered the same three tools as the local stdio
  server, "each with one addition"; it was an addition and an omission, since
  that endpoint's save took no working-style input and its load rendered no
  working-style evidence. The root README said that at load both the tool and
  the command present the recorded instances as attributed evidence, which was
  false for one of the two servers exposing a tool of that name, with no way
  for a reader to tell which was meant. Verified by storing a correctly formed
  `working.style` observation and loading it through both surfaces: the local
  one showed the evidence block, the server showed nothing. Repaired rather
  than documented away, because the module was written and tested and the
  server is marked preview. A cross-surface test now stores one document
  through the server and loads it through both surfaces, comparing the
  rendered evidence byte for byte, so the sentence is held true by a check
  instead of by prose.
- Changed: the conformance harness compares an abstract semantic location
  instead of exact error-location text. The fixture manifest bound exact
  JSON Pointer strings that the specification never defines, so an independent
  implementation that is semantically correct could be failed by the official
  suite for formatting a location differently. `path` becomes `location`, an
  ordered sequence of object member names and array indices, and each of the
  five runners maps its own error representation onto that sequence in a small
  adapter. The harness compares the segments, the expected outcome and the
  existing coarse error category; it does not compare message text, pointer
  serialization, exception types or internal representations. A pointer syntax
  remains a fine representation, parsed into segments before comparing. This
  binds the harness only: not the document format, not any SDK's public error
  API, and it adds no rule-identifier vocabulary.
- Fixed: the restore prompt's framing could be forged. It separated its parts
  with static text delimiters, so a section summary containing a line reading
  `=== HANDOVER META ===` rendered verbatim, split the document, and put
  planted text under a heading it did not belong to along with every section
  after it. The sentence telling the reader that instruction-shaped text is
  context rather than a command was byte-identical in all five
  implementations and powerless against this, because it is itself part of the
  same flat stream of characters. Every structural line now carries a marker
  generated for that one render from 128 bits of cryptographically secure
  entropy, content is escaped into the rendering by a total and reversible
  transformation, and the prompt states before the first byte of content which
  text may command the reader and which may not. The rendering distinguishes
  four kinds of text: the platform's own instructions, the restore
  instructions, the handover's data — including the `restoreInstructions`
  section, which is data despite its name — and material the data quotes in
  turn. Where entropy cannot be obtained the render fails with a controlled
  error; there is no fixed fallback token, because a predictable boundary
  looks exactly like a working one. Tests and goldens inject a fixed token so
  the byte-parity claims stay testable, and that injection point is not
  reachable from a document. TypeScript, Python, Go, JVM and .NET all
  changed, and all five conformance runners gained a `restore` category over
  four adversarial fixtures. It does not stop prompt injection; see
  [spec/restore-prompt.md](spec/restore-prompt.md) for what it does not cover.
- Fixed: the documented install pointed at things that do not exist. Every
  from-source path opened with `git clone https://github.com/nativesoil/handover.git`,
  a repository the release process has not populated: an authenticated clone
  yields an empty tree and the next command fails, and an anonymous one fails
  outright. The quickstart, the README, the server page, the server package
  readme and the agent install guide now run from the checkout the reader
  already has. The two places that wrote the bare name `soil-server` now say
  why it is not a package name at all: a runner resolves a PACKAGE name, the
  package will be `@nativesoil/handover-server`, and `soil-server` is only the
  executable inside it, so `npx soil-server` is wrong even after publication
  and today names something unclaimed on the registry. Checked, not assumed:
  `soil-server`, `soil-mcp` and all four `@nativesoil/…` packages answer `404`
  on registry.npmjs.org, and `soil-handover` answers `404` on PyPI.
- Fixed: the agent install guide's smoke test stated the wrong result. Its
  test document has four sections carrying content and the guide said to
  expect `3 / 17`, while the same page says anything other than the expected
  outcome is a failure, so an agent following it reported a false failure on a
  healthy install. The value is corrected and bound: a new documentation
  regression test, `packages/cli/src/install-guide.test.ts`, extracts the test
  document and the commands from the guide's own fenced blocks, runs the
  documented sequence through the real CLI against a scratch store, and
  asserts every stated expected outcome and exit code. The section count now
  has to agree in three places: the guide's prose, the guide's document, and
  what the CLI prints.
- Fixed: `soil save` and `soil validate` gave opposite answers about the same
  bytes. Save normalized before it validated, rebuilt the document from a
  whitelist, and silently discarded every unknown top-level field, unknown
  field on a section, unknown section key and provenance label outside the
  eleven on the way through. Measured before, through the CLI against a scratch
  store: five documents the validator rejected (an unknown top-level field, an
  unknown field on a section, an unknown provenance label, an unknown section
  key, and a document declaring `1.7` while carrying an extension object) were
  all stored with exit 0, and the stored `1.7` document still claimed `1.7`
  with the content that justified it gone. After: all five are refused by save
  with exit 1, at the same path validation names, and nothing is written.
  Normalization now carries every member it cannot rewrite through to
  validation instead of deleting it, in all five implementations, and the rule
  is pinned by a new `closed-world` conformance category in all five runners
  plus a CLI test that runs `validate` and `save` over the same bytes.
- Fixed: normalization stamped the wall clock into `createdAt` when the
  producing model had not written one. The specification calls that field the
  anchor for every frontier section and the only reference a cold reader has
  for judging how old the state is, and a stamped value is indistinguishable,
  to a consumer, from a time the session actually reported: a handover pasted a
  week after it was written came out claiming it was written today. A document
  with no `createdAt` is now invalid and is refused, never completed. A writer
  that genuinely is the capturing session still sets the field itself — the
  local and server MCP `soil_save` tools do, because the model hands over
  content it produced in the call that is running. **Known consequence:**
  `recipes/rescue-recipe-v1.txt` asks the model for exactly `projectId`,
  `title` and `extractionSections`, never for `createdAt`, so a reply produced
  by the rescue prompt alone no longer validates. The recipe texts are
  byte-pinned across five language ports, so closing that gap belongs to the
  pass that owns the recipes; the main extraction recipe already asks for
  `createdAt`, so the primary save path is unaffected.
- Fixed: normalization wrote its own `source.recipeVersion` into every document
  it touched, attributing this repository's recipe to output produced by an
  entirely different writer. The field's only use is telling recipe-produced
  output from anything else, and the specification itself says documents from
  other writers may lack it and stay valid — which stamping made unobservable.
  Only a writer that actually produced the document from that recipe may set it
  now. **Known consequence:** the extraction recipe does not currently ask the
  model to emit the field, so documents from the paste path carry no `source`
  object at all. That is the honest state; repopulating it means changing the
  recipe.
- Fixed: a `handoverId` that was present but not a usable string was dropped by
  normalization, after which the writer saw a document with no id and minted a
  fresh UUIDv7 over the top of it. The specification requires a malformed id to
  be rejected rather than replaced. It now reaches validation and is refused
  there, as does an unparseable `createdAt` and a non-string `projectId`.
- Changed: a reader supports EXACT format versions. `soilHandover` is checked
  against a set (`1.0` today) rather than against `^1\.[0-9]+$`, in all five
  validators and in `spec/handover.schema.json`, which now states an
  enumeration. The pattern accepted minors no reader implements, so a reader
  claimed to implement a version nobody has written. Five fixtures pin the
  line: the exact supported version, an older one, a higher minor, a higher
  major and a version that is not a version.
- Added: `spec/normalization-profile.md`, the reference normalization profile.
  All fifteen rewrites the official implementations perform on loose input, each
  with the input it accepts, the canonical output, whether data is lost, the
  provenance consequence, the safety consequence, its behaviour on malformed
  input, and where it is tested. Normative for an implementation that claims the
  profile, required for nothing else: a conformant reader may accept only
  canonical documents, and input that needs normalization is not itself a valid
  handover.
- Fixed: the Python, Go, JVM and .NET stores lost data when two processes
  shared one store, the same defect the TypeScript store had. Each was an
  unlocked read-modify-write — read the index, decide the next load code, write
  the document, write the index back — so two writers both read the same
  `nextCode`, both wrote a document at that code, and the second index write
  erased the first one's row. Both callers were acknowledged, and both were
  handed the same load code, so a receipt could tell a user to load a code that
  afterwards held somebody else's document. Measured before, four processes
  saving fifteen times each, three runs per language: Python 60 acknowledged
  and 18 / 18 / 17 on disk; Go 60 acknowledged and 27 / 16 / 15 on disk,
  measured through its CLI; the JVM 58 / 59 / 60 acknowledged and 12 / 6 / 14
  on disk, one run also leaving a half-written temporary file and one save
  dying outright on an index replaced under it; .NET 60 acknowledged and
  18 / 16 / 18 on disk. After: every language acknowledges 60, holds 60
  distinct codes and leaves 60 documents, over three runs each, with no
  temporary file left behind. All four now take the same advisory lock the
  TypeScript store takes, with the same on-disk shape — a `mkdir` lock
  directory at `<store root>/.locks`, a random holder id rather than a process
  id, broken as stale on a timeout with the directory's own modification time
  standing in when the owner died before writing its holder, and a refusal
  rather than a write when it cannot be taken. The temporary file behind each
  atomic write is now named with a random id instead of the process id, because
  two containers on one volume both run as pid 1. All five implementations were
  then run together against one shared store — 75 saves acknowledged, 75
  distinct codes, 75 documents, none lost — so a user with more than one SDK
  installed is protected by the same lock rather than by four locks that do not
  see each other. No runtime dependency was added: four of the five packages
  still have none. The .NET standard library cannot create a directory
  exclusively, so that one property calls the platform's own `mkdir` and
  `CreateDirectoryW` through an interop declaration rather than being quietly
  weakened; the reasoning, and what was measured about the two standard-library
  alternatives, is in `packages/sdk-dotnet/SoilHandover/Lock.cs`.
- Fixed: the secret scan was wrong in both directions. It missed transferable
  credentials it should have refused — GitHub personal access tokens, AWS
  access-key ids, Slack tokens, Google API keys, and credentials embedded in a
  URL, for which there was no detector at all — and it refused text it should
  have accepted, because four classes matched on the mention of a name rather
  than on a value bound to it. Naming a credential type, a header or an
  environment variable is now safe, as are published placeholders and explicit
  statements that a value was omitted, which is what two of the format's own
  section requirements ask for. Authorization-header, client-secret and
  application-credentials detection moved to value-shape matching; private-path
  detection gained a closed list of reserved principal names anchored to the
  whole path component; the bearer-token floor was raised so the bare word
  "credentials" no longer trips it. Private-key armour, JWT shape and the
  vendor key prefixes stay mention matches, because there the mention is the
  leak. A new `url_credentials` class refuses `scheme://user:password@host`.
  All five implementations return the same verdict for every fixture.
- Added: [spec/safety-patterns.md](spec/safety-patterns.md), normative. One
  section per detection class stating what it detects, the safe
  near-neighbours it must accept, the required outcome and its residual
  limitations, plus the precedence rule that a redaction claim never
  suppresses a detection in the same string, and the closed list of reserved
  principal names documentation may use in home paths.
- Fixed: an unrecognised section status, including one that differs only in
  capitalisation, is now refused at `/sections/<key>/status` in all five
  implementations. It used to be silently rewritten to `available`, so a
  capitalised status became content that counted as captured and disappeared
  from the list of what was not captured.
- Changed: this repository's own credential sweeps call the safety module's
  scanner rather than reusing its raw expressions, so they apply exactly the
  rule the product applies. Several classes only fire on a value bound to a
  name, and several carry exemptions for published placeholders and reserved
  principal names; a sweep assembled from the bare expressions reported hits
  the product does not treat as secrets, which is how a sweep once stopped on
  this repository's own documentation. The classes, their exemptions and their
  required outcomes are unchanged.
- Fixed: the `url_credentials` expression bounded its scheme name at 32
  characters instead of leaving it open-ended. An open-ended leading repetition
  has to be retried from every character of the subject, so on a long run of
  scheme-legal characters the scan cost O(n²) on the four backtracking engines:
  a document at the ingestion boundary's one-megabyte ceiling took tens of
  minutes per implementation, which the size fixtures made reachable. The
  ceiling sits well above every registered URI scheme, so no reachable document
  changes verdict; measured on the one-megabyte fixture the same scan went from
  minutes to 119 ms. The class, its near-neighbours and its required outcome
  are unchanged, and the expressions were never normative.
- Added: the pre-schema ingestion boundary, in all five SDKs and on the CLI's
  raw-document input path. One door per language now receives the serialized
  BYTES and, before any parser builds a value, enforces the three rules a
  constructed value can no longer show: the document must be UTF-8 with no
  byte order mark and is never transcoded or repaired, a member name repeated
  inside one object refuses the document, and nesting is bounded at 32 levels
  before anything recurses. Refusals carry a stable code and a JSON Pointer
  and never echo document content. What changed in behaviour: five
  implementations that previously disagreed about a byte order mark and about
  UTF-16 now return the same verdict; last-wins on duplicate member names is
  gone, which closes the case where the fail-closed secret scan and a consumer
  with a different parser read two different documents from the same bytes;
  and a document too deep for the safety scan is now refused with a structured
  error instead of being neither accepted nor scanned. The store, the reindex
  path and the CLI read bytes rather than pre-decoded text, so the boundary
  cannot be walked around. Twenty-one byte-level fixtures are registered in
  the conformance manifest, three per limit, and all five runners assert the
  same code and location for every one. Specified in spec/ingestion.md.
- Fixed: `validateHandover` returned early on a document whose root is not a
  JSON object and never ran the fail-closed secret scan on it. Such a document
  was refused either way, so nothing was ever stored, but refusing without
  scanning is not the same claim as scanning, and the boundary work made the
  difference visible. All five validators now scan before that early return,
  pinned by a conformance fixture.
- Fixed: the private-path safety tests in all five implementations used a
  real person's given name in their Windows-form example. They now use the
  same non-reserved placeholder principal the other two cases use, so the
  files that define the rule against private absolute paths no longer carry
  one. The assertion is unchanged: all three paths are still refused as
  `private_path`.
- Changed: how the contents of this repository are decided. Every file here
  was classified individually, with the reasoning written down, rather than
  filtered out of a larger tree by a list of things to remove: a filter only
  removes what somebody thought of, and an unclassified file now stops a
  release rather than riding along in it. The whole tree is swept for
  credential-shaped material before a release is built, binaries included,
  and the sweep's exceptions are named paths rather than a substring test; a
  deliberately planted finding has to be caught first, because a clean result
  from an untested method is not evidence. The first commit of this
  repository carries an explicit organisation identity rather than the
  identity of whichever machine produced it. Nothing in the format, the
  implementations or their behaviour moves.
- Added: secret scanning and dependency monitoring in continuous
  integration. `.github/workflows/security.yml` runs TruffleHog, pinned by
  image digest, over the checked-out working tree on every pull request and
  on pushes to `main`, and fails on a verified secret; it does not scan git
  history, and says so where it runs. It is a second, independent opinion
  beside the shape-based scan the safety module already applies, and it runs
  on every pull request rather than once at a release.
  `.github/dependabot.yml` names all
  five language surfaces explicitly — the node workspace, Python, Go, the
  Gradle build and the .NET projects — plus the workflows themselves,
  because the default configuration reaches none of the four implementations
  that keep their manifests outside the repository root. Neither file adds a
  dependency to any package.
- Changed: the server finished the `sectionsCaptured` rename and the two
  deprecated mirrors that bridged it are gone. `SectionCounts.captured` and
  `StoreEntry.sectionsCaptured` existed only so `packages/server` kept
  compiling while it was owned by a separate change; four places in the server
  read them (the save receipt's log field on both surfaces, the MCP save
  sentence, and the MCP list row) and now read `withContent` and
  `sectionsWithContent`. Two wire surfaces change with them: the save receipt's
  `sections` object no longer carries a `captured` key beside `withContent`, and
  a list row answers with `sectionsWithContent` rather than `sectionsCaptured`.
  The server's MCP list row also printed a bare `12/17 sections`; it says
  `12/17 sections carrying content`, the same wording every other surface uses,
  because a ratio without its unit reads as completeness. Reading an
  `index.json` written before the rename is unaffected: that compatibility read
  is in the store and stays.
- Fixed: the local store lost data when two processes shared one store, which
  reached every caller of the SDK including the `soil` CLI. Wrapping the
  server's call in a lock had not fixed it: `HandoverStore.save`, `update` and
  `reindex` were each still an unlocked read-modify-write, so two `soil save`
  processes against one `~/.soil` — an agent running the CLI beside a person
  doing the same — both read the same `nextCode`, both wrote a document at that
  code, and the second index write erased the first one's row. Measured before:
  four processes saving fifteen times each acknowledged 60 saves and left 26
  documents on disk. After: 60 acknowledged, 60 on disk, 60 distinct codes, and
  at eight processes by twenty-five saves, 200 for 200. All three write paths
  now run inside the same advisory lock the server uses, which moved from
  `packages/server/src/lock.ts` to `packages/sdk-ts/src/lock.ts` so there is one
  implementation rather than two: a `mkdir` lock keyed by a random holder id,
  stale-broken on a timeout, refusing the write rather than proceeding when it
  cannot be taken. The temporary file behind the atomic write is now named with
  a random id instead of the process id, because two containers on one volume
  both run as pid 1. Not fixed here: the Python, Go, JVM and .NET stores had
  the same unlocked read-modify-write and the same pid-named temporary file,
  and the Go CLI was measured losing 36 of 60 acknowledged saves the same way.
  They are fixed in the entry at the top of this section.
- Fixed: the self-hostable server lost data when two processes shared one data
  directory. Every read-modify-write, in the stores and in the registry, now
  runs inside an advisory `mkdir` lock keyed by a random holder id rather than
  a process id; a contended write is refused (`503` with `Retry-After` on the
  HTTP surface, "call the tool again" on the MCP one) and never acknowledged.
  Measured before: 60 saves acknowledged, 19 on disk, 41 receipts naming a code
  that afterwards held another document, and 8 concurrent `user add` calls
  acknowledged with 1 surviving row. After: nothing lost, no duplicate code, no
  dead token.
- Added: server offboarding and member management as commands.
  `soil-server user remove|rename`, `project member add|remove` and
  `project remove`, with `--purge` where a store is deleted. Removing a member
  ends their access on the next request and leaves the project's handovers,
  including the ones they wrote, in the project.
- Changed: server users have a stable UUIDv7 user id. Personal stores live at
  `users/<user-id>` and project membership references ids, so a released
  username carries nothing to the next person with that name. A data directory
  written before this is refused with a message naming the new
  `soil-server migrate`, which assigns ids, moves each store and rewrites
  membership, leaving tokens working.
- Added: one JSON request-log line per request on both server surfaces, with
  the caller, the action, the outcome and the duration, and never a token, a
  word of a handover, or an absolute path. `SOIL_SERVER_LOG=none` turns it off.
- Fixed: the server's MCP surface returned the underlying exception message on
  failure, which has been observed to contain an absolute path. Both surfaces
  now answer a failure generically and put the class in the operator's log.
- Changed: server request bodies go through one ingestion door
  (`packages/server/src/ingest.ts`) that enforces size, byte order marks and
  strict UTF-8 rather than calling `JSON.parse` inline. That file names exactly
  where the shared pre-schema boundary plugs in.
- Fixed: the documented server start command named an unpublished package.
  `docs/server.md` and the package README now document running from a checkout
  and say plainly that nothing is on npm.
- Added: working-style capture in the local save flow. The MCP server's
  `soil_save` asks four fixed questions about how the project actually worked
  in the thread being saved, and records the answers as a single
  `working.style` observation attributed to the server; `soil_load` and the
  CLI's `soil load` present the recorded instances as attributed evidence
  after the restore prompt. Optional and fail-soft: a save without answers is
  stored exactly as before, unusable answers are dropped, the fail-closed
  secret scan applies inside the answers, and nothing turns them into a
  score. No spec change: the `working.style` kind already exists in registry
  version 1.
- Added: save-time checking and grading, the open baseline. `soil check` runs
  ten documented deterministic rules and maps findings to a grade band, which
  is printed and never stored; `--attach` records counts, section names and
  individual rule outcomes as a `quality.capture` observation through the
  identity-preserving store update path, with no band in the payload.
  Documented in docs/checking.md.
- Added: the self-hostable single-node server preview,
  `packages/server`: shared projects, bearer auth with hashed tokens, the
  fail-closed write path, an HTTP API and an experimental MCP endpoint, on the
  same on-disk layout as the local store. Documented in docs/server.md.
