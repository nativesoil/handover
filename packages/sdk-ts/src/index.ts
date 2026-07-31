/**
 * @nativesoil/handover-sdk
 *
 * The official implementation of the Soil Handover Specification v1: the
 * types, the structural validator, the extraction recipe, the rescue prompt,
 * the local file store, the restore-prompt assembler, and the rail-card
 * renderer.
 *
 * Everything here is local. Nothing here reaches the network. The check
 * module is the open save-time baseline: deterministic, lint-style analysis
 * of the document itself, documented rule by rule in `docs/checking.md`.
 * Whether a handover actually restores a session is a different question,
 * answered only by a real load. See `docs/architecture.md` for what is here
 * now and what is planned.
 */

export {
  LIMITS,
  PROVENANCE_LABELS,
  SECTION_KEYS,
  SECTION_LABELS,
  SECTION_STATUSES,
  SECTION_TIERS,
  textLength,
  type ProvenanceLabel,
  type SectionKey,
  type SectionStatus,
  type SectionTier,
} from "./sections.js";

export {
  SPEC_VERSION,
  SUPPORTED_SPEC_VERSIONS,
  type Handover,
  type HandoverObservation,
  type HandoverQuality,
  type HandoverSafety,
  type HandoverSection,
  type HandoverSections,
  type HandoverSource,
  type SectionCounts,
  type StoreEntry,
  type StoreIndex,
  type ValidationIssue,
  type ValidationIssueKind,
  type ValidationResult,
  /** @deprecated Renamed to SectionCounts. */
  type CaptureCounts,
} from "./types.js";

export { HANDOVER_ID_PATTERN, isHandoverId, uuidv7 } from "./identity.js";

export {
  CLAIM_ID_DOMAIN,
  CLAIM_ID_LENGTH,
  CLAIM_KINDS,
  ClaimIdentityError,
  claimId,
  isClaimKind,
  normalizeClaimStatement,
  type ClaimKind,
} from "./claim.js";

export {
  HandoverValidationError,
  assertHandover,
  validateHandover,
} from "./validate.js";

export {
  SECRET_PATTERNS,
  SecretMaterialError,
  assertNoSecretMaterial,
  describeSecretFinding,
  findSecretMaterial,
  isFreeOfSecretMaterial,
  type SecretFinding,
  type SecretPattern,
} from "./safety.js";

export {
  INGEST_ERROR_CODES,
  INGEST_LIMITS,
  IngestError,
  ingestDocument,
  ingestDocumentOrThrow,
  ingestText,
  ingestTextOrThrow,
  type IngestErrorCode,
  type IngestIssue,
  type IngestResult,
} from "./ingest.js";

export { extractJsonBlock, normalizeHandover } from "./normalize.js";

export {
  ANTI_DRIFT_LENS,
  CLOSING_INSTRUCTION,
  RECIPE_VERSION,
  SECTION_GUIDANCE,
  SELF_SUFFICIENT_FRAMING,
  SHARED_RULES,
  buildRecipe,
  renderRecipe,
  type Recipe,
} from "./recipe.js";

export { RESCUE_PROMPT } from "./rescue.js";

export {
  DEFAULT_STALE_MS,
  DEFAULT_TIMEOUT_MS,
  LockBusyError,
  withLock,
  type LockOptions,
} from "./lock.js";

export {
  HandoverNotFoundError,
  HandoverStore,
  countSections,
  formatCode,
  parseCode,
  resolveStoreHome,
} from "./store.js";

export { buildRestorePrompt } from "./restore.js";
export type { RestoreOptions } from "./restore.js";

export {
  CHECK_DEFAULT_NOTES,
  CHECK_GRADES,
  CHECK_NOTES_MAX_CHARS,
  CHECK_RULES,
  CHECK_SEVERITIES,
  CHECK_VERSION,
  checkHandover,
  checkObservation,
  gradeFromCounts,
  splitEntries,
  type CheckCounts,
  type CheckFinding,
  type CheckGrade,
  type CheckObservationOptions,
  type CheckReport,
  type CheckRuleId,
  type CheckSeverity,
} from "./check.js";

export {
  renderCheck,
  renderList,
  renderLoaded,
  renderSaved,
  renderValidation,
  wrap,
} from "./render.js";
