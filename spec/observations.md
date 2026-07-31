# Standard observation kinds

Status: normative. Registry version 1, for the 1.x line of the
[Soil Handover Specification](README.md). Changes follow
[versioning.md](versioning.md): kinds are added, never renamed or removed,
within a major line.

For the plain-language overview of what observations are for and how a
reader should think about them, start with
[docs/concepts.md](../docs/concepts.md). This document is the normative
registry.

The `observations` envelope, `kind` and `data` required, `producedBy` and
`producedAt` optional, is defined in
[README.md](README.md#observations-the-extension-point). This document is the
registry of standard `kind` identifiers: what an entry with each kind claims
to be, what its `producedBy` means, and what its `data` is meant to hold.

## What a kind is

A kind is a label on a container. It tells a reader what the entry CLAIMS to
be, so evidence from different producers can be recognised, carried and shown
without coordination. A kind does not make the claim true: everything inside
`data` is a statement by the producer named in `producedBy`, and what the
statement is worth depends on who produced it, which is exactly what the
label is for.

This registry deliberately says nothing about how any evidence is produced,
selected or interpreted. An implementation that emits these kinds decides for
itself how it arrives at the contents; the format defines only what the
container means. Nothing here requires any implementation to emit or
understand any kind.

## Rules for readers

These bind any implementation that displays or processes observations:

1. Standard kinds are OPTIONAL. An implementation that never emits or reads
   one is fully conformant, and a handover carrying none is complete.
2. A reader that shows an observation MUST present it as evidence attached to
   the handover, and MUST NOT present any observation, alone or aggregated,
   as a grade or score of the handover. The format has no grade, and a
   display that turns evidence into one is not displaying this format.
3. A kind outside this registry is not an error. Unknown kinds are ignored
   and carried forward unchanged, exactly as
   [README.md](README.md#observations-the-extension-point) requires.
4. No observation changes how the 17 sections are read. Where an entry
   contradicts a section, the section wins.
5. The safety rule applies inside `data`. A secret there refuses the whole
   document.

Kinds outside this registry SHOULD use a reverse-DNS namespace
(`com.example.thing`), so they can never collide with a future standard kind.
Identifiers of the short dotted shape used below are reserved for this
registry.

## The registry, version 1

Three kinds.

### `quality.capture`

**What it claims to be.** An examination of the capture as a document, made at
or after save time: which sections carry content, which were declared missing
or blocked, and anything else the producer noted about the capture itself. It
is evidence about the capture, not about the project.

**`producedBy`.** The tool that examined the capture, named specifically
enough to weigh the claim, with a version: `example-checker 1.4`. An entry
produced by the same model that wrote the handover is a self-report, and the
label is what lets a reader see that.

**`data`.** Free-form, like every observation payload, but this kind has a
documented closed field set. A producer emitting `quality.capture` SHOULD emit
exactly these six fields and nothing else:

| Field                 | What it holds                                         |
| --------------------- | ----------------------------------------------------- |
| `sectionsWithContent` | how many of the 17 sections carry content             |
| `missingSections`     | the section keys with `status: "missing"`             |
| `blockedSections`     | the section keys with `status: "blocked"`             |
| `findings`            | this producer's individual rule outcomes              |
| `checkVersion`        | the version of the rule set that produced them        |
| `notes`               | short non-evaluative context, at most 280 code points |

These fields do not partition the 17 sections, and a reader MUST NOT read them
as if they did: `sectionsWithContent`, `missingSections` and `blockedSections`
enumerate what is absent and RETRIEVABLE, not everything that is not present as
content. A section declared `not_applicable` appears in none of them, on
purpose. It is not a gap. There is nothing to go and get, so listing it beside
the gaps would invite a reader to chase something that does not exist, which is
the opposite of what that status says. The arithmetic therefore does not close,
and a producer MUST NOT add a field to make it close.

Each entry in `findings` carries a rule identifier, a location, the observed
condition, and, where the producing rule defines one, a rule-local severity.
Severity classifies that one rule outcome. It is never a judgement of the
handover, and a reader MUST NOT present it as one.

`notes` is context, not a verdict: how the examination was made, what it did
not look at, which corpus the rules came from. Its bound is counted in the unit
every length bound in this format is counted in, the Unicode code point; see
[value-domain.md](value-domain.md). It MUST NOT carry an aggregate,
band, score or overall assessment in prose. The length bound is there so it
cannot quietly become the field the removed grade moved into.

A `quality.capture` payload MUST NOT carry a grade, band, score, rating,
pass mark or any other aggregate of its own findings, under any key. Rule 2
above forbids a reader from presenting an observation as a grade; this
forbids a producer from shipping one.

```json
{
  "kind": "quality.capture",
  "producedBy": "example-checker 1.4",
  "producedAt": "2026-07-19T14:15:00Z",
  "data": {
    "checkVersion": "1.0.0",
    "sectionsWithContent": 15,
    "missingSections": ["rejectedPaths", "openQuestions"],
    "blockedSections": [],
    "findings": [
      {
        "rule": "completeness.missing-without-reason",
        "location": "/sections/openQuestions",
        "observed": "declared missing, with no note here and nothing in quality.missingInputs saying why",
        "severity": "caution"
      }
    ],
    "notes": "Structural examination only. Nothing here was loaded into a model."
  }
}
```

**On derivability, stated plainly.** Removing the band does not make it
underivable, and saying otherwise would be its own dishonesty. Anyone holding
this payload and a producer's published threshold function can count the
severities and recompute the band exactly. What changes is who performs that
derivation and whether the threshold is visible while they do: a reader who
chooses to grade sees the rule that turns counts into a word, instead of
meeting a finished verdict from a producer they never met, carried inside the
document it judges.

**How readers treat it.** Show what it says: a statement about what the
capture carries, from a named producer. Never a score of the handover.

### `load.outcome`

**What it claims to be.** Evidence from one actual load: this handover was
loaded into a target session, and the producer recorded what came of it, such
as what the target model could state about the project, what it answered, or
how it continued. When a producer has results from a real load, this is the
kind they ride in.

**`producedBy`.** The tool that performed or observed the load. A load
happens after the capture, so an entry of this kind is normally attached to
the document later, which is what `producedAt` is for.

**`data`.** The documented intent is the target of the load, when it
happened, and the recorded outcomes in the producer's own terms:

```json
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
    ],
    "notes": "The target restated the locked decisions unprompted."
  }
}
```

**How readers treat it.** A record of one load into one target, shown as
history. It does not claim the next load will behave the same, and it is
never a grade of the handover.

### `working.style`

**What it claims to be.** Recorded instances of how the project actually
works: concrete situational answers or preferences captured at save time, in
the project's own terms. It complements the `workflow` section rather than
repeating it: the section is the extractor's prose account of how work runs,
and a `working.style` entry carries specific recorded instances as evidence
alongside it.

**`producedBy`.** The tool that recorded the instances.

**`data`.** The documented intent is an array of instances, each pairing a
situation with the response the project's way of working calls for:

```json
{
  "kind": "working.style",
  "producedBy": "example-recorder 2.0",
  "producedAt": "2026-07-19T14:14:00Z",
  "data": {
    "instances": [
      {
        "situation": "A change would remove part of an existing UI",
        "response": "Confirm the exact boundary with the owner before removing anything"
      }
    ]
  }
}
```

**How readers treat it.** Recorded statements about the project's way of
working, from a named producer. They are evidence, not policy: where an
instance disagrees with the `workflow` section, the section wins.

## What this registry does not define

How evidence is produced. Nothing here says how a producer arrives at a
`quality.capture`, runs the load behind a `load.outcome`, or records a
`working.style` instance. Those are implementation and service concerns, and
they are deliberately outside the format, so the format does not change every
time somebody improves their production of evidence.

The registry defines containers so that whatever evidence exists can travel
and be shown honestly. It defines no thresholds, no weighting, no aggregation
and no pass mark, and an implementation that derives a grade from these
entries is going beyond anything this specification supports.

## Versioning

This is registry version 1, with three kinds. Adding a kind is a minor,
additive change under [versioning.md](versioning.md); renaming or removing
one is not allowed within a major line. A reader built before a kind existed
treats it as unknown, which the rules above already make safe.
