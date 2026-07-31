# @nativesoil/handover-cli

The `soil` command. Save the project state, load it anywhere, see what survived.
Once installed, it needs no account, network or telemetry.

```
soil save                     print the extraction recipe to paste into your model
soil save -                   read the model's JSON reply on stdin and store it
soil save <file.json>         store a handover from a file
soil load [#NNN|last]         print the restore prompt for a stored handover
soil list                     list what is stored
soil validate <file|->        check a document against the spec
soil check <#NNN|file|->      check and grade a handover with deterministic rules
soil render <#NNN|file>       print the rail card for a handover
soil rescue                   print the prompt for a dead or full thread
soil where                    print the store location
```

Options: `--json` with load, render and check prints the raw document or
report, `--quiet` with save prints only the load code, which is what you want
in a script, and `--attach` with check on a stored code writes the report onto
the handover as a `quality.capture` observation. `-h`, `--help` and `-v`,
`--version` answer on their own and after any command.

An option a command does not take is refused by name and exits `2`. That is
what makes the options above worth anything in a script: a mistyped `--jsno`
is a failure you see, not a silent success printing a card at something that
asked for JSON.

## The round trip

```bash
soil save            # paste the recipe into the thread you want to keep
soil save -          # paste the model's reply back, Ctrl-D to finish
soil load '#001'     # anywhere else, in another tool or model
```

Quote the code or your shell eats the `#`.

## What a save reports

Sections carrying content out of 17, which sections are empty, which were held
back on purpose, and any gaps the capture stated. It counts structural content
presence, not sufficiency: a section holding one line counts like a section
holding a page. Grading is a separate, explicit step: `soil check` runs the open deterministic rules
documented in [docs/checking.md](../../docs/checking.md) and exits `0` for
`strong` or `adequate`, `1` for `thin` or `failing`, so a script can gate on
it. The grade is printed, never written onto the handover: `--attach` stores
counts, section names and individual rule outcomes, and no band. Whether a
handover actually restores a session is a different question, answered only
by a real load.

A save carrying a credential or a private absolute path is refused, nothing is
stored, and the message names the section and the class of material rather than
the value.

## What a load shows

`soil load` prints a card and the restore prompt. When the handover carries
`working.style` observations, recorded by the MCP server's save from four
fixed questions about how the project actually worked, the recorded instances
come last in the restore prompt, as a labelled block of attributed evidence:
named producer, dated, and framed so that where an instance disagrees with the
workflow section, the section wins. The block is assembled with the prompt, so
its heading carries the same per-render marker every other heading does and
nothing in a document can spell one. Evidence to weigh, not instructions to
follow, and nothing counts, scores or grades it. A handover without such
observations loads exactly as before.

## Where things live

`~/.soil`, or wherever `SOIL_HOME` points. Plain JSON files you can read with
`cat`. The MCP server in `@nativesoil/handover-mcp` uses the same store.

Full walkthrough: [docs/quickstart.md](../../docs/quickstart.md).
