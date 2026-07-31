# soil-handover (JVM)

The JVM implementation of the
[Soil Handover Specification](../../spec/README.md) v1, a conformant preview.
Kotlin targeting
JVM 17, with a Java-friendly API and one runtime dependency:
`kotlinx-serialization-json`, whose `JsonObject` preserves key order and whose
parsed number primitives keep their source text, both of which the byte-level
store parity depends on.

It passes the same [conformance fixtures](../../conformance/README.md) as the
TypeScript and Python SDKs, and the recipe, the rescue prompt, the restore
prompt, the rail cards and the stored file bytes are byte-identical across the
three.

```kotlin
import dev.nativesoil.handover.*
import kotlinx.serialization.json.Json

// 1. the text you paste into a model
val recipe = RECIPE_TEXT

// 2. what comes back, however loosely it is shaped
val handover = normalizeHandover(Json.parseToJsonElement(modelReply))

// 3. structure, then the fail-closed secret scan
val result = validateHandover(handover)
if (!result.valid) {
    for (issue in result.issues) println("${issue.kind.label} ${issue.path} ${issue.message}")
}

// 4. plain files under ~/.soil
val store = HandoverStore()
val entry = store.save(handover)
println(renderSaved(handover, entry.code))

// 5. what you paste into the next session
println(buildRestorePrompt(store.read(entry.code)))
```

From plain Java the same surface is static methods and fields, no coroutines
anywhere:

```java
JsonObject handover = Normalize.normalizeHandover(Json.Default.parseToJsonElement(reply));
ValidationResult result = Validate.validateHandover(handover);
HandoverStore store = new HandoverStore();
StoreEntry entry = store.save(handover);
System.out.println(Render.renderSaved(handover, entry.code));
```

## Build

From this directory, with a JDK 17+ on the path:

```bash
./gradlew build             # compile, test
./gradlew :conformance:run  # the conformance suite (conformance/jvm at the repo root)
```

Nothing is on Maven Central yet; `./gradlew jar` produces the library jar.

## What is here

| Export                                                                                 | Job                                                             |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `SECTION_KEYS`, `SECTION_TIERS`, `PROVENANCE_LABELS`, `Limits`                         | The format's fixed vocabulary                                   |
| `validateHandover`, `assertHandover`                                                   | Structure plus the safety rule, every problem reported at once  |
| `findSecretMaterial`, `assertNoSecretMaterial`, `SECRET_PATTERNS`                      | The fail-closed secret scan                                     |
| `normalizeHandover`, `extractJsonBlock`                                                | Loose model output to a spec-shaped document                    |
| `RECIPE_TEXT`, `RECIPE_VERSION`                                                        | The extraction recipe, byte-normative, packaged as a resource   |
| `RESCUE_PROMPT`                                                                        | For a thread that is already dead or full                       |
| `HandoverStore`, `countSections`, `formatCode`, `parseCode`                            | The local file store                                            |
| `checkHandover`, `checkObservation`, `CHECK_RULES`                                     | The open save-time baseline: deterministic checking and grading |
| `uuidv7`, `isHandoverId`                                                               | Writer-assigned identity                                        |
| `buildRestorePrompt`                                                                   | A handover to a paste-ready restore prompt                      |
| `renderSaved`, `renderLoaded`, `renderList`, `renderCheck`, `renderValidation`, `wrap` | The rail card, pure and deterministic                           |

Documents stay plain `JsonObject` trees, mirroring the Python SDK's plain
dicts: what you parse is what you validate, store and render, with nothing
lost in a mapping layer.

## Notes

**`validateHandover` checks two things.** The shape, and the safety rule: this
writer scans every string in the document and refuses one carrying
credential-shaped material or a private absolute path, so `store.save` never
writes it. Issues carry a `kind` of `STRUCTURE` or `SAFETY`. Neither check is
a judgement about content.

**`normalizeHandover` never invents.** It accepts `extractionSections`, bare
strings as sections, and absent sections, turning the last into a declared
`missing`. It will not make up a project id, so `validate` can tell you it is
missing. Observations pass through untouched.

**The renderers are pure.** No clock, no randomness, no I/O. Same input, same
bytes, in every SDK, which is why whole cards can be pinned in tests. They
report counts and never a score.

**The store is files.** `~/.soil`, or `SOIL_HOME`. One JSON document per
handover, plus an index that can be rebuilt from the documents, because the
documents are the truth. The layout, the code allocation and the file bytes
match the TypeScript store, so every SDK reads the same `~/.soil`.

**The prompts are byte-normative resources.** The canonical texts live in
`recipes/` at the repo root; the build packages them into the jar unchanged,
and `RecipeResourcesTest` holds the packaged bytes to byte identity with the
repo files, so the jar can never ship a paraphrase.

**Byte parity is pinned.** The golden files under `src/test/resources/parity/`
were produced by the built TypeScript SDK from the shared worked example, and
one of them from the conformance fixture carrying a `working.style`
observation; `ParityTest` holds the restore prompt with and without the
recorded working-style block, the rail cards, the stored file bytes and the
secret scan's observable behaviour to them.

## Tests

```bash
./gradlew test
```
