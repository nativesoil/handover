# Contributing

Thanks for looking. This repo holds a format other people's tools depend on, so
the bar is different in different parts of it: the spec changes slowly and on
evidence, the implementation changes like normal software.

## What is most useful

1. **A conformance fixture that catches something the suite misses.** The most
   valuable contribution here. A document that should be rejected and is not, or
   is rejected and should not be.
2. **An implementation in another language.** The format is plain JSON and the
   rules are short. See [conformance/README.md](conformance/README.md).
3. **Evidence that a rule is wrong.** A real handover that the format handles
   badly is worth more than an opinion about the format.
4. **Ordinary bugs and documentation fixes.** Always welcome, no ceremony.

## Proposing a spec change

Open an issue before writing code. A spec proposal needs four things:

**What breaks today.** A concrete case, ideally a real handover, where the format
loses something or forces a lie. "It would be cleaner if" is not a case.

**Which rule changes.** Name the section, field or requirement.

**Who it breaks.** Does an existing 1.x document stay valid? Does an existing
reader keep working? See [spec/versioning.md](spec/versioning.md) for what is
frozen for the whole 1.x line.

**Why not `observations`.** The extension point exists so that new evidence can
travel without changing the format. If a proposal can be an observation kind
instead of a spec change, it probably should be.

Two things that will not be accepted, so nobody wastes an afternoon:

- **A quality, score or grade field.** The absence of one is a design decision.
  Scoring a handover from inside the same file that wrote it is marking your own
  homework, and a format that offers the field will get the field filled in.
- **Anything that makes an honest gap look worse than a padded section.** The
  format is built so that "I could not capture this" is always safe to say. Every
  incentive here points at honesty, and that is deliberate.

## Changing the extraction recipe

The recipe in `packages/sdk-ts/src/recipe.ts` is authored text embedded verbatim,
and the same words are used in production. It is not code to be tidied.

- Do not reword a rule to read better. Rule wording is load-bearing, and the
  phrasings that look redundant are usually there because a model exploited the
  gap.
- A change needs a reason grounded in observed model behaviour: what a model did
  with the old wording and what it did with the new one.
- Deviations from the production wording are documented in a block at the top of
  the file. Add to it rather than editing silently.

## Code

- TypeScript, strict, ESM, Node 20 or newer.
- Zero runtime dependencies in the SDK. The CLI and MCP server depend only on the
  SDK. Adding a dependency to any of the three needs a reason in the pull
  request.
- Every package has tests. New behaviour comes with tests that would fail without
  it.
- Comments explain **why**. If a line needs a comment to say what it does, the
  line usually needs rewriting instead.
- Prettier is the formatter. `pnpm format` before committing. It has no parser
  for SVG, so the diagrams under `docs/diagrams/` are skipped in silence and
  `prettier --check .` passes over them whatever state they are in. They are
  formatted by hand; leave the indentation and the attribute order as you found
  them so the diff shows only what you changed.
- Relative links and image references are checked. `node scripts/check-links.mjs`
  fails on a target that is not in the tree and names it. `pnpm test` runs it.

Before opening a pull request:

```bash
pnpm build
pnpm test
pnpm conformance
```

All three must be green. `pnpm verify` runs them in order.

## Regenerating parity goldens

Some SDKs pin their output to the TypeScript SDK's, byte for byte, through
committed golden files. When the rendering or the recipes change, regenerate
rather than hand-edit:

- .NET: `pnpm build && node packages/sdk-dotnet/tools/generate-golden.mjs`
  rewrites `packages/sdk-dotnet/SoilHandover.Tests/golden/`.
- JVM: the parity resources in `packages/sdk-jvm/src/test/resources/parity/`
  are regenerated from the built TypeScript SDK the same way.
- Go: the embedded recipe copies in `packages/sdk-go/embedded/` must be
  updated whenever `recipes/` changes. The tests fail loudly otherwise.

## Prose style

The documentation in this repo is written to be read once, under time pressure,
by somebody whose thread just died. Three house rules:

- No em-dashes.
- Never describe anything in this repo as verified. Nothing here checks a
  handover's content, so the word would be a lie in a place where lies are
  expensive.
- **A count is derived or it is absent.** A number saying how many of something
  this repository has is a claim about the tree, and hand-written ones here
  have gone wrong repeatedly: per-runner check counts wrong by half, a diagram
  and a generator holding figures nothing derived, one count hiding behind ten
  different nouns, and a status count left behind the week a fourth status was
  added. If you write one, either derive it or leave the enumeration to do the
  work. `pnpm test` runs the checks that hold the counts we know about.

### Two things those checks cannot do for you

Read these before adding a number, because both are silent failures rather than
loud ones.

**A count whose noun no check knows is unchecked from the moment you write it.**
The checks match a fixed vocabulary — implementations, SDKs, runners, runtimes,
languages, sections, statuses, provenance labels, tools and a handful more. Write
"five backends" or "four writers of record" and nothing will ever compare it to
anything. If your count needs a noun that is not already in
`scripts/check-implementation-count.mjs` or `scripts/check-format-constants.mjs`,
add it there in the same change, or write the sentence without the number.

**A self-enumerating phrase is safe only while the list stays in the sentence.**
"three fixtures: just under it, exactly at it, and just over it" needs no check,
because the reader counts the list and the number cannot drift away from it
without the sentence visibly breaking. That protection is in the enumeration,
not in the number. Shorten it later to "three fixtures" and it becomes an
unchecked count, in an edit that looks like tidying. The checks print how many
such phrases they are leaving alone; if you take a list out, take its number out
with it.

## Commits and pull requests

Conventional-ish subjects (`fix(cli): ...`, `spec: ...`) are appreciated but not
enforced. What matters is that the body says why.

Keep a pull request to one thing. A spec change and a refactor in the same diff
gets reviewed twice as slowly and merged half as often.

## Contribution policy: DCO, inbound = outbound

Contributions are accepted under the [Developer Certificate of Origin](DCO.md)
and licensed inbound under the same Apache 2.0 license as the project. There
is no CLA and no copyright assignment: your contribution stays yours, licensed
to everyone under Apache 2.0, with your `Signed-off-by` line as the recorded
certification that you have the right to submit it. The license covers the
code and the specification text; the project's names and marks have their own
policy in [TRADEMARKS.md](TRADEMARKS.md).

Sign every commit: `git commit -s`. Pull requests with unsigned commits fail
the automated DCO check.

## Conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
