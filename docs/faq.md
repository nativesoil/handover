# FAQ

### Do I use the CLI, the MCP server, or an SDK?

Pick by who is doing the work. The `soil` CLI is the manual path plus the
inspection tools. The MCP servers are the client integration, so the model
saves and loads without copy and paste. The SDKs are building material for
developers embedding the format. All of them read and write the same store
and the same format, so this is not a fork in the road.

### When is this repository enough, and when do I need Native Soil Cloud?

This repository is enough for one person on one machine (the CLI and the
local MCP server) and for a team on hardware it runs (the self-hostable
server preview). Native Soil Cloud is the hosted service: accounts, sync
across machines, team projects, and the only path for a client that runs
purely in a browser or a phone app, because such a client cannot start a
process on your machine.

### Is this not just a summary?

No, and the difference is the point. A summary can preserve the recent
narrative while omitting older decisions, their reasons and the approaches
already rejected. A handover keeps what was decided: the decision you locked
three weeks ago is exactly the one a summary tends to drop and the next session
reopens. The 17 sections exist so the things that reliably get lost each have
somewhere to go.

### Why 17 sections rather than a free-form document?

Because a free-form document has no empty slots, so nothing looks missing. With
named sections, "nobody wrote down the constraints" is visible on the card. The
structure is not there so machines can parse the content; the content is prose.
It is there so gaps show.

### Does this send my project anywhere?

No. The CLI and the MCP server read and write files under `~/.soil`. There is no
account, no network call, no telemetry, and no key to configure. You can run the
whole thing on a machine with no internet.

### Do I need an account?

Not for the CLI or the MCP server. There is nothing to sign up for and no
service to reach.

The self-hostable server in `packages/server` is the one thing here that has
users at all: whoever runs it creates them and hands out bearer tokens. That is
an account on your own machine, issued by you, not a sign-up with us. See
[server.md](server.md).

### What if my model writes a secret into a handover?

The save is refused and nothing is stored. The message names the section and the
class of material, never the value. A handover is written to be moved into
another model, usually at another vendor, so a credential inside one has already
left your machine. See [format.md](format.md#the-safety-rule-which-is-enforced).

Talking about a secret is fine and encouraged: "a provider API key exists and is
set in the deployment platform" is exactly right. Pasting it is not.

### What exactly does it refuse: the name or the value?

The value. Naming a credential type, a header or an environment variable is
safe and stays valid, and the format asks for exactly that in two places:
`architecture` wants flag and command names quoted exactly, and `safetySummary`
wants what was withheld and where it is configured. All of these are accepted:

- "The service uses an Authorization header."
- "GOOGLE_APPLICATION_CREDENTIALS is set outside the handover."
- "The client_secret value was intentionally omitted."
- "A provider API key exists and is set in the deployment platform."
- `Authorization: Bearer <token>` and `client_secret=YOUR_CLIENT_SECRET`
- `/home/ada/.soil-server`, using one of the reserved names in
  [spec/safety-patterns.md](../spec/safety-patterns.md)

What is refused is a value bound to one of those names, wherever it sits: in an
assignment, in a URL's `user:password@host`, in a header, in a code block or in
plain prose. A vendor token (`sk-…`, `ghp_…`, `AKIA…`, `xoxb-…`, `AIza…`) is
refused on sight, because there the string itself is the credential.

Saying the value was redacted does not buy an exemption. If the same sentence
carries the token, the sentence is refused: otherwise a disclaimer would be all
it took to move a live credential between vendors.

### The scan flagged something that is not a secret.

Check first whether a value really is bound to the name, because that is the
only thing the scan objects to. Every class, the sentences it must accept, and
what it is known to miss are written out in
[spec/safety-patterns.md](../spec/safety-patterns.md).

Two cases are genuine and deliberate. A home path using a username outside the
reserved list is refused, because nothing can tell an invented username from a
real one. An environment variable bound to a concrete path is refused, because
a bound value is a bound value. Both have an honest wording that is also the
better one: say where the thing is configured rather than pasting the path.

If you find a case that cannot be reworded honestly, open an issue with the
wording, never with the value.

### Does it catch every secret?

No, and nothing does. Patterns catch shapes, and a secret with no recognisable
shape passes. The real defense is the recipe telling the model to carry the
meaning and never the value. The scan is the net underneath it.

### Why does my save say "9 / 17" when the conversation was long?

Because eight sections had nothing the model could honestly put in them, which is
common and often correct. A short debugging thread has no architecture decisions
in it. If the number looks wrong for what was actually in the conversation, the
model under-captured: paste the recipe again and ask it to fill the named
sections. The card tells you which ones are empty.

### Is a low count bad?

It is a count, not a grade, and it counts structure rather than substance: a
section holding one line counts exactly like a section holding a page, so
17 of 17 is not a statement that anything is complete. A capture with 9
sections carrying content and a clear list of what is empty is more useful
than one with 17 where eight are padding. The format is deliberately built so that honesty is never punished,
because the moment it is, extraction starts optimising for looking complete.

### Does it tell me whether the handover will actually work?

`soil check` grades the document itself using deterministic, documented
rules, and prints that grade. It does not write the grade onto the handover:
what `--attach` stores is counts, section names and individual rule outcomes.
The band is derivable from those plus the published threshold, and
[checking.md](checking.md) says so out loud rather than pretending otherwise.
None of it proves that a target model will restore the project correctly.
Only a real load and recorded outcome can answer that.

### Can I edit a handover by hand?

Yes. It is JSON, and it is yours. Run `soil validate file.json` afterwards to
check you have not broken the shape. Keep in mind that a handover is a record of
what a session said at a moment, so heavy editing turns it into something else,
which may be exactly what you want or exactly what you do not.

### Can I keep them in git?

Yes, and several people do. A private repo of `~/.soil/handovers` gives you a
history of how a project's state actually moved. Read the documents before you
push them anywhere shared: the safety scan stops credentials, not
commercially-sensitive prose.

### What happens when the thread is already full and nothing will run?

`soil rescue` prints a prompt that asks for the same JSON in a shape a model with
no tools can produce. Paste the reply into `soil save -`. It becomes a normal
handover with a normal code.

### Which models does this work with?

Models that can follow a long instruction and emit JSON. The recipe is plain
text and the format is plain JSON. Stronger models write better handovers, mostly
because they enumerate decisions instead of summarising them. What works
where, and how each claim was proven, is in
[compatibility.md](compatibility.md). Before you trust a row, read its
evidence: that page separates what you can check yourself from what rests on
the maintainers' word, and keeps the two under their own headings.

### My model returned prose around the JSON.

That is handled. The CLI extracts the first fenced block, or falls back to the
outermost braces.

### Can I write my own implementation?

Yes, that is what the spec and the conformance suite are for. See
[conformance/README.md](../conformance/README.md). The format is JSON and the
rules are short, so a port is small.

### Why is `code` in the document if a store assigns it?

Convenience: a handover that has been stored carries the address it was stored
under, so a file you find later tells you what to type. An extractor never writes
it, and a document without one is perfectly valid.

### What is `observations` for?

Attaching evidence about the project or the capture without changing the
format. A small standard vocabulary is defined in
[spec/observations.md](../spec/observations.md): `quality.capture`,
`load.outcome` and `working.style`. Each kind says what an entry claims to be
and how a reader shows it, never how the evidence is produced, and nothing
turns one into a grade. A reader ignores kinds it does not recognise and
carries them forward. See [format.md](format.md#extension-point).

Two of the three are produced here: `soil check --attach` writes a
`quality.capture`, and both MCP saves write a `working.style`. `load.outcome` is
the slot for evidence only a real load into a real target can produce, so
nothing in this repository fills it, and the vocabulary exists for the producers
that can.

A rail card names what is attached and who attached it, on its `evidence` and
`recorded` rows. The payload is read with `soil load '#NNN' --json`, because
`data` is free-form and a renderer laying out a shape it has never seen would be
inventing one.

### Are the recorded working-style instances a score?

No. When you save through the MCP server, it asks four fixed questions about
how the project actually worked in that thread, and the answers travel on the
handover as one `working.style` observation: attributed to the server, dated,
and covered by the same secret scan as everything else. At load they are shown
as evidence beside the sections, and where an instance disagrees with the
workflow section, the section wins. Nothing counts, scores or grades them, the
answers are optional, and a save without them is stored exactly as before.

### Why Apache 2.0?

Because a format nobody can build on is not a format. The spec, the recipe, the
storage and the round trip are yours, permanently, including the patent grant.

### What is Native Soil Cloud?

A hosted option: accounts, sync across machines, shared team projects, and
support. Nothing in this repo calls it or needs it, and a handover written here
never expires or degrades.
