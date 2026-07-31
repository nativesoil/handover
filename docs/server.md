# The self-hostable server preview

A self-hostable single-node server is available as a preview. It supports
personal and shared project stores, bearer-token authentication, an HTTP API
and an experimental MCP endpoint. It is not a hardened multi-tenant service.

`@nativesoil/handover-server` is that server: one machine, several people,
shared projects. A team or an organisation can run the whole handover
workflow on hardware they own, with nothing leaving it.

This is the middle of Soil Handover's three ways to run: more than the local
store one person keeps under `~/.soil` ([quickstart.md](quickstart.md)), and
deliberately less than the managed
[Native Soil Cloud](https://nativesoil.dev). All three read and write the
same document, so moving between them is moving files.

It is deliberately small. Users are rows in a JSON file, tokens are bearer
secrets the operator hands out, and every handover is a plain file in the same
on-disk format as the local `~/.soil` store, so any file can be copied out and
read anywhere, with or without this server.

## Five minutes to running

Run these from the root of a checkout of this repository. Nothing here is on a
package registry yet;
[install-with-an-agent.md](install-with-an-agent.md#packaged-cli) says what not
to write instead.

```console
$ pnpm install
$ pnpm build

$ node packages/server/bin/soil-server.js init
Initialised /home/ada/.soil-server.

Created user admin.

  Token: 4f0e...64 hex characters...9c1a

This token is shown once and is not stored on the server; only its hash is.
Give it to admin to use as: Authorization: Bearer <token>

  User id: 0198f2a1-... (stable; survives a rename)

$ node packages/server/bin/soil-server.js serve --port 8787
soil-server listening on http://127.0.0.1:8787, data in /home/ada/.soil-server
Bound to localhost only. To serve a network, put TLS in front and pass --host explicitly.
```

Everything the server stores lives under `SOIL_SERVER_HOME` (default
`~/.soil-server`), which is a different directory from the local `~/.soil`
store.

`pnpm build` is required: `bin/soil-server.js` runs the compiled `dist`. If it
is easier, put the binary on your path once with
`alias soil-server="node $PWD/packages/server/bin/soil-server.js"`; the rest of
this page writes `soil-server` for brevity.

Add people and a shared project (this is filesystem administration, done on
the machine itself, never over HTTP):

```console
$ soil-server user add ada
$ soil-server user add grace
$ soil-server project add team-x --members ada,grace --name "Team X"
Created project team-x (Team X) with members: ada, grace
```

Each `user add` prints that user's token exactly once, along with their user
id. A lost token is replaced with `user remove` followed by `user add`, which
is deliberately a _new account_: see "A username is a label" below.

That is the whole team setup: install, start, add each member once, hand each
their token once. From there the round trip is the same grammar the local
tools use. Each member points their client at `/v1/mcp` with their token (the
JSON block under "The MCP endpoint" below), and then ada tells her assistant
to save into `@team-x`; the `project` argument reads `"@team-x"` and
`"team-x"` as the same reference. Grace loads it back the same way:

> Save this into @team-x.

> Load #001 from @team-x.

A save with no project reference stays in that member's personal store, and a
reference to a project the member does not belong to answers like a project
that does not exist. Nothing about the shared store is configured on the
members' machines: the URL and the token are the whole client setup.

## Running a team: every operator task has a command

Nothing here needs a text editor, and every one of these commands takes the
same lock the running server takes, so they are safe to run against a live
server.

```console
$ soil-server user list
ada      0198f2a1-6c5e-7b41-9d2c-2a5e6f7b8c90  (created 2026-07-24T10:00:00.000Z)

$ soil-server user rename ada augusta        # the id, the store and every membership stay

$ soil-server project member add team-x grace
$ soil-server project member remove team-x grace
$ soil-server project remove team-x [--purge]

$ soil-server user remove grace [--purge]
$ soil-server migrate                        # only needed for a pre-user-id data directory
```

### What removing a member does to what is already stored

Decided, and enforced:

- **The project keeps every handover in it, including the ones the removed
  member wrote.** A shared project's knowledge belongs to the project, not to
  whoever typed it. Removing a person is not a way to delete their work, and a
  team that loses a leaver's handovers has lost exactly the thing this server
  exists to keep.
- **Their access ends on their next request.** Membership is read from disk on
  every single call, so there is no session to expire and no cache to clear.
  From then on the project answers them exactly like a project that does not
  exist: `404`, never `403`.
- **Their personal store is untouched.** It is theirs, and it was never in the
  project.

`user remove` does all of that for every project at once, and stops their token
authenticating. Their personal store stays on disk at `users/<user-id>`,
unreachable, until the operator deletes it; `--purge` deletes it in the same
breath. Removing a person from a team and destroying what they wrote are two
different decisions, and only the second one needs `--purge`.

### A username is a label, not an identity

Every user has a UUIDv7 user id, assigned once. The personal store directory is
that id, and project membership is a list of those ids. The username is a label
on top.

This matters because of what happens without it: remove `grace`, add `grace`
again for the next person with that handle, and the new person inherits the
previous one's entire personal store and every project they belonged to. With
ids, a released name carries nothing, and `user rename` moves no bytes at all.

A data directory created before this rule is `version: 1`. The server will not
serve it and the CLI will not read it; both say so and name `soil-server
migrate`, which assigns each user an id, moves each store from `users/<name>`
to `users/<id>`, rewrites the project member lists, and leaves tokens working.
Run it with the server stopped. It is idempotent.

## Two processes, one data directory

Every state change is a read-modify-write, and two processes doing that on one
directory at the same time (two containers on one volume, or an operator running
the admin CLI on a machine that is also serving) would otherwise lose data
silently: a save acknowledged and then overwritten, a receipt naming a load code
that afterwards holds somebody else's document, a `user add` answered yes that
leaves no row behind.

Every write runs inside an advisory lock, taken with `mkdir` on a directory
under `<home>/.locks`. The holder is identified by a random id, never a process
id, because two containers both running as pid 1 must not be able to look like
each other.

The same lock sits inside the SDK's `HandoverStore`, keyed on each store's own
root, which is what makes two `soil save` processes on one `~/.soil` safe as
well. They are one mechanism, `withLock` in `packages/sdk-ts/src/lock.ts`, taken
at two scopes: a lock around the server's call alone would leave the store's own
read-modify-write unguarded, and that path is reachable from the CLI.

**When the lock cannot be taken, the write is refused and nothing is written.**
The HTTP API answers `503` with `Retry-After: 1` and a body saying nothing was
stored; the MCP endpoint tells the model to call the tool again. A refusal a
caller can retry is honest; an acknowledgement for a write that did not survive
is not. A lock abandoned by a killed process is broken after 30 seconds.

Reads are not locked and do not need to be: every write lands through an atomic
rename, so a reader sees the whole old file or the whole new one.

This makes concurrent writers _safe_. It does not make them _fast_: waits are
synchronous, so a server waiting on another process's lock is not serving
anything else meanwhile. Held sections are a few file writes.

**The lock is not the only thing that occupies the process, and it is not the
first.** A save is validated before any lock is taken, and validation walks
every string in the document, including the secret scan. That work is
synchronous on a single-threaded runtime, so while it runs the server answers
nobody, including callers who wanted only to read.

The scan's patterns carry a ceiling on every repetition a backtracking engine
could be made to walk twice, so that walk is linear in the size of the document:
the cost is proportional and predictable, and the ceiling on it is the
serialized-document limit in
[`spec/ingestion.md`](../spec/ingestion.md) rather than anything per field.
[`spec/safety-patterns.md`](../spec/safety-patterns.md#why-the-repetitions-are-bounded)
states which repetitions carry a ceiling and what each one gives up for it.

The residual is worth stating plainly: a document at that ceiling, filled
entirely with the most expensive shape the scan has, costs a few hundred
milliseconds of scan on the request path. That is a bound, not a stall, but it
is time in which this server is serving nobody. A deployment that cares should
put a proxy limit in front of it, or accept the number.

## Request logging

One JSON line per request, on stdout:

```json
{
  "ts": "2026-07-24T10:00:00.000Z",
  "surface": "http",
  "action": "POST /v1/handovers",
  "userId": "0198f2a1-...",
  "username": "ada",
  "status": 201,
  "outcome": "ok",
  "project": "team-x",
  "code": "#001",
  "sections": 2,
  "durationMs": 4
}
```

MCP tool calls log the tool by name as well (`soil_save`, `soil_load`,
`soil_list`). Failures, refusals, `404`s and unauthorized attempts all get a
line; `SOIL_SERVER_LOG=none` turns request logging off.

A line never carries a token or a token hash (the hash _is_ the credential the
registry compares), never a word of a handover (not a section, not a title),
and never an absolute path. A load code, a project id and a section count say
what happened without saying what it said.

## The HTTP API

JSON in, JSON out, every route under `/v1`, every route behind
`Authorization: Bearer <token>`.

Save a handover document (the same format the local tools write):

```console
$ curl -s -X POST http://127.0.0.1:8787/v1/handovers \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"handover": {...a handover document...}, "project": "team-x"}'
{
  "code": "#001",
  "project": "team-x",
  "handoverId": "0198...",
  "projectId": "billing-rework",
  "title": "Billing rework, midpoint",
  "createdAt": "2026-07-24T10:00:00.000Z",
  "sections": {
    "withContent": 2,
    "missing": 15,
    "blocked": 0,
    "total": 17
  },
  "check": {
    "grade": "thin",
    "problems": 1,
    "cautions": 2,
    "advice": 0
  }
}
```

`withContent` counts sections holding a non-empty summary: structural content
presence, not completeness. There is no `captured` mirror of that number and no
`sectionsCaptured` key on a list row.

`check` is the open deterministic document check
([checking.md](checking.md)), run on what was just stored, exactly as a local
save runs it: the grade band and the finding counts, in `soil check`'s own
vocabulary. It is a report and nothing more. The grade never changes the
status code, a poorly graded save is still a `201`, because an honest gap
never blocks a save, and nothing from the report is written onto the
handover.

Leave `project` out (or send the document bare, with no wrapper) and the save
goes to your personal store. A document that fails validation, including the
fail-closed secret scan, is refused with `422` and the list of issues, and
nothing is written.

List everything you can see, load one back, see your projects:

```console
$ curl -s http://127.0.0.1:8787/v1/handovers      -H "Authorization: Bearer $TOKEN"
$ curl -s "http://127.0.0.1:8787/v1/handovers/%23001?project=team-x" \
    -H "Authorization: Bearer $TOKEN"
$ curl -s http://127.0.0.1:8787/v1/projects       -H "Authorization: Bearer $TOKEN"
```

A load answers with the stored document and its assembled restore prompt.
Codes are per store: `#001` in your personal store and `#001` in `team-x` are
different handovers, told apart by the `project` query parameter. `last` works
as a code. The `#` must be URL-encoded as `%23`, or just send `001`.

Membership is enforced on every project operation, and a project you are not
a member of answers exactly like a project that does not exist: `404`, never
`403`, so the responses reveal nothing about which project ids are in use.

Status codes: `401` no or wrong token, `400` a body the shared ingestion
boundary refuses (with its stable `code`, such as `encoding.byte_order_mark`,
`structure.duplicate_member`, `structure.depth_exceeded` or
`number.out_of_range`), `404` anything you cannot see, `413` a body over
1048576 bytes, `422` a refused save, `503` a contended write, `500` anything
else. And `500` is the whole of it, because an internal error message is not
something this server hands to a caller.

The `400` rules are not this server's own. `POST /v1/handovers` and
`POST /v1/mcp` hand their raw bytes to `ingestDocument` from
`@nativesoil/handover-sdk`, the same door the `soil` CLI, the local MCP server
and every language SDK go through, so a document this server accepts is a
document the others can read. The ceiling on a request body is the boundary's
own `INGEST_LIMITS.maxBytes`, which is why it is 1048576 bytes and not a
number chosen here.

## The MCP endpoint (experimental)

`POST /v1/mcp` speaks JSON-RPC per the MCP streamable HTTP transport basics:
`initialize`, `tools/list`, and `tools/call` for the same three tools as the
local stdio server (`soil_save`, `soil_load`, `soil_list`), each with an
optional `project` argument that addresses a shared project instead of the
caller's personal store.

One evidence note belongs right here rather than only on the compatibility
page: this endpoint is exercised by this repository's own test suite, and no
run by an external client against it is recorded in this repository yet. The
committed client sessions on [the compatibility page](compatibility.md) were
recorded against the local stdio server, not this one.

The same three tools means the same inputs and the same receipts: `soil_save`
here takes the 17 sections, the per-section status and provenance, the honesty
record, the safety record, attached observations and the four working-style
questions exactly as the local server does, and its receipt carries the same
`Checked at save` line, the open deterministic check's grade and finding
counts in the local receipt's own words, informing and never refusing a save.
`soil_load` here renders the recorded working-style instances as the same
attributed evidence block, from the same assembler, so one stored document
reads the same through the two surfaces.

Limitations, stated plainly: one request in, one response out. There is no
SSE stream, no server-initiated messages, and no session beyond the bearer
token. A client that requires the full streamable HTTP transport (resumable
streams, server notifications) will not get it here.

### Protocol versions, and the status you get back

This endpoint answers clients of two protocol eras and decides which from the
request in front of it. A request that declares
`io.modelcontextprotocol/protocolVersion` in `params._meta` is served under
`2026-07-28` with no handshake before it; anything else is a request from a
client that opens with `initialize`, and is served under `2025-06-18`,
`2025-03-26` or `2024-11-05` as its handshake settled. `server/discover`
reports the whole list.

The version key alone carries that decision, and that is a deliberate
divergence from the specification's letter, which reserves two per-request
keys and requires both on every modern request. A conforming `2026-07-28`
client must declare its protocol version on every request, so the version key
is the one reliable marker of a client that intends the new revision. Real
client runtimes send `io.modelcontextprotocol/clientCapabilities` alone, with
no version key, and are legacy clients in every other respect; reading that
shape as modern refused every call they made. A server's job is serving
clients, so a request carrying capabilities without a version is served as the
legacy request it otherwise is, byte for byte, and a request that declares the
version key is held to everything the revision requires, the accompanying
capabilities included.

The HTTP status says which of the two happened, because a client working out
what kind of server it reached reads the status before the body:

- `200` with a JSON-RPC result: the request was served. A tool that stored
  nothing still answers `200`, with `isError` inside the result, because the
  call was understood and did report its outcome.
- `202` with no body: a notification was accepted.
- `400` with a JSON-RPC error: the message was refused before it could be
  served. `-32602` when a request that declares the version key leaves out
  `io.modelcontextprotocol/clientCapabilities`, or when `server/discover`,
  which no legacy revision defines, arrives without the version key. `-32022`
  (`Unsupported protocol version`, with `data.supported` and `data.requested`)
  when it names a revision this endpoint will not speak, which is refused
  rather than quietly downgraded. `-32020` when a mirrored header disagrees
  with the body it copies, or when a `2026-07-28` request omits the
  `MCP-Protocol-Version` header. `-32600` when the body was not a JSON-RPC
  request at all, which matches the `400` a body that does not parse as JSON
  already got.
- `404` with a JSON-RPC error `-32601`: this endpoint does not implement that
  method. The body is what makes the status readable, because a client working
  out what it reached has to tell this from the `404` of an older server that
  does not host this endpoint at all.
- `500` with a JSON-RPC error `-32603`: the request was understood and this
  server then failed to complete it. Nothing was stored. The one entry here that
  is not the caller's fault, and the only one the transport says nothing about:
  it is `500` because that is what a proxy, a retry and a log can act on, and a
  `200` tells all three that the call succeeded. The sentence in the body is
  unchanged, and stays deliberately free of anything describing this machine.
- `401`, `403`, `405`, `413` and `503` as everywhere else on this server.

The status belongs to the error code, one at a time, and not to a class of
error. There is no rule here that every refusal is a `400`.

### The mirrored headers

The transport copies three body fields into headers so an intermediary can
route without parsing: `MCP-Protocol-Version` from the version in
`params._meta`, `Mcp-Method` from `method`, and `Mcp-Name` from the name a call
addresses. The body stays the source of truth.

Three rules cover them:

- **A header that contradicts its body is refused in either era**, with `-32020`
  and `400`, because that shape is a gateway acting on one value while this
  server acts on another, and that split belongs to no particular revision.
- **`Mcp-Method` and `Mcp-Name` are checked when sent and never required.**
  Absence is served, in either era.
- **`MCP-Protocol-Version` is required in the `2026-07-28` era.** A request
  whose body declares that version and omits the header is refused with the
  same `-32020`. A request that declares no version is a legacy request, and
  is served header or no header.

The second rule is a deliberate divergence from the specification's letter. The
transport requires all three headers on a modern request and lists a missing
standard header among the conditions a server must reject, alongside a wrong
one. Real client runtimes that carry the modern metadata in the body send no
mirrored headers at all, so requiring the two copies would refuse every call
those clients make, and the refusal would defend nothing: the body is the
source of truth, the copies exist so an intermediary can route without parsing,
and this server is not that intermediary. A copy that never arrived cannot
mislead a component into acting on it, where a copy that arrived saying
something else can, which is why the contradiction rule stays and the
requirement does not. A server whose job is serving clients takes the tolerant
reading.

`MCP-Protocol-Version` stays required in the modern era for the reason the
divergence does not reach it: the specification's permission to read an absent
version header as an older revision exists for clients that predate the header,
and it does not stretch to a body that declares `2026-07-28`, because reading
such a request as an older version would contradict the body.

Three cases pass untouched, and they are the same case three times over: a
header is a copy of a body field, so where there is no field there is no header,
in either direction.

- **A request that declares no version in its `_meta`.** Nothing for
  `MCP-Protocol-Version` to mirror, so it is not required and not read. Such a
  request is a legacy request, whatever else its `_meta` carries.
- **An `Mcp-Name` on a message that addresses nothing by name.** The header
  mirrors the name field of the calls the transport lists for it, and on anything
  else it is a copy of nothing.
- **A notification.** The transport states these requirements for requests and
  says plainly that it does not define them for a notification POST, so a
  notification is never refused for omitting one. One that sends a header
  contradicting its own body is still refused.

Only `Mcp-Name` is read through the `=?base64?...?=` sentinel, because it is the
only one of the three the transport allows a client to wrap. A protocol version
that arrives looking like a sentinel is a version that says that.

The transport is
[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http);
the eras and the negotiation rules are in
[Versioning and Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning).

Connect a client by giving it the URL and the token, for example:

```json
{
  "mcpServers": {
    "soil-team": {
      "url": "http://127.0.0.1:8787/v1/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## Storage layout

Plain files, owned by the operator, portable by construction:

```
~/.soil-server/
  users.json          user ids, usernames and token hashes; never a token
  projects.json       project ids, display names, member user ids
  .locks/             this server's write locks; empty except during a write
  users/<user-id>/    one personal store per user, keyed by the stable id
    index.json
    handovers/001.json
    .locks/           that store's own write lock, taken by the SDK
  projects/<id>/      one shared store per project
    index.json
    handovers/001.json
    .locks/
```

The per-user and per-project stores are byte-for-byte the same layout as the
local `~/.soil` store, `.locks` included: a local store carries the same
directory, because the SDK's `HandoverStore` takes its own lock around its own
read-modify-write. `.locks` is runtime state, never content. Copy a
`handovers/NNN.json` file anywhere and it is still a complete, readable
handover.

`projects/<id>` is also exactly what `soil project add` creates inside a local
store. That identity is the point, and a test holds it: a project container
written by the local tools is served by this server unchanged, and a project
this server stores reads back through the local tools unchanged. Moving a solo
project to a team is therefore not a migration: bring the containers into the
server's data directory, register each project and its members, and every
handover already in them is served as it stands. The registry files above are
the only thing the server adds, and they sit beside the stores, never inside
them.

The two locks are different scopes, not two mechanisms. The store's lock covers
one store's read-modify-write and is what makes the CLI safe; this server's
`<home>/.locks` covers the wider sections only the server has: a save plus the
read-back that proves the receipt, and a registry append. Both call the same
`withLock` in `packages/sdk-ts/src/lock.ts`, and they are always taken in that
order, so they cannot deadlock.

## Security posture

This is a single-node server preview, not a hardened multi-tenant service.
Concretely:

- It binds `127.0.0.1` by default. Serving a network is a deliberate act:
  pass `--host` and put TLS in front (a reverse proxy such as Caddy or nginx),
  because tokens travel in headers.
- A request that arrives with an `Origin` header is answered only when that
  origin is one the server recognises. Everything else gets `403`. See
  [Naming the origins you serve](#naming-the-origins-you-serve).
- Tokens are secrets. They are 256 random bits, shown once at creation, and
  stored only as SHA-256 hashes; authentication compares hashes in constant
  time. Whoever holds a token is that user.
- Tokens are also the whole of authentication, and that draws a line through
  clients. Anything that sends a configured `Authorization` header with a
  static bearer token connects: Claude Code, Codex CLI, Cursor, VS Code,
  Windsurf, Zed and the Gemini CLI all take such an MCP server entry.
  Consumer chat connectors that begin with an OAuth authorization flow, which
  is what ChatGPT's and claude.ai's do, cannot connect as built and reach the
  format through the hosted connector instead; that is the scope choice under
  "What is deliberately absent" below, not a gap waiting on work.
- Administration is filesystem access. There are no admin endpoints and no
  way to mint a token over the network; whoever can run `soil-server` on the
  machine is the operator.
- Isolation is by user id, checked on every call. Personal stores are separate
  directories, project access is a membership check against the caller's id,
  and a load code is parsed as an integer before it becomes a filename.
- Errors do not describe the machine. Both surfaces answer a failure with a
  generic sentence; the class of the failure goes in the operator's log. The
  format's own rule is that a private absolute path does not travel, and that
  does not stop being true because the thing that produced it was a stack
  trace.
- The server never phones anywhere. No telemetry, no update checks, no
  outbound connections of any kind.
- The data is plain files the operator owns, readable and movable without
  this software.

- Request bodies go through one ingestion door
  (`packages/server/src/ingest.ts`), and that door holds no rules of its own:
  it calls the shared pre-schema boundary every other surface calls, so the
  encoding rules, the depth ceiling, the duplicate-member-name rule and the
  numeric domain are the same here as in the CLI. The conformance suite's own
  boundary fixtures are driven through `POST /v1/handovers` and every verdict is
  pinned, so the network path and the local one cannot drift apart.

## Naming the origins you serve

Anything served from `localhost`, `127.0.0.1` or `[::1]` is recognised already,
on any scheme and any port. Name the rest:

```console
$ soil-server serve --port 8787 --allow-origin https://handovers.example
```

Each entry is a scheme, a host and a port, all three compared, so
`http://handovers.example` and `https://handovers.example:8443` are different
origins from the one above and stay refused. A request with no `Origin` at all
is served: that is every client this server has, since nothing but a browser
sends the header.

The reason the check exists is the one case binding loopback does not cover. A
page in a browser on this machine can reach a server on `127.0.0.1`, because the
attacker points a name they own at the loopback address and the browser goes
there. What the page cannot do is lie about where it came from, since the
browser fills the header in from where the page was loaded. That is also why a
page served from this machine is recognised without configuration: it is already
on this machine.

None of this is CORS, and no allow-origin header is ever sent back. The server
refusing to act is the whole mechanism.

## What is deliberately absent

No accounts beyond the operator's user list, no OAuth, no billing, no
telemetry, no accumulation or merging of project knowledge. A save validates,
scans, stores, counts sections and reports the open deterministic check's
grade, the same baseline every save runs everywhere; nothing deeper than
those documented rules measures anything here, and the grade informs without
ever refusing a save.

If you want the same open format with a managed service around it, the hosted
option at [nativesoil.dev](https://nativesoil.dev) exists for that; this
server is for running the open layer yourself.
