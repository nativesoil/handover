# The recipes

The canonical prompt texts, byte for byte. These two files are the single
source of truth for the words a model is given:

| File                     | What it is                                                                |
| ------------------------ | ------------------------------------------------------------------------- |
| `handover-recipe-v1.txt` | The extraction recipe `soil save` prints for the session you want to keep |
| `rescue-recipe-v1.txt`   | The rescue prompt for a dead or full thread with no tools available       |

Every SDK embeds the same text in code so they work without reading files at
runtime, and the conformance suite holds all the copies to byte identity:
the TypeScript, Python, Go, JVM and .NET SDKs, and these files. If an SDK's
text drifts by one byte, the suite fails. A change to the recipe is made here
and in every SDK in the same commit, and it bumps the recipe version.

## The recipe version

The current recipe version is **1.4.0**, and both files print it on their own
first line.

That first line is not decoration. Nothing in this repository stamps
`source.recipeVersion` into a document: a writer is handed a finished document
and is in no position to attest which recipe produced it, and a tool that filled
the field in for everything it touched would destroy the field's only use. The
one party that actually observes the recipe is the model reading it, so the
model is who reports the version, and the text carries the version so there is
something to report. That is the whole reason it is on the first line and not
only in `RECIPE_VERSION` in five SDKs, where the model cannot see it.

The extraction recipe tells the model to leave `source` out entirely if the
first line carries no version, so an older or trimmed copy of the text produces
a document with no claim rather than a guessed one.

The recipe version and the format version move independently. Improving the
wording of the recipe never moves the format version, and a format change
does not by itself change the recipe. Documents produced by other writers may
lack `source.recipeVersion` and remain valid.

The `v1` in the file names tracks the recipe's major version only; wording
improvements bump the minor or patch number without renaming the file.

## Self-sufficiency

These texts are the ONLY thing the model ever sees. The intended flow is a
person pasting one into a chat window that has no access to this repository,
no schema, no spec and no examples. Whatever a recipe fails to say, the model
has to guess, and a wrong guess is a refused save at the exact moment a thread
is dying.

So a closed set is written out in full rather than gestured at, and a shape a
model cannot infer — that `provenance` is a list, that `quality` and `safety`
carry lists of strings — is shown as literal JSON rather than described. That
costs length in a text that is pasted into a context window and charged for by
the token, and the trade is made deliberately in one direction: a longer prompt
is a marginal cost, and an instruction that cannot be followed is a total one.

`scripts/check-recipe-sufficiency.mjs` holds both files to that bar, reading
every requirement out of `../spec/handover.schema.json` at run time rather than
from any list kept beside the recipe, so a new required field or a new
enumeration value fails a check instead of silently making a recipe incomplete
again. It establishes that the requirements are PRESENT in the text; whether a
model can actually follow them is answered by a real first-attempt run.

## Licence

These two files are published under the Apache License 2.0, the same licence
as the rest of the repository they live in. The full text is in
[LICENSE](../LICENSE).

Copying the text into another implementation is what it is for, and doing so
byte for byte is the point rather than a liberty. Apache 2.0 carries a patent
grant from each contributor, in its section 3, covering that contributor's own
contributions to this work; it grants no trademark rights, in its section 6.
What it asks in return is in its section 4: pass the licence on, keep the
attribution notices, and mark the files you changed as changed.

The licence notice is here and not inside the two `.txt` files on purpose.
Their bytes are held identical to the copy embedded in each of the five SDKs
and checked by the conformance suite, so a line added to them is a line that
has to be added in six places or the suite fails — and it would also become
part of the text handed to a model, which is not what it is for.
