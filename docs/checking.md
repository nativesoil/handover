# Checking and grading

`soil check` examines a handover document and grades it. This page documents
what that means, every rule it runs, the exact grade mapping, and the line the
checker never crosses.

Every save runs the same rules on the document it just stored, and the save
receipt (the CLI's and the MCP tool's alike) reports the grade band and the
finding counts. That is the whole of it at save time: the grade informs and
never blocks a save, because an honest gap is worth more than a tidy
handover, and the full report, finding by finding, stays one `soil check`
away.

## What the checker is, and is not

The baseline checker is deterministic analysis of the document itself. Whether
a handover actually restores a session is a different question, answered only
by a real load.

Concretely:

- **Deterministic.** Same document in, same report out, byte for byte. Every
  finding traces to a rule on this page, and anyone can re-produce a report
  from the same file.
- **Lint-style.** The rules are documented heuristics over the text of the
  document: pattern matches, counts and thresholds. Nothing calls a model,
  nothing reaches the network, and nothing measures what any target model
  retains.
- **Fully explainable.** A finding is a rule id, a severity and a plain
  sentence. There is no hidden weighting and no aggregate that cannot be
  recomputed by hand from this page.

Results are checked and graded, nothing stronger. The grade band lives in the
report and stops there. It is printed on the card, present in `--json`, and it
decides the exit code. It is never written onto the document: the 17 sections
carry no grade, the format has no score field, and the observation `--attach`
writes carries no band either. See
[Attaching the report](#attaching-the-report) for what does travel and what
that costs.

Save-time checking and grading is an open baseline: every rule is documented
on this page and runs offline, and a better implementation of the same idea
is allowed anywhere. A hosted service may implement deeper checking over
this same format; whatever it adds, this baseline stays here, documented and
runnable offline.

## The rules

Three severities:

| Severity  | Meaning                                                      |
| --------- | ------------------------------------------------------------ |
| `problem` | Undermines the document's ability to restore anything        |
| `caution` | A concrete weakness worth fixing before the document travels |
| `advice`  | A soft signal. Reported, and it never lowers the grade       |

Every rule, with its id and its rationale:

### `completeness.missing-without-reason` (caution, per section)

A section declared `missing` with a `null` summary, while
`quality.missingInputs` is also empty. A gap is fine, that is the format
working as designed; an unexplained gap is not, because the next session
cannot tell "there was nothing" from "the extractor skipped it". A reason in
either place, the section's own note or the document-level list, satisfies
the rule.

### `completeness.no-durable-truth` (problem, document level)

None of the six durable-tier sections (project identity, decisions, workflow,
architecture, constraints, rejected paths) carries content. Everything the
document holds then describes one session's moment, and nothing in it
outlives that session. This is the single strongest signal that a capture
failed at its job.

### `self-containment.fetch-pointer` (caution per section, problem in restore instructions)

The text sends the reader somewhere else: phrases such as "see the repo",
"in the docs", "consult", "refer to", or a URL presented as where the content
lives ("documented at https://..."). A handover assumes its reader has
nothing else, so content behind a pointer is content that failed to travel.
Inside `restoreInstructions` this is a `problem`, because the boot prompt is
the one part that must stand entirely alone. A URL stated as a fact about the
system ("the service runs at https://...") is not flagged.

### `time.unanchored` (caution, per frontier section)

A frontier-tier section uses volatile time words ("currently", "now",
"today", "this week", "recently" and similar) with no capture-time anchor in
the same section ("at capture", "as of this capture", an explicit date).
Frontier sections describe a moment; without the anchor, a reader arriving
weeks later reads the moment as the present.

### `decisions.entry-without-reason` (caution, per entry)

An entry in the decisions section states a decision, detected by decision
verbs such as "decided", "chose", "locked", "agreed", but carries no reason
marker such as "because", "since", "so that", "after", or a stated inability
("cannot"). A decision without its reason is the exact thing a later session
relitigates. Entries are split deterministically on numbered items, bullets
and paragraphs.

### `anchors.no-exact-values` (advice, architecture and constraints)

The section talks about configuration ("config", "port", "version",
"pinned", "timeout", "limit" and similar) yet contains no digits at all.
Exact values, ports, versions, size ceilings, are what survive a move intact;
prose about configuration with every number stripped is a soft signal that
the pins were lost in extraction. Soft on purpose: some true configuration
statements carry no numbers.

### `gaps.blocked-without-omission-note` (caution, per section)

A section is `blocked`, meaning content was withheld for safety, but
`safety.unsafeOmissions` is empty. The format's rule for withheld material is
that the fact travels while the value does not: the safety record should name
what exists and where it is configured. A blocked section with a silent
safety record keeps neither the value nor the fact.

### `restore.absent` (problem)

At least one section carries content, but `restoreInstructions` does not.
The restore instructions are the boot prompt; captured content with nothing
telling the next session how to begin is a body without a spine.

### `restore.thin` (problem)

`restoreInstructions` is present, but shorter than the documented floor:
`max(300, 5% of the combined length of all other available sections)`,
applied only when that combined length is at least 1000 characters, so a
genuinely small capture is never asked for a long boot prompt. A rich capture
with a two-line restore prompt loses most of itself at the moment of load.

### `size.one-liner` (advice, per section)

An available section under 40 characters in a document whose available
sections number at least five with a median length of at least 200
characters. In a rich document, a one-liner usually means the section was
filled rather than written. Advice, not more, because a short section can be
honestly short.

## The grade mapping

Counts in, band out. No other inputs exist:

| Band       | Condition                              |
| ---------- | -------------------------------------- |
| `failing`  | 3 or more problems                     |
| `thin`     | 1 or 2 problems, or 6 or more cautions |
| `adequate` | no problems, 1 to 5 cautions           |
| `strong`   | no problems, no cautions               |

Advice findings never move the band. The mapping is implemented once, in
`gradeFromCounts`, and tested against this table.

## Using it

```bash
soil check '#004'          # check a stored handover
soil check capture.json    # check a file
soil check -               # check stdin
soil check '#004' --json   # print the report as JSON
```

The exit code is CI-friendly: `0` for `strong` or `adequate`, `1` for `thin`
or `failing`, `2` for usage errors. A document that fails validation is
reported by the validator and never graded.

The card shows the grade band, the finding counts by severity, and every
finding grouped by section with its rule id and a one-line explanation. It is
the report's card, so the band belongs on it.

## Attaching the report

```bash
soil check '#004' --attach
```

By default a check only prints; nothing is written. With `--attach`, and only
for a stored handover, the report is written onto the document as a
`quality.capture` observation, the standard kind defined in
[spec/observations.md](../spec/observations.md).

`producedBy` is `soil-cli/<version>`, `producedAt` is the check time, so a
reader can weigh who claims what, and when.

`data` is a closed field set, and exactly this:

| Field                 | What it holds                                         |
| --------------------- | ----------------------------------------------------- |
| `sectionsWithContent` | how many of the 17 sections carry content             |
| `missingSections`     | the section keys with `status: "missing"`             |
| `blockedSections`     | the section keys with `status: "blocked"`             |
| `findings`            | one entry per rule outcome                            |
| `checkVersion`        | the rule-set version that produced them               |
| `notes`               | short non-evaluative context, at most 280 code points |

Those first three fields do not partition the 17 sections, and they are not
meant to: they enumerate what is absent and retrievable, not everything that is
not present as content. A section declared `not_applicable` is in none of them
on purpose. It is not a gap, there is nothing to go and get, and listing it
beside the gaps would send a reader after something that does not exist. So the
numbers do not add up to 17, and nothing here will be added to make them.

Each finding carries a `rule` id, a `location` (a JSON-Pointer-ish path, or
`/` for a document-level rule), the `observed` condition in plain language,
and the rule-local `severity`. Severity classifies that one rule outcome. It
is not a judgement of the handover, and three cautions do not add up to one
in the payload.

`notes` says how the examination was made and what it did not look at. It is
bounded at 280 code points and `checkObservation` refuses a longer one rather
than truncating it, because a note long enough to hold a verdict is where a
removed grade goes to hide.

**What is not in there: the grade.** No band, no score, no counts-by-severity
roll-up, under any key. The document does not carry the judgement.

**And the honest part.** Removing the band does not remove derivability. The
findings carry severities, the severities can be counted, and
[the grade mapping](#the-grade-mapping) on this page is published. Anyone who
wants the band can compute it in about a minute, and they will get exactly
the band `soil check` printed.

That is not a loophole this design pretends to close. The difference is who
makes the derivation and what they can see while making it. A reader who
chooses to grade a handover meets the threshold function first: three
problems is `failing`, six cautions is `thin`, and those numbers came from
one producer's rules, on one day, at one version. A band travelling inside
the document arrives as a settled fact from a producer the reader never met,
about a document that cannot argue back. Same arithmetic, different claim.

The write goes through the store's update path, which holds two rules
absolutely: the `handoverId` never changes, and the load code never changes.
Attaching evidence never touches the 17 sections.

Checking again after an attach produces the same grade: observations never
change how the document is read.

### Reading an attached report back

`soil load` and `soil render` name what is attached and who attached it, on the
`evidence` and `recorded` rows of the rail card, so a reader knows the report
is there. The payload itself is read with:

```bash
soil load '#004' --json
```

That is deliberate rather than a gap, and the reasoning is worth stating because
the opposite choice is tempting. `data` is free-form and opaque to the
specification: a renderer laying out a payload shape it has never seen would be
inventing one, and the shape it invented would then be the shape producers were
pushed towards. There is also a narrower reason for this kind in particular.
`quality.capture` exists to carry findings without carrying a verdict, and a
findings block laid out on the load card, next to a section count, is where a
removed grade would quietly reassemble itself in the reader's eye. Naming the
kind and the producer says the evidence exists and who is answerable for it,
which is what the reader is owed; the rest is one command away and
[spec/observations.md](../spec/observations.md) says how to read it.

## In the SDK

```ts
import { checkHandover, checkObservation } from "@nativesoil/handover-sdk";

const report = checkHandover(handover); // pure, deterministic
report.grade; // "strong" | "adequate" | "thin" | "failing"
report.findings; // [{ rule, severity, section?, message }]
```

`CHECK_RULES` exports every rule id with its one-line explanation, and
`CHECK_VERSION` names the rule-set version, which every report and every
attached observation records. `CHECK_NOTES_MAX_CHARS` is the `notes` bound and
`CHECK_DEFAULT_NOTES` is the note written when the caller supplies none.

`report.grade` exists on the report and only on the report. `checkObservation`
never copies it onto the document.

The same surface exists in all five official implementations: `checkHandover`,
`checkObservation` and the check card render byte-identically across
TypeScript, Python, Go, JVM and .NET over a shared corpus, held by each SDK's
parity tests, and the Go binary's `soil check` matches the Node CLI's output
and exit codes.
