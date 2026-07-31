/**
 * Validation: does this document obey the Soil Handover Specification v1?
 *
 * Two normative rules are checked, and only two. First the shape: the 17
 * sections, the statuses, the labels, the bounds. Then the fail-closed secret
 * scan: a handover that carries credentials or private absolute paths is
 * rejected, because a handover is written to be moved and anything inside it
 * has already left the machine.
 *
 * Neither rule is a judgement about content. This answers "is this a handover
 * and is it safe to move", never "is this a good handover". A thin but honest
 * handover is valid, and so is one whose every section is `missing`.
 *
 * `spec/handover.schema.json` is the normative statement of these same rules.
 * A conformance test asserts that this function and that schema agree on every
 * fixture, so the two cannot drift apart.
 *
 * Zero dependencies on purpose: the SDK should be usable anywhere without a
 * validator bundle, and the error messages here can say what a JSON Schema
 * error cannot.
 */

import { HANDOVER_ID_PATTERN } from "./identity.js";
import { describeSecretFinding, findSecretMaterial } from "./safety.js";
import {
  LIMITS,
  PROVENANCE_LABELS,
  SECTION_KEYS,
  SECTION_STATUSES,
  textLength,
} from "./sections.js";
import {
  SUPPORTED_SPEC_VERSIONS,
  type Handover,
  type ValidationIssue,
  type ValidationIssueKind,
  type ValidationResult,
} from "./types.js";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CODE_PATTERN = /^#\d{3,}$/;
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Why `not_applicable` is the one gap status that must say something.
 *
 * It is a positive assertion about the project rather than a report about the
 * extractor, and it is the only status that tells the next model to stop
 * looking. A writer that cannot say why a section does not apply has not
 * established that it does not apply; it has established that it could not see
 * it, and `missing` says exactly that and carries no such requirement.
 */
const NOT_APPLICABLE_NEEDS_REASON =
  "must say why the section does not apply when status is 'not_applicable': a gap that tells the next model to stop looking has to carry its reason, and a gap with no reason is 'missing'";

const SOURCE_TEXT_KEYS = ["client", "model", "provider"] as const;
const SOURCE_KEYS = [...SOURCE_TEXT_KEYS, "recipeVersion"] as const;
const RECIPE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const OBSERVATION_KEYS = ["kind", "producedBy", "producedAt", "data"] as const;
const QUALITY_KEYS = ["missingInputs", "contradictions"] as const;
const SAFETY_KEYS = ["unsafeOmissions"] as const;
const ROOT_KEYS = [
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
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class IssueBag {
  readonly issues: ValidationIssue[] = [];
  add(
    path: string,
    message: string,
    kind: ValidationIssueKind = "structure",
  ): void {
    this.issues.push({ path, message, kind });
  }
}

function checkStringList(bag: IssueBag, value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    bag.add(path, "must be an array of strings");
    return;
  }
  if (value.length > LIMITS.listEntries) {
    bag.add(path, `must hold at most ${LIMITS.listEntries} entries`);
  }
  value.forEach((entry, i) => {
    if (typeof entry !== "string") {
      bag.add(`${path}/${i}`, "must be a string");
      return;
    }
    if (entry.trim().length === 0) {
      bag.add(`${path}/${i}`, "must not be empty");
    }
    if (textLength(entry) > LIMITS.listEntry) {
      bag.add(
        `${path}/${i}`,
        `must be at most ${LIMITS.listEntry} code points`,
      );
    }
  });
}

function checkExtraKeys(
  bag: IssueBag,
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      bag.add(`${path}/${key}`, "is not a field of this object");
    }
  }
}

function checkSections(bag: IssueBag, value: unknown): void {
  if (!isRecord(value)) {
    bag.add("/sections", "must be an object holding all 17 sections");
    return;
  }
  checkExtraKeys(bag, value, SECTION_KEYS, "/sections");

  for (const key of SECTION_KEYS) {
    const path = `/sections/${key}`;
    const section = value[key];
    if (section === undefined) {
      bag.add(
        path,
        "is required: every section is declared, and a gap is stated with status 'missing'",
      );
      continue;
    }
    if (!isRecord(section)) {
      bag.add(path, "must be an object with 'status' and 'summary'");
      continue;
    }
    checkExtraKeys(bag, section, ["status", "summary", "provenance"], path);

    const status = section["status"];
    if (
      typeof status !== "string" ||
      !SECTION_STATUSES.includes(status as never)
    ) {
      bag.add(
        `${path}/status`,
        `must be one of ${SECTION_STATUSES.join(", ")}`,
      );
    }

    const summary = section["summary"];
    if (summary !== null && typeof summary !== "string") {
      bag.add(`${path}/summary`, "must be a string or null");
    } else if (typeof summary === "string") {
      if (textLength(summary) > LIMITS.sectionSummary) {
        bag.add(
          `${path}/summary`,
          `must be at most ${LIMITS.sectionSummary} code points`,
        );
      }
      if (status === "available" && summary.trim().length === 0) {
        bag.add(
          `${path}/summary`,
          "must hold content when status is 'available'",
        );
      }
      if (status === "not_applicable" && summary.trim().length === 0) {
        bag.add(`${path}/summary`, NOT_APPLICABLE_NEEDS_REASON);
      }
    } else if (status === "available") {
      bag.add(
        `${path}/summary`,
        "must hold content when status is 'available'",
      );
    } else if (status === "not_applicable") {
      bag.add(`${path}/summary`, NOT_APPLICABLE_NEEDS_REASON);
    }

    const provenance = section["provenance"];
    if (provenance !== undefined) {
      if (!Array.isArray(provenance)) {
        bag.add(`${path}/provenance`, "must be an array of provenance labels");
      } else {
        if (provenance.length > LIMITS.provenanceLabels) {
          bag.add(
            `${path}/provenance`,
            `must hold at most ${LIMITS.provenanceLabels} labels`,
          );
        }
        const seen = new Set<unknown>();
        provenance.forEach((label, i) => {
          if (
            typeof label !== "string" ||
            !PROVENANCE_LABELS.includes(label as never)
          ) {
            bag.add(
              `${path}/provenance/${i}`,
              `must be one of ${PROVENANCE_LABELS.join(", ")}`,
            );
            return;
          }
          if (seen.has(label)) {
            bag.add(`${path}/provenance/${i}`, "is a duplicate label");
          }
          seen.add(label);
        });
      }
    }
  }
}

/**
 * Validate a candidate handover against the spec.
 *
 * Every problem is reported, not just the first, so a model fixing its output
 * needs one round trip rather than five.
 */
export function validateHandover(input: unknown): ValidationResult {
  const bag = new IssueBag();

  if (!isRecord(input)) {
    bag.add("", "a handover must be a JSON object");
    // Fail closed even here. A document with the wrong root shape is still a
    // document, and a credential inside one has still left the machine. The
    // scan runs before this early return so that no document the ingestion
    // boundary accepted is refused without also being scanned.
    for (const finding of findSecretMaterial(input)) {
      bag.add(finding.path, describeSecretFinding(finding), "safety");
    }
    return { valid: false, issues: bag.issues };
  }

  checkExtraKeys(bag, input, ROOT_KEYS, "");

  // Exact versions, never a pattern. A reader that accepts a minor it does not
  // implement is claiming to implement a version nobody has written; version
  // one is a closed world, so whatever that minor allowed would arrive
  // unrecognised. See `spec/versioning.md`.
  const version = input["soilHandover"];
  if (typeof version !== "string") {
    bag.add("/soilHandover", 'is required and must be a string, e.g. "1.0"');
  } else if (
    !(SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(version)
  ) {
    bag.add(
      "/soilHandover",
      `must be a format version this reader supports (${SUPPORTED_SPEC_VERSIONS.join(", ")}), got "${version}"`,
    );
  }

  const handoverId = input["handoverId"];
  if (handoverId === undefined) {
    bag.add(
      "/handoverId",
      "is required: the globally unique id a writer assigns when the handover is stored",
    );
  } else if (
    typeof handoverId !== "string" ||
    !HANDOVER_ID_PATTERN.test(handoverId)
  ) {
    bag.add(
      "/handoverId",
      "must be a UUID in canonical form: lowercase hex as 8-4-4-4-12",
    );
  }

  const projectId = input["projectId"];
  if (typeof projectId !== "string" || projectId.length === 0) {
    bag.add("/projectId", "is required and must be a non-empty string");
  } else {
    if (textLength(projectId) > LIMITS.projectId) {
      bag.add("/projectId", `must be at most ${LIMITS.projectId} code points`);
    }
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      bag.add(
        "/projectId",
        "must be a slug: letters, digits, dot, dash or underscore, no spaces",
      );
    }
  }

  const title = input["title"];
  if (typeof title !== "string" || title.trim().length === 0) {
    bag.add("/title", "is required and must be a non-empty string");
  } else if (textLength(title) > LIMITS.title) {
    bag.add("/title", `must be at most ${LIMITS.title} code points`);
  }

  const createdAt = input["createdAt"];
  if (typeof createdAt !== "string") {
    bag.add("/createdAt", "is required and must be an ISO 8601 timestamp");
  } else if (
    !ISO_DATE_PATTERN.test(createdAt) ||
    Number.isNaN(Date.parse(createdAt))
  ) {
    bag.add(
      "/createdAt",
      `must be an ISO 8601 timestamp, e.g. "2026-07-23T09:41:00Z"`,
    );
  }

  const source = input["source"];
  if (source !== undefined) {
    if (!isRecord(source)) {
      bag.add("/source", "must be an object");
    } else {
      checkExtraKeys(bag, source, SOURCE_KEYS, "/source");
      for (const key of SOURCE_TEXT_KEYS) {
        const entry = source[key];
        if (entry !== undefined && typeof entry !== "string") {
          bag.add(`/source/${key}`, "must be a string");
        }
      }
      const recipeVersion = source["recipeVersion"];
      if (
        recipeVersion !== undefined &&
        (typeof recipeVersion !== "string" ||
          !RECIPE_VERSION_PATTERN.test(recipeVersion))
      ) {
        bag.add(
          "/source/recipeVersion",
          'must be a semver string such as "1.0.0"',
        );
      }
    }
  }

  checkSections(bag, input["sections"]);

  const quality = input["quality"];
  if (quality !== undefined) {
    if (!isRecord(quality)) {
      bag.add("/quality", "must be an object");
    } else {
      checkExtraKeys(bag, quality, QUALITY_KEYS, "/quality");
      for (const key of QUALITY_KEYS) {
        if (quality[key] !== undefined) {
          checkStringList(bag, quality[key], `/quality/${key}`);
        }
      }
    }
  }

  const safety = input["safety"];
  if (safety !== undefined) {
    if (!isRecord(safety)) {
      bag.add("/safety", "must be an object");
    } else {
      checkExtraKeys(bag, safety, SAFETY_KEYS, "/safety");
      for (const key of SAFETY_KEYS) {
        if (safety[key] !== undefined) {
          checkStringList(bag, safety[key], `/safety/${key}`);
        }
      }
    }
  }

  // The extension point. Shape is checked; meaning is not. An entry whose
  // `kind` this implementation has never heard of is valid on purpose.
  const observations = input["observations"];
  if (observations !== undefined) {
    if (!Array.isArray(observations)) {
      bag.add("/observations", "must be an array of observations");
    } else {
      if (observations.length > LIMITS.observations) {
        bag.add(
          "/observations",
          `must hold at most ${LIMITS.observations} entries`,
        );
      }
      observations.forEach((observation, i) => {
        const path = `/observations/${i}`;
        if (!isRecord(observation)) {
          bag.add(path, "must be an object with 'kind' and 'data'");
          return;
        }
        checkExtraKeys(bag, observation, OBSERVATION_KEYS, path);

        const kind = observation["kind"];
        if (typeof kind !== "string" || kind.trim().length === 0) {
          bag.add(`${path}/kind`, "is required and must be a non-empty string");
        } else if (textLength(kind) > LIMITS.observationKind) {
          bag.add(
            `${path}/kind`,
            `must be at most ${LIMITS.observationKind} code points`,
          );
        }

        if (!isRecord(observation["data"])) {
          bag.add(`${path}/data`, "is required and must be an object");
        }

        for (const key of ["producedBy", "producedAt"] as const) {
          const value = observation[key];
          if (value !== undefined && typeof value !== "string") {
            bag.add(`${path}/${key}`, "must be a string");
          }
        }
        const producedAt = observation["producedAt"];
        if (
          typeof producedAt === "string" &&
          (!ISO_DATE_PATTERN.test(producedAt) ||
            Number.isNaN(Date.parse(producedAt)))
        ) {
          bag.add(`${path}/producedAt`, "must be an ISO 8601 timestamp");
        }
      });
    }
  }

  const code = input["code"];
  if (code !== undefined) {
    if (typeof code !== "string" || !CODE_PATTERN.test(code)) {
      bag.add("/code", 'must look like "#004": a hash and at least 3 digits');
    }
  }

  // Fail closed on credentials. This runs whatever the structural result was:
  // a malformed document carrying a key is still a key.
  for (const finding of findSecretMaterial(input)) {
    bag.add(finding.path, describeSecretFinding(finding), "safety");
  }

  return { valid: bag.issues.length === 0, issues: bag.issues };
}

/** Validate and narrow. Throws {@link HandoverValidationError} when invalid. */
export function assertHandover(input: unknown): asserts input is Handover {
  const result = validateHandover(input);
  if (!result.valid) {
    throw new HandoverValidationError(result.issues);
  }
}

/** Thrown by {@link assertHandover}. Carries every issue, not just the first. */
export class HandoverValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
  constructor(issues: readonly ValidationIssue[]) {
    const detail = issues
      .map((issue) => `${issue.path || "/"} ${issue.message}`)
      .join("; ");
    super(`not a valid Soil handover: ${detail}`);
    this.name = "HandoverValidationError";
    this.issues = issues;
  }
}
