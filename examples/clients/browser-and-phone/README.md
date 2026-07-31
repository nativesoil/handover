# In a browser or on a phone

ChatGPT and Claude in a browser or in their phone apps, Grok, Lovable, v0 and
Base44 run elsewhere: a page in a browser or an app on a phone cannot start a
process on your machine, so there is no local server to attach and nothing on
this page to configure. Two routes reach the format anyway, and the first one
asks nothing of the client but a text box.

## Copy and paste

The manual round trip runs from a terminal with a built checkout; the client
itself needs no account, no connector and no tools. Save, from the thread
that holds the work:

```bash
soil save        # prints the extraction recipe
```

Paste the whole recipe into the thread. The model answers with one JSON
block; paste that reply back:

```bash
soil save -      # paste the reply, then Ctrl-D
```

The receipt card prints with a `#NNN` load code. Later, in any of these
clients or anywhere else with a text box:

```bash
soil load '#001' # prints the card, then the restore prompt
```

Paste the restore prompt into the new thread and continue. `soil` here is the
CLI from a built checkout of this repository;
[the quickstart](../../../docs/quickstart.md) covers the alias and the store.
When a thread is dying and nothing can run, `soil rescue` prints a prompt a
model with no tools can still answer; paste its reply into `soil save -` and
you have a normal handover.

## The hosted route

These surfaces can also reach the format through the hosted Native Soil
connector, a separate service with accounts, whose code is not in this
repository and which nothing here calls; its connection steps live in that
service's own onboarding. Which of these clients have been exercised that
way, resting on the maintainers' internal log and on nothing a reader can
inspect, is on each client's rows on
[the compatibility page](../../../docs/compatibility.md#client-surfaces).

## Why the self-hostable server is not a third route

[The self-hostable server](../../../docs/server.md) changes none of this for
these clients. Connecting a remote server to ChatGPT or Claude runs through
a connector flow that requires an OAuth authorization server, and that
server deliberately has none: bearer tokens an operator hands out are its
whole authentication, which a configured header in a CLI or an editor can
send and these connector flows cannot. That is a scope choice, not an
accident; on these surfaces the format is reached by the two routes above.

## What you should see

The manual path has no tools to appear. What you see is the model's JSON
reply on the way out, the receipt card with a `#NNN` load code from
`soil save -`, and the restore prompt on the way back in. If the model in the
new thread can then say what the project is, which decisions bind and what
the next step is, the round trip held.
