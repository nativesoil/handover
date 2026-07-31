# The value domain: numbers and text length

Status: normative for the 1.x line. Changes follow [versioning.md](versioning.md).

[ingestion.md](ingestion.md) states the rules that bind while a handover is
still bytes, and closes by naming two limits it deliberately does not decide:
what a handover may hold once a token is a **number**, and how the **length**
of a string is counted and bounded. This document decides both.

They are here together because they have the same shape. Each is a rule that
looks obvious in one language and means something different in the next, and
each one, left unstated, produces implementations that agree on every ASCII
document and disagree on real ones. A limit that differs per language does not
fail loudly. It silently splits the format in two.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

---

## Part one: the numeric domain

> A number in a handover MUST be an integer, written in the integer form, whose
> value lies between -9007199254740991 and 9007199254740991 inclusive. A number
> token carrying a fraction part or an exponent MUST be refused, and so MUST a
> token whose magnitude exceeds that range. The rule binds on the number's
> TOKEN TEXT, at the ingestion boundary, before the token is converted to any
> numeric type.

### The ends of the range

The range is the safe-integer range: -(2^53 - 1) to 2^53 - 1. It is chosen, not
observed. Above it a 64-bit binary float can no longer tell two neighbouring
integers apart, so `9007199254740993` and `9007199254740992` become the same
value on a reader with doubles and stay different on a reader with
arbitrary-precision integers. The two readers then hold different documents,
which is the failure this format exists to prevent.

Nothing here was tuned to a crash, and no runtime's own ceiling was measured
and adopted. Two of the five official implementations could hold considerably
more than this and one could hold any integer at all; the bound is set where
the five stop AGREEING, which is a different and much lower place than where
any one of them stops working.

### The required form

A number token MUST match the JSON integer form: an optional minus sign, then
either `0` or a digit from 1 to 9 followed by any digits. No fraction part, no
exponent.

`100.0` and `1e2` are the integer 100 by any reading of arithmetic, and both are
refused. This is the deliberate part of the rule and it has a cost, so the
reason is stated rather than assumed: deciding whether an arbitrary decimal
denotes an integer requires exact decimal arithmetic over a token of arbitrary
length. `1e2` is easy; `1.00000000000000000000001e23` is not, and neither is a
four-hundred-digit mantissa with a negative exponent. The five official
implementations do not share one arithmetic that answers that question
identically, and a rule the five cannot execute identically is not a rule, it
is five rules that happen to agree on the examples somebody thought of.

The refusal is total and legible instead: a number in a handover is written the
way an integer is written. A producer that wants to record 100 writes `100`.

### Where the check binds, and why it is not in the validator

The check MUST run at the ingestion boundary, on the token text, and it MUST
run before the token is converted to a numeric type.

This is the same argument that puts the encoding, duplicate-member and nesting
rules there, and it is not a preference. By the time a value exists:

- a reader with 64-bit floats has already folded `9007199254740993` into
  `9007199254740992`, and a forty-digit token into a double with nothing left
  of its tail;
- `1e999` has already become an infinity, which is not a JSON value and cannot
  be reported as the number it came from;
- a reader with arbitrary-precision integers has lost nothing at all and sees
  no problem whatsoever.

So the value cannot answer the question, and the two readers cannot even be
made to answer it the same way. The token text can, and it is the only
representation all five read identically.

### Where numbers appear at all

In version one, every field the format defines is a string, an array or an
object. The one place a producer can put a number is inside
`observations[].data`, whose payload is free-form. The numeric domain is
therefore, in practice, a rule about observation payloads, and it applies
there in full: `data` is an extension point, not a way around a rule, exactly
as it is not a way around the duplicate-member rule or the safety rule.

The check nonetheless covers every number anywhere in the document, including
in a document that turns out not to be a handover at all. The boundary judges
bytes, not shape.

### Error codes and ordering

| Code                    | What it means                                    |
| ----------------------- | ------------------------------------------------ |
| `number.not_an_integer` | the token carries a fraction part or an exponent |
| `number.out_of_range`   | the token is an integer outside the stated range |

A refusal MUST carry the code and a JSON Pointer locating the offending value,
or `""` when the number is the whole document. It MUST NOT echo the value, for
the same reason no other refusal does.

The numeric domain takes position 6 in the ingestion boundary's normative
order of checks:

1. size
2. encoding
3. nesting depth
4. JSON syntax
5. duplicate member names
6. **numeric domain**

It comes last because it presupposes everything before it. A run of characters
is not yet a number until the document is known to be well-formed JSON, and a
document that breaks a structural rule as well as this one MUST report the
structural refusal, so two implementations never race two rules against each
other.

`NaN`, `Infinity` and `-Infinity` are not affected by this document. They are
not JSON values at all and are refused as `syntax.invalid_json`, which
[ingestion.md](ingestion.md) settles.

### How a conforming implementation computes it

No big-integer type is required, and none should be used, because reaching the
same verdict by different arithmetic is how five implementations drift.

1. Match the token against the integer form. A token that fails the match is
   `number.not_an_integer`.
2. Drop a leading minus sign. The integer form permits no leading zeros, so
   what remains is the value's decimal digits exactly.
3. If there are more than 16 digits, the value is out of range. `9007199254740991`
   has 16.
4. If there are exactly 16 digits, compare the digit string against
   `9007199254740991` as text. Equal-length decimal strings compare correctly
   under ordinary lexicographic order, so a string greater than that one is out
   of range.

That is the whole computation. It needs no numeric conversion, and it gives the
same answer in a language with 64-bit floats, a language with exact decimals
and a language with arbitrary-precision integers.

---

## Part two: the text unit

> Every length bound in this format is counted in **Unicode code points**: the
> number of code points in the string, where a character outside the Basic
> Multilingual Plane counts as one. It is not a count of UTF-16 code units, not
> a count of bytes, and not a count of grapheme clusters.

### Which strings the unit applies to

It applies to every string the format bounds by length. In version one those
are exactly:

| String                                                                         | Bound |
| ------------------------------------------------------------------------------ | ----- |
| `projectId`                                                                    | 120   |
| `title`                                                                        | 200   |
| each section's `summary`                                                       | 20000 |
| each entry of `quality.missingInputs`                                          | 1000  |
| each entry of `quality.contradictions`                                         | 1000  |
| each entry of `safety.unsafeOmissions`                                         | 1000  |
| `observations[].kind`                                                          | 200   |
| `notes` in a `quality.capture` payload, per [observations.md](observations.md) | 280   |

`projectId` is additionally restricted by a pattern to ASCII, so all three
candidate units happen to agree on it. That is a fact about that field, not an
exemption: the unit is the same one.

### Which strings it does not apply to

It does not apply to strings the format bounds by GRAMMAR rather than by
length. `soilHandover`, `handoverId`, `createdAt`, `code` and
`source.recipeVersion` each have to match a pattern, and the pattern bounds
them. There is no length rule to express in any unit, and adding one would be
a second way to refuse a document that is already refused.

It does not apply, individually, to any string the format does not bound:
`source.client`, `source.model`, `source.provider`, `observations[].producedBy`,
every string inside the free-form `observations[].data` payload, and every
object member name. These are bounded only by the document size limit of
1048576 bytes in [ingestion.md](ingestion.md), which bounds them collectively
and is stated in bytes because it is a resource bound. An implementation MUST
NOT invent a per-string bound for these: refusing a document that this
specification accepts is not conformance, it is a different format.

### How a conforming implementation computes it

Counting code points does not require a Unicode character table, and this is
the property that made the unit affordable. The count is a fact about the
encoding:

- From UTF-8 bytes: count the bytes whose top two bits are not `10`. Every
  continuation byte matches `10xxxxxx` and every other byte begins a code
  point.
- From UTF-16 code units: count the units that are not low surrogates
  (`0xDC00` to `0xDFFF` preceded by a high surrogate). A surrogate pair is one
  code point.
- From a sequence of code points, which is what a string already is in some
  languages: count them.

An unpaired surrogate counts as one code point. A document may carry one, and
counting it as zero would let a string carry unbounded content past a bound.

Neither formulation changes when a new version of Unicode is published.

### The argument, including the options that lost

The three real candidates were bytes of the UTF-8 encoding, Unicode code
points, and UTF-16 code units. All three are cheap to compute and all three
give the same answer on ASCII, which is why a suite written in ASCII cannot
tell an implementation counting one from an implementation counting another.
Grapheme clusters were a fourth candidate and lost first.

**Grapheme clusters, rejected.** A grapheme cluster is what a person calls a
character, so it is the unit with the best claim to being what a bound means.
It is also the only candidate that cannot be computed without shipping a
Unicode table and keeping it current: the segmentation rules are UAX #29 and
they change between Unicode versions. Two implementations built a year apart
would then bound the same string differently, and an independent implementation
would have to take on a data dependency to read a handover. That cost is not
payable by a format whose whole claim is that a document survives being read by
something we have never seen.

**Bytes of the UTF-8 encoding, rejected — and it was the strongest of the
losing arguments.** The case for bytes is real and worth writing down, because
a rule whose losing argument is not recorded gets relitigated. It runs: the
document is UTF-8 and nothing else, so a byte count is exact and unambiguous;
every language computes it in one call; and the format ALREADY has a byte
limit, the 1048576-byte document ceiling, so choosing bytes gives the whole
specification one currency, in which the sum of the parts is obviously bounded
by the whole.

What answers it is that the two limits bound different things. The document
ceiling bounds what a reader must decode, scan and walk. That is a resource
bound, resources are consumed in bytes, and bytes are the honest unit for it.
A string-length bound is a content rule: it says how much prose a section may
carry. Expressed in bytes, the same sentence costs one unit per character in
English, three in Japanese and four in an emoji, so the identical content is
accepted from one project and refused from another on the basis of the script
it is written in. That is a property of the encoding leaking into a rule about
meaning, and no reader could be told why.

The second answer is narrower and decisive on its own. The bounds are already
published, in `handover.schema.json`, as JSON Schema `maxLength` keywords, and
`maxLength` is defined in code points (JSON Schema validation section 6.3.1, on
top of RFC 8259). JSON Schema cannot express a byte bound at all. Choosing
bytes would mean either deleting those keywords, leaving an implementation that
reads only the schema with no bound whatsoever, or leaving them in place
stating a number that means something different from the number this document
states. The conformance suite holds the published schema and the reference
validator to the same verdict on every fixture; under a byte unit those two
would disagree permanently on every non-ASCII fixture.

**UTF-16 code units, rejected.** This is what four of the five official
implementations were doing when this rule was written, so it had incumbency and
nothing else. It encodes a representation the format never uses: a handover is
UTF-8 on the wire and on disk, and UTF-16 appears in this specification only in
the list of encodings the ingestion boundary refuses. It gives an emoji twice
the weight of an ideograph for a reason that exists nowhere in the document. It
contradicts the published schema in the same way bytes would. And it obliges an
implementation in a language with no UTF-16 anywhere — Go, Rust, C — to
simulate a representation solely to count something.

**Unicode code points, chosen.** It is what the published schema already means,
so the normative artefact stops contradicting the implementations rather than
the other way round. It is script-neutral: a bound admits the same number of
characters in every writing system, and a character is a character whichever
plane it lives in. It costs no table and no data dependency. It is computable
directly from the encoding the format actually uses. And it was already what
one of the five implementations did, so the change moved four surfaces onto the
thing the specification had said all along instead of inventing a sixth answer.

One consequence is worth stating because it decides the compatibility question.
For any string, the code-point count is less than or equal to the UTF-16 count,
which is less than or equal to the UTF-8 byte count. Code points is therefore
the most permissive of the three, and fixing the unit made no previously valid
document invalid. What it changed is that documents the specification always
allowed, and four implementations refused, are now accepted by all five.

### What the unit does not claim

It does not claim to be what a person counts. `é` written as `e` followed by a
combining acute is two code points and one perceived character, and a bound of
1000 admits five hundred such characters. A family emoji built from several
people joined by zero-width joiners can be seven code points and one picture.
The unit is stated so that five implementations agree, not so that a bound
matches an intuition; no unit does both, and a unit that tried would be the
grapheme cluster, which loses for the reason above.

It says nothing about normalisation. Two strings that a reader would call the
same text may have different code-point counts if one is composed and the other
decomposed. This specification does not normalise, does not require a producer
to normalise, and does not compare strings for equivalence.

### Where the check binds

A length bound belongs to a named field, so it is enforced where the field is
known: in the validator, alongside the other structural rules. Unlike the
numeric domain, nothing is destroyed by parsing here — a string arrives at the
validator intact — so there is no reason to move it earlier, and the ingestion
boundary deliberately enforces no global cap on the length of an arbitrary
string.

---

## Conformance

The numeric domain is exercised by the `boundary` fixture list in
`conformance/fixtures/manifest.json`: both ends of the range and one step past
each of them, a forty-digit magnitude, an integer written with a decimal point,
an integer written in exponent form, a fraction, and a refusal located inside
an array.

The text unit is exercised by `valid/text-unit-at-the-limit.json`, whose every
bounded string sits exactly on its limit in code points and over it in UTF-16
code units and in bytes, and by two invalid fixtures one code point past their
bounds. The `text-unit` category in every conformance runner covers the
remaining bounded fields, including the 20000-code-point section summary, which
is built at run time rather than committed: as an astral string it would be an
eighty-kilobyte fixture, and a string constructed in the runner proves the same
thing.

Every case in both sets is deliberately non-ASCII. On ASCII the three candidate
units agree, so an ASCII fixture cannot tell a conformant implementation from
one counting the wrong thing.
