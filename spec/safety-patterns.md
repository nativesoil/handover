# Safety detection classes

Normative. This document defines what the safety rule in
[README.md](README.md) actually detects, class by class.

Each class is stated by **what material it detects**, by the **safe
near-neighbours** an implementation must accept, by the **required outcome**,
and by its **residual limitations**. The classes are normative. The fixtures
are minimum cases, not the definition: an implementation that recognises only
the published strings is not conformant, because the classes are what the rule
means and the fixtures are only the places where the boundary was pinned down.

The regular expressions in the official implementations are **not** normative.
An implementation MAY detect a class by any means that produces the required
result for every fixture. Parity between implementations is parity of
outcomes, never of algorithms: the five official SDKs use different regular
expression engines and must return the same verdict, with the same class name,
for every case here.

## The boundary

SAFE. These MUST be accepted:

- naming a credential type, for example "a provider API key exists"
- naming a header or an environment variable, with no value bound to it
- published placeholders
- explicit statements that a value was omitted or redacted
- exact flag and environment-variable names, without values

UNSAFE. These MUST be refused, wherever they appear — in an assignment, in a
URL, in a header, in a code block, or in unstructured text:

- high-confidence provider tokens
- assigned secret values
- bearer-token material
- private key material
- credentials embedded in URLs
- prohibited private absolute paths

The safe list is not a courtesy. Two of this specification's own section
requirements ask for exactly those sentences:
[sections.md](sections.md) tells `architecture` to carry "load-bearing safe
configuration values quoted exactly: ports, version pins, flag and command
names", and it tells `safetySummary` to carry "what was withheld, that it
exists, and where it is configured". A scanner that refuses those makes the
format contradict itself.

## Two detection mechanisms

**Mention matching.** The mention is the leak. Private-key armour, the JWT
shape and the vendor key prefixes have no innocent form: a string that looks
like one is one. These classes fire on sight and take no exemption.

**Value-shape matching.** The name is safe and the binding is the leak.
Authorization headers, client secrets, application-credentials and URL
userinfo fire only when a value is bound to the name. Private paths are a
value-shape match with a closed exemption list.

## The precedence rule

Text claiming redaction — _redacted_, _withheld_, _omitted_, _masked_ — MUST
NOT suppress a genuine detection in the same string. The conjunction is
refused, under the label of the class that detected the material.

Concretely: an exemption is judged against **the candidate value alone**,
never against the surrounding text. "The token was redacted:
`ghp_…`" is refused as `provider_api_key`, because the word _redacted_ is not
part of the token. This is the rule that stops a model from learning that a
disclaimer buys it an exemption.

## Reserved principal names

It is structurally impossible to tell an invented username from a real one.
`/Users/casey/...` could be a person or a placeholder, and no amount of
pattern work decides it. So the format publishes a closed list instead of
guessing, in the spirit of the reserved example domains.

The reserved principal names, **in force**:

| Name       | For                                         |
| ---------- | ------------------------------------------- |
| `agent`    | an agent container's home                   |
| `ada`      | the documentation's worked-example operator |
| `user`     | a generic single-user machine               |
| `username` | a generic single-user machine               |
| `you`      | a second-person instruction                 |
| `me`       | a first-person note                         |

A home path whose first component after `/Users/`, `/home/` or
`X:\Users\` is exactly one of these, compared case-insensitively against the
**whole** path component, is accepted. `/home/agent/.soil` is accepted;
`/home/agentic-runner/.soil` is refused, because the exemption is anchored to
the component, not to a prefix.

**Proposed, not in force: `example` and `examples`.** They belong on this list
on the merits, and the reserved example domains are the precedent. They are
not on it because conformance fixture
`conformance/fixtures/invalid/secret-private-path.json` currently requires
`/Users/example/Developer/orchard` to be REFUSED, and the inline case tables in
all five conformance runners require `it lives at /Users/example/code/app` to be
refused as `private_path`. Adding `example` to the list without changing those
fixtures would make every implementation fail its own suite. The proposed
change is: rewrite that fixture to use a non-reserved principal (`casey`), keep
it refused, and add a valid fixture using `/Users/example/...` that must be
accepted. **This change is not made here. It needs director sign-off, because a
conformance fixture is a published contract.**

Until then, documentation uses `ada`, `agent` or `user`.

---

## Class `private_key_pem`

**Detects.** PEM private-key armour: a `BEGIN … PRIVATE KEY` header, in any of
its variants (RSA, EC, OPENSSH, PKCS#8), case-insensitively. Mention matching:
nothing legitimate writes that armour into prose.

**Required safe near-neighbours.**

- "The signing key is a PEM private key held in the platform's secret manager."
- "The deploy uses an RSA private key. Its value is not carried here."

**Required outcome.** Refused as `private_key_pem`. Fail closed: nothing is
stored, and the error names the class and the section, never the value.

**Residual limitations.** A private key with its armour stripped — the base64
body alone — is not detected. Neither is a key rendered as an escaped
one-line JSON string with the armour rewritten. Armour carrying more than 32
characters of label between `BEGIN ` and `PRIVATE KEY` is not detected; the
longest label in use is `ENCRYPTED ` at ten, and the ceiling is what keeps
the scan linear (see [Why the repetitions are
bounded](#why-the-repetitions-are-bounded)).

## Class `authorization_header`

**Detects.** An `Authorization` header name followed by a colon and a
credential: a value long enough to be one, optionally after a scheme keyword
(`Bearer`, `Basic`, `Token`, `Digest`, `ApiKey`). Value-shape matching.

**Required safe near-neighbours.**

- "The service uses an Authorization header." — the name, with nothing bound
- `` `Authorization: Bearer <token>` `` — a published placeholder
- `-H "Authorization: Bearer $TOKEN"` — a shell variable, not a value

**Required outcome.** `Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1lMTIzNDU2`
is refused as `authorization_header`. The three near-neighbours are accepted.

**Residual limitations.** A header split across lines, or written with the
name and the value in separate sentences, is not detected. A very short
credential — under sixteen characters — is not detected by this class, on the
grounds that the false-positive cost of a lower floor exceeds its value.
More than 32 spaces or tabs at any one of the three points where the header
permits whitespace is not detected by this class; HTTP writes one or none and
forbids any before the colon, and the `Bearer` spelling of that string is
still refused as `bearer_token`. The ceiling is what keeps the scan linear
(see [Why the repetitions are bounded](#why-the-repetitions-are-bounded)).

## Class `bearer_token`

**Detects.** The word `Bearer` followed by whitespace and token material long
enough to be a token. Value-shape matching.

**Required safe near-neighbours.**

- "The endpoint expects bearer credentials; the token is not carried here."
- "The API uses Bearer token authentication."

**Required outcome.** `Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e` is refused as
`bearer_token`. Ordinary English words after `Bearer` are accepted: the floor
is set above the length of the words that actually appear there.

**Residual limitations.** The length floor is the whole defence against
prose. A short opaque token written after the word `Bearer` passes. A token
carried without the word `Bearer` anywhere near it is the job of the vendor
classes, not this one.

## Class `jwt`

**Detects.** Three base64url segments separated by dots, beginning `eyJ` —
the shape of a JSON Web Token whose header decodes to a JSON object. Mention
matching.

**Required safe near-neighbours.**

- "Login returns a JWT; the value is not carried here."
- "Sessions are JWT-based with a fifteen-minute expiry."

**Required outcome.** Refused as `jwt`.

**Residual limitations.** A JWT whose header does not begin `eyJ` — an
unusual but legal encoding — is not detected. A truncated JWT with one
segment removed is not detected, and may still be sensitive. A token whose
header segment runs past 256 base64url characters is not detected, which
means one embedding a certificate chain (`x5c`) or a public key (`jwk`)
rather than carrying `alg`, `typ` and `kid`; a token with an ordinary header
is detected however long its payload or signature. The ceiling is what keeps
the scan linear (see [Why the repetitions are
bounded](#why-the-repetitions-are-bounded)).

## Class `provider_api_key`

**Detects.** High-confidence vendor token formats, on sight, wherever they
appear. Mention matching. At minimum:

| Format                        | Example prefix                              |
| ----------------------------- | ------------------------------------------- |
| `sk-` provider keys           | `sk-…`                                      |
| GitHub personal access tokens | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`      |
| GitHub fine-grained tokens    | `github_pat_…`                              |
| AWS access-key ids            | `AKIA` + 16 uppercase, `ASIA` + 16          |
| Slack tokens                  | `xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`, `xoxs-` |
| Google API keys               | `AIza` + 35                                 |

These are refused inside a URL, inside a code block and inside prose alike. A
GitHub token written as the userinfo of a clone URL is the same token.

**Required safe near-neighbours.**

- "A provider API key exists and is set in the deployment platform."
- "The CI job reads a GitHub token from the repository secrets."
- "We authenticate to AWS with an access key held in the runner environment."

**Required outcome.** Refused as `provider_api_key`, including when the same
string claims the value was redacted.

**Residual limitations.** The list is a list. A vendor format not on it
passes, and new formats appear continuously. Adding a format is additive and
never a breaking change to the specification. The canonical vendor
_documentation_ examples — AWS publishes `AKIAIOSFODNN7EXAMPLE` — are refused
along with everything else, deliberately: an implementation that special-cases
them has to decide which strings are real, which is the thing that cannot be
decided.

## Class `client_secret`

**Detects.** A `client_secret` or `client-secret` name with a value bound to
it by `=` or `:`, in an assignment, a JSON member or a query string. Value-shape
matching.

**Required safe near-neighbours.**

- "The client_secret value was intentionally omitted."
- "The client_secret is rotated monthly."
- `client_secret=YOUR_CLIENT_SECRET` — a published placeholder
- "| `client_secret` | OAuth client-secret material |" — a documentation table

**Required outcome.** `client_secret=9f8a7b6c5d4e3f2a1b0c` and
`"client_secret": "9f8a7b6c5d4e3f2a1b0c"` are refused as `client_secret`. The
four near-neighbours are accepted.

**Residual limitations.** A client secret bound to a differently-named
variable is invisible to this class. A short secret — under eight characters —
is not detected. A placeholder built from words outside the published
placeholder vocabulary is refused; the remedy is to state the omission in
prose, which the format prefers anyway.

## Class `google_application_credentials`

**Detects.** Two things. An assignment binding a value to
`GOOGLE_APPLICATION_CREDENTIALS`, and inline service-account material — a JSON
object declaring `"type": "service_account"`. Value-shape matching.

**Required safe near-neighbours.**

- "GOOGLE_APPLICATION_CREDENTIALS is set outside the handover."
- "The runner authenticates with a Google service account; the key is not
  carried here."
- `GOOGLE_APPLICATION_CREDENTIALS=REDACTED` — an explicit omission

**Required outcome.** `GOOGLE_APPLICATION_CREDENTIALS=/opt/keys/sa.json` and
`{"type": "service_account", …}` are refused as
`google_application_credentials`.

**Residual limitations.** The assignment form refuses any bound value,
including a documented example path that carries no secret. That is the cost
of stating the boundary as "a value is bound to the name": write the sentence
instead, or use a published placeholder. Service-account material rendered
without the `type` member is not detected.

## Class `private_path`

**Detects.** An absolute path rooted in a user's home directory:
`/Users/<principal>`, `/home/<principal>` or `X:\Users\<principal>`, where
`<principal>` is not a reserved principal name. Value-shape matching with a
closed exemption list.

**Required safe near-neighbours.**

- `/home/ada/.soil-server` — a reserved principal
- `/home/agent/.soil` — a reserved principal
- `C:\Users\user\.soil` — a reserved principal
- `src/checkout/window.ts` — a relative path
- `/opt/orchard/config` — an absolute path outside any home directory

**Required outcome.** `/Users/casey/Developer/thing`, `/home/deploy/app` and
`C:\Users\casey\project` are refused as `private_path`. The five
near-neighbours are accepted.

**Residual limitations.** A reserved name may collide with a real username;
`/Users/ada/...` belonging to a real Ada is accepted and leaks. That is the
accepted cost of publishing a list, and it is the same trade the reserved
example domains make. Home directories under other roots — `/var/home`,
`/export/home`, a mounted profile — are not detected. A path shortened to
`~/Developer/thing` is not detected, and is the form the format prefers.

## Class `url_credentials`

**Detects.** Credentials in a URL's userinfo component:
`scheme://user:password@host`. Value-shape matching.

**Required safe near-neighbours.**

- `https://example.com/docs` — no userinfo
- `http://127.0.0.1:8787/v1/handovers` — a port is not a password
- `postgres://app:password@db.internal:5432/app` — a published placeholder
- `redis://:${REDIS_PASSWORD}@cache` — a variable reference, not a value

**Required outcome.**
`postgres://orchard:9f8a7b6c5d4e3f@db.internal:5432/orchard` is refused as
`url_credentials`. The four near-neighbours are accepted.

**Residual limitations.** A userinfo component with no colon — a bare token
as the username, `https://<token>@github.com/...` — is not detected by this
class. It is detected by `provider_api_key` when the token is in a recognised
vendor format, and not at all when it is not. Percent-encoded credentials
whose encoding hides the colon are not detected.

---

## Why the repetitions are bounded

Several classes above state a ceiling among their residual limitations. The
ceilings are not part of what a class means, and a port is free to detect the
same class without them. They are recorded here because they are the one place
where an implementation detail is allowed to narrow a class, and a reader
comparing two implementations should be able to see why.

The scan runs on every string in a document, and in the server preview it runs
synchronously on the request path. Most regular expression engines backtrack:
of the official implementations, only the Go SDK's does not. On a backtracking
engine a repetition the engine can be made to walk more than once costs time
quadratic in the length of the string, and a single document string can reach
most of the whole-document ceiling in `spec/ingestion.md`. There are two ways
to arrange it, and both are reachable from ordinary document content:

- **Split enumeration.** Two repetitions that can both consume the same
  character, with only an optional element between them, make the engine try
  every way of dividing one run between them.
- **Anchor multiplicity.** A literal anchor built out of characters that the
  repetition following it also accepts recurs every few characters in a run
  made of that anchor, and each occurrence starts a fresh scan of the rest.

Bounding a repetition turns either into a fixed cost per starting position,
which makes the scan linear. Each ceiling is set well above the longest real
instance of the thing it bounds, so no string a credential can actually take
changes verdict, and what it does give up is written into the residual
limitations of its class rather than left for somebody to discover.

Not every repetition needs a ceiling. One with nothing after it is walked once
and never divided, because nothing follows it that can fail and send the engine
back: the length floor closing a value, or the repetition closing a private
path. One reachable only after an already-bounded repetition has succeeded is
safe for the same reason, since the bound in front of it caps how many starting
positions can reach it. A ceiling where none is needed narrows a class for
nothing, so the classes above state only the ones that are load-bearing.

One practical constraint on any implementation doing this: Go's RE2 rejects a
repeat count over 1000 when it compiles the expression, so a ceiling has to be
either small or absent. That is a second reason the ceilings above are set
where they are.

## Published placeholders

A candidate value is treated as a published placeholder, and accepted, when it
is built only from placeholder words joined by `-`, `_` or `.`, or when it is a
run of `x`, `*`, `.`, `-` or `_`. The vocabulary includes _redacted_,
_withheld_, _omitted_, _masked_, _removed_, _placeholder_, _changeme_, _none_,
_null_, _todo_, _your_, _my_, _the_, _example_, _sample_, _dummy_, _test_,
_fake_, _token_, _secret_, _api_, _key_, _client_, _id_, _value_, _password_,
_pass_, _user_, _username_, _here_, _goes_ and _xxx_, compared
case-insensitively, with one trailing sentence mark allowed.

Placeholder syntax that uses punctuation — `<token>`, `${TOKEN}`, `{{TOKEN}}`,
`$TOKEN` — needs no vocabulary at all: those characters cannot appear in a
credential value as the classes define one, so the shape never matches.

Residual limitation: a real secret that happens to read as placeholder words —
a password literally set to `password` — is accepted. Documentation writes
those strings constantly and real deployments should not, so the trade is
deliberate.

## What the whole rule does not do

It does not catch every secret. A credential with no recognisable shape passes
every class here, and no scanner catches those. The real defence is RULE 2 of
the extraction recipe, which tells the model to carry the meaning and never the
value. This is the net underneath it.

It does not redact, rewrite or partially store. It refuses, and hands the
problem back with the class and the location named — never the value, because
an error message is another place a secret can end up.
