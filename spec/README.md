# The Soil Handover Specification, version 1.0

Status: stable for the 1.x line. Changes follow [versioning.md](versioning.md).

A **handover** is a portable capture of a project's working state. It is written
by a model at the end of a session and read by a different model at the start of
the next one, usually in a different tool, often from a different vendor. It has
to survive that trip on its own.

This document defines what a handover is. The machine-readable statement of the
same thing is [handover.schema.json](handover.schema.json). The section-by-section
detail is [sections.md](sections.md). The standard observation kinds are in
[observations.md](observations.md). What the safety rule detects, class by
class, is in [safety-patterns.md](safety-patterns.md). The rules that bind
before a document is a value at all, on the serialized bytes, are in
[ingestion.md](ingestion.md). What a handover may hold once a token is a
number, and the unit every length bound is counted in, are in
[value-domain.md](value-domain.md). The rules that bind on the way back out, when a
handover is rendered into text a model will read as a prompt, are in
[restore-prompt.md](restore-prompt.md). What a version means, and what a reader
may assume about one, is in [versioning.md](versioning.md).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Why a fixed format at all

Every AI tool loses its context at a boundary: a thread fills up, a session ends,
you move from a chat to an editor, a model is deprecated, a teammate takes over.
The work does not change at that boundary, but everything the assistant knew
about the work disappears, and the next session starts by rediscovering, and
often relitigating, what was already settled.

A summary does not survive this. A summary can preserve the recent narrative
while omitting older decisions, their reasons and the approaches already
rejected, which is exactly backwards: a decision locked three weeks ago binds
just as hard as one locked this morning, and it is the older one the next model
will quietly reopen.

So the format is not a free-form blob. It is 17 named sections, chosen so that
the things that actually get lost each have somewhere to go and cannot be
summarised away into a paragraph about how things are going well.

## Principles

1. **Self-sufficiency.** A handover assumes its reader has nothing else: no repo,
   no docs, no links, no earlier thread, no shared memory. If content would have
   to be fetched, it is inlined instead.
2. **Declared gaps.** All 17 sections are present in every handover. A section
   with nothing in it says so, and says which kind of nothing: unseen, withheld,
   or genuinely absent from this project. Silence is not a gap report, and a gap
   the reader can see is recoverable in a way that a gap it cannot see is not.
3. **Meaning, not values.** A handover carries what a secret is for and where it
   is configured. It never carries the secret. This one is enforced, not
   suggested: see the safety rule below.
4. **Anchored time.** Durable sections state what still holds. Frontier sections
   state what was true at the capture, in those words, so a later reader does not
   promote stale state into its own present.
5. **Prose over structure.** Sections are prose, because prose is what survives
   being pasted into a model that has never seen this schema. The structure is
   there so nothing goes missing, not so machines can parse the content.
6. **No grade.** Nothing in this specification scores a handover. A capture is
   described by what it carries and what it states it could not carry, and the
   counts that describe it report structural presence, never sufficiency.

## The document

```json
{
  "soilHandover": "1.0",
  "handoverId": "019f7ab8-3380-73f2-8ae7-c99b6d964841",
  "projectId": "orchard-checkout",
  "title": "Checkout rework: address step split, payment retry pending",
  "createdAt": "2026-07-19T14:12:00Z",
  "source": {
    "client": "claude-code",
    "model": "opus-4.8",
    "provider": "anthropic"
  },
  "sections": {
    "projectIdentity": {
      "status": "available",
      "summary": "...",
      "provenance": ["model_reported"]
    },
    "decisions": { "status": "available", "summary": "..." },
    "...": "all 17 keys, always",
    "safetySummary": { "status": "missing", "summary": null }
  },
  "quality": { "missingInputs": ["..."], "contradictions": ["..."] },
  "safety": { "unsafeOmissions": ["..."] },
  "code": "#004"
}
```

| Field          | Required | What it is                                                             |
| -------------- | -------- | ---------------------------------------------------------------------- |
| `soilHandover` | yes      | The format version. Exactly `1.0` today.                               |
| `handoverId`   | yes      | The globally unique id, a UUID. Assigned by the writer at store time.  |
| `projectId`    | yes      | A short stable slug. Handovers of one project share it.                |
| `title`        | yes      | A short human title for this capture.                                  |
| `createdAt`    | yes      | ISO 8601 with `Z` or an offset. The anchor for every frontier section. |
| `source`       | no       | Which client, model, provider and recipe version wrote it.             |
| `sections`     | yes      | All 17 sections, each declared.                                        |
| `quality`      | no       | The extractor's stated gaps and unresolved contradictions.             |
| `safety`       | no       | What was deliberately withheld, one line each.                         |
| `observations` | no       | Attached evidence. The extension point, described below.               |
| `code`         | no       | A local address such as `#004`, written by a store, never by a model.  |

### Identity

`handoverId` is the handover's globally unique identity, assigned by the
writer at the moment the handover is stored. The official writers emit a
UUIDv7 (RFC 9562). The extraction recipe never asks the model to invent an
id, because an id a model makes up is an id two documents can share: a
document that arrives from a model without one is given one by the writer
that stores it, and a document that claims validity without one is invalid.

The semantics are small and strict:

- A copy of a handover, byte for byte, keeps its `handoverId`.
- A new capture gets a new id, even a capture of the same project a minute
  later. Identity belongs to the document, not to the project.
- Migration never changes it. Converting a document to a newer format
  produces a document with the same `handoverId`, and so does rebuilding a
  store's index around it.
- The id is opaque. It is never derived from the content, never reused, and
  carries no meaning beyond identity. The timestamp inside a UUIDv7 is an
  implementation detail of how uniqueness is generated, never a fact a reader
  may lean on.

The local `code` (`#004`) is not identity. It is a short human handle one
store assigned for typing, and two stores may both hold a `#001` without any
collision, because identity lives in `handoverId`.

### The recipe version

A handover is produced by a model following an extraction recipe, and the
recipe improves on its own schedule. `source.recipeVersion` records which
recipe version produced a document, as a semver string such as `1.0.0`.

Only a writer that actually produced the document from a recipe may set it. A
tool that is handed a finished document by somebody else MUST NOT stamp its own
recipe version into it: the field's only use is telling recipe-produced output
apart from anything else, and a tool that fills it in for every document it
touches destroys exactly that. Documents produced by other writers may lack it
and remain valid, which is the case the rule protects.

That rule leaves one party able to state the field honestly, and it is the model
following the recipe, because the model is the only one that observed which
recipe it was given. The reference recipes therefore print their own version on
their first line and ask the model to copy it back, so what lands in the document
is something the writer of that document actually read rather than something a
later tool assumed. A recipe that does not state its version gets no claim: the
reference recipe tells the model to leave `source` out entirely in that case.

The format version and the recipe version move independently: improving the
recipe never moves the format version. The canonical recipe texts live in
`recipes/` at the repo root, and the conformance suite holds every embedded copy
to byte identity with them.

### A section

```json
{ "status": "available", "summary": "prose", "provenance": ["repo_verified"] }
```

`status` is one of four words and no others:

- `available`: the content is here. `summary` MUST be a non-empty string.
- `missing`: the extractor could not see it. `summary` is `null`, or a short note.
- `blocked`: it was withheld for safety. `summary` says what is gone and why, in
  terms that do not reproduce the thing being withheld.
- `not_applicable`: the section genuinely has no subject in this project. `summary`
  MUST be a non-empty string saying why.

The last three are not interchangeable, and the difference is the whole reason
there are three of them. `missing` says the extractor failed to see something
that may well exist, so the next session should go and look. `blocked` says the
thing exists and is deliberately not travelling, so the next session should ask
for it through another channel. `not_applicable` says there is nothing there to
find, so the next session should stop looking. Collapsing them loses the only
instruction a gap can carry.

`not_applicable` MUST carry a reason, on the same terms as `available`, and this
is the one place the format asks prose of a section that holds no project
content. The rule follows from what the status is: it is a positive assertion
about the project, not a gap report, and every positive assertion in this format
carries its reason. It is also the only status that tells the next model to stop
looking, and a wrong instruction to stop looking, with no reason attached, is the
most expensive thin section a handover can contain.

The argument against the requirement is recorded here because it was a good one
and because a rule whose losing argument is not written down gets relitigated.
It ran: the other two gap statuses may say nothing, so a required reason makes
the fourth behave unlike its siblings; and a hard validation failure on a
missing reason is exactly the pattern that turns an honesty signal into a
save-blocking error, which pressures a writer into hiding the very distinction
the status exists to make.

What answers it is that the requirement blocks no honest save. A writer that
cannot say why a section does not apply has not established that it does not
apply. It has established that it could not see it, and `missing` says exactly
that, carries no such requirement, and stays free. So the rule does not refuse
an honest claim; it ROUTES an unjustified one to the status that is true. That
is why the objection does not carry, and it is also the boundary the rule must
never be pushed past: the moment a requirement of this kind leaves a writer with
no honest place to go, it has become the failure the objection describes.

`provenance` is optional, and its labels let a reader tell a check from a report
from a guess: `repo_verified`, `soil_observed`, `prompt_report`,
`user_locked_memory`, `model_reported`, `inferred`, `owner_observed`,
`live_verified`, `emulator_verified`, `planned_only`, `blocked`. The set is
closed and frozen for the whole 1.x line, so a label means the same thing in
every implementation. A label outside it is refused, and adding one requires a
major version. That cost is deliberate: provenance is the format's only trust
mechanism, and a label two implementations disagree about is worse than no
label. Evidence that needs a vocabulary this set does not have travels as an
observation instead.

`status`, `provenance` and `summary` are the only three fields a section may
carry. A fourth field is refused.

## Observations: the extension point

```json
"observations": [
  {
    "kind": "com.example.something",
    "producedBy": "example-tool 2.1",
    "producedAt": "2026-07-19T14:20:00Z",
    "data": { "anything": "the producer wants" }
  }
]
```

`observations` is an optional array where evidence **about** the project or
**about** the capture can travel with the handover. `kind` and `data` are
required; `producedBy` and `producedAt` are optional; no other keys are allowed
on an entry. `data` is a free-form object.

What it is for: results from a real load, third-party annotations, situational
evidence, anything a producer wants to attach without waiting for the format to
grow a field for it. A small standard vocabulary of kinds, with what each one
claims to be and how a reader treats it, is defined in
[observations.md](observations.md). Kinds outside that registry SHOULD use a
reverse-DNS namespace so two producers do not collide.

What this specification says about how the contents are produced: nothing. It
does not define how an observation is produced, how it is scored, weighted,
aggregated or interpreted. Those are implementation and service concerns, and
they are deliberately outside the format so the format does not have to change
every time somebody has a new idea about evidence. The standard kinds define
what an entry claims to be, never how it is made.

The rules that do bind:

1. Observations are OPTIONAL. An implementation that never emits or reads one is
   fully conformant, and a handover with no observations is complete.
2. A reader MUST ignore an entry whose `kind` it does not recognise, and MUST NOT
   treat it as an error. Forward compatibility is the point: a document written
   by a newer producer stays readable by an older reader.
3. A reader SHOULD carry unrecognised entries forward unchanged rather than drop
   them, so passing a handover through a tool does not quietly delete evidence.
4. Observations MUST NOT change how the 17 sections are read. The sections are
   the handover. An observation that contradicts a section does not override it.
5. The safety rule applies inside `data` exactly as it does everywhere else. The
   secret scan MUST cover observations, and a secret in `data` refuses the whole
   document.

## Normative requirements

A conformant implementation:

1. MUST accept every document in `conformance/fixtures/valid` and reject every
   document in `conformance/fixtures/invalid`.
2. MUST require a `handoverId` on a document claiming validity, MUST reject one
   that is not a UUID rather than replace it, and, when storing, MUST assign a
   fresh id to a document that arrives without one and keep the id of a
   document that already carries one.
3. MUST require all 17 section keys, and MUST reject a section key outside the 17.
4. MUST reject a `status` outside the four allowed values and a `provenance`
   label outside the eleven. Rejection is the only allowed response: an
   unrecognised status, including one that differs only in capitalisation and
   one that is a near neighbour of a real value such as `notApplicable` or
   `n/a`, MUST NOT be silently rewritten to a recognised one, because a
   rewritten status makes a claim about the section that nobody wrote.
5. MUST reject `status: "available"` with an empty or absent `summary`, and
   MUST reject `status: "not_applicable"` with an empty or absent `summary`.
   A section that claims to carry content must carry content, and a section
   that claims the project has no such thing must say why.
6. MUST reject an unknown top-level field and an unknown field on a section.
   Version one is a closed world: the field sets are fixed, and adding to
   either requires a major version. There is deliberately no field for a
   score, and an implementation that adds one is not producing this format.
   The one extension point is `observations`, whose `kind` is open.
7. MUST refuse a document whose declared format version it does not explicitly
   support, rather than guess at what changed. Support is a set of exact
   versions, not a pattern: today that set is exactly `1.0`. A reader that
   accepts an unimplemented minor because the string starts with `1.` is
   claiming to implement a version nobody has written. See
   [versioning.md](versioning.md).
8. **MUST reject a handover that contains secrets or private absolute paths**, and
   MUST store nothing when it does, including inside `observations[].data`. See
   the safety rule below.
9. MUST accept a handover carrying `observations` with kinds it does not
   recognise, and MUST NOT let an unknown kind change how the sections are read.
10. MUST NOT describe a handover as checked, graded or scored on the basis of
    anything in this specification, because nothing here checks content.
11. SHOULD report how many sections carry content when it saves one, because
    that is the honest thing a local tool can say.
12. MUST apply the ingestion boundary in [ingestion.md](ingestion.md) before
    any other layer sees a serialized handover: UTF-8 with no byte order mark
    and no silent conversion, no duplicate member name inside one object, and
    no nesting deeper than 32 levels, each refused with the stated error code
    rather than repaired, guessed at, or left to a stack overflow.
13. MUST NOT present a section count as completeness, sufficiency, readiness
    or successful continuation. Section counts report structural content
    presence only: a section holds a non-empty summary, or it does not. A
    document whose every section holds two characters counts as 17 of 17. An
    implementation that displays such a count MUST make clear that it reports
    structural content presence, and MUST NOT label it with a word asserting
    completeness, capture, readiness or sufficiency.
14. MUST apply the restore-prompt boundary in
    [restore-prompt.md](restore-prompt.md) if it renders a handover into text
    that a model reads as a prompt: content is escaped or serialized into the
    rendering rather than concatenated into it, any text delimiter separating
    the parts is unpredictable per render, and the rendering states that the
    handover is data. A renderer MUST NOT let a document's own text create,
    close or impersonate a structural element of the rendering, and MUST NOT
    describe the result as preventing prompt injection, which it does not.
15. MUST NOT delete content in order to accept a document. An implementation
    that accepts loose input and rewrites it into canonical shape MUST carry an
    unknown top-level field, an unknown field on a section, an unknown section
    key and an unrecognised provenance label through to validation, so a save
    path and a validation of the same bytes give the same verdict. The
    permitted rewrites of the reference implementations are enumerated in
    [normalization-profile.md](normalization-profile.md), which no
    implementation has to adopt.
16. MUST apply the value domain in [value-domain.md](value-domain.md): a
    number in a handover is an integer, written in the integer form, between
    -9007199254740991 and 9007199254740991, judged from the token text at the
    ingestion boundary before any conversion; and every length bound in this
    format is counted in Unicode code points, never in UTF-16 code units,
    bytes or grapheme clusters. Both exist because the five official
    implementations gave different answers for the same document and neither
    difference announced itself: a parser rounds an oversized integer in
    silence, and a bound counted in the local string type accepts a title in
    one language that it refuses in another.
17. MUST NOT invent the facts a reader depends on. Specifically: it MUST NOT
    change a document's declared format version, MUST NOT supply a `createdAt`
    a document does not carry, and MUST NOT write `source.recipeVersion` into a
    document it did not itself produce from that recipe. A document with no
    `createdAt` is invalid and is refused, not completed: the field is the
    anchor every frontier section is read against, and a wall-clock value
    stamped in at save time is indistinguishable to a consumer from a real one.

The reference implementations satisfy requirement 13 with the fixed wording
`sections carrying content`. That exact English is not normative: a third-party
interface may say it in its own words, in its own language, or with its own
affordance. What binds is the meaning, and that a reader cannot come away with
"17 of 17" as a statement that the handover is complete or ready.

## The safety rule

> A conformant implementation MUST reject a handover containing secrets or
> private absolute paths, and MUST fail closed: nothing is stored, and the
> reported error names the section and the class of material, never the value.

A handover is written to be moved. It goes into a second model, usually at a
second vendor, sometimes into a teammate's session. Anything inside it has
already left the machine it was written on. A document carrying an API key is
therefore not a handover with a small problem, it is a credential in transit.

The rule lives here and not in the JSON Schema because JSON Schema cannot express
"this string looks like a token". An implementation that only validates against
the schema is not conformant, which the conformance suite checks directly: the
secret fixtures are accepted by the schema and MUST be rejected by the
implementation.

What the rule refuses is a value, not a name:

> Naming a credential type, header or environment variable without including
> transferable authentication material MUST NOT by itself cause rejection.
> Published placeholders and explicit statements that a value was omitted or
> redacted MUST also be accepted.
>
> Implementations MUST reject high-confidence transferable authentication
> material regardless of whether it appears in an assignment, a URL, a header,
> a code block or unstructured text. The normative detection classes and
> required safe near-neighbours are defined in
> [safety-patterns.md](safety-patterns.md). That document states each class by
> what it detects and gives the fixtures that fix its boundary. An
> implementation MAY detect a class by any means that produces the required
> results for those fixtures.

At minimum an implementation MUST detect, in any string anywhere in the document:

| Class                            | What it catches                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `provider_api_key`               | vendor token formats on sight: `sk-`, `ghp_`, `github_pat_`, `AKIA`, `xox…-`, `AIza` |
| `jwt`                            | three base64url segments, the shape of a session token                               |
| `bearer_token`                   | `Bearer` followed by token material                                                  |
| `authorization_header`           | an `Authorization:` header with a credential bound to it                             |
| `private_key_pem`                | `BEGIN PRIVATE KEY` and its variants                                                 |
| `client_secret`                  | a client secret with a value bound to it                                             |
| `google_application_credentials` | application-credentials material bound to a value                                    |
| `private_path`                   | absolute paths under a home directory or a Windows drive root                        |
| `url_credentials`                | credentials in a URL's userinfo, `scheme://user:password@host`                       |

The classes are normative and the fixtures are minimum cases. An implementation
does not become conformant by recognising only the published test strings, and
the regular expressions in the official implementations are not part of the
contract. Parity between implementations is parity of OUTCOMES: the same
verdict, with the same class name, never the same algorithm.

A redaction claim never suppresses a detection. Text saying a value was
redacted, withheld, omitted or masked MUST NOT excuse material found in the
same string; the conjunction is refused under the detected class.
[safety-patterns.md](safety-patterns.md) states the precedence rule, the
reserved principal names documentation may use in home paths, and the residual
limitation of every class.

This is a net, not a guarantee. A secret with no recognisable shape passes, and
no scanner catches those. The real defense is in the extraction recipe, which
tells the model to carry the meaning and never the value; the scan is what
catches the day it does not listen.

Two things the rule does not do. It does not stop a handover from _talking_ about
secrets: "a provider API key exists and is set in the deployment platform" is
correct and stays valid, and is exactly what the format wants. And it does not
redact, rewrite or partially store. It refuses.

## What is not in this specification

This specification covers capturing a handover and carrying it. It does not cover
judging one. There is no notion here of a handover being good, complete, or
better than another, and no field to record such a judgement.

That is a decision about the format, not a gap waiting to be filled by a
`quality` score. Whether a handover actually restored a session is a real
question, and a document cannot answer it about itself; only a real load can.
When such evidence exists, the place for it is `observations`, whose standard
kind `load.outcome` ([observations.md](observations.md)) is shaped for
exactly that. The specification still says nothing about how such evidence is
produced.

An implementation may analyse a document and report on it in its own output,
as the official CLI's save-time checking does. The document itself never
carries a grade, score or quality field.

## Serialization

JSON is normative. A Soil handover is interchanged as a single UTF-8 JSON
document validating against `handover.schema.json`. Other encodings (compact
binary, RPC, analytics formats) may exist as DERIVED transport or storage
forms, but the JSON document is the single source of truth, and a conformant
implementation must be able to produce and consume it.

The rules that bind on the BYTES, before a document is a value, are stated in
[ingestion.md](ingestion.md): the encoding rule, the duplicate-member rule and
the nesting ceiling. They live there and not in the JSON Schema for the same
reason the safety rule does: a schema validator is handed an
already-constructed value, so by the time it runs, the byte order mark has been
stripped, the repeated member has collapsed to one, and the recursion that a
deep document would break has already happened. An implementation that only
validates against the schema is not conformant.

Media type: `application/vnd.soil.handover+json` (registration pending; use
this identifier in `Content-Type`/`datacontenttype` fields today).

## Conformance classes

There are two claims an implementation can make, and they are different:

**Soil Document Conformant.** The documents it produces and consumes follow
this specification: the schema, the section semantics, the versioning rules.
This is a claim about DOCUMENTS.

**Soil Secure Writer Conformant.** The implementation additionally runs the
defined safety pipeline before writing: it scans for credential-shaped material
and private absolute paths and refuses to store a handover that carries them,
storing nothing. This is a claim about BEHAVIOUR, proven by the safety fixtures
in the conformance suite (documents that MUST be refused).

The distinction matters because a format cannot police its own instances: a
document written by an arbitrary tool can be fully schema-valid and still
contain a secret. The honest statements are "the official writer scans and
blocks detected secrets before writing", and never "a Soil document cannot
contain secrets". Conformance for writers is tested on observable behaviour
(the same inputs refused, the same category reported), not on any particular
internal implementation.

A conformant reader may accept only canonical documents. Input that has to be
normalized before it validates is not itself a valid handover, and an
implementation that never accepts loose input at all is fully conformant. The
rewrites the reference implementations do perform are stated in
[normalization-profile.md](normalization-profile.md), which is normative for an
implementation claiming that profile and required by nothing else here.

Planned future profiles (artifact references, events, integrity and signing,
observability) are collected in [profiles.md](profiles.md), which is
NON-NORMATIVE: nothing there is required for conformance with this version.

## Licence

This document and the files beside it are published under the Apache License
2.0, the same licence as the rest of the repository they live in. The full
text is in [LICENSE](../LICENSE).

Two things worth knowing before implementing from this document. Apache 2.0
carries a patent grant from each contributor, in its section 3, covering that
contributor's own contributions to this work. It grants no trademark rights,
in its section 6: the licence lets you implement the format and says nothing
about what you may call the result.

An independent implementation needs no permission beyond that licence. The
licence does not confer a conformance claim either — that rests on the
evidence, in the two classes described above.
