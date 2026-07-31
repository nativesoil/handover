# @nativesoil/handover-server

The self-hostable single-node server preview for the Soil Handover
Specification: bearer-token users, personal and shared project stores, an
HTTP API and an experimental MCP endpoint, all over the same plain-file
stores the local tools use. It is not a hardened multi-tenant service.

**Not published yet.** Run it from the root of a checkout of this repository.
[`docs/install-with-an-agent.md`](../../docs/install-with-an-agent.md#packaged-cli)
says what not to write instead, now and after publication.

```console
$ pnpm install && pnpm build
$ node packages/server/bin/soil-server.js init
$ node packages/server/bin/soil-server.js serve --port 8787
```

Full setup, the operator commands, curl examples, the storage layout and the
security posture are in [`docs/server.md`](../../docs/server.md).

- Binds `127.0.0.1` by default; put TLS in front for network use.
- Tokens are shown once and stored only as hashes.
- Users have a stable id, so a released username carries nothing with it.
- Every write is serialised by a lock, so two processes on one volume cannot
  lose each other's saves; a contended write is refused with `503`, never
  acknowledged.
- A save reports the open deterministic check's grade beside the section
  counts, the same baseline a local save reports; the grade informs, never
  blocks a save, and is never written onto the handover.
- One JSON log line per request, with no token and no handover content.
- Every handover is a plain JSON file in the same layout as `~/.soil`.
- The server never makes an outbound connection.

Apache-2.0, like the rest of this repository.
