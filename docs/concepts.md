# Concepts

What Soil Handover makes possible, and why it works the way it does, for
someone deciding whether to rely on it rather than someone about to run it.
The practical walkthrough is [quickstart.md](quickstart.md); the normative
definition is [`spec/`](../spec/README.md). Everything on this page is true of
this repository today unless it is explicitly marked planned.

## Why not just save everything?

The obvious way to preserve an AI session is to keep all of it: the full
transcript, every message, nothing lost. It feels safe. It is the approach
most tools take, and it fails for a reason worth understanding, because the
whole design of this format follows from it.

Imagine handing a new colleague four hundred pages of raw meeting transcripts
and saying "you are taking over the project, it is all in there". Everything
IS in there. The decision that shaped the architecture is in there, on page
41, in a side remark, resolved after an argument that spans three meetings.
The approach that was tried and abandoned in week two is in there, but the
abandonment is on a different page than the attempt. Your colleague will read
the last thirty pages, form a picture from what is recent, and walk straight
into the abandoned approach by Friday.

A model reading a transcript tends toward the same failure. In a long
history, older but still binding decisions are hard to distinguish from
superseded discussion, and presence is not the same as weight. The failure
is specific and common: **what was said last can outweigh what was decided
long ago**, and the settled question from week three is often exactly the
one the new session cheerfully reopens.

Summaries rarely fix this, and they can industrialise it. A summary keeps
the recent narrative and compresses the old, and the reasons behind
decisions are often the first thing compression drops. What survives is
"we use X", not "we use X because Y failed under load in March, and here
is what that rules out".
A decision without its reason is a decision waiting to be relitigated.

So the format refuses the "save everything" premise. A handover is a
structured extraction with a fixed set of named sections, and the sections
exist precisely so that the important-but-old has a place it cannot be
compressed out of: every locked decision WITH its reason, every rejected
approach WITH what went wrong, every constraint WITH why it binds. The
extraction rule is enumerate, never summarise: a record per decision, however
old, because age is not unimportance. Age is usually what makes a decision
worth writing down.

## Drift, and the context ghost

Two failure modes have names in this project, because naming them is how you
design against them.

**Drift** is the slow slide away from established truth as a session runs on
or state passes between models. It is rarely dramatic. A port number quoted
as 5433 in week one gets "corrected" to the more common 5432 by a helpful
later model. A scoped rule ("never auto-deploy on Fridays") widens into a
blanket one ("never auto-deploy"). A term the project defined precisely gets
paraphrased into an ordinary word, and every later reference to it quietly
breaks. Each step is small and locally plausible, which is what makes drift
dangerous: nobody notices the moment the picture stopped being true.

The format's countermeasures are visible all through the spec: exact safe
values are kept verbatim because an exact anchor still works when context
degrades while a paraphrase decays into guesswork; the project's own
vocabulary is carried word for word, with meanings, enumerated rather than
sampled; time-bound statements are anchored ("at capture") so a later reader
cannot mistake last week's status for today's.

**The context ghost** is what you get when a transcript is replayed into a
fresh model in the hope of resurrecting a session. The new model produces
something that looks like the old session: same tone, same topics, fluent
references to recent messages. But it is an imitation assembled from the
surface of the conversation, not a continuation of its commitments. The
ghost knows what was talked about; it does not know what was DECIDED, which
alternatives are closed, or why. It feels right for five minutes and then
reopens a settled question, and the feeling of continuity is precisely what
makes the failure expensive: nobody double-checks a colleague who sounds
like they remember.

A handover is the alternative to the ghost: instead of the surface of the
conversation, the next model gets its commitments, stated as commitments.

## The handover document

![The whole handover flow on one page, left to right. One session, in whatever tool you use, holds the decisions and the reasons for them. The command soil save carries it through both gates into one JSON file, plain text on your own disk at a path under a home directory. The command soil load carries that file back through both gates into another session, in another tool or another model, which continues from there. The two gates are named but not enumerated here: the ingestion boundary reads the bytes before anything is parsed, and the validator reads the document once those bytes are a value. Both run in both directions, because a stored file is bytes again, so it is judged again on the way out; nothing is stored until both pass. The rule-by-rule detail is in the round trip diagram. There are two doors into one store: the soil command line, and a local MCP server that your client starts as a process on your own machine. After install, this round trip needs no account, no network and no telemetry.](diagrams/high-level-flow.svg)

One session, one file, another session. The two gates marked on the path are
enumerated rule by rule in [architecture.md](architecture.md).

A handover is one JSON file, readable by people as well as machines. The
format is versioned, published, and backed by a JSON Schema, with written
compatibility rules: additions are backward compatible within a major
version, and a reader refuses a major version it does not know rather than
guessing.

Each document carries a globally unique identity, assigned when it is
stored, which is separate from the short local code a store hands out for
typing. Identity survives copying, archival and migration.

Because the whole thing is a file, ordinary operations apply: keep handovers
in version control, retain them under your own policy, audit what a session
was told, move work between tools, providers and people by moving the file.
If the tool that wrote a handover disappears, the file remains a plain JSON
document that anything can read.

## Durable state and frontier state

The format separates what outlives a session from what does not. Durable
sections hold the project's accumulated truth: decisions, constraints,
architecture, rejected approaches. Frontier sections hold what was true at
the moment of capture: the task in flight, the blockers, the next steps. A
small third group describes the capture itself.

The separation is a format rule, not a writing convention, because mixing
the two is one of drift's main entry points: a new session reads last
month's status and reports it as today's. A reader of a handover is told,
structurally, which statements still hold and which describe a moment that
has passed.

## Declared gaps

Every handover declares all of its sections, including the empty ones. A
section with nothing in it says so, a section withheld on purpose says so,
and the extractor's own statement of what it could not capture travels with
the document, alongside any contradictions it saw but could not resolve.

This matters most when you did not write the handover yourself. A gap you
can see is recoverable: the next session knows to ask. A gap you cannot see
becomes a confident wrong answer. The format is deliberately built so that
an honest thin capture is never punished, because a format that rewards
looking complete teaches extraction to pad.

## Safety boundaries

A handover is written to be moved: into another tool, another provider,
sometimes another person's session. So conformant writers refuse, at write
time, any document that carries credential-shaped material or private
absolute paths. Nothing is stored, and the error names the kind of material,
never the value.

Meaning travels, values do not. "A payment provider key exists and is set in
the deployment platform" is a correct and useful sentence in a handover; the
key itself never is. The scan is pattern-based, which the documentation
states plainly: it is a net, not a guarantee. For a compliance review, the
relevant properties are that the refusal is fail-closed, that it is
observable behaviour, and that the conformance suite tests it directly.

## Conformance you can test

The format is a contract, not a product. Conformance is defined by
language-neutral fixtures anyone can run, and it comes in two separately
reported classes: a claim about documents (schema and semantics) and a claim
about writer behaviour (refusing credential-shaped material and storing
nothing).

Five implementations, in TypeScript, Python, Go, Kotlin and C#, pass the
same fixtures today, in continuous integration. That is the practical proof
that the format does not depend on any one codebase: a sixth implementation
claims compatibility by passing the same suite, on evidence rather than on
intent.

## Observations: evidence, not adjectives

Sections carry what a project KNOWS. There is a second kind of continuity,
harder to carry: how a project WORKS. Its decision style, what it refuses,
how it handles a blocker, the register it writes in. The sections describe
this where the project has stated it ("prefers direct answers", "always
tests before merging"), and descriptions are useful, but they have a known
weakness: a description can be complied with superficially. Hand an actor a
character sheet and you get someone playing the adjectives. Hand them
recorded footage of the character and something different happens: there is
now a concrete standard to match, and departures from it become visible.

That is what the observations extension point is for. A handover can carry
recorded EVIDENCE alongside its stated descriptions: not "this project
handles blockers directly" but an actual recorded instance of how this
project handled a blocker, captured at the time, attributed to whoever
recorded it. Three standard kinds exist today, defined in
[spec/observations.md](../spec/observations.md):

- **`quality.capture`**: a producer's statement about what the capture
  itself holds, for example which sections carry content and which are
  declared empty. It lets a reader weigh a handover before trusting it.
- **`load.outcome`**: the recorded result of one real load into one real
  target, for example which sections the receiving session actually put to
  use and where it struggled. History, never a promise: it says what
  happened once, not what will happen.
- **`working.style`**: recorded instances of the project's working patterns,
  as evidence beside the workflow section's stated rules.

Two of the three have a producer in this repository: `soil check --attach`
writes a `quality.capture`, and both MCP saves write a `working.style`.
`load.outcome` has none, and that is not an oversight to be tidied away. It is
the one kind whose evidence a save cannot manufacture, because it is the record
of a load that has actually happened into a target this repository does not
control. The slot is defined so that a producer who does run those loads has
somewhere honest to put the result; nothing here fills it, and a reader meeting
an entry of that kind is meeting a claim from somebody else.

The save flow records working-style instances itself, on both MCP surfaces.
Alongside the 17 sections, `soil_save` asks four fixed questions about how the
project actually worked in the thread being saved: how the last blocker was
handled, how conflicting instructions were resolved, how new work was checked
before it was trusted, and an assumption the thread made and how it was
caught. The answers, when the model gives any, ride as one `working.style`
observation attributed to whichever server recorded them; a save without
answers is stored exactly as before, and an unusable answer is dropped rather
than failing the save. At load, all three surfaces present the recorded
instances after the sections as attributed evidence: `soil_load` on the local
stdio server, `soil_load` on the self-hostable server, and the CLI's
`soil load`. All three get the block from the same assembler that builds the
rest of the prompt, so its heading carries that render's own marker, and where
an instance disagrees with the workflow section, the section wins.

Why this design should help a cold model, stated carefully. When a fresh
model loads a handover, everything it receives is instructions and
descriptions, and drift pressure applies to both. Evidence gives the model
something descriptions cannot: demonstrations to anchor against. It is
harder to slide away from a concrete recorded instance than from an
adjective, for the same reason the format prefers a verbatim port number to
"the usual port". The design bet is that demonstrations anchor where
descriptions merely suggest.

That is a design rationale, not a measured result: this repository does not
claim that observations reduce drift by any amount.
What the format commits to is narrower and fully testable: evidence travels
intact (unknown kinds pass through byte for byte), it is always attributed
to its producer, it is shown honestly as that producer's claim, nothing in
the format aggregates it into a grade, and the same safety rules apply
inside it. How evidence is produced is outside the format on purpose: the
format defines the container and its honesty rules, so that anyone's
tooling, including tooling that does not exist yet, can put evidence there
and any reader can weigh it.

For a reader of a loaded handover the practical effect is this: the next
model starts not only with what the project decided, but with attributed,
dated evidence of how the project actually behaves, and it is told exactly
what that evidence is and is not.

## Deployment models

Three ways to run the same format, picked by your situation rather than by
feature list.

**Local**, which is one person on one machine: the `soil` CLI and the local
stdio MCP server, both in this repository. After installation, saving and
loading are file operations under your own home directory, with no account,
no network use and no telemetry.

**The self-hostable server preview**, which is a team on hardware they run:
personal and shared project stores, bearer tokens the operator hands out, an
HTTP API and an experimental MCP endpoint, all in this repository. It is not
a hardened multi-tenant service.

**[Native Soil Cloud](https://nativesoil.dev)**, which is the hosted service:
zero-setup use, with accounts, sync and team projects. It is also the only
path for a client that runs purely in a browser or a phone app, because such
a client cannot start or reach a process on your machine.

All three run on the same file format: a handover stays a plain, versioned
JSON document that can be stored and processed independently of any hosted
service, and nothing in this repository calls Native Soil Cloud, needs it,
degrades without it, or expires.
