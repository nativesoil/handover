# The ingestion boundary

Status: normative for the 1.x line. Changes follow [versioning.md](versioning.md).

Everything else in this specification describes a handover as a **value**: 17
sections, four statuses, a fixed set of labels. This document describes the
step before that, where a handover is still **bytes**, and states the rules
that can only be enforced there.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Why there is a boundary at all

Three rules in this document share one property: a JSON parser destroys the
evidence for them before any other layer runs.

- A byte order mark is stripped, or turns into a stray character, depending on
  which reader you used.
- Two members with the same name collapse into one, and which one survives
  depends on the parser.
- The recursion that a deeply nested document would break has already run by
  the time you hold a value.

So none of the three can be checked by the JSON Schema, by a schema validator,
by the section validator, or by the fail-closed secret scan. All four of those
are handed an already-constructed value. This is a fact about layers, not a gap
in the schema, and it is why the conformance suite carries a separate
`boundary` fixture list that is judged on bytes.

A conformant implementation MUST have exactly one place where a serialized
handover enters, and that place MUST apply the rules below before any other
layer sees the document. The internal mechanism is deliberately unspecified:
what is fixed is the verdict, the error code and the reported location.

## The order of the checks

Normative, and identical on every implementation:

1. size
2. encoding (byte order mark, then unit width, then UTF-8 validity)
3. nesting depth
4. JSON syntax
5. duplicate member names
6. the numeric domain, stated in [value-domain.md](value-domain.md)

Depth comes before syntax on purpose. Parsing recurses, the secret scan
recurses, and the validator recurses; a ceiling enforced inside any of them is
a ceiling enforced too late. Duplicate member names come last so that a
malformed document is a syntax refusal everywhere rather than a race between
two rules.

When a document breaks several rules, the first one in this order is the one
reported. When a document contains several duplicate member names, which one is
reported is deliberately unspecified; every conformance fixture carries exactly
one.

## Error codes

A refusal MUST carry one of these stable codes and a JSON Pointer locating it,
or `""` when the whole document is at fault. A refusal MUST NOT echo any value
from the document, for the same reason the secret scan does not.

| Code                            | What it means                                          |
| ------------------------------- | ------------------------------------------------------ |
| `document.too_large`            | more than 1048576 bytes                                |
| `encoding.byte_order_mark`      | the bytes open with a byte order mark, in any encoding |
| `encoding.unsupported_encoding` | the leading bytes are UTF-16 or UTF-32                 |
| `encoding.invalid_utf8`         | the bytes are not decodable as UTF-8                   |
| `structure.depth_exceeded`      | nesting deeper than 32 levels                          |
| `syntax.invalid_json`           | not a single well-formed JSON document                 |
| `structure.duplicate_member`    | a member name repeated inside one object               |
| `number.not_an_integer`         | see [value-domain.md](value-domain.md)                 |
| `number.out_of_range`           | see [value-domain.md](value-domain.md)                 |

## Encoding

> A serialized handover MUST be valid UTF-8. A producer MUST NOT write a byte
> order mark. Other encodings are invalid. Malformed UTF-8 produces a
> controlled error and is never repaired. No implementation may silently
> convert an alternative encoding.

A reader MUST NOT strip a byte order mark and carry on, and MUST NOT substitute
U+FFFD for an undecodable byte. Both are silent repairs, and a repaired
document is not the document that arrived: two readers then disagree about what
was written, which is the failure this format exists to prevent.

An implementation MUST detect an alternative encoding from the leading bytes
rather than from a declaration, because there is nowhere to declare one. The
detection rule is the one in RFC 4627 section 3: the first token of a JSON text
is ASCII, so the position of the NUL padding in the first four bytes names the
unit width.

| First four bytes | Encoding |
| ---------------- | -------- |
| `00 00 00 xx`    | UTF-32BE |
| `xx 00 00 00`    | UTF-32LE |
| `00 xx 00 xx`    | UTF-16BE |
| `xx 00 xx 00`    | UTF-16LE |

Byte order marks are recognised for UTF-8 (`EF BB BF`), UTF-16 (`FF FE`,
`FE FF`) and UTF-32 (`FF FE 00 00`, `00 00 FE FF`). A UTF-32LE mark opens with
the two bytes of a UTF-16LE mark, so the four-byte forms MUST be tested first
or the reported encoding will be the wrong one.

Valid multibyte UTF-8 is ordinary content and MUST be accepted. The rule is
about encodings, never about non-ASCII text.

## Duplicate member names

> A serialized handover containing duplicate member names in the same JSON
> object is invalid and MUST be rejected BEFORE schema validation.

The argument is security, not tidiness. With last-wins, the fail-closed secret
scan sees one value for `/sections/architecture` and a consumer parsing the same
bytes with a different parser sees the other. The document that was scanned is
then not the document that is read, and the scan's guarantee is void. Refusing
is the only outcome that keeps the two readers in agreement.

The rule is about one name repeated **inside one object**. The same name in two
different objects is ordinary JSON: `status` and `summary` appear in all 17
section objects of every handover, and an implementation that refuses that has
implemented something else.

The check MUST cover the whole document, including `observations[].data`. The
extension point is free-form, but it is not a way around the rule.

## Nesting depth

> A serialized handover MUST NOT nest more than 32 levels. Every implementation
> MUST check depth BEFORE recursive operations that can throw stack errors.
> Exceeding the limit MUST produce a structured error, never an uncontrolled
> stack or recursion failure and never a silent kill.

Depth counts containers. The root container is level 1, a member value inside it
that is itself a container is level 2, and so on. A document that is a single
scalar has depth 0.

The ceiling is **derived, not observed**. It was not tuned to any crash:

- the deepest structure a handover needs without custom observation data is 4
  (root, `sections`, one section, its `provenance` array);
- the deepest real fixture in this repository is 6;
- the lowest hard parser ceiling among the five official implementations is 64
  (`System.Text.Json`'s default reader depth);
- 32 is half of that: far above anything a handover needs, far below the first
  runtime that would fail on its own terms.

Before this boundary existed, the recursion that actually failed on a deep
document was inside the fail-closed secret scan. A document deep enough to
break it was therefore neither accepted nor scanned, which is the worst of the
three outcomes. Checking depth first is what makes "accepted" and "scanned" the
same set.

## Size

> A serialized handover MUST NOT exceed 1048576 bytes.

Also derived: the largest real document in this repository is the worked example
at 18719 bytes, so the ceiling leaves roughly fifty times the headroom any
handover has ever needed, while still bounding what a reader will decode, scan
and walk. The check is on the byte count alone and runs first, before decoding.

## What this document does not decide

Two limits belong to the same boundary and are deliberately not stated here:
the numeric domain (what a handover may hold once a token is a number) and the
text-length unit (how the length of a string is counted and bounded). Both are
now decided, in [value-domain.md](value-domain.md), which builds on this
boundary rather than sitting beside it. The numeric domain is enforced HERE, as
the sixth check, because a parser destroys its evidence exactly as it destroys
the evidence for the three rules above; the text unit is enforced in the
validator, because a length bound belongs to a named field and nothing is lost
by parsing a string.

One syntax question is settled here, because without it the surfaces disagree
about what a JSON document even is: `NaN`, `Infinity` and `-Infinity` are not
JSON values and MUST be refused as `syntax.invalid_json`. That is a statement
about the grammar, not about the numeric domain.

## Conformance

The fixtures are in `conformance/fixtures/boundary/` and are registered in the
`boundary` list of `conformance/fixtures/manifest.json`. Each limit has three
fixtures: just under it, exactly at it, and just over it.

Each entry states the boundary's verdict and, for an accepted document, what the
validator must then say about it. That second field is the point of the whole
exercise: an accepted document is never merely accepted. Two fixtures pin it.
`boundary/depth-32-secret-at-the-floor.json` sits at exactly the nesting ceiling
and the fail-closed secret scan must still reach the deepest value in it;
`boundary/accepted-non-object-root-with-secret.json` has a root the validator
refuses on shape, and the scan must still reach the string inside, because
"rejected anyway" is not the same claim as "scanned".
