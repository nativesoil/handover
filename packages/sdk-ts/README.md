# @nativesoil/handover-sdk

The official implementation of the [Soil Handover Specification](../../spec/README.md)
v1. Zero runtime dependencies.

```ts
import {
  buildRestorePrompt,
  HandoverStore,
  normalizeHandover,
  renderRecipe,
  renderSaved,
  validateHandover,
} from "@nativesoil/handover-sdk";

// 1. the text you paste into a model
const recipe = renderRecipe();

// 2. what comes back, however loosely it is shaped
const handover = normalizeHandover(JSON.parse(modelReply));

// 3. structure, then the fail-closed secret scan
const result = validateHandover(handover);
if (!result.valid) {
  for (const issue of result.issues) {
    console.error(issue.kind, issue.path, issue.message);
  }
}

// 4. plain files under ~/.soil
const store = new HandoverStore();
const entry = store.save(handover);
console.log(renderSaved(handover, entry.code));

// 5. what you paste into the next session
console.log(buildRestorePrompt(store.read(entry.code)));
```

## What is here

| Export                                                                         | Job                                                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `SECTION_KEYS`, `SECTION_TIERS`, `PROVENANCE_LABELS`, `LIMITS`                 | The format's fixed vocabulary                                   |
| `Handover` and friends                                                         | Types mirroring the JSON Schema                                 |
| `validateHandover`, `assertHandover`                                           | Structure plus the safety rule, every problem reported at once  |
| `findSecretMaterial`, `assertNoSecretMaterial`, `SECRET_PATTERNS`              | The fail-closed secret scan                                     |
| `normalizeHandover`, `extractJsonBlock`                                        | Loose model output to a spec-shaped document                    |
| `buildRecipe`, `renderRecipe`, `SHARED_RULES`, `SECTION_GUIDANCE`              | The extraction recipe, verbatim, as data                        |
| `RESCUE_PROMPT`                                                                | For a thread that is already dead or full                       |
| `HandoverStore`, `countSections`, `formatCode`, `parseCode`                    | The local file store                                            |
| `buildRestorePrompt`                                                           | A handover to a paste-ready restore prompt                      |
| `checkHandover`, `checkObservation`, `CHECK_RULES`                             | The open save-time baseline: deterministic checking and grading |
| `renderSaved`, `renderLoaded`, `renderList`, `renderValidation`, `renderCheck` | The rail card, pure and deterministic                           |

## Notes

**`validateHandover` checks two things.** The shape, and the safety rule: a
document carrying credential-shaped material or a private absolute path is
invalid, and `store.save` will not write it. Issues carry a `kind` of
`structure` or `safety`. Neither check is a judgement about content.

**`normalizeHandover` never invents.** It accepts `extractionSections`, bare
strings as sections, and absent sections, turning the last into a declared
`missing`. It will not make up a project id, so `validate` can tell you it is
missing. Observations pass through untouched.

**The renderers are pure.** No clock, no randomness, no I/O. Same input, same
bytes, which is why whole cards can be pinned in tests. They report counts and
never a score.

**`checkHandover` is the open baseline.** Deterministic, lint-style analysis
of the document itself, with every rule and the grade mapping documented in
[docs/checking.md](../../docs/checking.md). Whether a handover actually
restores a session is a different question, answered only by a real load.
`checkObservation` packages the report's counts, section names and individual
rule outcomes as a `quality.capture` observation, with the grade band left
out, and `store.update` attaches it without ever changing the `handoverId` or
the code.

**The store is files.** `~/.soil`, or `SOIL_HOME`. One JSON document per
handover, plus an index that can be rebuilt from the documents, because the
documents are the truth.
