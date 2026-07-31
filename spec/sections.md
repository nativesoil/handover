# The 17 sections

Every handover declares all 17, in this order. A section with nothing in it says
so, and says which kind of nothing: `status: "missing"` when the extractor could
not see it, `status: "blocked"` when it was withheld for safety, and
`status: "not_applicable"` when this project genuinely has no such thing, with a
required non-empty `summary` saying why. The list is fixed for the whole 1.x
line.

`not_applicable` is the one gap status that tells the next model to stop
looking, so it is used only where the project really has no subject for the
section, never as a tidier way of saying the extractor came up empty. Most
sections have a natural "none" answer in prose instead, and the guidance below
says so where it applies: `blockers`, `rejectedPaths` and `constraints` all
accept "none" as content. Reach for `not_applicable` where the section's whole
premise is foreign to the work, not where its answer this week happens to be
nothing.

They fall into three tiers, and the tiers are the point: durable truth outlives
the session, frontier state does not, and mixing them is how a cold model ends up
confidently reporting last week's status as today's.

| Tier                   | Sections                                                                                                        | Half-life                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Durable, the project   | `projectIdentity`, `decisions`, `workflow`, `architecture`, `constraints`, `rejectedPaths`                      | still true later         |
| Frontier, this session | `executiveSummary`, `currentTask`, `latestUserIntent`, `sessionDelta`, `blockers`, `nextSteps`, `openQuestions` | true at the capture      |
| Meta, the handover     | `sessionActivity`, `restoreInstructions`, `provenanceMap`, `safetySummary`                                      | about the capture itself |

![The shape of a handover. Six durable sections still true later: projectIdentity, decisions, workflow, architecture, constraints, rejectedPaths. Seven frontier sections true at the capture: executiveSummary, currentTask, latestUserIntent, sessionDelta, blockers, nextSteps, openQuestions. Four meta sections about the capture itself: sessionActivity, restoreInstructions, provenanceMap, safetySummary. Each section carries exactly three fields, status, summary and provenance, and a fourth is refused. Status is one of four: available, missing, blocked, not_applicable. Provenance is optional and drawn from eleven closed labels. Observations are the one extension point, with an open kind and free-form data.](../docs/diagrams/document-shape.svg)

The whole shape on one page: the 17 in their tiers, the four statuses a section
may carry, the eleven provenance labels, and the one place the format is open.

The exact wording an extractor is given for each section is in
[`packages/sdk-ts/src/recipe.ts`](../packages/sdk-ts/src/recipe.ts), published
verbatim. What follows is the human summary.

---

## Tier A: the project

### `projectIdentity`

**Purpose.** What the project is and how the person wants it worked on, so the
reader understands the world before it touches anything.

**Belongs.** Purpose and domain. Who it is for. The project's own working
language: its named concepts, internal names and recurring phrases, each with its
agreed meaning, enumerated and quoted exactly. The user's working style, stated
preferences, and the corrections they have made.

**Does not belong.** The current task. Anything about the tool that captured
this. Vocabulary paraphrased into ordinary words: a renamed term silently breaks
every later reference to it.

### `decisions`

**Purpose.** Stop the next model from relitigating what is settled. This is the
single highest-value section in the format.

**Belongs.** Every locked decision, enumerated, each with the reason it was
locked, however long ago it was locked. Any constraint it imposes. Where a
decision was disputed and then resolved, the dispute history in role terms and
how it settled. Validity conditions where the work actually established them.

**Does not belong.** A count. A summary of the recent ones. A decision stripped of
its reason, which is the same as a decision waiting to be reopened. A decision
recorded as if nobody ever objected, which invites the next model to fold the
moment somebody objects again.

### `workflow`

**Purpose.** How the work is run, so the next model operates the way this project
actually operates.

**Belongs.** Process contracts, review rituals, the definition of done, expected
sequencing, and the standing "always do X, never do Y" corrections. A correction
belongs together with the failure mode it targets.

**Does not belong.** What the work is, as opposed to how it is run. A correction
widened into a blanket ban: a ban on one kind of question is not a ban on
questions.

### `architecture`

**Purpose.** The durable shape of the system or the process.

**Belongs.** The parts and their roles by name, how they fit, the data or process
model, and what is built versus what is merely planned. Load-bearing safe
configuration values quoted exactly: ports, version pins, flag and command names.

**Does not belong.** Volatile state, which is `currentTask`. Private absolute
paths, branch names, exact file inventories. Anything about the handover tooling
itself. Values rounded or paraphrased, which makes them useless as anchors.

### `constraints`

**Purpose.** The invariants that make the work wrong if broken.

**Belongs.** Safety and compliance limits, budget and scope ceilings, platform
requirements, performance and correctness bars, each with why it binds and with
exact limits quoted. Validity conditions where they exist.

**Does not belong.** Preferences, which are `workflow`. An invented condition on a
rule that is actually unconditional, and the reverse: dropping a real bound turns
a scoped rule into a false absolute.

### `rejectedPaths`

**Purpose.** Institutional memory of what not to do.

**Belongs.** What was tried and abandoned, what was explicitly rejected, what went
wrong, and any residue left behind.

**Does not belong.** Options never actually considered. Nothing here expires:
age is exactly why the next model is about to retry it.

---

## Tier B: this session's frontier

### `executiveSummary`

**Purpose.** One screen that orients a cold reader before it reads anything else.

**Belongs.** What the project is, where it stood at the capture, and the single
most important next thing.

**Does not belong.** Detail that belongs in a real section. This is the door, not
the room.

### `currentTask`

**Purpose.** Resume mid-stride.

**Belongs.** The task in flight at the capture, the approach and why, how far
along, what done looks like, and the reported state as of the save. Volatile
statements anchored with "at capture".

**Does not belong.** The act of saving. If a thread shows no real task, that is
what to say. Unqualified "currently" and "now", which a later reader will read as
its own present.

### `latestUserIntent`

**Purpose.** The last substantive direction, in the person's own framing, which
overrides stale earlier plans inside this handover.

**Belongs.** Their wording where it is safe to quote, the nuance, and how it
changes the plan.

**Does not belong.** "The user asked to save." A save request is the trigger for
the capture, never the intent; look back past it for the real one.

### `sessionDelta`

**Purpose.** The bridge between accumulated truth and the latest frontier.

**Belongs.** What changed since this conversation began: decided, built, reversed,
learned, unblocked, and which durable facts this session added or revised.

**Does not belong.** A restatement of the durable sections. "None" is a fine
answer when nothing durable changed.

### `blockers`

**Purpose.** What is stopping progress and what that implies for sequencing.

**Belongs.** How the blocker shows up, what has already been tried, and the
dependency it imposes.

**Does not belong.** Vague risk. "None" is a fine answer, when true.

### `nextSteps`

**Purpose.** Start immediately without asking what to do.

**Belongs.** Concrete ordered actions with their dependencies, and for each one
the locked decisions and constraints that govern how it must be done.

**Does not belong.** "Continue the work." A step with no first move.

### `openQuestions`

**Purpose.** Mark what is not yet decided so the next model does not assume.

**Belongs.** The question, what is at stake, options under consideration.

**Does not belong.** Coverage gaps, which are things the extractor could not see
rather than things the project has not settled. Those go in
`quality.missingInputs`.

---

## Tier C: the handover itself

### `sessionActivity`

**Purpose.** What actually moved the state, and what came of it.

**Belongs.** Consequential actions and outcomes: commands run, changes made,
deploys, tests, artifacts produced.

**Does not belong.** Raw logs, raw output, runtime identifiers. Meaning only.

### `restoreInstructions`

**Purpose.** The one paste-ready boot prompt. This is what a load hands to the
next model first.

**Belongs.** The whole working state, standalone: durable truth first with every
locked decision and its reason, then the latest state and the ordered next steps.
Where they apply, a short "what not to import" and a short "what to check first".

**Does not belong.** Pointers outward. No "see the repo", no "consult the docs",
no bare link. Inline what the reader would otherwise have to fetch, because it
cannot fetch anything. No mention of the tooling that moved this.

### `provenanceMap`

**Purpose.** Make trust legible, so the reader knows which claims to lean on.

**Belongs.** Which load-bearing claims were checked against the project itself,
which are reported from the conversation, which are inferred, and what could not
be seen at all.

**Does not belong.** A guess presented as a check. A claim of access the extractor
did not have.

### `safetySummary`

**Purpose.** Make deliberate omissions visible instead of silent.

**Belongs.** What was withheld, that it exists, and where it is configured.

**Does not belong.** The value. Ever. A guessed location: if the extractor does
not know where a thing is configured, the honest answer is that the location is
unknown. See the safety rule in [README.md](README.md), which is enforced.
