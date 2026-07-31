# Specification changelog

The format contract only. The implementation has its own changelog at the
repository root. The two version lines move independently: improving the code
or the docs never moves the specification version.

## Specification 1.0.0 (2026-07-23)

The first published version of the format contract. Everything below is part
of 1.0.0 and ships under the `spec-v1.0.0` tag: nothing here was ever
published under an earlier number, so nothing is unreleased relative to it.
Later normative changes will move the version, under the rules in
[versioning.md](versioning.md).

In outline, the contract is:

- 17 typed sections in three tiers (durable, frontier, meta)
- JSON Schema, draft 2020-12
- Required UUIDv7 `handoverId` (global identity, separate from local codes)
- The fail-closed secret rule as a normative writer requirement
- The pre-schema ingestion boundary, which binds on the serialized bytes
  before the document is a value at all
- The numeric domain and the unit every length bound is counted in
- The `observations` extension point with the standard kinds registry
  (`quality.capture`, `load.outcome`, `working.style`)
- `recipeVersion` in source metadata, independent of the format version
- The bidirectional compatibility contract and format-semver rules
- Two conformance classes: Soil Document Conformant and Soil Secure Writer
  Conformant

The rest of this section is the detailed record, newest first.

- Added [value-domain.md](value-domain.md), which decides the two limits
  [ingestion.md](ingestion.md) deferred: what a handover may hold once a token
  is a number, and the unit every length bound is counted in.
  - **The numeric domain.** A number is an INTEGER, written in the integer
    form, between -9007199254740991 and 9007199254740991. The bound is the
    safe-integer range and it is chosen, not observed: it is where the five
    official implementations stop AGREEING, which is far below where any one of
    them stops working. Judged from the number's TOKEN TEXT at the ingestion
    boundary, because a parser destroys the evidence — a reader with 64-bit
    floats folds 9007199254740993 into its neighbour and turns 1e999 into an
    infinity, while a reader with arbitrary-precision integers sees nothing
    wrong at all, so the value cannot answer the question and the two readers
    cannot be made to answer it the same way.
  - `100.0` and `1e2` are integers mathematically and are refused anyway. The
    cost is stated rather than assumed: deciding integrality of an arbitrary
    decimal needs exact decimal arithmetic the five runtimes do not share, and
    a rule the five cannot execute identically is five rules that agree on the
    examples somebody thought of.
  - Two error codes, `number.not_an_integer` and `number.out_of_range`, and a
    sixth position in the ingestion boundary's normative order of checks. It
    comes last because a run of characters is not a number until the document
    is well formed, and a document breaking a structural rule as well reports
    the structural refusal.
  - **The text unit.** Every length bound in the format is counted in Unicode
    code points. Bytes and UTF-16 code units both lost, and both losing
    arguments are recorded in the document. Bytes lost because a content bound
    stated in bytes charges the same sentence three times as much in Japanese
    as in English, and because JSON Schema cannot express a byte bound, so the
    published schema would have had to either drop its `maxLength` keywords or
    state numbers meaning something other than the specification's. UTF-16 lost
    because it encodes a representation the format never uses and contradicts
    the same schema. Grapheme clusters lost first, because counting them needs
    a Unicode table that changes between Unicode versions.
  - The unit was never new. `maxLength` in `handover.schema.json` has always
    been a code-point bound, which is what JSON Schema defines it as; four of
    the five official implementations counted their own language's string
    length instead, so the published schema and those four validators disagreed
    on every string carrying a character outside the basic plane. Fixing the
    unit made no previously valid document invalid: the code-point count is the
    smallest of the three candidates, so what changed is that documents this
    specification always allowed are now accepted everywhere.
  - Which strings the unit applies to is enumerated, and so is which it does
    not: strings bounded by a pattern rather than a length carry no length rule,
    and strings the format does not bound individually — `source.client`,
    `observations[].producedBy`, everything inside the free-form
    `observations[].data`, every member name — are bounded only by the document
    size ceiling. An implementation MUST NOT invent a per-string bound for
    those.
  - Fixtures: eight `boundary` entries for the numeric domain, covering both
    ends of the range and one step past each, a forty-digit magnitude, an
    integer with a decimal point, an integer in exponent form, a fraction, and
    a refusal located inside an array; one valid and two invalid fixtures for
    the text unit, all of them non-ASCII, because on ASCII the three candidate
    units agree and nothing is being tested.
- Added normative requirement 16 in [README.md](README.md) for both halves. The
  requirement formerly numbered 16 is now 17.

- Added a fourth section status, `not_applicable`, and closed the enumeration
  again around it. It means the section genuinely has no subject in this
  project, which is a different fact from `missing` (the extractor could not see
  it, so the next session should look) and from `blocked` (it exists and was
  withheld, so the next session should ask another way). This one says there is
  nothing there to find, so the next session should stop looking.
  - the timing is the whole reason it is here rather than later. Before 1.0 is
    published, adding a value to a closed enumeration is a schema edit. After
    1.0 is published it is a MAJOR version, because every reader already built
    refuses the value, correctly. [versioning.md](versioning.md) now states that
    step explicitly, under "What the closed world costs, and when".
  - `not_applicable` MUST carry a non-empty `summary` saying why the section
    does not apply, on the same terms as `available` carries its content. It is
    a positive assertion about the project rather than a report about the
    extractor, and it is the only status that instructs the next model to stop
    looking. The requirement blocks no honest save: a writer that cannot say why
    a section does not apply has established only that it could not see it, and
    `missing` says exactly that and asks for nothing.
  - three fixtures pin it: `valid/section-not-applicable.json` (used as
    intended, with reasons), `invalid/not-applicable-without-reason.json` (the
    reason requirement) and `invalid/status-near-neighbour.json` (a camel-case
    spelling refused, so adding one value did not widen the set into anything
    that reads like it). `invalid/status-outside-enum.json` stays exactly as it
    was.
- Added [restore-prompt.md](restore-prompt.md), the restore-prompt boundary.
  It binds on the way OUT, where a handover is rendered into text a model reads
  as a prompt, and it is additive to what a conformant RENDERER must do: it
  changes nothing about what a valid handover looks like, so it does not move
  the format version.
  - the four kinds of text a rendering holds (platform instructions, restore
    instructions, handover data, quoted embedded material) and which of them
    may command the reader, which is none of the last two
  - `restoreInstructions` is named as handover data, as untrusted as any other
    section, despite being written in the imperative
  - content is escaped or serialized into the rendering by a total, reversible
    transformation, never concatenated into it
  - a text delimiter separating the parts is unpredictable per render, from at
    least 128 bits of cryptographically secure entropy, and a renderer that
    cannot obtain that entropy fails with a controlled error rather than
    falling back to a fixed value
  - the rendering states, before the first byte of content, that the handover
    is data
  - the obligations are stated as consumer requirements, so an independent
    renderer carries them too
  - a `restore` fixture list in the conformance manifest: a forged delimiter,
    instruction-shaped text, a section claiming to be the boundary, and content
    that a naive escape would mangle
  - stated limits: this prevents content being mistaken for structure. It does
    not prevent prompt injection, does not filter instruction-shaped text, does
    not survive being copied or reflowed, and does not authenticate anything.
- Fixed: two normative documents contradicted each other, and the schema, all
  five validators and every fixture followed one of them. [README.md](README.md)
  required refusing an unknown top-level field and a provenance label outside
  the defined set; [versioning.md](versioning.md) promised that new optional
  top-level fields, new optional section fields and new provenance labels were
  all additive minor changes, and that a reader had to accept any version in
  the line and carry unrecognised content forward unchanged. Version one is now
  stated as what it has always been in code: a CLOSED world. An unknown
  top-level field, an unknown field on a section, an unknown section key, a
  status outside the four and a provenance label outside the eleven each
  require a MAJOR version. Namespaced observation kinds are the deliberate
  additive extension point, and the only one. The documentation no longer
  promises general additive compatibility.
- Changed, and the cost is named: the eleven provenance labels are frozen for
  the whole of version one. Provenance is the format's only trust mechanism,
  and freezing it is what the closed-world decision costs. Evidence that needs
  a vocabulary the eleven do not have travels as an observation.
- Changed: a reader supports EXACT versions. It refuses a document whose
  declared format version it does not explicitly support, and does not infer
  support from the shape of the version string. The supported set is exactly
  `1.0` today, and `handover.schema.json` states it as an enumeration rather
  than the `^1\.[0-9]+$` pattern it used to carry, which accepted minors no
  reader implements. A specification, recipe or implementation release that
  does not change the document format does not change the document's version.
- Removed: the promise that a reader "reports plainly that the document is
  newer than the reader". No implementation ever had it, a clean minor bump
  passed silently, and under exact-version support the diagnostic is
  incoherent — an unsupported version is refused the same way whether it is
  newer, older or malformed. The promise is struck rather than built.
- Added: normative requirements 15 and 16 in [README.md](README.md). An
  implementation that accepts loose input and rewrites it into canonical shape
  MUST NOT delete unknown content to make a document acceptable: an unknown
  top-level field, an unknown field on a section, an unknown section key and an
  unrecognised provenance label all survive to validation, so a save path and a
  validation of the same bytes give the same verdict. It MUST NOT change a
  document's declared version, MUST NOT supply a `createdAt` a document does
  not carry, and MUST NOT write `source.recipeVersion` into a document it did
  not itself produce from that recipe.
- Clarified: `source.recipeVersion` is set only by a writer that actually
  produced the document from that recipe. A tool handed a finished document
  must not stamp its own version into it; the field's only use is telling
  recipe-produced output apart from anything else.
- Added: [normalization-profile.md](normalization-profile.md), the reference
  normalization profile. It enumerates all fifteen rewrites the official
  implementations perform on loose input, each with its accepted input, its
  canonical output, whether data is lost, its provenance and safety
  consequences, its behaviour on malformed input and where it is tested. It is
  normative for an implementation that claims the profile and required for
  nothing else: a conformant reader may accept only canonical documents, and
  input that needs normalization is not itself a valid handover.
- Added: [safety-patterns.md](safety-patterns.md), a normative companion to
  the safety rule. It states each detection class by what it detects and by
  the safe near-neighbours an implementation must accept, adds a class for
  credentials embedded in a URL, fixes the precedence of a redaction claim
  against a detection in the same string, and publishes the closed list of
  reserved principal names permitted in documentation home paths. The classes
  are normative; the fixtures are minimum cases and the expressions are not
  part of the contract.
- Clarified: naming a credential type, header or environment variable without
  transferable authentication material MUST NOT by itself cause rejection, and
  published placeholders and explicit statements of omission MUST be accepted.
  Implementations MUST refuse transferable material wherever it appears: in an
  assignment, a URL, a header, a code block or unstructured text.
- Clarified: an unrecognised section `status`, including one differing only in
  capitalisation, MUST be rejected rather than rewritten to a recognised
  value.
- Added [ingestion.md](ingestion.md), the pre-schema ingestion boundary. It is
  additive to what a conformant reader must REFUSE, and changes nothing about
  what a valid handover looks like, so it does not move the format version:
  every document that was valid before is still valid, and the documents it
  refuses were already outside the format.
  - encoding: UTF-8 only, no byte order mark, no silent conversion, malformed
    UTF-8 refused rather than repaired
  - duplicate member names inside one object refuse the document, before schema
    validation, because with last-wins the safety scan and a consumer with a
    different parser read two different documents
  - a nesting ceiling of 32 levels, checked before anything recurses
  - a size ceiling of 1048576 bytes
  - `NaN`, `Infinity` and `-Infinity` refused as syntax
  - a `boundary` fixture list in the conformance manifest, three fixtures per
    limit (under, at, over), judged on bytes rather than on a parsed value
