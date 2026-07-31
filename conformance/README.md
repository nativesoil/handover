# Conformance

How to claim **Soil Compatible**.

The claim means one thing: a handover written by your implementation is read
correctly by everybody else's, and the reverse. It is not a quality mark and
nobody administers it. You run the suite, it passes, you say so.

![The conformance contract. One fixture list, conformance/fixtures/manifest.json, is read by five runners: TypeScript, Python, Go, Kotlin on the JVM and C sharp on .NET. The list holds eleven valid documents, thirty-five invalid ones, four restore-rendering fixtures and twenty-nine byte fixtures for the ingestion boundary. Twelve of the thirty-five invalid documents carry credential-shaped material and the published schema accepts every one of them. The list fixes which documents are accepted, which are refused, and where the error is, as an ordered sequence of member names and array indices. It deliberately does not fix the message text, how a location is serialized, or the language's exception type. Results are reported as two separate claims, one about documents and one about writer behaviour.](../docs/diagrams/conformance-contract.svg)

Why the fixture list is a contract rather than a test suite: what it pins down
for every implementation, and what it deliberately leaves to each one. The
counts on it are the lengths of the four lists in `fixtures/manifest.json`,
and a test holds the drawing, its description and the alt text above to them.

## The two classes

There are two claims an implementation can make, and the suite reports them
separately, never as one green blob:

- **Soil Document Conformant** is a claim about DOCUMENTS: the schema, the
  section semantics, identity, round trips, versioning.
- **Soil Secure Writer Conformant** is a claim about BEHAVIOUR: the safety
  fixtures that must be refused, with the right category reported and nothing
  stored.

The distinction matters because a format cannot police its own instances: a
document written by an arbitrary tool can be fully schema-valid and still
carry a secret. A reader-only implementation can honestly claim the first
class without the second; a writer claims the second by refusing the same
inputs this suite refuses. See the conformance classes section of
[spec/README.md](../spec/README.md).

## Run it

```bash
pnpm install
pnpm conformance
```

The full run drives all five runners and needs Go, a JDK (17 or newer, for
the Gradle wrapper) and .NET 8 on the PATH alongside Node and Python. Each
runner can also be invoked on its own; the table below says how.

Each runner prints the same three lines: which implementation it ran against,
the spec version it held that implementation to, and one line per class.

```
soil conformance (typescript, spec 1.0)
Soil Document Conformant       <count> checks
Soil Secure Writer Conformant  <count> checks
```

The counts themselves are deliberately not reproduced in this document. A
count is a fact about how many assertions this repository's runners happen to
make, nothing in the specification defines what one check is, and the corpus
is meant to grow: the last section of this page asks you to add a fixture, and
every fixture that lands moves the number. So there is nothing here for a
reader to act on. Run the suite and read your own. What is worth knowing about
those two numbers is stated below instead of illustrated, because a statement
stays true when the corpus changes.

Five runners, one contract. Each one holds its SDK to the same fixtures, and
each can be run on its own:

| Runner     | Invocation                                                              |
| ---------- | ----------------------------------------------------------------------- |
| TypeScript | `node conformance/dist/run.js` (after `pnpm build`)                     |
| Python     | `python3 conformance/run_py.py`                                         |
| Go         | `go run -C conformance/go .`                                            |
| JVM        | `packages/sdk-jvm/gradlew -p packages/sdk-jvm :conformance:run --quiet` |
| .NET       | `dotnet run --project conformance/dotnet`                               |

The suite runs against this repo's own implementations on every build, so the
official implementations are held to the same bar as everybody else.

Two things hold of the printed counts on any tree. The TypeScript runner
reports more document checks than the other four, because the `schema` and
`mcp` categories run there only: the schema cross-check pins the published
JSON Schema to the fixtures once, and every SDK is pinned to those same
fixtures, so none can drift from the schema alone. And all five report the
same Secure Writer count, because all the writers are held to the same Secure
Writer checks.

## What is checked

| Category        | Class         | What it proves                                                                                                                                                                                                                                |
| --------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures`      | document¹     | Every valid fixture validates. Every invalid one fails, at the semantic location the manifest names                                                                                                                                           |
| `boundary`      | document²     | The pre-schema ingestion boundary, judged on the BYTES: size, UTF-8 with no byte order mark, no duplicate member name inside one object, no nesting past 32 levels, and every number an integer in the safe-integer range read from its token |
| `text-unit`     | document      | Every length bound in the format counted in Unicode code points, on strings where the candidate units disagree                                                                                                                                |
| `schema`        | document      | The published JSON Schema and the implementation agree, so neither drifts alone                                                                                                                                                               |
| `identity`      | document      | The `handoverId` rules: writer-assigned UUIDv7, copies keep it, codes are not identity                                                                                                                                                        |
| `observations`  | document      | Unknown observation kinds survive a round trip and change nothing about the sections                                                                                                                                                          |
| `safety`        | secure writer | A handover carrying credentials is refused, and the refusal never echoes the value                                                                                                                                                            |
| `normalization` | document      | The loose shapes models actually emit become valid documents                                                                                                                                                                                  |
| `closed-world`  | document      | Version one is closed: a normalizer may not drop unknown content to make a document acceptable, nor invent the facts a reader depends on, so a save and a validation of the same bytes give the same verdict                                  |
| `store`         | document      | Save, list and read round trip through plain files, and the index rebuilds from them                                                                                                                                                          |
| `restore`       | document      | A loaded handover carries its gaps, its time anchoring and its framing, every field a writer supplied reaches the reader, and content in it cannot be mistaken for the rendered prompt's own structure                                        |
| `determinism`   | document      | The renderer returns identical bytes for identical input, and reports no score                                                                                                                                                                |
| `recipe`        | document      | The recipe matches `recipes/` byte for byte, and the recipe version travels                                                                                                                                                                   |
| `mcp`           | document      | Exactly three tools, every input schema strict and union-free, and the producer surface able to express all 17 sections, every status and every provenance label                                                                              |

¹ The fixture checks that refuse a safety fixture count toward the secure
writer class: refusing one is writer behaviour, not document shape.

² Except two: the boundary fixtures that are accepted and carry
credential-shaped material count toward the secure writer class, because what
they prove is that the fail-closed scan is reached. One sits at exactly the
nesting ceiling with the material at its deepest point; the other has a root
the validator refuses on shape, so it pins that "rejected anyway" is not the
same claim as "scanned". The `boundary` category is separate from `schema` on
purpose: a schema validator is handed an already-constructed value, and by the
time it sees one the byte order mark is gone, the repeated member has collapsed
to whichever copy the parser kept, the recursion a deep document would break
has already run, and an oversized integer has been rounded into one the schema
accepts. That is a fact about layers, not a gap in the schema. The rules are
stated in [spec/ingestion.md](../spec/ingestion.md) and
[spec/value-domain.md](../spec/value-domain.md).

The text unit is the one rule of that pair the published schema does state, so
it is checked in its own category rather than at the boundary: every
`maxLength` in `spec/handover.schema.json` is a bound in Unicode code points,
as JSON Schema defines the keyword. That is why the unit is what it is, and
[spec/value-domain.md](../spec/value-domain.md) fixes it normatively so that an
implementation counting its own language's string length cannot read the same
bound differently. A rule the schema states is still a rule five
implementations can apply five ways, which is what the `text-unit` fixtures and
checks are for.

## The fixtures

```
fixtures/
  manifest.json     what each fixture is and why it is valid or not
  valid/
  invalid/
  restore/          VALID documents whose content is written to be mistaken
                    for the rendered restore prompt's own structure: a forged
                    delimiter, instruction-shaped text, a section claiming to
                    be the boundary, content a naive escape would mangle
  boundary/         BYTES, not documents: byte order marks, UTF-16 and UTF-32,
                    malformed UTF-8, repeated member names, nesting at 31, 32
                    and 33 levels, and number tokens at and past both ends of
                    the safe-integer range, in fraction and in exponent form
```

`manifest.json` is the interesting file. Every entry carries a reason in plain
language, so the suite doubles as an explanation of the format's edges:

```json
{
  "file": "invalid/grade-field.json",
  "location": ["grade"],
  "reason": "An unknown top-level field. This one is deliberate: there is no grade in the format."
}
```

Two flags matter on invalid entries:

- `"kind": "safety"` means the fixture must be refused by the secret scan, not
  merely by its shape.
- `"schemaExpressible": false` means JSON Schema cannot state the rule. Those
  fixtures MUST be **accepted** by the schema and **rejected** by the
  implementation, which is the suite's proof that validating against the schema
  alone is not enough to be conformant.

### Where an error is reported: the semantic location

`location` is an **abstract semantic location**: an ordered sequence of object
member names and array indices, from the root of the document down to the
offending value. `["sections", "decisions", "status"]` is a section's status.
`["observations", 0, "data", "endpoint"]` reaches through an array index into a
payload. The empty sequence, `[]`, means the document itself.

It used to be an exact JSON Pointer string, and that bound a contract the
specification never defines. An independent implementation that is
semantically correct, reporting the same place in its own notation, could be
failed by the official suite for spelling a location differently. That is a
formatting requirement masquerading as conformance.

So the harness is explicit about what it compares:

- **Compared:** the sequence of location segments, the expected validation
  outcome (valid or rejected, and for a boundary fixture the stable ingest
  code), and the coarse error category where an entry states one (`kind`).
- **Not compared:** the message text, how a location is serialized, the
  language's exception type, and any implementation's internal representation.

A pointer syntax is still a perfectly good representation, inside an SDK or on
the wire. Each runner simply parses its own representation into segments before
comparing, in a small adapter named `locationOf` (or `location_of`) at the top
of the runner. All five official SDKs report a JSON Pointer-ish string, so all
five adapters are the pointer-to-segments parse; yours may be anything, as long
as it produces the same sequence.

This is a contract for this harness. It binds neither the document format nor
any SDK's public error API, and it introduces no rule-identifier vocabulary.

The valid fixtures include the worked example from `examples/`, so the
documentation cannot drift away from the format.

The `restore` list is its own thing too, because its fixtures are neither
invalid nor interesting as documents: every one of them validates. What is
judged is the RENDERING. Each is rendered with the manifest's fixed
`restoreBoundaryToken` and held to the same outcomes: every line a reader could
take for structure carries that render's marker, no content line borrows the
marker unescaped, and each section's block decodes back to its summary by
removing one leading backslash. Production renders take the marker from the
platform's cryptographic source, which is what makes it unforgeable; the fixed
token exists so a check on the rendered bytes is possible at all. The rule is
stated in [spec/restore-prompt.md](../spec/restore-prompt.md), which also says
what it does not cover: it stops content being mistaken for structure, and it
does not stop prompt injection.

The `boundary` list is its own thing, because its fixtures are bytes rather than
documents: several of them are not valid UTF-8 and none of them can be judged
from a parsed value. Each entry states the boundary's verdict (`ingest`) and,
for an accepted one, what the validator must then say (`afterIngest`). That
second field is the point: an accepted document is never merely accepted, and
`afterIngest: "refused-by-safety"` pins the case where a document sits exactly
at the nesting ceiling and the fail-closed secret scan must still reach the
deepest value in it. Entries carrying `generateBytes` instead of `file` have no
file at all: at a megabyte each the size fixtures do not belong in a repository,
so every runner materialises them at run time. Regenerate the committed ones
with `node scripts/generate-boundary-fixtures.mjs`.

## Claiming compatibility in another language

The fixtures are language-neutral JSON, and they are the actual contract. A port
does this:

1. **Read the manifest.** For each valid fixture, your validator accepts it. For
   each invalid fixture, it rejects it and reports a problem at the stated
   semantic location.
   For each `boundary` fixture, your ingestion path returns the stated verdict
   with the stated error code, on the raw bytes, before your parser has built
   anything. See [spec/ingestion.md](../spec/ingestion.md); the mechanism is
   yours to choose, the verdict is not.
   1b. **Apply the restore-prompt boundary** if you render a handover into a
   prompt. Content is escaped or serialized into the rendering rather than
   concatenated into it, any text delimiter is unpredictable per render, and
   the rendering says the handover is data. See
   [spec/restore-prompt.md](../spec/restore-prompt.md) and the `restore`
   fixtures; the mechanism is yours, the outcome on those fixtures is not.
2. **Implement the identity rules** if you store handovers: assign a UUIDv7
   `handoverId` to a document that arrives without one, keep the id of one
   that has it, and never change an id on reindex or migration. A local code
   is a nickname, not identity.
3. **Implement the safety rule.** The pattern classes are listed in
   [spec/README.md](../spec/README.md#the-safety-rule). Fail closed: store
   nothing, and never echo the matched value in the error. This is what the
   Secure Writer class is.
4. **Handle unknown observation kinds** by ignoring them and carrying them
   forward, not by rejecting or dropping them. The standard kinds and the
   reader rules for them are in [spec/observations.md](../spec/observations.md).
5. **Accept the loose input shapes** if you accept model output directly:
   `extractionSections` as well as `sections`, a bare string as a section, and
   absent sections becoming `missing`.
6. **Use the canonical recipe texts** in [`recipes/`](../recipes/README.md) if
   you print a recipe at all, byte for byte, and stamp `source.recipeVersion`
   into the documents you write.
7. **Report counts, never a score.** An implementation that adds a grade field is
   not producing this format.
8. **Refuse a major version you do not know** rather than half-reading it.

Then say which class your implementation passes for spec 1.0, per class, and
link to your own run.

## Contributing a fixture

A fixture that catches something this suite misses is the most useful
contribution to this repo. Add the file, add a manifest entry with a reason in
plain language, and open a pull request.

If the fixture shows that a **rule** is wrong rather than that an implementation
is, say so in the pull request. That is a spec discussion, and it is welcome:
see [CONTRIBUTING.md](../CONTRIBUTING.md).
