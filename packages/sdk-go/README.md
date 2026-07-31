# soil-handover (Go)

The Go implementation of the
[Soil Handover Specification](../../spec/README.md) v1, a conformant preview,
plus the `soil` CLI as one static binary. Standard library only, Go 1.22+.

It passes the same [conformance fixtures](../../conformance/README.md) as the
TypeScript and Python SDKs, and the recipe, the rescue prompt, the restore
prompt and the rail cards are byte-identical across the three.

```go
import handover "github.com/nativesoil/handover/packages/sdk-go"

// 1. the text you paste into a model
recipe := handover.RenderRecipe()

// 2. what comes back, however loosely it is shaped
block, _ := handover.ExtractJSONBlock(modelReply)
parsed, _ := handover.ParseJSON([]byte(block))
doc := handover.Normalize(parsed, time.Time{})

// 3. structure, then the fail-closed secret scan
result := handover.Validate(doc)
for _, issue := range result.Issues {
    fmt.Println(issue.Kind, issue.Path, issue.Message)
}

// 4. plain files under ~/.soil
store := handover.NewStore("")
entry, err := store.Save(doc)

// 5. what you paste into the next session
loaded, _ := store.Read(entry.Code)
fmt.Print(handover.BuildRestorePrompt(loaded))
```

## The binary

```bash
go build -C packages/sdk-go -o soil ./cmd/soil
```

One static binary, no runtime, no dependencies. The Go SDK conforms to the
shared document and secure-writer fixtures, and the binary's command surface,
output bytes and exit codes match the Node CLI in `packages/cli`, `soil
check` and `--attach` included:

```
soil save                     print the extraction recipe to paste into your model
soil save -                   read the model's JSON reply on stdin and store it
soil save <file.json>         store a handover from a file
soil load [#NNN|last]         print the restore prompt for a stored handover
soil list                     list what is stored
soil validate <file|->        check a document against the spec
soil check <#NNN|file|->      check and grade a handover with deterministic rules
soil render <#NNN|file>       print the rail card for a handover
soil rescue                   print the prompt for a dead or full thread
soil where                    print the store location
```

## What is here

| Export                                                                         | Job                                                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `SectionKeys`, `SectionTiers`, `ProvenanceLabels`, `Limit*`                    | The format's fixed vocabulary                                   |
| `Obj`, `ParseJSON`, `MarshalJSONIndent`                                        | The ordered JSON model documents travel in                      |
| `Validate`, `AssertHandover`                                                   | Structure plus the safety rule, every problem reported at once  |
| `FindSecretMaterial`, `CheckNoSecretMaterial`, `SecretPatterns`                | The fail-closed secret scan                                     |
| `Normalize`, `ExtractJSONBlock`                                                | Loose model output to a spec-shaped document                    |
| `BuildRecipe`, `RenderRecipe`, `SharedRules`, `SectionGuidance`                | The extraction recipe, verbatim, as data                        |
| `RescuePrompt`                                                                 | For a thread that is already dead or full                       |
| `Store`, `CountSections`, `FormatCode`, `ParseCode`, `UUIDv7`                  | The local file store and the writer-assigned identity           |
| `CheckHandover`, `CheckObservation`, `CheckRules`                              | The open save-time baseline: deterministic checking and grading |
| `BuildRestorePrompt`, `BuildRestorePromptWithOptions`                          | A handover to a paste-ready restore prompt                      |
| `RenderSaved`, `RenderLoaded`, `RenderList`, `RenderCheck`, `RenderValidation` | The rail card, pure and deterministic                           |

## Notes

**Documents stay in the ordered JSON model.** Go's built-in maps forget
insertion order, and this SDK preserves a document's own key order the way
the official TypeScript implementation does, in validation paths, in the secret scan's
finding order, and in the bytes the store writes. `ParseJSON` produces `*Obj`
values; `MarshalJSONIndent` writes them back byte-compatibly with the
TypeScript store, so all SDKs read and write the same `~/.soil`.

**`Validate` checks two things.** The shape, and the safety rule: this
writer scans every string in the document and refuses one carrying
credential-shaped material or a private absolute path, so `Store.Save` never
writes it. Issues carry a `Kind` of `structure` or `safety`. Neither check is
a judgement about content.

**`Normalize` never invents.** It accepts `extractionSections`, bare strings
as sections, and absent sections, turning the last into a declared `missing`.
It will not make up a project id, so `Validate` can tell you it is missing.
Observations pass through untouched.

**The renderers are pure.** No clock, no randomness, no I/O. Same input, same
bytes, in every SDK, which is why whole cards can be pinned in tests. They
report counts and never a score.

**The prompts are verbatim.** The recipe and the rescue prompt are normative
artifacts; `embedded/` holds build-time copies of the canonical files in
[`recipes/`](../../recipes/README.md), and a test plus the conformance suite
hold the embedded bytes identical to the repo files. Cross-SDK byte parity of
the restore prompt and the rail cards is pinned by the golden files in
`testdata/`, generated from the TypeScript SDK.

## Tests

```bash
cd packages/sdk-go
go vet ./...
go test ./...
```

And the conformance suite, from the repo root:

```bash
go run -C conformance/go .
```
