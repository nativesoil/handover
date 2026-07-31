# The format, for humans

The normative version is in [`spec/`](../spec/README.md). This is the same thing
explained rather than specified.

## A handover is a file

```json
{
  "soilHandover": "1.0",
  "handoverId": "019f7ab8-3380-73f2-8ae7-c99b6d964841",
  "projectId": "orchard-checkout",
  "title": "Checkout rework: address step split, payment retry pending",
  "createdAt": "2026-07-19T14:12:00Z",
  "sections": { "...": "17 of these" },
  "quality": { "missingInputs": ["..."] },
  "safety": { "unsafeOmissions": ["..."] }
}
```

That is the whole document. One globally unique id, one project slug, one
title, one timestamp, 17 sections, and two small honesty records. It is JSON because JSON travels, and the
sections are prose because prose is what survives being pasted into a model that
has never heard of this schema.

## Identity is a UUID, the load code is a nickname

`handoverId` is the document's globally unique identity. The writer assigns it
at the moment the handover is stored, as a UUIDv7, and the model is never
asked to invent one. A copy keeps its id; a new capture of the same project
gets a new one; migration never changes it. The id is opaque: it carries no
meaning beyond identity, and nothing is ever derived from the content.

The load code (`#004`) is different: a short local handle one store hands out
so a human has something to type. Two machines can both have a `#001`. That
is fine, because identity does not live there.

## Why 17 sections

Because the alternative is a summary, and summaries tend to lose the same
things: the decision made three weeks ago, the approach already tried and
abandoned, the constraint nobody mentioned because everybody knew it. Named
sections mean those things have somewhere to go, and an empty section is
visible.

The 17 sit in three tiers with different half-lives:

**Durable.** `projectIdentity`, `decisions`, `workflow`, `architecture`,
`constraints`, `rejectedPaths`. These outlive the session. A decision locked in
March still binds in July, and this is the tier that stops the next model from
reopening it.

**Frontier.** `executiveSummary`, `currentTask`, `latestUserIntent`,
`sessionDelta`, `blockers`, `nextSteps`, `openQuestions`. These were true at the
capture. They are written in "at capture" language on purpose, so a reader in
August does not report July's status as today's.

**Meta.** `sessionActivity`, `restoreInstructions`, `provenanceMap`,
`safetySummary`. About the capture itself, including the boot prompt a load hands
to the next model first.

Section by section, with what belongs and what does not:
[spec/sections.md](../spec/sections.md).

## A section says whether it has anything

```json
{ "status": "available",      "summary": "prose", "provenance": ["repo_verified"] }
{ "status": "missing",        "summary": null }
{ "status": "blocked",        "summary": "Host names withheld. The shape is one writer with regional readers." }
{ "status": "not_applicable", "summary": "A one-author manuscript has no system to describe." }
```

All 17 keys are always present. A section with nothing in it says so rather than
disappearing, because a reader cannot tell an omitted section from an overlooked
one, and a gap you can see is worth more than a gap you cannot.

This is why an honest thin handover is a good handover. A thread that opened with
"save this" and contained no work should produce a document that says so, in 16
missing sections. Any format that made that embarrassing would be teaching models
to pad.

The three kinds of nothing are not interchangeable, and each one tells the next
session to do something different. `missing` says the extractor could not see it,
so go and look. `blocked` says the extractor had it and left it out on purpose,
so ask for it another way. `not_applicable` says this project has no such thing,
so stop looking.

That distinction has to survive the load, or it was never made. Both rail cards
name the three on separate rows, and the restore prompt lists them on separate
lines under `KNOWN GAPS`, with the short note the writer left on an empty or a
withheld section beside it. A rendering that shows all three as one gap gives
the reader the wrong instruction two times out of three, and
[spec/restore-prompt.md](../spec/restore-prompt.md) states that as an
obligation on any renderer, not only these ones.

That last one is the only status that carries an instruction to stop, so it is
the only gap status that has to say why: its `summary` is required and non-empty,
the same rule `available` lives under. Nothing honest is blocked by that. A
writer that cannot say why a section does not apply has not established that it
does not apply, only that it could not see it, and `missing` says exactly that
and asks for nothing.

`provenance` is optional and tells the reader what kind of claim it is looking
at: checked against the project, reported from the conversation, or inferred. The
eleven labels are fixed so they mean the same thing everywhere.

Because it is the format's only trust mechanism, it has to arrive. The restore
prompt carries the labels under `WHERE THE CLAIMS CAME FROM`, grouped by label
rather than listed per section: eleven lines at most whatever the document's
size, where a line per section would be seventeen lines of mostly repetition. It
also says the thing an absence would not: a section named under no label carries
none, which is not the same as a label saying it was checked. The rail cards name
the labels present, which is what fits in a column.

## The two honesty records

```json
"quality": {
  "missingInputs": ["Conversion numbers since Monday's deploy had not accumulated at capture."],
  "contradictions": ["The bundle ceiling is 180 KB in the notes and 'about 175' in an earlier conversation."]
},
"safety": {
  "unsafeOmissions": ["Payment provider API credentials exist and are set in the deployment platform. Values withheld."]
}
```

`quality.missingInputs` is what the extractor knows or suspects it could not
carry. `quality.contradictions` is where the project disagrees with itself and
nobody has settled it. `safety.unsafeOmissions` is what was withheld, one line
each, saying that the thing exists and where it is configured.

All three travel into the restore prompt. A stated gap is recoverable, because
the next session can ask. An unstated gap becomes a confident wrong answer.

## The safety rule, which is enforced

A handover carrying an API key is not a handover with a small problem. It is a
credential in transit: the document is written to be moved into a second model,
usually at a second vendor, sometimes into a teammate's session.

So a save is refused, fail closed, when any string anywhere in the document looks
like a credential or a private absolute path:

<!-- card: bound refused-secret -->

```
  ┌─ SOIL · refused · secret material ────────────────
  │
  │   conformance/fixtures/invalid/secret-provider-key.json
  │
  ├─ nothing was stored ──────────────────────────────
  │
  │   ✗ /sections/architecture/summary looks like it
  │     contains a provider API key or access-key id
  │     in a vendor format (provider_api_key).
  │     Remove the value: say that the thing exists
  │     and where it is configured, never what it
  │     is.
  │
  └─ remove the value, keep the meaning, then save again
```

Nothing is stored, and the message never repeats what it matched, because an
error message is another place a secret can end up.

The classes are listed in [spec/README.md](../spec/README.md#the-safety-rule)
and defined one by one, with the sentences each one must accept, in
[spec/safety-patterns.md](../spec/safety-patterns.md): vendor keys, JWTs,
bearer tokens, authorization headers carrying a credential, PEM private keys,
client secrets bound to a value, application-credentials material, credentials
inside a URL, and absolute paths under a home directory or a Windows drive
root.

What it refuses is a value, not a name. Naming a credential type, a header or
an environment variable is safe, and so is a published placeholder or a
sentence saying the value was left out. "The service uses an Authorization
header", "GOOGLE_APPLICATION_CREDENTIALS is set outside the handover" and "the
client_secret value was intentionally omitted" all stay valid, because the
format asks for exactly those sentences elsewhere. A redaction claim never
buys an exemption for material in the same sentence: the conjunction is
refused.

Two things it does not do. It does not stop a handover from talking about
secrets: "a provider API key exists and is set in the deployment platform" is
correct, useful, and stays valid. And it does not redact or partially store. It
refuses, and hands the problem back.

It is also a net rather than a guarantee. A secret with no recognisable shape
gets through, and no scanner catches those. The real defense is the extraction
recipe telling the model to carry the meaning and never the value; the scan is
what catches the day it does not listen.

## Extension point

`observations` is an optional array for evidence **about** the project or
**about** the capture: results from a real load, third-party annotations,
anything a producer wants to attach without the format having to grow a field
for it. `kind` and `data` are required, `producedBy` and `producedAt` are
optional, and no other keys are allowed on an entry. `data` is free-form.

A small standard vocabulary of kinds is defined in
[spec/observations.md](../spec/observations.md): `quality.capture` (a producer's
statement about what the capture carries), `load.outcome` (what one real load
into one target produced), and `working.style` (recorded instances of how the
project works). Two of the three have a producer in this repository;
`load.outcome` is the slot for evidence only a real load can produce, and
nothing here performs one. Either MCP save also takes observations of any
kind through its declared schema, and attributes them to the surface that
wrote the entry rather than repeating an attribution it cannot check. Here is
what a `load.outcome` looks like in a document, written by a producer that
does:

```json
"observations": [
  {
    "kind": "load.outcome",
    "producedBy": "example-runner 0.9",
    "producedAt": "2026-07-21T08:30:00Z",
    "data": {
      "target": { "client": "example-editor", "model": "example-model" },
      "recorded": [
        {
          "asked": "Which decision governs the pause state?",
          "answered": "Pause stays first-class; collapsing it caused double charges in 2024."
        }
      ]
    }
  }
]
```

A kind is a label on a container: it says what the entry claims to be, so a
reader knows how to show it. It does not make the claim true, and the
specification says nothing about how any evidence is produced. Kinds outside
the registry should use a reverse-DNS namespace (`com.example.thing`).

Four rules make it safe to rely on:

1. It is optional. A handover with no observations is complete, and a tool that
   never reads one is fully conformant.
2. A reader ignores kinds it does not recognise, and carries them forward
   unchanged rather than dropping them. That is what makes an old reader safe to
   point at a new producer's output.
3. Observations never change how the 17 sections are read. The sections are the
   handover, and nothing in `observations` is ever shown as a grade of it.
4. The safety rule applies inside `data`. A secret there refuses the whole
   document, exactly as it would in a section.

## Loose input, strict storage

Models write JSON by hand under pressure. They wrap it in prose, use the key
`extractionSections` instead of `sections`, write a section as a bare string, or
skip sections they had nothing for.

None of that costs you the capture. Normalization pulls the JSON out of the
reply, accepts the loose shapes, and turns a section nobody wrote into a
declared `missing`. What it will not do is invent content, guess a project id,
supply a capture time the document never carried, or attribute its own recipe
to somebody else's output.

Neither will it delete. A member it cannot rewrite is carried through exactly as
written, so validation reports it at the path it occupies rather than a save
quietly stripping it: a save and a validation of the same bytes give the same
answer. Every rewrite it does perform is enumerated in
[spec/normalization-profile.md](../spec/normalization-profile.md), which no
implementation is required to adopt.

Observations are the exception: they pass through untouched. They come from
tools rather than from a model writing under pressure, so a malformed one is
reported rather than quietly patched.

Then validation is strict, and what gets stored is a spec-clean document.

## Versioning

`soilHandover` is `MAJOR.MINOR`, and version one is a CLOSED world: the
top-level field set, the section field set and the eleven provenance labels are
fixed, and a reader refuses anything outside them. Adding to any of the three
takes a major version. The one extension point is `observations`, whose `kind`
is an open namespaced string.

A reader supports exact versions. It refuses a document whose declared version
it does not implement, and never infers support from the shape of the version
string: today the supported set is exactly `1.0`. There is no "any 1.x is fine"
rule, because "1.x" describes a line rather than an implementation, and a
reader that accepted `1.4` would be claiming to implement a version nobody has
written. Backward compatibility is still required: a later reader accepts every
valid earlier document in the line, and lists every earlier version in the set
it supports.

The full policy, including what is frozen for the whole 1.x line and the two
rules that bind normalization, is in
[spec/versioning.md](../spec/versioning.md).
