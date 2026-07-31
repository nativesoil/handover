# The restore-prompt boundary

Status: normative for the 1.x line. Changes follow [versioning.md](versioning.md).

[ingestion.md](ingestion.md) states the rules that bind on the way IN, while a
handover is still bytes. This document states the rules that bind on the way
OUT, when a handover is rendered into text that a model will read as a prompt.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Why there is a boundary at all

A handover is written by one party and read by another party's model. On a
shared project surface it is written by several parties. The rendered restore
prompt puts that text directly into a model's context, next to the rendering
tool's own instructions about how to read it, in one flat stream of characters.

A flat stream has no channels. The only thing telling the reader which part is
the tool's instruction and which part is the document is the appearance of the
text itself, and appearance is something content can imitate. With a fixed,
guessable delimiter, a section summary containing that delimiter renders inside
its own section and is nonetheless read as the start of a new one: the planted
text appears under a heading it does not belong to, and every section after it
appears under a heading nobody wrote.

This is not a hypothesis. It was demonstrated against a rendering that
separated its parts with static text delimiters, and against a rendering that
also carried a sentence telling the reader that instruction-shaped text inside
the document is context rather than a command. The sentence is worth keeping and
it does not address this: it is itself part of the flat stream, and it says
nothing about which lines are structure.

## The four kinds of text

A rendered restore prompt is an arrangement of four kinds of text with three
different origins and three different levels of authority. A conformant renderer
MUST keep them distinguishable, and MUST NOT let the lower kinds appear as the
higher ones.

| Kind                     | Origin                                | Authority over the reader                                     |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------- |
| Platform instructions    | the host the reading model runs on    | highest; outside the document and outranking everything in it |
| Restore instructions     | the renderer                          | the rendering tool's own framing and structure                |
| Handover data            | the handover document                 | none; it is a report, never an instruction to the reader      |
| Quoted embedded material | something the handover quotes in turn | none, and less standing than the data quoting it              |

Two consequences that are easy to get wrong:

- **The `restoreInstructions` section is handover data, not restore
  instructions.** It is written by a model in the previous session, it is
  usually phrased in the imperative, and it is exactly as untrusted as every
  other section. The name is about what it describes, not about who it may
  command.
- **A renderer MUST NOT emit text claiming to be the platform's own
  instructions**, and MUST NOT present handover data as if it were. The reading
  model's operating instructions come from its host. Nothing in a handover is
  entitled to speak with that voice, and nothing a renderer writes should
  pretend to.

## The rule

> A rendered restore prompt MUST be assembled so that no content in the
> handover can be read as the prompt's own structure. A renderer MUST NOT
> produce a rendering in which a document's own text can create, close or
> impersonate a structural element of that rendering.

The rule is stated as the attack it prevents, not as a mechanism. Any assembly
that makes content unable to counterfeit structure satisfies it. An unforgeable
delimiter is one way to get there and it is the way the reference
implementations chose; it is a means, and it is not required by name.

Three obligations follow, and these do bind:

1. **Content is serialized or escaped into the rendering.** Placing a
   document's text into the output MUST be a defined transformation, not a
   concatenation. Whatever the transformation is, it MUST be total (defined for
   every input, including text that already looks escaped) and it MUST be
   reversible (a reader can recover the original bytes from the rendering by a
   stated rule). An escape that mangles some inputs, or that cannot be undone
   unambiguously, has replaced one confusion with another.
2. **Wherever the rendering separates parts with a text delimiter, that
   delimiter is unpredictable per render.** It MUST be derived from at least 128
   bits obtained from a cryptographically secure source at render time, it MUST
   be different for every render of the same document, and a renderer that
   cannot obtain such entropy MUST fail with a controlled error rather than
   render with a fixed or derived-from-content value. A predictable boundary is
   a forgeable boundary, and a forgeable boundary is worse than no boundary,
   because it looks exactly like a working one.
3. **The rendering states that the source material is data.** The prompt MUST
   say, before the first byte of handover content, that everything from the
   document is data rather than an instruction to the reader, and that a line
   inside the data resembling structure is still data. Where a delimiter is
   used, the prompt MUST also tell the reader how to recognise it, or the
   defence is invisible to the only party who could act on it.

A renderer MAY inject a fixed delimiter value in tests, so that golden outputs
stay stable. That injection point MUST NOT be reachable from a handover
document, from its content, or from any untrusted input.

## What the rendering has to carry

The rules above are about how content is placed. This section is about what is
placed, and it exists because a renderer can satisfy every rule above while
quietly dropping fields.

A field is not delivered until a reader sees it. Accepting a field, validating
it and storing it is three quarters of a feature and reads as a whole one, and
the quarter that is missing is invisible from the writing side: the writer's
own receipt shows what it sent. So the obligation is stated as a reachability
requirement rather than as a layout.

A conformant renderer MUST make every field below reachable by the reader of a
load, on the rendered prompt or on a surface the same command prints beside it:

| Field                                  | Why the reader needs it                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `title`                                | What the document is called. A reader asked to apply a handover should know which handover it is   |
| `source.client`, `.model`, `.provider` | What wrote it, which is what a reader weighs the whole document by                                 |
| `source.recipeVersion`                 | Which extraction text produced it, so a difference between two documents is attributable           |
| every `sections[*].provenance` label   | The format's only trust mechanism. A label that reaches no reader is a trust signal nobody can use |
| `sections[*].status`, told apart       | Four statuses are four answers. Three are kinds of nothing and they are not interchangeable        |
| `sections[*].summary` on a gap         | The short note saying what is gone and why, on a `missing` or a `blocked` section                  |
| `quality.missingInputs`                | What the capture knew it could not carry                                                           |
| `quality.contradictions`               | Statements in the project that conflict and were not resolved                                      |
| `safety.unsafeOmissions`               | What was withheld on purpose, so the omission is visible rather than silent                        |

Two consequences bind:

- **A renderer MUST NOT report a withheld section as an empty one.** `missing`
  says the extractor could not see it, so the reader should go and look.
  `blocked` says it exists and was withheld, so the reader should ask
  elsewhere. `not_applicable` says the project has no such subject, so the
  reader should stop looking. A rendering that shows all three as one gap gives
  the reader the wrong instruction two times out of three.
- **Where a field reaches the reader is a renderer's judgement, and its
  absence is not.** A rendering has finite attention to spend, and the
  reference implementations spend it differently per field: `provenance`
  travels grouped by label rather than as a line per section, and the recipe
  version reaches the rail card rather than the prompt. Either choice satisfies
  this section. Reaching nothing does not.

What is deliberately NOT required: `soilHandover`, which the parser has already
acted on; `handoverId`, an opaque identifier with no reader action attached; and
the inside of an observation's `data`, which is free-form and opaque to this
specification, so a renderer laying out a payload shape it has never seen would
be inventing one. A renderer SHOULD instead name the observation's `kind` and
`producedBy`, so a reader knows the evidence is there and who is answerable for
it.

## Consumer obligations

These bind on every implementation that renders a handover into a prompt, not
only on the reference ones. A defence that lives only in a reference
implementation is a defence that no independent implementation has, which is
the failure mode this section exists to close.

A conformant renderer:

1. MUST satisfy the rule above and its three obligations.
2. MUST apply the same treatment to every piece of handover-derived text it
   places in the output, including section summaries, the boot prompt, stated
   gaps, contradictions, safety omissions and any identifier or timestamp
   interpolated into a sentence. Content interpolated inside a line MUST NOT be
   able to end that line.
3. MUST NOT weaken the treatment for text it believes is trustworthy. There is
   no trusted section; a shared project surface is precisely the case where the
   writer and the reader are different people.
4. MUST NOT claim, in its documentation or its output, that this boundary
   prevents prompt injection. It prevents one specific confusion, stated in the
   next section.
5. SHOULD carry the adversarial fixtures in `conformance/fixtures/restore/` in
   its own test suite, and MUST report the same outcome on them: with the
   manifest's fixed boundary token, every line of the rendering that a reader
   could take for structure carries that render's delimiter, and every section's
   content is recoverable from the rendering by the renderer's stated rule.
6. MUST make every field named in "What the rendering has to carry" reachable
   by the reader of a load, and MUST NOT report a withheld section as an empty
   one. Where each field lands is the renderer's judgement; whether it lands
   anywhere is not.

## What this does not cover

Stated plainly, because a boundary described as complete is a boundary somebody
will lean on:

- **It does not prevent prompt injection.** A model willing to act on
  instructions it finds inside data will act on them when the data is correctly
  labelled as data. Delimiters remove the structural confusion; they do not
  supply the reader's judgement. Nothing in this document, and nothing in any
  known rendering, makes a handover safe to hand to a model with tools and no
  supervision.
- **It does not filter or rewrite content.** Instruction-shaped text travels,
  on purpose: "the founder said never deploy on a Friday" is a fact about the
  project and the format exists to carry it. The boundary changes how that text
  is framed, never whether it arrives.
- **It ends where the text is copied.** The delimiter is generated for one
  render. Once a user pastes the prompt into a session, quotes it back, or an
  intermediary reflows it, the guarantee is gone. A client that strips
  backslashes, renders markdown, or re-wraps long lines can undo the escaping,
  and this specification cannot reach those clients.
- **It says nothing about the host's own channel separation.** Where a host
  offers a real distinction between instructions and data, that distinction is
  stronger than any in-band marker and a renderer SHOULD use it in addition.
  This document describes what is possible when the only channel is characters.
- **It does not authenticate the handover.** A boundary tells a reader which
  bytes are data. It does not say who wrote them, and nothing in the 1.x line
  does; integrity and signing are collected in [profiles.md](profiles.md) as a
  future profile.

## Conformance

The fixtures are in `conformance/fixtures/restore/` and are registered in the
`restore` list of `conformance/fixtures/manifest.json`, together with the fixed
boundary token every runner injects. Each one is a valid document whose content
is written to be mistaken for structure:

| Fixture                            | What it plants                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `forged-delimiter.json`            | banner and heading lines spelled exactly as the reference rendering spells them                      |
| `instruction-shaped-content.json`  | an instruction override, a fake system turn, and a boot prompt asking for silent exfiltration        |
| `section-claims-the-boundary.json` | a section asserting that it is the trusted framing, naming the marker, plus a two-line stated gap    |
| `escaping-hazards.json`            | already-escaped lines, a lone backslash, indented and tab-led delimiters, and the marker named aloud |

The reference implementations are TypeScript, Python, Go, JVM and .NET, and all
five assemble the prompt the same way: `soil:` followed by 128 bits of
lowercase hex on every banner and every section heading, content escaped by
prefixing a backslash to any line that already begins with one, resembles a
delimiter, or contains the marker, and inline values escaped by doubling
backslashes and turning line breaks into two characters. That is one conformant
choice among many. What binds is the rule and the three obligations, and what is
tested is the outcome on the fixtures.

The reachability requirement is checked in the `restore` category too, on the
worked example and on `valid/blocked-and-safe.json`: the title reaches the
prompt, the client, the model, the provider and the recipe version say what
wrote the document, every provenance label the document carries arrives, a
withheld section is named as withheld rather than counted among the empty ones,
and the note a writer left on a withheld section travels. Every runner carries
those checks, because a field one implementation renders and another drops would
make the cross-language byte-identity claim false.

Where the reference implementations put each field, as one conformant answer
among many:

| Field                                  | Where a reader meets it                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `title`                                | the `THIS HANDOVER` block, and both rail cards                                    |
| `source.client`, `.model`, `.provider` | the `THIS HANDOVER` block, and the `written by` block on the cards                |
| `source.recipeVersion`                 | the same two places                                                               |
| `sections[*].provenance`               | `WHERE THE CLAIMS CAME FROM`, grouped by label; the cards name the labels present |
| the three kinds of gap, told apart     | `KNOWN GAPS`, on separate lines; the cards name them on separate rows             |
| the note on a gap section              | `KNOWN GAPS`, under the section it belongs to                                     |
| `quality.contradictions`               | `KNOWN GAPS`, and the save card                                                   |
| an observation's `kind`, `producedBy`  | the `evidence` and `recorded` rows on the cards                                   |
