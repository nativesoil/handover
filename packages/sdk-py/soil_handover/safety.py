"""The secret scan: a handover that carries credentials is not portable.

A handover is written to be moved. It goes into a second model, often at a
second vendor, sometimes into a teammate's session. Anything inside it has
left the machine it was written on. So a document carrying an API key, a
bearer token, a private key or a private absolute path is not a handover with
a small problem, it is a credential in transit, and this implementation
refuses to store one.

The rule is fail-closed and it is normative: see ``spec/README.md``. The
detection classes, their required safe near-neighbours and their residual
limitations are stated in ``spec/safety-patterns.md``. It is a spec rule
rather than a schema rule because JSON Schema cannot express "this string
looks like a token", which is exactly why the conformance suite checks it
separately.

What this scan is and is not:

- It refuses transferable authentication material, not the subject of a
  sentence. Naming a credential type, a header or an environment variable
  without binding a value to it is safe and stays valid, because two of the
  format's own section requirements ask for exactly that.
- It refuses that material wherever it appears: in an assignment, in a URL, in
  a header, in a code block or in unstructured prose.
- It is not a guarantee. A secret with no recognisable shape passes, and no
  scanner catches those. RULE 2 in the extraction recipe is the real defense:
  carry the meaning, never the value. This is the net underneath.
- It never echoes what it matched. A finding names the pattern class and the
  section, never the value, because an error message is another place a
  secret can end up.

Two mechanisms, and the difference matters. Private-key armour, JWT shape and
the vendor key prefixes are MENTION matches: there the mention is the leak.
Authorization headers, client secrets, application-credentials and URL
userinfo are VALUE-SHAPE matches: they fire only when a value is bound to the
name. Private paths are a value-shape match with a closed exemption list of
reserved principal names that documentation may use.

Parity with ``packages/sdk-ts/src/safety.ts`` is a parity of OUTCOMES: the
same inputs are refused with the same class reported, and the conformance
fixtures hold both to it. The expressions themselves are not normative.

NO REPETITION HERE MAY BE RESCANNED. ``re`` backtracks, and on a backtracking
engine a repetition the engine can be made to walk more than once costs
quadratic time in two ways, both reachable from one document string: SPLIT
ENUMERATION, where two repetitions that can consume the same character with
only an optional element between them make the engine try every division of a
run; and ANCHOR MULTIPLICITY, where a literal anchor built from characters the
following repetition accepts recurs every few characters and each occurrence
starts a fresh scan. Bounding turns both into a constant per starting
position. This module is the worst of the five for it: measured on 16000
characters of whitespace after ``Authorization:``, ``re`` took 2067 ms where
Node took 633 ms and Go's non-backtracking RE2 took 4 ms. The ceilings match
``safety.ts`` exactly and are documented there.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

# The most whitespace allowed where a header permits optional whitespace.
# HTTP writes one space or none and forbids any before the colon.
_OWS = r"[ \t]{0,32}"

# The most characters allowed between `BEGIN ` and `PRIVATE KEY` in PEM
# armour. The longest label in use is `ENCRYPTED ` at ten.
_PEM_LABEL_MAX = 32

# The ceiling on a JWT's header segment, in base64url characters. Only this
# segment needs one: it bounds the scan looking for the FIRST dot, which is
# the scan a run of `eyJ` can restart every three characters. The payload and
# signature stay open, which keeps the class exact and is also the only form
# Go's RE2 can compile, since it refuses a repeat count over 1000.
_JWT_HEADER_MAX = 256

# Characters that can appear inside transferable authentication material.
# Deliberately excludes the punctuation placeholder syntax is made of (`<`,
# `>`, `$`, `{`, `}`), so `Bearer <token>` and `client_secret=${VALUE}` never
# look like values in the first place.
_VALUE = r"[A-Za-z0-9._~+/=-]"

# The same, widened for a filesystem path or URI bound to a variable.
_PATH_VALUE = r"[A-Za-z0-9._~+/=:\\-]"

# Words a published placeholder is made of. A candidate value built only from
# these, joined by `-`, `_` or `.`, is documentation rather than a credential.
_PLACEHOLDER_WORD = (
    r"(?:redacted|withheld|omitted|masked|removed|placeholder|changeme|none"
    r"|null|nil|na|todo|tbd|your|my|the|example|sample|dummy|test|fake|token"
    r"|tokens|secret|secrets|api|apikey|key|keys|client|id|value|password"
    r"|passwd|pass|user|username|here|goes|xxx)"
)

# A candidate value that is a published placeholder or an explicit statement
# that the value was left out. Applied to the captured value alone, never to
# the surrounding string: a redaction claim elsewhere in the same text must
# never suppress a genuine detection. See the precedence rule in
# ``spec/safety-patterns.md``.
_PLACEHOLDER_VALUE = re.compile(
    r"^(?:x{3,}|\*{3,}|\.{3,}|-{3,}|_{3,}|"
    + _PLACEHOLDER_WORD
    + r"(?:[-_.]"
    + _PLACEHOLDER_WORD
    + r")*)[.,;:!?]?$",
    re.IGNORECASE,
)

# The reserved principal names, published so documentation has home paths it
# can write down. It is structurally impossible to tell an invented username
# from a real one, so the format reserves a closed list instead of guessing,
# in the spirit of the reserved example domains.
#
# `example` is NOT on this list yet: conformance fixture
# `invalid/secret-private-path.json` currently requires `/Users/example/...`
# to be refused. The addition is proposed in `spec/safety-patterns.md` and
# waits on sign-off.
RESERVED_PRINCIPAL_NAMES: tuple[str, ...] = (
    "agent",
    "ada",
    "user",
    "username",
    "you",
    "me",
)

_RESERVED_PRINCIPAL = re.compile(
    r"^(?:" + "|".join(RESERVED_PRINCIPAL_NAMES) + r")$", re.IGNORECASE
)


@dataclass(frozen=True)
class SecretPattern:
    """A named pattern. The label is stable and safe to show a user."""

    # Stable class name, e.g. `provider_api_key`. Never the matched text.
    label: str
    # What the class means, for an error message a person has to act on.
    description: str
    pattern: re.Pattern[str]
    # Applied to one capture group of a match, never to the whole string. When
    # it matches, that match is documentation rather than a credential and is
    # skipped; other matches in the same string are still judged on their own.
    exempt: re.Pattern[str] | None = None
    # Which capture group ``exempt`` judges.
    exempt_group: int = 1


# The patterns applied to every string in a handover.
SECRET_PATTERNS: tuple[SecretPattern, ...] = (
    SecretPattern(
        label="private_key_pem",
        description="a PEM-encoded private key",
        # ANCHOR MULTIPLICITY: `BEGIN ` is made of characters the label
        # repetition accepts, so a run built out of it puts an anchor every
        # six characters. Given up: armour with a label over 32 characters,
        # which no PEM variant in use has.
        pattern=re.compile(
            r"BEGIN [A-Z ]{0," + str(_PEM_LABEL_MAX) + r"}PRIVATE KEY",
            re.IGNORECASE,
        ),
    ),
    SecretPattern(
        label="authorization_header",
        description="an authorization header carrying a credential",
        # SPLIT ENUMERATION: the two runs of optional whitespace straddling
        # the optional scheme keyword can both consume the same space. Given
        # up: a header separated by more than 32 spaces or tabs at one of
        # those points; the `Bearer` form is still caught by `bearer_token`.
        pattern=re.compile(
            r"Authorization" + _OWS + r":" + _OWS
            + r"(?:Bearer|Basic|Token|Digest|ApiKey|Api-Key)?" + _OWS
            + r"(" + _VALUE + r"{16,})",
            re.IGNORECASE,
        ),
        exempt=_PLACEHOLDER_VALUE,
    ),
    SecretPattern(
        label="bearer_token",
        description="a bearer token",
        pattern=re.compile(
            r"Bearer[ \t]+(" + _VALUE + r"{20,})", re.IGNORECASE
        ),
        exempt=_PLACEHOLDER_VALUE,
    ),
    SecretPattern(
        label="jwt",
        description="a JSON web token",
        # ANCHOR MULTIPLICITY: `eyJ` is made of characters the segment
        # repetition accepts, so `eyJ` repeated puts an anchor every three
        # characters, each rescanning for a dot that is not there. Given up: a
        # token whose header segment runs past 256 base64url characters, which
        # means one embedding a certificate chain (`x5c`) or key (`jwk`).
        pattern=re.compile(
            r"eyJ[A-Za-z0-9_-]{1," + str(_JWT_HEADER_MAX) + r"}"
            r"\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"
        ),
    ),
    SecretPattern(
        label="provider_api_key",
        description="a provider API key or access-key id in a vendor format",
        pattern=re.compile(
            r"(?:\bsk-[A-Za-z0-9]"
            r"|\bgh[pousr]_[A-Za-z0-9]{36,}"
            r"|\bgithub_pat_[A-Za-z0-9_]{22,}"
            r"|\b(?:AKIA|ASIA)[0-9A-Z]{16}"
            r"|\bxox[baprs]-[A-Za-z0-9-]{10,}"
            r"|\bAIza[0-9A-Za-z_-]{35})"
        ),
    ),
    SecretPattern(
        label="client_secret",
        description="a client secret bound to a value",
        # Measured linear before the change: the binding operator
        # disambiguates the two runs. Bounded anyway, so that inserting an
        # optional element between them later cannot recreate the fault.
        pattern=re.compile(
            r"client[_-]?secret[\"']?" + _OWS + r"[:=]" + _OWS + r"[\"']?"
            r"(" + _VALUE + r"{8,})",
            re.IGNORECASE,
        ),
        exempt=_PLACEHOLDER_VALUE,
    ),
    SecretPattern(
        label="google_application_credentials",
        description="application-credentials material bound to a value",
        # Bounded on the same ceiling and for the same prophylactic reason as
        # `client_secret`; both forms measured linear before the change.
        pattern=re.compile(
            r"(?:GOOGLE_APPLICATION_CREDENTIALS[\"']?" + _OWS + r"[:=]" + _OWS
            + r"[\"']?"
            r"(" + _PATH_VALUE + r"{4,})"
            r"|\"type\"" + _OWS + r":" + _OWS + r"\"service_account\")"
        ),
        exempt=_PLACEHOLDER_VALUE,
    ),
    SecretPattern(
        label="private_path",
        description=(
            "an absolute path inside a home directory or a Windows drive root"
        ),
        pattern=re.compile(
            r"(?:/Users/|/home/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)"
        ),
        exempt=_RESERVED_PRINCIPAL,
    ),
    SecretPattern(
        label="url_credentials",
        description="credentials embedded in a URL",
        # The scheme name is bounded rather than open-ended. An unbounded
        # leading repetition has to be retried from every character of the
        # subject, and on a long run of scheme-legal characters that costs
        # O(n^2) on a backtracking engine: a one-megabyte document takes tens
        # of minutes. The ceiling is 32, well above every registered URI
        # scheme, so no reachable input changes verdict.
        pattern=re.compile(
            r"[a-zA-Z][a-zA-Z0-9+.-]{0,31}://[A-Za-z0-9._~%+-]+"
            r":([A-Za-z0-9._~%+-]+)@[A-Za-z0-9.-]"
        ),
        exempt=_PLACEHOLDER_VALUE,
    ),
)


@dataclass(frozen=True)
class SecretFinding:
    """One thing the scan found. A class and a location, never a value."""

    # JSON Pointer-ish path, e.g. `/sections/architecture/summary`.
    path: str
    # The pattern class, e.g. `provider_api_key`.
    label: str
    # What that class means.
    description: str


def _matches_class(text: str, entry: SecretPattern) -> bool:
    """True when at least one match of this class is not exempt.

    Every match is judged on its own captured value, so a placeholder in one
    sentence never excuses a real credential in the next.
    """
    for match in entry.pattern.finditer(text):
        if entry.exempt is None:
            return True
        value = (
            match.group(entry.exempt_group)
            if entry.exempt_group <= (match.re.groups or 0)
            else None
        )
        if value is None or not entry.exempt.fullmatch(value):
            return True
    return False


def _scan_string(text: str, path: str, findings: list[SecretFinding]) -> None:
    for entry in SECRET_PATTERNS:
        if _matches_class(text, entry):
            findings.append(
                SecretFinding(
                    path=path, label=entry.label, description=entry.description
                )
            )


def _scan(value: Any, path: str, findings: list[SecretFinding]) -> None:
    if isinstance(value, str):
        _scan_string(value, path if path else "/", findings)
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _scan(item, f"{path}/{index}", findings)
        return
    if isinstance(value, dict):
        for key, nested in value.items():
            _scan(nested, f"{path}/{key}", findings)


def find_secret_material(value: Any) -> list[SecretFinding]:
    """Find secret-shaped material anywhere in a value.

    Returns every finding rather than the first, so a model fixing its output
    sees the whole list. Pure: it never mutates, logs or echoes anything it
    matched.
    """
    findings: list[SecretFinding] = []
    _scan(value, "", findings)
    return findings


def is_free_of_secret_material(value: Any) -> bool:
    """True when nothing secret-shaped is present."""
    return len(find_secret_material(value)) == 0


def describe_secret_finding(finding: SecretFinding) -> str:
    """A safe, actionable sentence about one finding.

    Names the class and the location, and says what to do instead. Never
    includes the matched value.
    """
    return (
        f"looks like it contains {finding.description} ({finding.label}). "
        "Remove the value: say that the thing exists and where it is "
        "configured, never what it is."
    )


class SecretMaterialError(Exception):
    """Raised by ``assert_no_secret_material``. Findings, never values."""

    def __init__(self, findings: list[SecretFinding]) -> None:
        detail = "; ".join(
            f"{finding.path} {finding.label}" for finding in findings
        )
        super().__init__(
            f"this handover carries secret material and was not stored: {detail}"
        )
        self.findings = tuple(findings)


def assert_no_secret_material(value: Any) -> None:
    """Fail closed: raise when anything secret-shaped is present."""
    findings = find_secret_material(value)
    if findings:
        raise SecretMaterialError(findings)
