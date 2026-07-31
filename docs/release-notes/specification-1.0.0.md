# Specification 1.0.0

Draft release notes for the `spec-v1.0.0` tag (2026-07-23). The
specification and the implementation are versioned separately; improving the
code or the docs never moves the specification version. The implementation's
own notes are in [implementation-0.1.0.md](implementation-0.1.0.md).

The first version of the Soil Handover Specification: the format contract
for a portable JSON document carrying a project's working state between AI
tools.

## What it defines

- **17 typed sections in three tiers** (durable, frontier, meta). Every
  section is always declared; a gap is stated, never silent, and it says which
  kind of gap it is. Four statuses: `available`, and then `missing` (the
  extractor could not see it), `blocked` (it was withheld) and
  `not_applicable` (the project has no such thing, and the section says why).
- **A published JSON Schema**, draft 2020-12.
- **A required UUIDv7 `handoverId`**: global identity for a document,
  separate from the short local load codes.
- **The fail-closed secret rule** as a normative writer requirement: a save
  carrying credential-shaped material or private absolute paths is refused,
  and nothing is stored.
- **The `observations` extension point** with an initial registry of three
  standard kinds (`quality.capture`, `load.outcome`, `working.style`).
  Unrecognised kinds are ignored, never an error.
- **`recipeVersion` in source metadata**, independent of the format version,
  set only by a writer that actually produced the document from that recipe.
- **Version one as a closed world**: the top-level field set, the section field
  set, the 17 section keys, the four statuses and the eleven provenance labels
  are all fixed, and anything outside them is refused rather than carried.
  Adding to any of them takes a major version. Namespaced observation kinds
  are the one deliberate extension point.
- **A reader supports exact versions**, which is a set and not a pattern:
  today exactly `1.0`. A later reader accepts every valid earlier document in
  the line; an earlier reader refuses a later one on the version, before shape,
  because it cannot know what the later version added.
- **Two conformance classes**, honestly separated: Soil Document Conformant
  for a document, Soil Secure Writer Conformant for a writer that also
  proves it runs the safety pipeline.

## Where it lives

The prose, the rationale, the schema and the standard kinds are all under
[spec/](../../spec/README.md), with the versioning and migration rules in
[spec/versioning.md](../../spec/versioning.md).
