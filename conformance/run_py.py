"""The conformance suite, run against the Python SDK.

This is what "Soil Compatible" means, executed. It runs the golden fixtures
against ``packages/sdk-py`` and checks the behaviours that make handovers
portable rather than merely well-formed:

  1. fixtures      the valid ones validate, the invalid ones fail where the
                   manifest says they fail, compared as an abstract semantic
                   location rather than as pointer text
  1b. boundary     the pre-schema ingestion boundary: encoding, duplicate
                   member names, nesting depth and the numeric domain, judged
                   on the BYTES, because none of them can be seen from a value
  1c. text-unit    every length bound in the format counted in Unicode code
                   points, on strings where the candidate units disagree
  2. identity      the handoverId rules: writer-assigned UUIDv7, copies keep
                   it, new captures get a new one, codes are not identity
  3. observations  the extension point stays forward compatible: unknown kinds
                   survive a round trip and change nothing about the sections
  4. safety        a handover carrying credentials or private absolute paths
                   is refused, and the refusal never echoes the value
  5. normalization the loose shapes a model actually emits become documents
  6. store         save, list and read round trip through plain files
  7. restore       a loaded handover carries its gaps and its framing, every
                   field a writer supplied reaches the reader, and content in
                   it cannot be mistaken for the rendered prompt's own
                   structure
  8. determinism   the renderer returns identical bytes for identical input
  9. recipe        all 17 sections have guidance, and the rules are intact

The schema-agreement category runs in the TypeScript runner (``run.ts``),
which pins the published JSON Schema to these same fixtures; both SDKs are
pinned to the fixtures here and there, so the schema and the two validators
cannot drift apart. Prompt-text byte parity across the SDKs is asserted by
``packages/sdk-py/tests/test_parity.py``.

Run it with ``pnpm conformance``, which runs both runners. It exits non-zero
on failure, and it prints what failed rather than a count.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "conformance" / "fixtures"

sys.path.insert(0, str(ROOT / "packages" / "sdk-py"))

from soil_handover import (  # noqa: E402
    HandoverStore,
    RECIPE_VERSION,
    RESCUE_PROMPT,
    SECTION_GUIDANCE,
    SECTION_KEYS,
    SECTION_LABELS,
    SHARED_RULES,
    LIMITS,
    build_recipe,
    build_restore_prompt,
    extract_json_block,
    INGEST_LIMITS,
    find_secret_material,
    ingest_document,
    normalize_handover,
    render_recipe,
    render_saved,
    text_length,
    validate_handover,
)

from datetime import datetime, timezone  # noqa: E402

NOW = datetime(2026, 7, 22, 10, 0, 0, tzinfo=timezone.utc)

# A syntactically valid UUID used where a check needs a document that is
# complete but is not exercising the writer's assignment path.
A_VALID_ID = "019f7e89-fc00-7000-8000-000000000000"
# A capture time, stated by the document. Nothing here reads a clock.
A_CAPTURE_TIME = "2026-07-22T10:00:00Z"

# The exact shape the official writers emit: UUIDv7, RFC 9562 variant.
UUID_V7_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


# The two conformance classes, reported separately and never as one green
# blob. "Soil Document Conformant" is a claim about DOCUMENTS: the schema,
# the section semantics, round trips, identity. "Soil Secure Writer
# Conformant" is a claim about BEHAVIOUR: the safety fixtures that must be
# refused, with the right category, storing nothing.
DOCUMENT = "document"
SECURE_WRITER = "secure-writer"


def class_of(category: str) -> str:
    """Which class a category's checks belong to unless a check says
    otherwise."""
    return SECURE_WRITER if category == "safety" else DOCUMENT


@dataclass
class Suite:
    checks: int = 0
    checks_by_class: dict[str, int] = field(
        default_factory=lambda: {DOCUMENT: 0, SECURE_WRITER: 0}
    )
    failures: list[tuple[str, str, str]] = field(default_factory=list)

    def check(
        self,
        category: str,
        condition: bool,
        detail: str,
        conformance_class: str | None = None,
    ) -> None:
        if conformance_class is None:
            conformance_class = class_of(category)
        self.checks += 1
        self.checks_by_class[conformance_class] += 1
        if not condition:
            self.failures.append((conformance_class, category, detail))


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def fixture_path(file: str) -> Path:
    return (FIXTURES / file).resolve()


# An abstract semantic location: an ordered sequence of object member names
# and array indices, from the root of the document to the offending value. The
# empty sequence means the document itself.
#
# This is what the harness compares, and it is deliberately not a string. The
# manifest used to bind exact JSON Pointer text, which made a formatting choice
# into a conformance requirement the specification never states. A pointer is
# still a fine representation; each runner parses its own representation into
# segments before comparing, and the function below is this runner's adapter.
def location_of(pointer: str) -> list:
    if pointer in ("", "/"):
        return []
    out: list = []
    for raw in pointer.lstrip("/").split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        out.append(int(token) if token.isdigit() else token)
    return out


def show_location(location: list) -> str:
    """A semantic location, for a failure message. Never compared."""
    return " > ".join(str(segment) for segment in location) or "the document"


# The fixed boundary token every restore-prompt check injects. Production
# takes 128 bits from the platform's cryptographic source instead, which is
# what makes the boundary unforgeable; a fixed token here is what makes a
# check on the rendered bytes possible at all.
RESTORE_TOKEN = read_json(FIXTURES / "manifest.json")["restoreBoundaryToken"]
RESTORE_MARK = f"soil:{RESTORE_TOKEN}"
_STRUCTURE_SHAPED = re.compile(r"^\s*(?:===|##)")


def check_fixtures(suite: Suite) -> None:
    manifest = read_json(FIXTURES / "manifest.json")

    for entry in manifest["valid"]:
        doc = read_json(fixture_path(entry["file"]))
        result = validate_handover(doc)
        problems = "; ".join(
            f"{issue.path} {issue.message}" for issue in result.issues
        )
        suite.check(
            "fixtures",
            result.valid,
            f"{entry['file']} should be valid but the validator reported:"
            f" {problems}",
        )

    for entry in manifest["invalid"]:
        doc = read_json(fixture_path(entry["file"]))
        result = validate_handover(doc)
        # Refusing a safety fixture is writer behaviour, so those two checks
        # count toward the Secure Writer class; structural rejections are
        # document checks.
        entry_class = (
            SECURE_WRITER if entry.get("kind") == "safety" else DOCUMENT
        )
        suite.check(
            "fixtures",
            not result.valid,
            f"{entry['file']} should be rejected ({entry['reason']}) but"
            " validated",
            entry_class,
        )
        wanted = entry["location"]
        reported = (
            ", ".join(
                show_location(location_of(issue.path))
                for issue in result.issues
            )
            or "nothing"
        )
        suite.check(
            "fixtures",
            any(location_of(issue.path) == wanted for issue in result.issues),
            f"{entry['file']} should report a problem at"
            f" {show_location(wanted)}, reported: {reported}",
            entry_class,
        )
        if entry.get("kind") == "safety":
            suite.check(
                "safety",
                any(issue.kind == "safety" for issue in result.issues),
                f"{entry['file']} should be refused by the secret scan, not"
                " merely by shape",
            )


def boundary_bytes(entry: dict) -> bytes:
    """Materialise one boundary fixture: bytes on disk, or a padded document."""
    if "file" in entry:
        return fixture_path(entry["file"]).read_bytes()
    total = entry["generateBytes"]
    return ('{"pad":"' + "x" * (total - 10) + '"}').encode("utf-8")


def check_ingestion_boundary(suite: Suite) -> None:
    """The pre-schema ingestion boundary: encoding, duplicate member names
    and nesting depth, all judged on the bytes before a value exists.

    The category is its own because none of it can be seen from a constructed
    value, which is exactly why the three defects survived this long. The
    published JSON Schema and the reference validator are both handed an
    already-parsed value, so both are structurally blind here; that is a fact
    about layers, not a gap in the schema.
    """
    manifest = read_json(FIXTURES / "manifest.json")
    for entry in manifest["boundary"]:
        data = boundary_bytes(entry)
        value, issue = ingest_document(data)
        name = entry["name"]

        if entry["ingest"] == "accepted":
            suite.check(
                "boundary",
                issue is None,
                f"{name}: must be accepted, was refused with"
                f" {issue.code if issue else ''}",
            )
            if issue is not None:
                continue

            # An accepted document is never merely accepted. The validator
            # runs on it and must return a result, because the one outcome
            # worse than a rejection is a document that is accepted and
            # never scanned.
            result = validate_handover(value)
            after = entry.get("afterIngest")
            if after == "valid":
                problems = "; ".join(
                    f"{i.path} {i.message}" for i in result.issues
                )
                suite.check(
                    "boundary",
                    result.valid,
                    f"{name}: accepted at the boundary, then rejected by the"
                    f" validator: {problems}",
                )
            elif after == "refused-by-safety":
                suite.check(
                    "boundary",
                    any(i.kind == "safety" for i in result.issues),
                    f"{name}: accepted at the boundary, so the fail-closed"
                    " secret scan must reach it and refuse it",
                    SECURE_WRITER,
                )
            else:
                suite.check(
                    "boundary",
                    not result.valid,
                    f"{name}: is not a handover, so the validator must say so"
                    " rather than accept it",
                )
            continue

        suite.check(
            "boundary",
            issue is not None and issue.code == entry["ingest"],
            f"{name}: must be refused with {entry['ingest']}, got"
            f" {issue.code if issue else 'acceptance'}",
        )
        if issue is not None and "location" in entry:
            suite.check(
                "boundary",
                location_of(issue.path) == entry["location"],
                f"{name}: must report the issue at"
                f" {show_location(entry['location'])}, reported"
                f" {show_location(location_of(issue.path))}",
            )

    suite.check(
        "boundary",
        INGEST_LIMITS.max_depth == 32 and INGEST_LIMITS.max_bytes == 1048576,
        "the boundary limits must be 32 levels and 1048576 bytes, found"
        f" {INGEST_LIMITS.max_depth} and {INGEST_LIMITS.max_bytes}",
    )
    suite.check(
        "boundary",
        INGEST_LIMITS.max_integer == 9007199254740991
        and INGEST_LIMITS.min_integer == -9007199254740991,
        "the integer domain must run from -9007199254740991 to"
        f" 9007199254740991, found {INGEST_LIMITS.min_integer} to"
        f" {INGEST_LIMITS.max_integer}",
    )


# One code point, two UTF-16 code units, four UTF-8 bytes.
_ASTRAL = "\U0001F600"
# Two code points, two UTF-16 code units, three UTF-8 bytes, one cluster.
_COMBINED = "e\u0301"


def check_text_unit(suite: Suite) -> None:
    """The text unit, exercised at every individually bounded string.

    The fixtures pin three of these sites and this pins all five, including
    the 20000-code-point section summary, which is deliberately not a fixture:
    at four bytes per astral character it would be an eighty-kilobyte file in
    a repository whose largest real document is eighteen kilobytes, and a
    string built here costs nothing and proves the same thing.

    Everything here is deliberately NOT ASCII. On ASCII the three candidate
    units -- code points, UTF-16 code units and UTF-8 bytes -- all give the
    same answer, so an ASCII test cannot tell a conformant implementation from
    one counting the wrong thing.
    """

    def base() -> dict:
        doc = dict(
            normalize_handover(
                {
                    "projectId": "text-unit",
                    "title": "The text unit",
                    "createdAt": A_CAPTURE_TIME,
                    "sections": {
                        "executiveSummary": "The text unit, exercised."
                    },
                }
            )
        )
        doc["handoverId"] = A_VALID_ID
        return doc

    def with_summary(text: str) -> dict:
        doc = base()
        sections = dict(doc["sections"])
        sections["architecture"] = {"status": "available", "summary": text}
        doc["sections"] = sections
        return doc

    def with_field(name: str, value) -> dict:
        doc = base()
        doc[name] = value
        return doc

    cases = [
        (
            f"title at {LIMITS.title} code points",
            "/title",
            with_field("title", _ASTRAL * LIMITS.title),
            with_field("title", _ASTRAL * (LIMITS.title + 1)),
        ),
        (
            f"title at {LIMITS.title} code points of combining sequences",
            "/title",
            with_field("title", _COMBINED * (LIMITS.title // 2)),
            with_field("title", _COMBINED * (LIMITS.title // 2) + "x"),
        ),
        (
            f"section summary at {LIMITS.section_summary} code points",
            "/sections/architecture/summary",
            with_summary(_ASTRAL * LIMITS.section_summary),
            with_summary(_ASTRAL * (LIMITS.section_summary + 1)),
        ),
        (
            f"a stated gap at {LIMITS.list_entry} code points",
            "/quality/missingInputs/0",
            with_field(
                "quality",
                {"missingInputs": [_COMBINED * (LIMITS.list_entry // 2)]},
            ),
            with_field(
                "quality",
                {
                    "missingInputs": [
                        _COMBINED * (LIMITS.list_entry // 2) + "x"
                    ]
                },
            ),
        ),
        (
            f"an observation kind at {LIMITS.observation_kind} code points",
            "/observations/0/kind",
            with_field(
                "observations",
                [{"kind": _ASTRAL * LIMITS.observation_kind, "data": {}}],
            ),
            with_field(
                "observations",
                [
                    {
                        "kind": _ASTRAL * (LIMITS.observation_kind + 1),
                        "data": {},
                    }
                ],
            ),
        ),
        (
            # projectId is pattern-restricted to ASCII, so all three candidate
            # units agree on it. It is here for the bound, not for the unit.
            f"projectId at {LIMITS.project_id} code points",
            "/projectId",
            with_field("projectId", "p" * LIMITS.project_id),
            with_field("projectId", "p" * (LIMITS.project_id + 1)),
        ),
    ]

    for what, path, at, over in cases:
        result = validate_handover(at)
        problems = "; ".join(
            f"{i.path} {i.message}" for i in result.issues
        )
        suite.check(
            "text-unit",
            result.valid,
            f"{what} must be accepted, refused: {problems}",
        )
        refused = validate_handover(over)
        suite.check(
            "text-unit",
            not refused.valid
            and any(i.path == path for i in refused.issues),
            f"one code point over {what} must be refused at {path}",
        )

    # The unit itself, on the three cases that separate the candidates.
    suite.check(
        "text-unit",
        text_length(_ASTRAL) == 1 and len(_ASTRAL.encode("utf-16-le")) == 4,
        "a character outside the basic plane is one code point and two UTF-16"
        " code units",
    )
    suite.check(
        "text-unit",
        text_length(_COMBINED) == 2,
        "one perceived character written as a base plus a combining mark is"
        " two code points, not one",
    )
    suite.check(
        "text-unit",
        text_length("caf\u00e9") == 4
        and len("caf\u00e9".encode("utf-8")) == 5,
        "a precomposed accented character is one code point and two UTF-8"
        " bytes",
    )


def check_observations(suite: Suite) -> None:
    # The extension point: unknown kinds survive a full round trip, and the
    # sections are read the same with them as without them.
    home = tempfile.mkdtemp(prefix="soil-observations-")
    try:
        store = HandoverStore(home)
        doc = read_json(fixture_path("valid/observations-unknown-kinds.json"))

        entry = store.save(doc)
        read = store.read(entry["code"])
        suite.check(
            "observations",
            len(read.get("observations") or []) == 3,
            "an unrecognised observation must survive a save and a read, not"
            " be dropped",
        )
        suite.check(
            "observations",
            read["observations"] == doc["observations"],
            "an unrecognised observation must round trip unchanged",
        )

        normalized = normalize_handover(doc)
        suite.check(
            "observations",
            normalized["observations"] == doc["observations"],
            "normalization must not interpret, filter or reorder observations",
        )

        without = {
            key: value for key, value in read.items() if key != "observations"
        }
        suite.check(
            "observations",
            build_restore_prompt(read, RESTORE_TOKEN)
            == build_restore_prompt(without, RESTORE_TOKEN),
            "observations must not change how the 17 sections are read",
        )

        unknown_only = validate_handover(
            {
                **doc,
                "observations": [
                    {"kind": "kind.from.the.future", "data": {"x": 1}}
                ],
            }
        )
        suite.check(
            "observations",
            unknown_only.valid,
            "a kind this implementation has never heard of must be accepted,"
            " not treated as an error",
        )
    finally:
        shutil.rmtree(home, ignore_errors=True)


def check_identity(suite: Suite) -> None:
    """Identity: the ``handoverId`` rules, exercised one by one.

    The letters match the fixture list in the specification work: (a) a new
    handover gets a new UUIDv7, (b) a byte-for-byte copy keeps its id, (c) a
    new capture of the same project gets a new one, (d) local codes may
    collide across stores without identity collision, (e) the id survives the
    store's own update path, (f) an invalid or missing id is handled
    deterministically, and (g) is these same checks run by ``run.ts`` over
    the same fixtures.
    """
    home_a = tempfile.mkdtemp(prefix="soil-identity-a-")
    home_b = tempfile.mkdtemp(prefix="soil-identity-b-")
    try:
        store_a = HandoverStore(home_a)
        store_b = HandoverStore(home_b)

        def fresh():
            return normalize_handover(
                {
                    "projectId": "identity",
                    "title": "Identity",
                    "createdAt": A_CAPTURE_TIME,
                    "sections": {
                        "executiveSummary": "The identity rules, exercised."
                    },
                })

        # (a) a new handover gets a new UUIDv7, assigned by the writer.
        first = store_a.save(fresh())
        first_doc = store_a.read(first["code"])
        suite.check(
            "identity",
            isinstance(first_doc.get("handoverId"), str)
            and UUID_V7_PATTERN.match(first_doc["handoverId"]) is not None,
            "(a) a handover stored without an id must be assigned a UUIDv7 by"
            " the writer",
        )

        # (c) a new capture, even of the same project, gets a new handoverId.
        second = store_a.save(fresh())
        second_doc = store_a.read(second["code"])
        suite.check(
            "identity",
            second_doc.get("handoverId") is not None
            and second_doc.get("handoverId") != first_doc.get("handoverId"),
            "(c) a new capture of the same project must get a new handoverId",
        )

        # (d) local codes may collide across two stores; identity does not.
        other = store_b.save(fresh())
        other_doc = store_b.read(other["code"])
        suite.check(
            "identity",
            other["code"] == first["code"]
            and other_doc.get("handoverId") != first_doc.get("handoverId"),
            "(d) two stores may both hold a #001, and the two documents must"
            " still have different handoverIds",
        )

        # (b) a byte-for-byte copy keeps its handoverId, in any store.
        copy = json.loads(json.dumps(first_doc))
        copy_entry = store_b.save(copy)
        copy_doc = store_b.read(copy_entry["code"])
        suite.check(
            "identity",
            copy_doc.get("handoverId") == first_doc.get("handoverId"),
            "(b) a byte-for-byte copy must keep its handoverId when stored"
            " again",
        )

        # (e) the store's own update path never changes an id. There is no
        # migration tooling yet, so the rule is pinned on reindex: the files
        # are rewritten around, and identity must come out untouched.
        store_a.reindex()
        suite.check(
            "identity",
            store_a.read(first["code"]).get("handoverId")
            == first_doc.get("handoverId"),
            "(e) rebuilding the store's index must leave every handoverId"
            " unchanged",
        )

        # (f) an invalid or missing id is handled deterministically on
        # validate: a structure issue at /handoverId, never a replacement.
        without_id = {
            key: value
            for key, value in first_doc.items()
            if key != "handoverId"
        }
        missing = validate_handover(without_id)
        suite.check(
            "identity",
            not missing.valid
            and any(
                issue.path == "/handoverId" and issue.kind == "structure"
                for issue in missing.issues
            ),
            "(f) a document claiming validity without an id must fail with a"
            " structure issue at /handoverId",
        )
        malformed = validate_handover(
            {**first_doc, "handoverId": "handover-42"}
        )
        suite.check(
            "identity",
            not malformed.valid
            and any(
                issue.path == "/handoverId" for issue in malformed.issues
            ),
            "(f) a malformed id must fail at /handoverId rather than be"
            " replaced",
        )
    finally:
        shutil.rmtree(home_a, ignore_errors=True)
        shutil.rmtree(home_b, ignore_errors=True)


def check_secret_scan(suite: Suite) -> None:
    clean = read_json(ROOT / "examples" / "orchard-checkout.json")
    suite.check(
        "safety",
        len(find_secret_material(clean)) == 0,
        "the worked example must be free of secret material",
    )

    # One unsafe positive per mandatory class, plus the vendor formats and
    # the precedence case. spec/safety-patterns.md is the normative
    # statement; this table is the minimum an implementation must refuse.
    cases = [
        ("the key is sk-abc123def456", "provider_api_key"),
        (
            "clone https://ghp_16C7e42F292c6912E7710c838347Ae178B4a"
            "@github.com/o/r.git",
            "provider_api_key",
        ),
        ("the runner env holds AKIAIOSFODNN7EXAMPLE", "provider_api_key"),
        (
            "the bot posts with"
            " xoxb-2314789012-4567890123456-AbCdEfGhIjKlMnOpQrStUvWx",
            "provider_api_key",
        ),
        (
            "maps is keyed with AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
            "provider_api_key",
        ),
        (
            "Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e",
            "bearer_token",
        ),
        (
            "Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1lMTIzNDU2",
            "authorization_header",
        ),
        ("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", "jwt"),
        ("-----BEGIN PRIVATE KEY-----", "private_key_pem"),
        (
            'the app reads client_secret="9f8a7b6c5d4e3f2a1b0c"',
            "client_secret",
        ),
        (
            'the runner loads {"type": "service_account",'
            ' "project_id": "x"}',
            "google_application_credentials",
        ),
        (
            "GOOGLE_APPLICATION_CREDENTIALS=/opt/keys/orchard-sa.json",
            "google_application_credentials",
        ),
        ("it lives at /Users/example/code/app", "private_path"),
        ("it lives at /home/deploy/app", "private_path"),
        ("it lives at C:\\Users\\example\\app", "private_path"),
        (
            "postgres://orchard:9f8a7b6c5d4e3f@db.internal:5432/orchard",
            "url_credentials",
        ),
        (
            "The token was redacted:"
            " ghp_16C7e42F292c6912E7710c838347Ae178B4a is gone.",
            "provider_api_key",
        ),
    ]

    for text, label in cases:
        doc = normalize_handover(
            {
                "handoverId": A_VALID_ID,
                "projectId": "scan",
                "title": "Scan",
                "createdAt": A_CAPTURE_TIME,
                "sections": {"architecture": text},
            })
        findings = find_secret_material(doc)
        suite.check(
            "safety",
            any(finding.label == label for finding in findings),
            f"a section carrying {label} must be detected",
        )
        result = validate_handover(doc)
        suite.check(
            "safety",
            not result.valid,
            f"a handover carrying {label} must be rejected, not merely"
            " flagged",
        )
        for issue in result.issues:
            suite.check(
                "safety",
                text not in issue.message,
                f"a {label} finding must not echo the matched value back",
            )

    # The safe near-neighbour of every class. Refusing any of these would
    # make the format contradict its own section requirements:
    # `architecture` asks for flag and command names quoted exactly, and
    # `safetySummary` asks for what was withheld and where it is configured.
    safe_cases = [
        "A provider API key exists and is set in the deployment platform."
        " Its value is not carried here.",
        "The service uses an Authorization header.",
        "GOOGLE_APPLICATION_CREDENTIALS is set outside the handover.",
        "The client_secret value was intentionally omitted.",
        "The endpoint expects bearer credentials; the token is not carried"
        " here.",
        "Login returns a JWT; the value is not carried here.",
        "The signing key is a PEM private key held in the platform's secret"
        " manager.",
        "Run `soil save --project orchard`; SOIL_HOME selects the store and"
        " PORT defaults to 3000.",
        "Send it as `Authorization: Bearer <token>`, or as"
        " `Authorization: Bearer $TOKEN`.",
        "The config template ships client_secret=YOUR_CLIENT_SECRET.",
        "Initialised /home/ada/.soil-server, and the container mounts"
        " /home/agent/.soil.",
        "The URL is documented as postgres://app:password@db.internal:5432"
        "/app.",
        "See src/checkout/window.ts and https://example.com/docs",
    ]

    for text in safe_cases:
        doc = normalize_handover(
            {
                "handoverId": A_VALID_ID,
                "projectId": "scan",
                "title": "Scan",
                "createdAt": A_CAPTURE_TIME,
                "sections": {"architecture": text},
            })
        result = validate_handover(doc)
        refused = ", ".join(
            f"{issue.path} {issue.kind}" for issue in result.issues
        )
        suite.check(
            "safety",
            result.valid,
            "naming a credential type, header, environment variable, flag or"
            f" documented placeholder must stay valid, refused: {refused}",
        )


def check_normalization(suite: Suite) -> None:
    model_reply = "\n".join(
        [
            "Sure, here is the save:",
            "",
            "```json",
            json.dumps(
                {
                    "projectId": "loose-shape",
                    "title": "A reply in the rescue shape",
                    "createdAt": A_CAPTURE_TIME,
                    "extractionSections": {
                        "projectIdentity": (
                            "A project that exists only to test the loose"
                            " shape."
                        ),
                        "decisions": {
                            "status": "available",
                            "summary": "One decision was made.",
                        },
                        "blockers": {"status": "missing", "summary": None},
                    },
                }
            ),
            "```",
            "",
            "Let me know if you want anything changed.",
        ]
    )

    block = extract_json_block(model_reply)
    suite.check(
        "normalization",
        block is not None,
        "a fenced JSON block inside prose should be extracted",
    )

    doc = normalize_handover(json.loads(block or "{}"))

    # Normalization is not a writer, so the id is still absent here. The only
    # thing standing between this reply and validity must be the id the
    # writer assigns at store time.
    before_id = validate_handover(doc)
    before_problems = "; ".join(
        f"{issue.path} {issue.message}" for issue in before_id.issues
    )
    suite.check(
        "normalization",
        not before_id.valid
        and len(before_id.issues) == 1
        and before_id.issues[0].path == "/handoverId",
        "a normalized reply should be one writer-assigned id away from"
        f" valid, got: {before_problems}",
    )

    result = validate_handover({**doc, "handoverId": A_VALID_ID})
    problems = "; ".join(
        f"{issue.path} {issue.message}" for issue in result.issues
    )
    suite.check(
        "normalization",
        result.valid,
        "a normalized rescue-shaped reply should be valid once identified,"
        f" got: {problems}",
    )
    suite.check(
        "normalization",
        len(doc["sections"]) == 17,
        "normalization should declare all 17 sections",
    )
    suite.check(
        "normalization",
        doc["sections"]["projectIdentity"]["status"] == "available",
        "a bare string section should become an available section",
    )
    suite.check(
        "normalization",
        doc["sections"]["workflow"]["status"] == "missing",
        "a section the model never wrote should be recorded as missing, not"
        " invented",
    )
    suite.check(
        "normalization",
        "extractionSections" in RESCUE_PROMPT,
        "the rescue prompt should ask for the shape normalization accepts",
    )

    # An unrecognised status, wrong capitalisation included, must reach
    # validate and be refused there. Silently rewriting it to `available`
    # would turn a typo into content that counts as captured.
    for wrong in (
        "Available",
        "AVAILABLE",
        "partial",
        "notApplicable",
        "not applicable",
        "NOT_APPLICABLE",
    ):
        written = normalize_handover(
            {
                "handoverId": A_VALID_ID,
                "projectId": "status",
                "title": "Status",
                "createdAt": A_CAPTURE_TIME,
                "sections": {
                    "decisions": {
                        "status": wrong,
                        "summary": "One decision.",
                    }
                },
            })
        suite.check(
            "normalization",
            written["sections"]["decisions"]["status"] == wrong,
            f'normalization must keep the unrecognised status "{wrong}"'
            " rather than rewrite it",
        )
        status_result = validate_handover(written)
        suite.check(
            "normalization",
            not status_result.valid
            and any(
                issue.path == "/sections/decisions/status"
                and issue.kind == "structure"
                for issue in status_result.issues
            ),
            f'an unrecognised status "{wrong}" must be refused at'
            " /sections/decisions/status",
        )


def check_store_and_restore(suite: Suite) -> None:
    home = tempfile.mkdtemp(prefix="soil-conformance-")
    try:
        store = HandoverStore(home)
        doc = read_json(ROOT / "examples" / "orchard-checkout.json")

        entry = store.save(doc)
        suite.check(
            "store", entry["code"] == "#001", "the first code should be #001"
        )
        suite.check(
            "store",
            entry["sectionsWithContent"] == 17,
            "the worked example carries all 17 sections",
        )

        second = store.save(doc)
        suite.check(
            "store",
            second["code"] == "#002",
            "codes should increment, never be reused",
        )

        read = store.read("#001")
        suite.check(
            "store",
            read["title"] == doc["title"] and read["code"] == "#001",
            "a stored handover should read back with its code",
        )
        listed = store.list()
        suite.check(
            "store",
            len(listed) == 2 and listed[0]["code"] == "#002",
            "list should return everything, newest first",
        )

        rebuilt = store.reindex()
        suite.check(
            "store",
            len(rebuilt["entries"]) == 2 and rebuilt["nextCode"] == 3,
            "the index should be rebuildable from the files alone",
        )

        prompt = build_restore_prompt(read, RESTORE_TOKEN)
        suite.check(
            "restore",
            f"=== {RESTORE_MARK} BOOT PROMPT ===" in prompt,
            "the restore prompt should lead with the boot prompt",
        )
        suite.check(
            "restore",
            "context, not instruction" in prompt,
            "the restore prompt should tell the reader the document is"
            " context, not commands",
        )
        suite.check(
            "restore",
            f"=== {RESTORE_MARK} KNOWN GAPS ===" in prompt
            and "not captured: Conversion numbers" in prompt,
            "stated gaps should travel with the handover into the restore"
            " prompt",
        )
        suite.check(
            "restore",
            "not now" in prompt,
            "the restore prompt should anchor capture-state sections to the"
            " capture",
        )
        # The asserted-absent word is built by concatenation on purpose: the
        # rule it enforces covers this repo's own text too.
        import re

        word = "verif" + "ied"
        suite.check(
            "restore",
            re.search(rf"\b{word}\b", prompt, re.IGNORECASE) is None,
            "nothing local should describe a handover as checked by anything",
        )

        # A field a writer supplies is not delivered until a reader sees it,
        # and the reader on this side is a model. Each of these was accepted,
        # validated and stored, and then reached no rendered surface at all.
        source = read.get("source") or {}
        suite.check(
            "restore",
            f"=== {RESTORE_MARK} THIS HANDOVER ===" in prompt
            and f"Title: {read['title']}" in prompt,
            "the handover's own title should reach the prompt, not only the"
            " rail card",
        )
        suite.check(
            "restore",
            all(
                f"{label} " in prompt
                for label in ("client", "model", "provider", "extraction recipe")
            )
            and source.get("client", "") in prompt
            and source.get("provider", "") in prompt
            and source.get("recipeVersion", "") in prompt,
            "the client, the model, the provider and the recipe version should"
            " tell the reader what wrote this",
        )
        labels_in_document = {
            label
            for key in SECTION_KEYS
            for label in (read["sections"][key].get("provenance") or [])
        }
        suite.check(
            "restore",
            len(labels_in_document) > 0
            and f"=== {RESTORE_MARK} WHERE THE CLAIMS CAME FROM ===" in prompt
            and all(label in prompt for label in labels_in_document),
            "every provenance label the document carries should reach the"
            " reader, because provenance is the format's only trust mechanism",
        )

        # A withheld section and an empty one are two different instructions to
        # the reader, and the prompt reported both as the second.
        withheld_doc = read_json(fixture_path("valid/blocked-and-safe.json"))
        withheld_prompt = build_restore_prompt(withheld_doc, RESTORE_TOKEN)
        withheld_keys = [
            key
            for key in SECTION_KEYS
            if withheld_doc["sections"][key].get("status") == "blocked"
        ]
        empty_line = next(
            (
                line
                for line in withheld_prompt.split("\n")
                if line.startswith("Sections with nothing in them")
            ),
            "",
        )
        suite.check(
            "restore",
            len(withheld_keys) > 0
            and all(
                SECTION_LABELS[key] not in empty_line
                and f"withheld from {SECTION_LABELS[key]}" in withheld_prompt
                for key in withheld_keys
            ),
            "a withheld section should be named as withheld rather than"
            " counted among the empty ones",
        )
        suite.check(
            "restore",
            all(
                not (withheld_doc["sections"][key].get("summary") or "")
                or (withheld_doc["sections"][key]["summary"] or "")[:40]
                in withheld_prompt
                for key in withheld_keys
            ),
            "the note a writer left on a withheld section should travel to the"
            " reader",
        )
    finally:
        shutil.rmtree(home, ignore_errors=True)


def _unescape_line(line: str) -> str:
    """Recover the original content line: exactly one backslash comes off."""
    return line[1:] if line.startswith("\\") else line


def check_restore_boundary(suite: Suite) -> None:
    """The restore-prompt boundary, on adversarial documents.

    Every fixture in the manifest's ``restore`` list is a VALID handover whose
    content is written to be mistaken for the rendered prompt's own structure.
    The rule in spec/restore-prompt.md is that content cannot be mistaken for
    structure, and it is checked here as three outcomes rather than as a
    mechanism: every line a reader could take for structure carries this
    render's marker; after the first structural line, a line carrying the
    marker is either structure or is visibly escaped; and removing one leading
    backslash from each line of a section's rendered block returns that
    section's summary byte for byte.

    What is NOT checked, because it is not what the boundary claims: that
    instruction-shaped text is absent. It travels on purpose.
    """
    manifest = read_json(FIXTURES / "manifest.json")
    banner_line = re.compile(rf"^=== {re.escape(RESTORE_MARK)} .+ ===$")
    heading_line = re.compile(rf"^## {re.escape(RESTORE_MARK)} .+$")

    for entry in manifest["restore"]:
        doc = read_json(fixture_path(entry["file"]))

        suite.check(
            "restore",
            validate_handover(doc).valid,
            f"{entry['name']}: an adversarial fixture must be a valid"
            " handover, or it is testing the validator instead",
        )

        prompt = build_restore_prompt(doc, RESTORE_TOKEN)
        lines = prompt.split("\n")

        unmarked = [
            line
            for line in lines
            if _STRUCTURE_SHAPED.match(line) and RESTORE_MARK not in line
        ]
        suite.check(
            "restore",
            not unmarked,
            f"{entry['name']}: {len(unmarked)} line(s) read as structure"
            f" without this render's marker, the first being"
            f" {json.dumps(unmarked[0] if unmarked else '')}",
        )

        first_structural = next(
            (i for i, line in enumerate(lines) if banner_line.match(line)),
            -1,
        )
        borrowed = [
            line
            for line in lines[first_structural + 1 :]
            if RESTORE_MARK in line
            and not banner_line.match(line)
            and not heading_line.match(line)
            and not line.startswith("\\")
        ]
        suite.check(
            "restore",
            not borrowed,
            f"{entry['name']}: {len(borrowed)} content line(s) carry the"
            f" marker unescaped, the first being"
            f" {json.dumps(borrowed[0] if borrowed else '')}",
        )

        for key in SECTION_KEYS:
            section = doc["sections"][key]
            if section.get("status") != "available" or not section.get(
                "summary"
            ):
                continue
            summary = section["summary"]
            if key == "restoreInstructions":
                heading = f"=== {RESTORE_MARK} BOOT PROMPT ==="
                anchor = lines.index(heading) + 2 if heading in lines else -1
            else:
                heading = f"## {RESTORE_MARK} {SECTION_LABELS[key]}"
                anchor = lines.index(heading) + 1 if heading in lines else -1
            suite.check(
                "restore",
                anchor > 0,
                f"{entry['name']}: the rendering has no marked heading for"
                f" {key}",
            )
            block = lines[anchor : anchor + len(summary.split("\n"))]
            suite.check(
                "restore",
                "\n".join(_unescape_line(line) for line in block) == summary,
                f"{entry['name']}: the rendered block for {key} does not"
                " decode back to the section's summary",
            )


def check_determinism(suite: Suite) -> None:
    import re

    doc = read_json(ROOT / "examples" / "orchard-checkout.json")
    once = render_saved(doc, "#001")
    twice = render_saved(doc, "#001")
    suite.check(
        "determinism",
        once == twice,
        "the renderer should return identical bytes for identical input",
    )
    suite.check(
        "determinism",
        re.search(r"\d+\s*%", once) is None
        and re.search(r"score", once, re.IGNORECASE) is None,
        "a local save card should report counts, never a score",
    )


def check_recipe(suite: Suite) -> None:
    # The recipe is complete, its text is byte-identical to the canonical
    # files in recipes/, and the recipe version travels with every document
    # the official writers produce.
    recipe_file = (ROOT / "recipes" / "handover-recipe-v1.txt").read_text(
        encoding="utf-8"
    )
    suite.check(
        "recipe",
        render_recipe() == recipe_file,
        "the SDK's rendered recipe must be byte-identical to"
        " recipes/handover-recipe-v1.txt, the single source of truth",
    )
    rescue_file = (ROOT / "recipes" / "rescue-recipe-v1.txt").read_text(
        encoding="utf-8"
    )
    suite.check(
        "recipe",
        RESCUE_PROMPT + "\n" == rescue_file,
        "the SDK's rescue prompt must be byte-identical to"
        " recipes/rescue-recipe-v1.txt, the single source of truth",
    )
    suite.check(
        "recipe",
        re.match(r"^\d+\.\d+\.\d+$", RECIPE_VERSION) is not None,
        "the recipe version must be a semver string",
    )

    # The recipe version travels, and it is never invented: an ingestion path
    # is handed a document somebody else wrote, so it may not attribute its
    # own recipe to that document. An input that already states one keeps it,
    # a stored document round-trips it untouched, and a document without one
    # is still valid.
    unstamped = normalize_handover(
        {
            "projectId": "recipe-version",
            "title": "Not stamped",
            "createdAt": A_CAPTURE_TIME,
        })
    suite.check(
        "recipe",
        "source" not in unstamped,
        "normalization must not write its own recipeVersion onto a document"
        " it did not produce",
    )
    kept = normalize_handover(
        {
            "projectId": "recipe-version",
            "title": "Kept",
            "createdAt": A_CAPTURE_TIME,
            "source": {"recipeVersion": "0.9.9"},
        })
    suite.check(
        "recipe",
        kept.get("source", {}).get("recipeVersion") == "0.9.9",
        "an input that already states a recipeVersion must keep it untouched",
    )
    home = tempfile.mkdtemp(prefix="soil-recipe-version-")
    try:
        store = HandoverStore(home)
        example = read_json(ROOT / "examples" / "orchard-checkout.json")
        entry = store.save(example)
        suite.check(
            "recipe",
            store.read(entry["code"]).get("source", {}).get("recipeVersion")
            == example.get("source", {}).get("recipeVersion"),
            "a document's recipeVersion must round-trip through the store"
            " untouched",
        )
    finally:
        shutil.rmtree(home, ignore_errors=True)
    without_one = read_json(fixture_path("valid/thin-but-honest.json"))
    suite.check(
        "recipe",
        "source" not in without_one
        and validate_handover(without_one).valid,
        "a document without a recipeVersion is still valid: other writers"
        " may lack one",
    )

    recipe = build_recipe()
    suite.check(
        "recipe",
        all(len(SECTION_GUIDANCE.get(key, "")) > 200 for key in SECTION_KEYS),
        "every one of the 17 sections needs real guidance, not a label",
    )
    suite.check(
        "recipe",
        len(SHARED_RULES) == 6,
        "the recipe should carry the opening rule and RULES 1 to 5",
    )
    suite.check(
        "recipe",
        len(recipe.instructions) == len(SHARED_RULES) + 5,
        "the instruction block should be the rules, the lens, the framing and"
        " the close",
    )
    for rule in ("RULE 1", "RULE 2", "RULE 3", "RULE 4", "RULE 5"):
        suite.check(
            "recipe",
            any(text.startswith(rule) for text in SHARED_RULES),
            f"{rule} should be present verbatim",
        )



def check_closed_world(suite: Suite) -> None:
    """The closed-world contract, and the one invariant that follows from it:
    a save path and a validation of the same bytes give the same verdict.

    Version one is closed. The top-level field set, the section field set and
    the eleven provenance labels are fixed, and a reader refuses anything
    outside them. A normalizing implementation therefore may not delete
    unknown content to make a document acceptable, because then the same bytes
    are rejected by validate and accepted by save. It may not invent the facts
    a reader depends on either: the capture time, the recipe attribution and
    the declared version are all claims only their real author is in a
    position to make.
    """
    canonical = read_json(
        FIXTURES / "valid" / "version-exactly-supported.json"
    )

    # Support is a set of exact versions, not a pattern over the 1.x line.
    suite.check(
        "closed-world",
        validate_handover(canonical).valid,
        "a document at exactly the supported version must validate",
    )
    for unsupported in ("0.9", "1.1", "1.10", "2.0", "1", "1.0.0", ""):
        result = validate_handover({**canonical, "soilHandover": unsupported})
        suite.check(
            "closed-world",
            not result.valid
            and any(issue.path == "/soilHandover" for issue in result.issues),
            f'an unsupported format version "{unsupported}" must be refused at'
            " /soilHandover, never inferred from the shape of the string",
        )

    sections = canonical["sections"]
    unknown_content = (
        ("an unknown top-level field", {**canonical, "grade": 0.92}, "/grade"),
        (
            "an unknown field on a section",
            {
                **canonical,
                "sections": {
                    **sections,
                    "decisions": {
                        "status": "missing",
                        "summary": None,
                        "confidence": 0.4,
                    },
                },
            },
            "/sections/decisions/confidence",
        ),
        (
            "an unknown section key",
            {
                **canonical,
                "sections": {
                    **sections,
                    "vibes": {"status": "available", "summary": "Good."},
                },
            },
            "/sections/vibes",
        ),
        (
            "a provenance label outside the eleven",
            {
                **canonical,
                "sections": {
                    **sections,
                    "decisions": {
                        "status": "available",
                        "summary": "One.",
                        "provenance": ["repo_verified", "vibe_checked"],
                    },
                },
            },
            "/sections/decisions/provenance/1",
        ),
        (
            "an unknown member of source",
            {**canonical, "source": {"client": "a-tool", "temperature": 0.7}},
            "/source/temperature",
        ),
    )

    for what, document, path in unknown_content:
        direct = validate_handover(document)
        through = validate_handover(normalize_handover(document))
        suite.check(
            "closed-world",
            not direct.valid
            and any(issue.path == path for issue in direct.issues),
            f"{what} must be refused at {path}",
        )
        suite.check(
            "closed-world",
            not through.valid
            and any(issue.path == path for issue in through.issues),
            f"{what} must survive normalization and still be refused at"
            f" {path}: a save that strips it and a validation that refuses it"
            " are two answers about the same bytes",
        )

    # Nothing is invented. Each of these was measured being stamped in.
    bare = normalize_handover(
        {"projectId": "invents-nothing", "title": "Invents nothing"}
    )
    suite.check(
        "closed-world",
        "createdAt" not in bare,
        "normalization must not supply a createdAt the document does not"
        " carry: it is the anchor every frontier section is read against",
    )
    suite.check(
        "closed-world",
        any(
            issue.path == "/createdAt"
            for issue in validate_handover(
                {**bare, "handoverId": A_VALID_ID}
            ).issues
        ),
        "a document with no createdAt must be refused, not completed",
    )
    suite.check(
        "closed-world",
        "source" not in bare,
        "normalization must not attribute its own recipe to a document it did"
        " not produce",
    )

    for declared in ("1.7", "2.0", "0.9"):
        carried = normalize_handover({**canonical, "soilHandover": declared})
        suite.check(
            "closed-world",
            carried["soilHandover"] == declared,
            f'normalization must leave a declared version "{declared}" exactly'
            " as written, neither upgrading nor downgrading it",
        )

    # A malformed identifier is refused rather than replaced. Dropping it here
    # is what let a writer mint a fresh one over the top of it.
    for malformed in (42, "handover-42", ""):
        carried = normalize_handover({**canonical, "handoverId": malformed})
        suite.check(
            "closed-world",
            "handoverId" in carried
            and any(
                issue.path == "/handoverId"
                for issue in validate_handover(carried).issues
            ),
            "a malformed handoverId must reach validation and be refused"
            " there, never be dropped and replaced",
        )


def run_conformance() -> Suite:
    suite = Suite()
    check_fixtures(suite)
    check_ingestion_boundary(suite)
    check_text_unit(suite)
    check_identity(suite)
    check_observations(suite)
    check_secret_scan(suite)
    check_normalization(suite)
    check_closed_world(suite)
    check_store_and_restore(suite)
    check_restore_boundary(suite)
    check_determinism(suite)
    check_recipe(suite)
    return suite


if __name__ == "__main__":
    suite = run_conformance()
    # The two classes are reported separately, always. A single green blob
    # would let a writer claim the safety behaviour it never proved.
    print("soil conformance (python, spec 1.0)")
    print(
        "Soil Document Conformant      "
        f" {suite.checks_by_class[DOCUMENT]} checks"
    )
    print(
        "Soil Secure Writer Conformant "
        f" {suite.checks_by_class[SECURE_WRITER]} checks"
    )
    if suite.failures:
        print(f"\n{len(suite.failures)} of {suite.checks} checks failed\n")
        for conformance_class, category, detail in suite.failures:
            print(f"  [{conformance_class}/{category}] {detail}")
        print()
        sys.exit(1)
