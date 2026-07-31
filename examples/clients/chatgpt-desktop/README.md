# ChatGPT desktop app

There is no configuration file to write; the desktop app takes the server as
a form. In Settings, open MCP servers, select Add server, and enter a name,
the STDIO type, and the command:

```text
name      soil
type      STDIO
command   node <checkout>/packages/mcp/bin/soil-mcp.js
```

Save, then select Restart when the app offers it; the connection starts after
that.

## What you should see

The server list shows `soil` enabled, `/mcp` in the composer lists it among
the connected servers, and in a conversation the three tools are available:
`soil_save`, `soil_load` and `soil_list`. A save ends in the receipt card
with a `#NNN` load code.

## The self-hostable server is not behind that form

The HTTP side of the form is not a way to
[the self-hostable server](../../../docs/server.md). Attaching a remote
server to ChatGPT runs through a connector flow that requires an OAuth
authorization server, and that server deliberately has none: bearer tokens
an operator hands out, shown once and stored hashed, are its whole
authentication. That is a scope choice, not an accident; ChatGPT reaches
the format through the hosted Native Soil connector instead, on the
client's rows on
[the compatibility page](../../../docs/compatibility.md#client-surfaces).

## Where the evidence stands

The form fields and the steps above come from
[OpenAI's MCP documentation](https://learn.chatgpt.com/docs/extend/mcp), read
on 2026-07-30, which documents the desktop app attaching STDIO servers run as
a local process and Streamable HTTP servers reached at an address. No run
through the desktop app is recorded in this repository, so this page claims
none; what has run for ChatGPT in the browser and on iOS, through the hosted
connector on the maintainers' word only, is on the client's rows on
[the compatibility page](../../../docs/compatibility.md#client-surfaces).
