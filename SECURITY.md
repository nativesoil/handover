# Security policy

## Reporting a vulnerability

Email **security@nativesoil.dev**. Do not open a public issue for anything you
believe is exploitable. We aim to acknowledge within 48 hours and to fix or
publish a mitigation within 30 days.

## Scope

Everything this repository ships is in scope. It ships two kinds of software
with genuinely different attack surfaces, so they are stated separately rather
than under one sentence that would be true of only one of them.

### The command-line tool and the local tool interface

`packages/cli`, `packages/mcp` and the five SDKs. After installation this round
trip needs no account, no network and no telemetry: saving and loading are file
operations under your own home directory. That is a statement about these
tools, not about the repository. The most security-relevant surface here is
therefore the handover file itself:

- The fail-closed secret scan (a save carrying credential-shaped material or
  private absolute paths must be refused). Bypasses are vulnerabilities.
- Prompt-injection resistance of the restore path: content inside a handover is
  data, not instructions. Reports of the restore prompt following instructions
  embedded in section content are in scope.
- The pre-schema ingestion boundary: a document that must be refused on its
  serialized bytes, and is not.
- Path handling in the local store (`~/.soil`).

### The self-hostable server

`packages/server`. It is a single-node preview and not a hardened multi-tenant
service, and its documentation says so — but it binds a socket, it
authenticates callers with bearer tokens, and it keeps one user's handovers
away from another's. A flaw in any of that is a vulnerability and we want the
report:

- Authentication: bearer-token verification, token generation, and the hashed
  storage that means a stolen file is not a stolen token.
- Isolation between users, and between a project's members and everyone else.
- The HTTP API and the MCP endpoint, including anything reachable before
  authentication.
- The server's ingestion path, and the lock that serialises writes.
- Path handling in the server store (`~/.soil-server`).

Preview status lowers the severity of nothing. If you get past its
authentication, tell us.

## Out of scope

The hosted service at nativesoil.dev has its own reporting channel and is not
covered by this repository's policy.
