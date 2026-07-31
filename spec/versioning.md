# Versioning and migration

The version lives in the document, in `soilHandover`, as `MAJOR.MINOR`. The
current version is **1.0**, and it is the only version defined so far.

A handover is a message from one session to another, and the gap between them can
be a year. The format has to be readable by tools written before it and after it,
so the rules below are about what a reader may assume, not just about what a
writer may emit.

## Version one is a closed world

This is the decision every other rule here follows from. A handover document is
CLOSED: the set of top-level fields, the set of fields on a section and the set
of provenance labels are fixed, and a reader refuses a document carrying
anything outside them.

- An unknown top-level field is refused.
- An unknown field on a section is refused.
- A provenance label outside the eleven is refused.
- A section key outside the seventeen is refused.
- A `status` outside the four is refused.

None of those can be added in a 1.x release. Each of them requires a MAJOR
version, because each of them changes what a document may contain, and a reader
that quietly accepted one would be reading a document it does not understand.

![The closed world. A major version is required for a new top-level field, a new field on a section, a new section key or a rename or a reorder, a fifth section status, a twelfth provenance label, a change to what an existing field means, or making an optional field required. A minor release, which still moves the document's version, covers raising a bound. Nothing moves the document's version for a new observation kind, for wording in the extraction recipe, for a new implementation release, or for editorial specification work. Backward compatibility is required and forward compatibility is none: an earlier reader refuses a later document on the version, before shape.](../docs/diagrams/closed-world.svg)

The three groups a change can fall into, and the one that costs a 2.0. An
adopter who reads only one thing on this page should read this.

### What the closed world costs, and when

The cost of a closed enumeration is not constant. It has a step in it, and the
step is publication.

Before 1.0 is published, adding a value to one of these sets is a schema edit.
Nothing has been written against the enumeration yet, no reader is in the field
refusing the new value, and the whole change is the schema, the validators, the
renderers and the fixtures moving together in one commit.

After 1.0 is published, the same addition is a MAJOR version. Every reader
already built refuses the new value, correctly, because refusing what it does
not understand is exactly what this document told it to do. A document carrying
the new value is unreadable to every one of them, and no amount of care in the
writer changes that.

So a value that is known to be needed is added before publication or it waits
for 2.0. That is why the fourth section status, `not_applicable`, landed in this
release rather than in the first 1.x that found time for it: the need was known,
and the window in which it cost a schema edit was closing.

The same arithmetic is why the eleven provenance labels are frozen, stated
below rather than hidden: nothing forced a twelfth before publication, and after
publication the price is 2.0.

The one deliberate extension point is `observations`, whose `kind` is an open
namespaced string. Adding a kind is not a spec change at all: it needs no
version, no schema edit and no reader update, because the format already says a
reader ignores a kind it does not recognise and carries the entry forward
unchanged. Evidence a producer wants to attach that the seventeen sections have
no place for goes there, and nowhere else.

The cost of this decision is named rather than hidden: **the eleven provenance
labels are frozen for the whole of version one.** Provenance is the format's
only trust mechanism, the one thing that lets a cold reader tell a check from a
report from a guess, and a label that means one thing in one implementation and
something else in another destroys it. A closed set means a new kind of evidence
cannot get a label until 2.0. It can still travel, as an observation.

## What each part means

**MAJOR** changes when a document written under the new version can no longer be
read correctly by a reader built for the old one. Renaming a section, removing
one, changing what a status means, making an optional field required, adding a
top-level field, adding a field to a section, adding a section status and adding
a provenance label are all major changes.

A reader MUST refuse a major version it does not know rather than guess. Guessing
is worse than failing here: a reader that silently drops a section it does not
understand produces a handover that looks complete and is not, which is the exact
failure this format exists to prevent.

**MINOR** changes keep every document that was valid under the earlier version
valid, and keep its meaning identical, while allowing documents the earlier
version did not. Raising a bound is the realistic case. A minor release still
moves the document's version, and a reader still has to be told about it: see
the next section.

## A reader supports exact versions

A reader MUST refuse a document whose declared format version it does not
explicitly support, and it MUST NOT infer support from the shape of the version
string. There is no "any 1.x is fine" rule.

Today the supported set is exactly one version:

```
1.0
```

The reason is that "1.x" describes a line, not an implementation. A reader that
accepts `1.4` because the string starts with `1.` is claiming to implement a
version nobody has written yet, and it will then be handed documents that use
whatever headroom 1.4 opened. Refusing is the honest answer, and under the
closed-world rule above it is also the safe one.

Three consequences worth stating out loud:

- **A specification release that does not change the document format does not
  change the document's version.** Editorial rewrites, new fixtures, new prose,
  a corrected example: none of them move `soilHandover`.
- **A recipe release never moves the document's version.** The extraction recipe
  carries its own semver, and it moves on its own schedule. Improving how a
  model is asked for a section does not change what the section is.
- **An implementation release never moves the document's version.** A new SDK, a
  bug fix, a faster scanner: the format is unchanged, so the documents are
  unchanged.

The version moves when the document format moves, and at no other time.

## What is frozen for the whole 1.x line

These cannot change without a 2.0:

- The 17 section keys, their names and their order.
- The four section statuses: `available`, `missing`, `blocked`,
  `not_applicable`.
- The eleven provenance labels.
- The set of top-level fields, and the set of fields on a section.
- The requirement that every section is declared.
- The meaning of `available` requiring content, and of `not_applicable`
  requiring its reason.
- The required top-level fields: `soilHandover`, `handoverId`, `projectId`,
  `title`, `createdAt`, `sections`.
- The identity semantics of `handoverId`: assigned by the writer at store
  time, kept by a copy, fresh for a new capture, unchanged by migration, and
  opaque beyond identity.
- The rule that a document with secrets or private absolute paths is refused.
- The absence of any grade, score or quality field.

## What may change in a 1.x release

- New observation kinds, which is the extension point doing its job: adding a
  kind is not a spec change at all, and it moves no version.
- Wording in the extraction recipe. The recipe carries its own semver, the
  recipe version, recorded in a document as `source.recipeVersion` by a writer
  that actually produced that document from that recipe. The format version and
  the recipe version move independently: improving how a model is asked for a
  section never moves the format version, because it does not change what the
  section is. The canonical recipe texts live in `recipes/` at the repo root.
- Bounds, upward only. Lowering a limit could invalidate documents that were
  valid when written, so limits go up, never down, inside a major line. Raising
  one is a minor release, and a reader has to add the new version to the set it
  supports before it will read a document that uses the new headroom.

Nothing else. In particular: no new top-level field, no new field on a section,
no new section status, and no new provenance label.

## The compatibility contract, in both directions

"1.x compatible" is meaningless without a direction. The contract is:

- **Backward (required):** a later reader MUST accept every valid earlier
  document in the line, and MUST list every earlier version in the set it
  supports.
- **Forward (none):** an earlier reader does not read a later document. It
  refuses it on the version, before shape, because it cannot know what the later
  version added. This is not a limitation being tolerated; it is the rule.
- Existing fields never change meaning inside a major line.
- An unknown MAJOR version MUST be refused, never guessed at.
- Migration is explicit and non-destructive: it produces a new document and
  leaves the original untouched.

## Normalization is not versioning

A writer may accept loose input and turn it into a canonical document. The
official implementations do, and every rewrite they perform is enumerated in
[normalization-profile.md](normalization-profile.md), which is not required for
conformance.

Two rules bind that path, and they are versioning rules:

1. Normalization MUST NOT change a document's declared version. It never
   upgrades a document and never downgrades one.
2. Normalization MUST NOT delete content in order to make a document
   acceptable. An unknown top-level field, an unknown field on a section, an
   unknown provenance label and an unknown section key all survive
   normalization and are refused by validation, so a save and a validation of
   the same bytes give the same answer.

If a migration function is ever introduced it is explicit: separately invoked,
version aware, documented, tested for data loss, and never a hidden part of a
save.

## Migration between major versions

When 2.0 arrives, three things ship with it:

1. A written list of every breaking change and why each one was worth breaking.
2. A converter from 1.x to 2.0 in this repo, so no stored handover is stranded.
3. A period where the official implementation reads both, and writes 1.x by
   default until the ecosystem has moved.

A stored handover is never rewritten in place by an upgrade. Converting produces a
new document, because a handover is a record of what a session actually said at a
moment, and silently editing that record makes the whole thing worth less.

## Deprecating a section key

If a section ever has to go, it is deprecated before it is removed:

1. In a minor release, the key is marked deprecated in this spec. It is still
   required, still validated, and readers keep reading it.
2. Extractors stop being asked to fill it, so new handovers carry it as
   `missing`.
3. Only the next major release drops it from the required set, and the converter
   folds whatever it held into whichever section inherited its job.

This has not happened yet. It is written down because the alternative, deciding
it in a hurry when it does happen, produces exactly the silent loss the format is
supposed to prevent.
