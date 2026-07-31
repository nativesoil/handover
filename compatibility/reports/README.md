# Compatibility reports

Per-environment report files land here, one file per real test session worth
recording. A report is the written-down evidence behind a row in
[environments.yaml](../environments.yaml) or
[integrations.yaml](../integrations.yaml): what ran, where, when, and what
did not run.

A report states, at minimum:

- the date the session ran
- the client and surface (and version, where known)
- the operations that were exercised
- the outcome, in plain terms
- limitations: what the session does not show

Reports describe single sessions and are never edited to say more than the
session showed. New evidence gets a new report. Rows in the YAML source
files link here, and [docs/compatibility.md](../../docs/compatibility.md),
the generated block in the root README, and
[readme-snippet.md](../readme-snippet.md) are all generated from those files.

A report is what moves a row off `maintainer-attested`. A session that
happened but produced nothing anyone else can read stays a maintainer
attestation, however real it was.

Naming: `<integration>-<client>.md`, lowercase, hyphenated, for example
`local-mcp-claude-code.md`.
