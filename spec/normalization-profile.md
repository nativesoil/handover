# The reference normalization profile

**Status: normative for an implementation that claims this profile. NOT
required for Soil Handover conformance.** An implementation that accepts only
canonical documents is fully conformant, and is arguably the stricter reader.
Nothing in [README.md](README.md) requires any of what follows.

A **canonical** document is one that validates as written. Input that has to be
rewritten before it validates is not itself a valid handover: that is the whole
reason this document is separate from the specification, and the reason the
profile can be declined.

## Why the profile exists at all

A handover is written by a model, by hand, under pressure, at the end of a
session that is running out of room. Models use a loose key for the sections,
they write a section as a bare string instead of an object, they leave out the
sections they had nothing for, they forget the version. None of that is
interesting, and none of it should cost a user their capture. So the reference
implementations accept a small, enumerated set of loose shapes and rewrite them
into canonical ones.

The danger is equally simple. A rewrite that DELETES rather than reshapes turns
a save into a second, quieter validator that disagrees with the first one: a
document the validator rejects is stored with success, because normalization
rebuilt it from a whitelist and dropped everything not on the list, and the
stored document still claims the higher version number whose content has just
been stripped.

So the profile binds two rules on itself, and they are the reason it can be
trusted:

> **N1. Nothing is deleted.** Every member present in the input is present in
> the output. A member that cannot be rewritten is carried through verbatim, so
> validation reports it at the path it actually occupies. A save and a
> validation of the same bytes give the same verdict.
>
> **N2. Nothing is invented.** Normalization may state facts about the shape it
> just produced. It may not state facts about where the content came from, when
> it was captured, or which recipe produced it. Those belong to the writer that
> actually did the work, and a value filled in on their behalf is
> indistinguishable, to the consumer, from a real one.

N1 follows from version one being a closed world ([versioning.md](versioning.md)):
an unknown top-level field, an unknown field on a section, an unknown section
key and a provenance label outside the eleven are all errors, not extension
points, so deleting one hides an error rather than tidying noise.

## Where it runs

Normalization is the on-ramp for text a model produced: the CLI's `soil save -`
paste path, the SDKs' `normalizeHandover` (and its four ports), and the
manual rescue flow. It never runs on a document read back out of a store: a
stored document is read, validated and returned exactly as it was written.

## The fifteen rewrites

Each entry states the loose input it accepts, the canonical output it produces,
whether anything is lost, what it does to provenance, what it does to safety,
what it does with malformed input, and where the behaviour is pinned by a test.

Four of the fifteen are defects rather than conveniences and are no part of the
profile: **9** and **10** (deletion of unknown content), **14** (a fabricated
capture time) and **15** (falsified recipe attribution). A fifth is a special
case of **12** and is called out there: dropping a malformed document identifier,
so that the writer mints a replacement over the top of it. All five are stated
here, in place, rather than left out, because an implementation cannot avoid a
rewrite nobody named.

---

### 1. The loose sections key

- **Accepts:** a root carrying `extractionSections` and no `sections`.
- **Produces:** the same object as `sections`. The `extractionSections` key is
  consumed and does not appear in the output.
- **Data lost:** none. The key is consumed only when it is actually the source
  of `sections`. A document carrying BOTH keys is carrying content under a key
  nothing read, so `extractionSections` is carried through and validation
  refuses the document at `/extractionSections`.
- **Provenance:** none.
- **Safety:** none. The scan runs over the output, which holds the same strings.
- **Malformed input:** an `extractionSections` that is not an object is ignored
  as a source and carried through as an unknown member.
- **Tested:** `normalize.test.ts` "accepts the loose extractionSections key";
  the same case in all five conformance runners under `normalization`.

### 2. A bare string becomes an available section

- **Accepts:** a section value that is a non-empty string.
- **Produces:** `{"status": "available", "summary": "<the trimmed text>"}`.
- **Data lost:** leading and trailing whitespace only.
- **Provenance:** the section gets no `provenance`, which is correct: the model
  stated no source, and inventing `model_reported` would be a claim nobody made.
- **Safety:** none; the text is unchanged apart from trimming, and the scan sees
  it.
- **Malformed input:** n/a.
- **Tested:** `normalize.test.ts` "turns a bare string into an available
  section", and the five runners.

### 3. An empty or whitespace-only section value becomes a declared gap

- **Accepts:** a section value that is a string with nothing in it.
- **Produces:** `{"status": "missing", "summary": null}`.
- **Data lost:** whitespace.
- **Provenance:** none.
- **Safety:** none.
- **Malformed input:** n/a.
- **Tested:** `normalize.test.ts` "treats an empty string as a gap rather than
  as content".

### 4. A section the input never carried is declared missing

- **Accepts:** a `sections` object missing some of the seventeen keys.
- **Produces:** every one of the seventeen, the absent ones as
  `{"status": "missing", "summary": null}`.
- **Data lost:** none. This is the format's own rule made explicit: a gap is
  stated, never left out, because a reader cannot tell an omitted section from
  an overlooked one.
- **Provenance:** none.
- **Safety:** none.
- **Malformed input:** a `sections` value that is not an object is carried
  through untouched, and validation refuses it at `/sections`.
- **Tested:** `normalize.test.ts` "declares all 17 sections even from an empty
  object"; every runner's `normalization` block.

### 5. A section value that cannot be reshaped

- **Accepts:** `null`, which becomes `{"status": "missing", "summary": null}`,
  because "nothing here" is exactly what `missing` states.
- **Produces:** for any other unreshapable value — a number, an array, a boolean
  — the value is carried through verbatim, and validation refuses it at
  `/sections/<key>`.
- **Data lost:** none. Turning the value into a declared gap instead would
  delete whatever the model wrote and turn a document validation rejects into
  one a save accepts.
- **Provenance:** that would be worse than lossy. A section holding a number
  recorded as a gap the extractor could not see is a false statement about the
  capture.
- **Safety:** it would also remove the value from the document before the secret
  scan ran over it. Carried through, the value is scanned.
- **Malformed input:** this IS the malformed case.
- **Tested:** `normalize.test.ts` "keeps a section value it cannot reshape";
  `closed-world` in all five runners.

### 6. A section summary is trimmed

- **Accepts:** a `summary` holding padded text, or holding only whitespace.
- **Produces:** the trimmed text, or `null` when nothing survives trimming.
- **Data lost:** whitespace.
- **Provenance:** none.
- **Safety:** none.
- **Malformed input:** a `summary` that is neither a string nor `null` is
  carried through verbatim, and validation refuses it at
  `/sections/<key>/summary`.
- **Tested:** `normalize.test.ts` "turns a bare string into an available
  section" (the trimming) and the `.NET` golden `normalized-loose.json`, which
  pins `"  padded  "` becoming `"padded"` byte for byte.

### 7. A section status is inferred when the key is absent

- **Accepts:** a section object with a `summary` and no `status`, or with
  neither.
- **Produces:** `available` when there is content, `missing` when there is not.
- **Data lost:** none.
- **Provenance:** this is the one inference the profile permits, and it is a
  statement about the shape rather than about the source: a section that carries
  content is available by definition of the word.
- **Safety:** none.
- **Malformed input:** see 8.
- **Tested:** `normalize.test.ts` "infers available when an object has a summary
  but no status".

### 8. A section status that is present but not usable text

- **Accepts:** a `status` that is present and is a number, an object, an empty
  string, and so on.
- **Produces:** the value, carried through verbatim. Validation refuses it at
  `/sections/<key>/status`.
- **Data lost:** none. Dropping the value and inferring the status from the
  summary instead would let a section whose status is `42` come out as
  `available`.
- **Provenance:** a status this implementation cannot read is never rewritten to
  one of the three. A rewritten status makes a claim about the section that
  nobody wrote: the section would count as carrying content, would vanish from
  the list of what was not captured, and the author would never learn the word
  was wrong. That rule is normative, in
  [README.md](README.md) requirement 4, and applies to a status differing only
  in capitalisation.
- **Safety:** none.
- **Malformed input:** this IS the malformed case.
- **Tested:** `normalize.test.ts` "keeps an unrecognised status so validation
  refuses it", parameterised over `Available`, `AVAILABLE`, `partial`, `done`,
  and the same list in every runner.

### 9. Dropping unknown members at every level: NO PART OF THE PROFILE

- **The rewrite:** any member the whitelist does not name, meaning an unknown
  top-level field, an unknown field on a section, an unknown key inside
  `source`, `quality` or `safety`, and a section key outside the seventeen, is
  taken out, and the document is rebuilt from the whitelist with all of it gone.
- **Data lost:** everything not on the whitelist, silently.
- **Provenance:** catastrophic, and this is the centre of it. A document
  declaring a higher minor version and carrying whatever that minor added is
  stored with the version claim intact and the content stripped, so the stored
  document asserts a format it no longer contains.
- **Safety:** an unknown member can carry credential-shaped material, and the
  fail-closed scan runs over the rebuilt document, so it never sees it. Nothing
  is stored that the scan refused, and a document is stored that the scan never
  read.
- **Instead:** every unknown member is carried through, at the path it occupies,
  and validation refuses the document there. Version one is a closed world; an
  unknown member is an error, and the extension point for anything a producer
  wants to attach is `observations`.
- **Tested:** `closed-world` in all five conformance runners (unknown top-level
  field, unknown section field, unknown section key, unknown `source` member),
  `normalize.test.ts` "carries unknown content to validation", the CLI suite
  "soil save and soil validate agree about the same bytes", and the fixtures
  `invalid/grade-field.json`, `invalid/section-invented.json`,
  `invalid/section-extra-field.json`.

### 10. Filtering out provenance labels outside the eleven: NO PART OF THE PROFILE

- **The rewrite:** a `provenance` array holding labels this implementation does
  not know comes out with the unknown labels deleted, and an array left empty by
  that, like a `provenance` that is not an array at all, is dropped entirely.
- **Data lost:** the labels.
- **Provenance:** this is the worst place in the format to delete quietly.
  Provenance is the format's only trust mechanism, the one thing that lets a
  cold reader tell a check from a report from a guess. A section that arrives
  labelled `["repo_verified", "something_this_reader_does_not_know"]` comes out
  labelled `["repo_verified"]`, which reads as better sourced than what was
  written.
- **Safety:** none directly.
- **Instead:** `provenance` is carried verbatim whenever the key is present, and a
  label outside the eleven is refused at `/sections/<key>/provenance/<i>`. The
  eleven are frozen for the whole of version one, which is the cost of the
  closed-world decision and is stated as such in
  [versioning.md](versioning.md).
- **Tested:** `normalize.test.ts` "keeps a provenance label it does not
  recognise", `closed-world` in all five runners, the fixture
  `invalid/provenance-outside-enum.json`, and the .NET golden
  `normalized-loose.json`.

### 11. Quality and safety list entries that are not usable prose

- **Accepts:** `quality.missingInputs`, `quality.contradictions` and
  `safety.unsafeOmissions` holding padded strings.
- **Produces:** the entries trimmed, when EVERY entry in the list is usable
  prose.
- **Data lost:** whitespace, and only that. A list holding anything unusable is
  left exactly as written, so validation reports the entry that is wrong at
  `/quality/missingInputs/<i>` instead of this profile deleting it. Filtering the
  unusable entries out one by one, and dropping a list left empty by that along
  with the object holding it, is the rewrite this one refuses.
- **Provenance:** the stated gaps are the extractor's own honesty record.
  Deleting an entry from it makes a capture look more complete than the
  extractor said it was, which is precisely backwards.
- **Safety:** a deleted entry is also out of the secret scan's reach.
- **Malformed input:** a `quality` or `safety` that is not an object is carried
  through and refused.
- **Tested:** `normalize.test.ts` "keeps a quality entry it cannot use, rather
  than deleting it"; the .NET golden `normalized-loose.json`.

### 12. Scalar string members are trimmed

- **Accepts:** `soilHandover`, `handoverId`, `projectId`, `title`, `createdAt`,
  `code`, and `source.client` / `model` / `provider` / `recipeVersion`, holding
  padded text.
- **Produces:** the trimmed text.
- **Data lost:** whitespace.
- **Provenance:** none.
- **Safety:** none.
- **Malformed input:** a member that is present but not usable text is carried
  through verbatim so validation can name it. **This is where the fifth refused
  rewrite lives.** Dropping a `handoverId` that is present but not a string
  leaves the writer looking at a document with no id, and the writer then mints a
  fresh UUIDv7 over the top of it. [README.md](README.md) requirement 2 says a
  malformed id MUST be rejected rather than replaced, so that rewrite does the
  opposite of the rule without telling anybody. The same holds for a `createdAt`
  that cannot be parsed and for a non-string `projectId`.
- **Tested:** `normalize.test.ts` "keeps a malformed handoverId rather than
  letting a writer replace it" and "keeps a createdAt it cannot parse instead of
  replacing it"; `closed-world` in all five runners; the fixture
  `invalid/handover-id-not-a-uuid.json`.

### 13. The declared version, project id and title are filled in when absent

- **Accepts:** a root with no `soilHandover`, no `projectId` or no `title`.
- **Produces:** `soilHandover` set to the version this implementation writes
  (`1.0`); `projectId` and `title` set to the empty string.
- **Data lost:** none.
- **Provenance:** filling in the version is the one claim the profile is
  entitled to make, and the reason is worth stating precisely: it is a statement
  about the shape this function just produced, not about where the content came
  from. Normalization genuinely produces a 1.0-shaped document. It is NOT an
  upgrade: an input that states a version keeps it, whatever it says, so a
  document declaring `1.7` comes out declaring `1.7` and is refused on the
  version. Normalization never moves a declared version in either direction.
  The empty `projectId` and `title` are placeholders that validation refuses;
  they exist so the error is reported as a missing value rather than a missing
  key.
- **Safety:** none.
- **Malformed input:** covered by 12.
- **Tested:** `normalize.test.ts` "does not upgrade or downgrade a declared
  version" and "does not invent a project id, so validation can say so";
  `closed-world` in all five runners.

### 14. Filling the capture time in from the wall clock: NO PART OF THE PROFILE

- **The rewrite:** a root with no `createdAt` comes out with `createdAt` set to
  the moment normalization ran.
- **Data lost:** none, but that is not the problem.
- **Provenance:** this is the problem. `createdAt` is the anchor every frontier
  section is read against and the only reference a cold reader has for judging
  how old the state is. A value read from the clock at save time is
  indistinguishable, to a consumer, from a time the session actually reported,
  because the field has no flag saying which one it is. A handover pasted a week
  after it was written comes out claiming it was written today, and its frontier
  sections are then read as current.
- **Safety:** none.
- **Instead:** a document with no `createdAt` is invalid and is refused.
  Normalizing never supplies one.
- **Known consequence, and it is real:** the rescue prompt in
  `recipes/rescue-recipe-v1.txt` asks the model for exactly `projectId`, `title`
  and `extractionSections`, and never for `createdAt`, so a reply produced by
  that prompt alone does not validate. The main extraction recipe does ask for
  `createdAt`, so the primary save path is unaffected. A writer that genuinely IS
  the capturing session, meaning the local MCP server's `soil_save`, where the
  model hands over content it produced in the call that is running, sets
  `createdAt` itself, which is a true statement rather than a fabricated one.
- **Tested:** `normalize.test.ts` "does not stamp a createdAt the document never
  carried"; `closed-world` in all five runners; the CLI suite "refuses a capture
  with no time rather than stamping the wall clock"; the fixture
  `invalid/created-at-missing.json`.

### 15. Filling the recipe version in from a constant: NO PART OF THE PROFILE

- **The rewrite:** a root whose `source` has no `recipeVersion`, or no `source`
  at all, comes out with `source.recipeVersion` set to this implementation's own
  recipe version, and with a `source` object created to hold it if there was
  none.
- **Data lost:** none, but again that is not the problem.
- **Provenance:** the field's only use is telling recipe-produced output from
  anything else, and stamping it onto every document that passes through destroys
  exactly that. Normalization is handed a document somebody else wrote. The
  specification itself says documents from other writers may lack the field and
  remain valid, which is the case the rule protects, and filling it in makes that
  case unobservable.
- **Safety:** none.
- **Instead:** `source` appears in the output only when the input carried one, and
  `recipeVersion` only when the input stated one. Only a writer that actually
  produced the document from a recipe may set it.
- **Known consequence:** the extraction recipe does not ask the model to emit
  `source.recipeVersion`, so documents produced through the official paste path
  carry none at all. That is the honest state: no writer here is in a position to
  attest the field, and populating it would mean changing the recipe.
- **Tested:** `normalize.test.ts` "does not stamp a recipe version onto a
  document it did not produce" and "keeps a recipe version the input states";
  the `recipe` block in all five runners; the .NET goldens
  `normalized-loose.json` and `store-002.json`, which no longer carry a `source`
  object at all.

---

## What the profile never touches

- **`observations`.** They pass through byte for byte. Nothing here interprets
  them, reorders them, filters them by `kind`, rewrites `data`, or repairs a
  malformed entry. An entry whose kind the implementation has never heard of is
  the exact case the extension point exists for, so dropping or rewriting it
  would make the format lossy in the one place it promises not to be. And unlike
  the seventeen sections, observations are produced by tools rather than by a
  model writing JSON by hand: a tool that emits a malformed envelope should be
  told so by validation, not quietly patched.
- **A root that is not a JSON object.** It is returned as it arrived. Building a
  document around it would replace the value rather than report it, and the
  fail-closed secret scan must be able to reach a string inside a non-object
  root — which is what the boundary fixture
  `boundary/accepted-non-object-root-with-secret.json` pins.
- **A document read back from a store.** Reads validate; they do not normalize.

## Claiming the profile

An implementation claims this profile by doing the eleven that are part of it,
doing nothing else, and holding N1 and N2. The other four, **9**, **10**, **14**
and **15**, are the refused ones: an implementation that does any of them does
not have this profile, it has the defect this profile exists to name. One
observable test settles it, and it is worth running against any implementation
that makes the claim:

> Take the documents the validator rejects. Run them through the save path.
> Every one must be refused, with the same issue at the same path.

The reference implementations run that test in five languages, under the
`closed-world` category of the conformance suite, and at the binary level in the
CLI suite.
