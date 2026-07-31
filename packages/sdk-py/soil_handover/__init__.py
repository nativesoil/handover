"""soil_handover

The official Python implementation of the Soil Handover Specification v1: the
types, the structural validator, the extraction recipe, the rescue prompt,
the local file store, the restore-prompt assembler, and the rail-card
renderer.

Everything here is local. Nothing here reaches the network. The check
module is the open save-time baseline: deterministic, lint-style analysis of
the document itself, documented rule by rule in ``docs/checking.md``. Whether
a handover actually restores a session is a different question, answered only
by a real load. See ``docs/architecture.md`` for what is here now and what is
planned.

This SDK and the TypeScript SDK in ``packages/sdk-ts`` implement the same
specification and pass the same conformance fixtures. The recipe, the rescue
prompt, the restore prompt and the rail cards are byte-identical across the
two, and both writers refuse the same secret-shaped inputs.
"""

from .check import (
    CHECK_DEFAULT_NOTES,
    CHECK_GRADES,
    CHECK_NOTES_MAX_CHARS,
    CHECK_RULES,
    CHECK_SEVERITIES,
    CHECK_VERSION,
    CheckCounts,
    CheckFinding,
    CheckReport,
    check_handover,
    check_observation,
    grade_from_counts,
    split_entries,
)
from .identity import HANDOVER_ID_PATTERN, is_handover_id, uuidv7
from .ingest import (
    INGEST_ERROR_CODES,
    INGEST_LIMITS,
    IngestError,
    IngestIssue,
    IngestLimits,
    ingest_document,
    ingest_document_or_raise,
    ingest_text,
    ingest_text_or_raise,
)
from .lock import (
    DEFAULT_STALE_MS,
    DEFAULT_TIMEOUT_MS,
    LockBusyError,
    with_lock,
)
from .normalize import extract_json_block, normalize_handover
from .recipe import (
    ANTI_DRIFT_LENS,
    CLOSING_INSTRUCTION,
    RECIPE_VERSION,
    Recipe,
    SECTION_GUIDANCE,
    SELF_SUFFICIENT_FRAMING,
    SHARED_RULES,
    build_recipe,
    render_recipe,
)
from .render import (
    render_check,
    render_list,
    render_loaded,
    render_saved,
    render_validation,
    wrap,
)
from .rescue import RESCUE_PROMPT
from .restore import build_restore_prompt
from .safety import (
    SECRET_PATTERNS,
    SecretFinding,
    SecretMaterialError,
    SecretPattern,
    assert_no_secret_material,
    describe_secret_finding,
    find_secret_material,
    is_free_of_secret_material,
)
from .sections import (
    LIMITS,
    Limits,
    PROVENANCE_LABELS,
    SECTION_KEYS,
    SECTION_LABELS,
    SECTION_STATUSES,
    SECTION_TIERS,
    text_length,
)
from .store import (
    HandoverNotFoundError,
    HandoverStore,
    count_sections,
    format_code,
    parse_code,
    resolve_store_home,
)
from .types import (
    CaptureCounts,
    SectionCounts,
    Handover,
    HandoverObservation,
    HandoverQuality,
    HandoverSafety,
    HandoverSection,
    HandoverSource,
    SPEC_VERSION,
    SUPPORTED_SPEC_VERSIONS,
    StoreEntry,
    StoreIndex,
    ValidationIssue,
    ValidationResult,
)
from .validate import (
    HandoverValidationError,
    assert_handover,
    validate_handover,
)

__all__ = [
    "ANTI_DRIFT_LENS",
    "CHECK_DEFAULT_NOTES",
    "CHECK_GRADES",
    "CHECK_NOTES_MAX_CHARS",
    "CHECK_RULES",
    "CHECK_SEVERITIES",
    "CHECK_VERSION",
    "CheckCounts",
    "CheckFinding",
    "CheckReport",
    "CLOSING_INSTRUCTION",
    "DEFAULT_STALE_MS",
    "DEFAULT_TIMEOUT_MS",
    "CaptureCounts",
    "SectionCounts",
    "HANDOVER_ID_PATTERN",
    "Handover",
    "HandoverNotFoundError",
    "HandoverObservation",
    "HandoverQuality",
    "HandoverSafety",
    "HandoverSection",
    "HandoverSource",
    "HandoverStore",
    "HandoverValidationError",
    "INGEST_ERROR_CODES",
    "INGEST_LIMITS",
    "IngestError",
    "IngestIssue",
    "IngestLimits",
    "LIMITS",
    "Limits",
    "LockBusyError",
    "PROVENANCE_LABELS",
    "RECIPE_VERSION",
    "RESCUE_PROMPT",
    "Recipe",
    "SECRET_PATTERNS",
    "SECTION_GUIDANCE",
    "SECTION_KEYS",
    "SECTION_LABELS",
    "SECTION_STATUSES",
    "SECTION_TIERS",
    "text_length",
    "SELF_SUFFICIENT_FRAMING",
    "SHARED_RULES",
    "SPEC_VERSION",
    "SUPPORTED_SPEC_VERSIONS",
    "SecretFinding",
    "SecretMaterialError",
    "SecretPattern",
    "StoreEntry",
    "StoreIndex",
    "ValidationIssue",
    "ValidationResult",
    "assert_handover",
    "assert_no_secret_material",
    "build_recipe",
    "build_restore_prompt",
    "check_handover",
    "check_observation",
    "count_sections",
    "describe_secret_finding",
    "extract_json_block",
    "find_secret_material",
    "format_code",
    "grade_from_counts",
    "ingest_document",
    "ingest_document_or_raise",
    "ingest_text",
    "ingest_text_or_raise",
    "is_free_of_secret_material",
    "is_handover_id",
    "normalize_handover",
    "parse_code",
    "render_check",
    "render_list",
    "render_loaded",
    "render_recipe",
    "render_saved",
    "render_validation",
    "resolve_store_home",
    "split_entries",
    "uuidv7",
    "validate_handover",
    "with_lock",
    "wrap",
]
