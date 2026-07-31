"""Validation: does this document obey the Soil Handover Specification v1?

Two normative rules are checked, and only two. First the shape: the 17
sections, the statuses, the labels, the bounds. Then the fail-closed secret
scan: a handover that carries credentials or private absolute paths is
rejected, because a handover is written to be moved and anything inside it
has already left the machine.

Neither rule is a judgement about content. This answers "is this a handover
and is it safe to move", never "is this a good handover". A thin but honest
handover is valid, and so is one whose every section is ``missing``.

``spec/handover.schema.json`` is the normative statement of these same rules,
and this module mirrors ``packages/sdk-ts/src/validate.ts`` check for check,
in the same order, so the two implementations report the same issues at the
same paths. The conformance suite holds both to every fixture.

Standard library only, on purpose: the SDK should be usable anywhere without
a validator dependency, and the error messages here can say what a JSON
Schema error cannot.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from .identity import HANDOVER_ID_PATTERN
from .safety import describe_secret_finding, find_secret_material
from .sections import (
    LIMITS,
    PROVENANCE_LABELS,
    SECTION_KEYS,
    SECTION_STATUSES,
    text_length,
)
from .types import (
    SUPPORTED_SPEC_VERSIONS,
    ValidationIssue,
    ValidationResult,
)

# Why ``not_applicable`` is the one gap status that must say something.
#
# It is a positive assertion about the project rather than a report about the
# extractor, and it is the only status that tells the next model to stop
# looking. A writer that cannot say why a section does not apply has not
# established that it does not apply; it has established that it could not see
# it, and ``missing`` says exactly that and carries no such requirement.
_NOT_APPLICABLE_NEEDS_REASON = (
    "must say why the section does not apply when status is"
    " 'not_applicable': a gap that tells the next model to stop looking has"
    " to carry its reason, and a gap with no reason is 'missing'"
)

_PROJECT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_CODE_PATTERN = re.compile(r"^#\d{3,}$")
_ISO_DATE_PATTERN = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})"
    r"(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)

_SOURCE_TEXT_KEYS = ("client", "model", "provider")
_SOURCE_KEYS = (*_SOURCE_TEXT_KEYS, "recipeVersion")
_RECIPE_VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")
_OBSERVATION_KEYS = ("kind", "producedBy", "producedAt", "data")
_QUALITY_KEYS = ("missingInputs", "contradictions")
_SAFETY_KEYS = ("unsafeOmissions",)
_ROOT_KEYS = (
    "soilHandover",
    "handoverId",
    "projectId",
    "title",
    "createdAt",
    "source",
    "sections",
    "quality",
    "safety",
    "observations",
    "code",
)


def _is_timestamp(value: str) -> bool:
    # The pattern pins the shape; the datetime constructor rejects components
    # that only look like a date, e.g. a 13th month or a 30th of February.
    match = _ISO_DATE_PATTERN.match(value)
    if match is None:
        return False
    year, month, day, hour, minute, second = (int(g) for g in match.groups())
    try:
        datetime(year, month, day, hour, minute, second)
    except ValueError:
        return False
    return True


class _IssueBag:
    def __init__(self) -> None:
        self.issues: list[ValidationIssue] = []

    def add(self, path: str, message: str, kind: str = "structure") -> None:
        self.issues.append(ValidationIssue(path=path, message=message, kind=kind))


def _check_string_list(bag: _IssueBag, value: Any, path: str) -> None:
    if not isinstance(value, list):
        bag.add(path, "must be an array of strings")
        return
    if len(value) > LIMITS.list_entries:
        bag.add(path, f"must hold at most {LIMITS.list_entries} entries")
    for i, entry in enumerate(value):
        if not isinstance(entry, str):
            bag.add(f"{path}/{i}", "must be a string")
            continue
        if len(entry.strip()) == 0:
            bag.add(f"{path}/{i}", "must not be empty")
        if text_length(entry) > LIMITS.list_entry:
            bag.add(
                f"{path}/{i}",
                f"must be at most {LIMITS.list_entry} code points",
            )


def _check_extra_keys(
    bag: _IssueBag,
    record: dict[str, Any],
    allowed: tuple[str, ...],
    path: str,
) -> None:
    for key in record:
        if key not in allowed:
            bag.add(f"{path}/{key}", "is not a field of this object")


def _check_sections(bag: _IssueBag, value: Any) -> None:
    if not isinstance(value, dict):
        bag.add("/sections", "must be an object holding all 17 sections")
        return
    _check_extra_keys(bag, value, SECTION_KEYS, "/sections")

    for key in SECTION_KEYS:
        path = f"/sections/{key}"
        if key not in value:
            bag.add(
                path,
                "is required: every section is declared, and a gap is stated"
                " with status 'missing'",
            )
            continue
        section = value[key]
        if not isinstance(section, dict):
            bag.add(path, "must be an object with 'status' and 'summary'")
            continue
        _check_extra_keys(
            bag, section, ("status", "summary", "provenance"), path
        )

        status = section.get("status")
        if not isinstance(status, str) or status not in SECTION_STATUSES:
            bag.add(
                f"{path}/status",
                f"must be one of {', '.join(SECTION_STATUSES)}",
            )

        summary = section.get("summary")
        if summary is not None and not isinstance(summary, str):
            bag.add(f"{path}/summary", "must be a string or null")
        elif isinstance(summary, str):
            if text_length(summary) > LIMITS.section_summary:
                bag.add(
                    f"{path}/summary",
                    f"must be at most {LIMITS.section_summary} code points",
                )
            if status == "available" and len(summary.strip()) == 0:
                bag.add(
                    f"{path}/summary",
                    "must hold content when status is 'available'",
                )
            if status == "not_applicable" and len(summary.strip()) == 0:
                bag.add(f"{path}/summary", _NOT_APPLICABLE_NEEDS_REASON)
        elif status == "available":
            bag.add(
                f"{path}/summary",
                "must hold content when status is 'available'",
            )
        elif status == "not_applicable":
            bag.add(f"{path}/summary", _NOT_APPLICABLE_NEEDS_REASON)

        if "provenance" in section:
            provenance = section["provenance"]
            if not isinstance(provenance, list):
                bag.add(
                    f"{path}/provenance",
                    "must be an array of provenance labels",
                )
            else:
                if len(provenance) > LIMITS.provenance_labels:
                    bag.add(
                        f"{path}/provenance",
                        f"must hold at most {LIMITS.provenance_labels} labels",
                    )
                seen: set[str] = set()
                for i, label in enumerate(provenance):
                    if (
                        not isinstance(label, str)
                        or label not in PROVENANCE_LABELS
                    ):
                        bag.add(
                            f"{path}/provenance/{i}",
                            f"must be one of {', '.join(PROVENANCE_LABELS)}",
                        )
                        continue
                    if label in seen:
                        bag.add(
                            f"{path}/provenance/{i}", "is a duplicate label"
                        )
                    seen.add(label)


def validate_handover(input: Any) -> ValidationResult:
    """Validate a candidate handover against the spec.

    Every problem is reported, not just the first, so a model fixing its
    output needs one round trip rather than five.
    """
    bag = _IssueBag()

    if not isinstance(input, dict):
        bag.add("", "a handover must be a JSON object")
        # Fail closed even here. A document with the wrong root shape is
        # still a document, and a credential inside one has still left the
        # machine. The scan runs before this early return so that no document
        # the ingestion boundary accepted is refused without also being
        # scanned.
        for finding in find_secret_material(input):
            bag.add(finding.path, describe_secret_finding(finding), "safety")
        return ValidationResult(valid=False, issues=tuple(bag.issues))

    _check_extra_keys(bag, input, _ROOT_KEYS, "")

    # Exact versions, never a pattern. A reader that accepts a minor it does
    # not implement is claiming to implement a version nobody has written;
    # version one is a closed world, so whatever that minor allowed would
    # arrive unrecognised. See spec/versioning.md.
    version = input.get("soilHandover")
    if not isinstance(version, str):
        bag.add("/soilHandover", 'is required and must be a string, e.g. "1.0"')
    elif version not in SUPPORTED_SPEC_VERSIONS:
        supported = ", ".join(SUPPORTED_SPEC_VERSIONS)
        bag.add(
            "/soilHandover",
            "must be a format version this reader supports"
            f' ({supported}), got "{version}"',
        )

    if "handoverId" not in input:
        bag.add(
            "/handoverId",
            "is required: the globally unique id a writer assigns when the"
            " handover is stored",
        )
    else:
        handover_id = input["handoverId"]
        if not isinstance(handover_id, str) or not HANDOVER_ID_PATTERN.match(
            handover_id
        ):
            bag.add(
                "/handoverId",
                "must be a UUID in canonical form: lowercase hex as"
                " 8-4-4-4-12",
            )

    project_id = input.get("projectId")
    if not isinstance(project_id, str) or len(project_id) == 0:
        bag.add("/projectId", "is required and must be a non-empty string")
    else:
        if text_length(project_id) > LIMITS.project_id:
            bag.add(
                "/projectId",
                f"must be at most {LIMITS.project_id} code points",
            )
        if not _PROJECT_ID_PATTERN.match(project_id):
            bag.add(
                "/projectId",
                "must be a slug: letters, digits, dot, dash or underscore,"
                " no spaces",
            )

    title = input.get("title")
    if not isinstance(title, str) or len(title.strip()) == 0:
        bag.add("/title", "is required and must be a non-empty string")
    elif text_length(title) > LIMITS.title:
        bag.add("/title", f"must be at most {LIMITS.title} code points")

    created_at = input.get("createdAt")
    if not isinstance(created_at, str):
        bag.add("/createdAt", "is required and must be an ISO 8601 timestamp")
    elif not _is_timestamp(created_at):
        bag.add(
            "/createdAt",
            'must be an ISO 8601 timestamp, e.g. "2026-07-23T09:41:00Z"',
        )

    if "source" in input:
        source = input["source"]
        if not isinstance(source, dict):
            bag.add("/source", "must be an object")
        else:
            _check_extra_keys(bag, source, _SOURCE_KEYS, "/source")
            for key in _SOURCE_TEXT_KEYS:
                if key in source and not isinstance(source[key], str):
                    bag.add(f"/source/{key}", "must be a string")
            if "recipeVersion" in source:
                recipe_version = source["recipeVersion"]
                if not isinstance(
                    recipe_version, str
                ) or not _RECIPE_VERSION_PATTERN.match(recipe_version):
                    bag.add(
                        "/source/recipeVersion",
                        'must be a semver string such as "1.0.0"',
                    )

    _check_sections(bag, input.get("sections"))

    if "quality" in input:
        quality = input["quality"]
        if not isinstance(quality, dict):
            bag.add("/quality", "must be an object")
        else:
            _check_extra_keys(bag, quality, _QUALITY_KEYS, "/quality")
            for key in _QUALITY_KEYS:
                if key in quality:
                    _check_string_list(bag, quality[key], f"/quality/{key}")

    if "safety" in input:
        safety = input["safety"]
        if not isinstance(safety, dict):
            bag.add("/safety", "must be an object")
        else:
            _check_extra_keys(bag, safety, _SAFETY_KEYS, "/safety")
            for key in _SAFETY_KEYS:
                if key in safety:
                    _check_string_list(bag, safety[key], f"/safety/{key}")

    # The extension point. Shape is checked; meaning is not. An entry whose
    # `kind` this implementation has never heard of is valid on purpose.
    if "observations" in input:
        observations = input["observations"]
        if not isinstance(observations, list):
            bag.add("/observations", "must be an array of observations")
        else:
            if len(observations) > LIMITS.observations:
                bag.add(
                    "/observations",
                    f"must hold at most {LIMITS.observations} entries",
                )
            for i, observation in enumerate(observations):
                path = f"/observations/{i}"
                if not isinstance(observation, dict):
                    bag.add(path, "must be an object with 'kind' and 'data'")
                    continue
                _check_extra_keys(bag, observation, _OBSERVATION_KEYS, path)

                kind = observation.get("kind")
                if not isinstance(kind, str) or len(kind.strip()) == 0:
                    bag.add(
                        f"{path}/kind",
                        "is required and must be a non-empty string",
                    )
                elif text_length(kind) > LIMITS.observation_kind:
                    bag.add(
                        f"{path}/kind",
                        "must be at most"
                        f" {LIMITS.observation_kind} code points",
                    )

                if not isinstance(observation.get("data"), dict):
                    bag.add(f"{path}/data", "is required and must be an object")

                for key in ("producedBy", "producedAt"):
                    if key in observation and not isinstance(
                        observation[key], str
                    ):
                        bag.add(f"{path}/{key}", "must be a string")
                produced_at = observation.get("producedAt")
                if isinstance(produced_at, str) and not _is_timestamp(
                    produced_at
                ):
                    bag.add(
                        f"{path}/producedAt", "must be an ISO 8601 timestamp"
                    )

    if "code" in input:
        code = input["code"]
        if not isinstance(code, str) or not _CODE_PATTERN.match(code):
            bag.add(
                "/code", 'must look like "#004": a hash and at least 3 digits'
            )

    # Fail closed on credentials. This runs whatever the structural result
    # was: a malformed document carrying a key is still a key.
    for finding in find_secret_material(input):
        bag.add(finding.path, describe_secret_finding(finding), "safety")

    return ValidationResult(valid=len(bag.issues) == 0, issues=tuple(bag.issues))


class HandoverValidationError(Exception):
    """Raised by ``assert_handover``. Carries every issue, not just the first."""

    def __init__(self, issues: tuple[ValidationIssue, ...]) -> None:
        detail = "; ".join(
            f"{issue.path or '/'} {issue.message}" for issue in issues
        )
        super().__init__(f"not a valid Soil handover: {detail}")
        self.issues = issues


def assert_handover(input: Any) -> None:
    """Validate, raising ``HandoverValidationError`` when invalid."""
    result = validate_handover(input)
    if not result.valid:
        raise HandoverValidationError(result.issues)
