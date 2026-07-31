# Related work

Approaches that address the same loss of context this format addresses, and
where this format differs. Descriptions here are of approach categories, not
reviews of specific products; capabilities of individual tools change too
fast for a document like this to characterise them responsibly.

## Provider memory features

Most large assistant products now carry some form of built-in memory:
facts, preferences and project context retained across sessions to improve
continuity inside that product.

The difference is the boundary. A handover is a file you hold, designed to
cross tool, provider and account boundaries, and its entire content is
inspectable before it is given to anything. Whatever a product remembers
internally, this format's job starts where a product's own continuity ends:
at the switch to a different tool.

## Agent memory systems

A family of libraries and services gives agents long-term memory: stored
facts or embeddings, retrieved at runtime and injected into context. These
are runtime infrastructure, and good ones make a single agent noticeably
more capable.

A handover is not runtime infrastructure. It is an artifact: complete at
rest, readable without any retrieval service, and carried between systems
that share nothing but the ability to read JSON. The two compose rather
than compete; an agent with its own memory can still write a handover for
whatever comes after it.

## Manual handoff conventions

Many teams already keep a `HANDOFF.md` or notes file, written by hand or
requested from the model at the end of a session. This is the closest
relative, and the instinct is exactly right.

What a convention lacks is rules. A free-form document has no fixed
sections, so nothing is visibly missing; no time anchoring, so stale state
reads as current; no safety scan, so credentials travel by accident; and no
way for a second tool to rely on its shape. This format is that practice
with the missing rules added: declared sections, declared gaps, anchored
time, an enforced safety rule, and a conformance suite.

## Summarisation and compaction

Most tools compress the conversation when context runs out, and
summarisation is the default answer to "carry this to a new thread". It is
better than nothing and worse than it looks: a summary can preserve the
recent narrative while omitting older decisions, their reasons and the
rejected approaches, and it reports no gaps, so what was lost is invisible.

A handover captures working state instead of compressing a log, and where
it could not capture something, it says so.

## Session resume

Tools that restore their own previous sessions solve continuity within one
tool well. This format exists for the boundary those features stop at:
continuing in a different tool, on a different model, under a different
provider, or in a different person's hands.

## Where MCP fits

The [Model Context Protocol](https://modelcontextprotocol.io/) is not an
alternative to any of the above; it is the open standard this repo uses to
let assistants save and load handovers without copy-paste. The format does
not depend on it: the same round trip runs through the CLI, or through any
tool that reads and writes the documents.

## Summary of the differences

Relative to all of the above, this format commits to five things: working
state rather than a conversation log; gaps declared rather than silent; a
write-time safety rule that is enforced, not advised; a versioned,
schema-backed document with global identity; and conformance defined by
language-neutral fixtures that five implementations pass today.
