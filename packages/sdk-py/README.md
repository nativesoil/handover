# soil-handover (Python)

The Python implementation of the
[Soil Handover Specification](../../spec/README.md) v1, a conformant preview.
Standard library only, Python 3.10+.

It passes the same [conformance fixtures](../../conformance/README.md) as the
TypeScript SDK, and the recipe, the rescue prompt, the restore prompt and the
rail cards are byte-identical across the two.

```python
from soil_handover import (
    HandoverStore,
    build_restore_prompt,
    normalize_handover,
    render_recipe,
    render_saved,
    validate_handover,
)

# 1. the text you paste into a model
recipe = render_recipe()

# 2. what comes back, however loosely it is shaped
handover = normalize_handover(json.loads(model_reply))

# 3. structure, then the fail-closed secret scan
result = validate_handover(handover)
if not result.valid:
    for issue in result.issues:
        print(issue.kind, issue.path, issue.message)

# 4. plain files under ~/.soil
store = HandoverStore()
entry = store.save(handover)
print(render_saved(handover, entry["code"]))

# 5. what you paste into the next session
print(build_restore_prompt(store.read(entry["code"])))
```

## Install

Nothing is on PyPI yet. From a checkout of this repo:

```bash
pip install packages/sdk-py
```

Or run straight from the tree: the package has no dependencies, so adding
`packages/sdk-py` to `sys.path` is enough.

## What is here

| Export                                                                              | Job                                                              |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `SECTION_KEYS`, `SECTION_TIERS`, `PROVENANCE_LABELS`, `LIMITS`                      | The format's fixed vocabulary                                    |
| `Handover` and friends                                                              | TypedDicts mirroring the JSON Schema; documents stay plain dicts |
| `validate_handover`, `assert_handover`                                              | Structure plus the safety rule, every problem reported at once   |
| `find_secret_material`, `assert_no_secret_material`, `SECRET_PATTERNS`              | The fail-closed secret scan                                      |
| `normalize_handover`, `extract_json_block`                                          | Loose model output to a spec-shaped document                     |
| `build_recipe`, `render_recipe`, `SHARED_RULES`, `SECTION_GUIDANCE`                 | The extraction recipe, verbatim, as data                         |
| `RESCUE_PROMPT`                                                                     | For a thread that is already dead or full                        |
| `HandoverStore`, `count_sections`, `format_code`, `parse_code`                      | The local file store                                             |
| `check_handover`, `check_observation`, `CHECK_RULES`                                | The open save-time baseline: deterministic checking and grading  |
| `build_restore_prompt`                                                              | A handover to a paste-ready restore prompt                       |
| `render_saved`, `render_loaded`, `render_list`, `render_check`, `render_validation` | The rail card, pure and deterministic                            |

## Notes

**`validate_handover` checks two things.** The shape, and the safety rule:
this writer scans every string in the document and refuses one carrying
credential-shaped material or a private absolute path, so `store.save` never
writes it. Issues carry a `kind` of `structure` or `safety`. Neither check is
a judgement about content.

**`normalize_handover` never invents.** It accepts `extractionSections`, bare
strings as sections, and absent sections, turning the last into a declared
`missing`. It will not make up a project id, so `validate` can tell you it is
missing. Observations pass through untouched.

**The renderers are pure.** No clock, no randomness, no I/O. Same input, same
bytes, in both SDKs, which is why whole cards can be pinned in tests. They
report counts and never a score.

**The store is files.** `~/.soil`, or `SOIL_HOME`. One JSON document per
handover, plus an index that can be rebuilt from the documents, because the
documents are the truth. The layout and the file bytes match the TypeScript
store, so both SDKs read the same `~/.soil`.

**The prompts are verbatim.** The recipe and the rescue prompt are normative
artifacts copied byte for byte from the published recipe; a parity test in
`tests/test_parity.py` holds them identical to the TypeScript SDK's strings.

## Tests

```bash
pip install pytest
pnpm build        # the parity tests read the TypeScript SDK's built output
python -m pytest packages/sdk-py
```
