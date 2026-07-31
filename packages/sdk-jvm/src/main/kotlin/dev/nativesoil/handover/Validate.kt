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
 * `spec/handover.schema.json` is the normative statement of these same rules,
 * and the conformance suite holds this validator to the same fixtures the
 * schema is held to, so the two cannot drift apart.
 *
 * Mirrors `packages/sdk-ts/src/validate.ts` rule for rule, message for
 * message, in the same order, so the issues a caller sees are the same in
 * every SDK.
 */
@file:JvmName("Validate")

package dev.nativesoil.handover

import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * What kind of rule an issue broke. `STRUCTURE` is the shape of the document.
 * `SAFETY` is the fail-closed secret scan, which is a spec rule rather than a
 * schema rule because JSON Schema cannot express "this string looks like a
 * token".
 */
enum class ValidationIssueKind(val label: String) {
    STRUCTURE("structure"),
    SAFETY("safety"),
}

/** One problem found by [validateHandover]. */
data class ValidationIssue(
    /** JSON Pointer-ish path to the offending value, e.g. `/sections/decisions`. */
    @JvmField val path: String,
    /** What is wrong, in plain language. Never quotes the offending value. */
    @JvmField val message: String,
    /** Which rule was broken. */
    @JvmField val kind: ValidationIssueKind = ValidationIssueKind.STRUCTURE,
)

/** The result of validating a candidate handover. */
data class ValidationResult(
    @JvmField val valid: Boolean,
    @JvmField val issues: List<ValidationIssue>,
)

/**
 * Why `not_applicable` is the one gap status that must say something.
 *
 * It is a positive assertion about the project rather than a report about the
 * extractor, and it is the only status that tells the next model to stop
 * looking. A writer that cannot say why a section does not apply has not
 * established that it does not apply; it has established that it could not see
 * it, and `missing` says exactly that and carries no such requirement.
 */
private const val NOT_APPLICABLE_NEEDS_REASON =
    "must say why the section does not apply when status is 'not_applicable': " +
        "a gap that tells the next model to stop looking has to carry its reason, " +
        "and a gap with no reason is 'missing'"

private val PROJECT_ID_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*$")
private val CODE_PATTERN = Regex("^#\\d{3,}$")
private val ISO_DATE_PATTERN =
    Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$")
private val RECIPE_VERSION_PATTERN = Regex("^\\d+\\.\\d+\\.\\d+$")

private val SOURCE_TEXT_KEYS = listOf("client", "model", "provider")
private val SOURCE_KEYS = SOURCE_TEXT_KEYS + "recipeVersion"
private val OBSERVATION_KEYS = listOf("kind", "producedBy", "producedAt", "data")
private val QUALITY_KEYS = listOf("missingInputs", "contradictions")
private val SAFETY_KEYS = listOf("unsafeOmissions")
private val ROOT_KEYS = listOf(
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

private fun isParseableTimestamp(value: String): Boolean =
    try {
        OffsetDateTime.parse(value)
        true
    } catch (e: DateTimeParseException) {
        false
    }

private class IssueBag {
    val issues = mutableListOf<ValidationIssue>()

    fun add(
        path: String,
        message: String,
        kind: ValidationIssueKind = ValidationIssueKind.STRUCTURE,
    ) {
        issues.add(ValidationIssue(path, message, kind))
    }
}

private fun checkStringList(bag: IssueBag, value: JsonElement?, path: String) {
    if (value !is JsonArray) {
        bag.add(path, "must be an array of strings")
        return
    }
    if (value.size > Limits.LIST_ENTRIES) {
        bag.add(path, "must hold at most ${Limits.LIST_ENTRIES} entries")
    }
    value.forEachIndexed { i, entry ->
        val text = asStringOrNull(entry)
        if (text == null) {
            bag.add("$path/$i", "must be a string")
            return@forEachIndexed
        }
        if (text.trim().isEmpty()) {
            bag.add("$path/$i", "must not be empty")
        }
        if (textLength(text) > Limits.LIST_ENTRY) {
            bag.add("$path/$i", "must be at most ${Limits.LIST_ENTRY} code points")
        }
    }
}

private fun checkExtraKeys(
    bag: IssueBag,
    record: JsonObject,
    allowed: List<String>,
    path: String,
) {
    for (key in record.keys) {
        if (key !in allowed) {
            bag.add("$path/$key", "is not a field of this object")
        }
    }
}

private fun checkSections(bag: IssueBag, value: JsonElement?) {
    if (value !is JsonObject) {
        bag.add("/sections", "must be an object holding all 17 sections")
        return
    }
    checkExtraKeys(bag, value, SECTION_KEYS, "/sections")

    for (key in SECTION_KEYS) {
        val path = "/sections/$key"
        val section = value[key]
        if (section == null) {
            bag.add(
                path,
                "is required: every section is declared, and a gap is stated with status 'missing'",
            )
            continue
        }
        if (section !is JsonObject) {
            bag.add(path, "must be an object with 'status' and 'summary'")
            continue
        }
        checkExtraKeys(bag, section, listOf("status", "summary", "provenance"), path)

        val status = asStringOrNull(section["status"])
        if (status == null || status !in SECTION_STATUSES) {
            bag.add("$path/status", "must be one of ${SECTION_STATUSES.joinToString(", ")}")
        }

        val summary = section["summary"]
        val summaryText = asStringOrNull(summary)
        if (summary == null || (summary !is JsonNull && summaryText == null)) {
            bag.add("$path/summary", "must be a string or null")
        } else if (summaryText != null) {
            if (textLength(summaryText) > Limits.SECTION_SUMMARY) {
                bag.add(
                    "$path/summary",
                    "must be at most ${Limits.SECTION_SUMMARY} code points",
                )
            }
            if (status == "available" && summaryText.trim().isEmpty()) {
                bag.add("$path/summary", "must hold content when status is 'available'")
            }
            if (status == "not_applicable" && summaryText.trim().isEmpty()) {
                bag.add("$path/summary", NOT_APPLICABLE_NEEDS_REASON)
            }
        } else if (status == "available") {
            bag.add("$path/summary", "must hold content when status is 'available'")
        } else if (status == "not_applicable") {
            bag.add("$path/summary", NOT_APPLICABLE_NEEDS_REASON)
        }

        val provenance = section["provenance"]
        if (provenance != null) {
            if (provenance !is JsonArray) {
                bag.add("$path/provenance", "must be an array of provenance labels")
            } else {
                if (provenance.size > Limits.PROVENANCE_LABELS) {
                    bag.add(
                        "$path/provenance",
                        "must hold at most ${Limits.PROVENANCE_LABELS} labels",
                    )
                }
                val seen = mutableSetOf<String>()
                provenance.forEachIndexed { i, labelElement ->
                    val label = asStringOrNull(labelElement)
                    if (label == null || label !in PROVENANCE_LABELS) {
                        bag.add(
                            "$path/provenance/$i",
                            "must be one of ${PROVENANCE_LABELS.joinToString(", ")}",
                        )
                        return@forEachIndexed
                    }
                    if (label in seen) {
                        bag.add("$path/provenance/$i", "is a duplicate label")
                    }
                    seen.add(label)
                }
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
fun validateHandover(input: JsonElement?): ValidationResult {
    val bag = IssueBag()

    if (input !is JsonObject) {
        bag.add("", "a handover must be a JSON object")
        // Fail closed even here. A document with the wrong root shape is still
        // a document, and a credential inside one has still left the machine.
        // The scan runs before this early return so that no document the
        // ingestion boundary accepted is refused without also being scanned.
        for (finding in findSecretMaterial(input)) {
            bag.add(finding.path, describeSecretFinding(finding), ValidationIssueKind.SAFETY)
        }
        return ValidationResult(false, bag.issues)
    }

    checkExtraKeys(bag, input, ROOT_KEYS, "")

    // Exact versions, never a pattern. A reader that accepts a minor it does
    // not implement is claiming to implement a version nobody has written;
    // version one is a closed world, so whatever that minor allowed would
    // arrive unrecognised. See spec/versioning.md.
    val version = asStringOrNull(input["soilHandover"])
    if (version == null) {
        bag.add("/soilHandover", "is required and must be a string, e.g. \"1.0\"")
    } else if (version !in SUPPORTED_SPEC_VERSIONS) {
        val supported = SUPPORTED_SPEC_VERSIONS.joinToString(", ")
        bag.add(
            "/soilHandover",
            "must be a format version this reader supports ($supported), got \"$version\"",
        )
    }

    val handoverId = input["handoverId"]
    if (handoverId == null) {
        bag.add(
            "/handoverId",
            "is required: the globally unique id a writer assigns when the handover is stored",
        )
    } else {
        val idText = asStringOrNull(handoverId)
        if (idText == null || !HANDOVER_ID_PATTERN.matches(idText)) {
            bag.add(
                "/handoverId",
                "must be a UUID in canonical form: lowercase hex as 8-4-4-4-12",
            )
        }
    }

    val projectId = asStringOrNull(input["projectId"])
    if (projectId == null || projectId.isEmpty()) {
        bag.add("/projectId", "is required and must be a non-empty string")
    } else {
        if (textLength(projectId) > Limits.PROJECT_ID) {
            bag.add("/projectId", "must be at most ${Limits.PROJECT_ID} code points")
        }
        if (!PROJECT_ID_PATTERN.matches(projectId)) {
            bag.add(
                "/projectId",
                "must be a slug: letters, digits, dot, dash or underscore, no spaces",
            )
        }
    }

    val title = asStringOrNull(input["title"])
    if (title == null || title.trim().isEmpty()) {
        bag.add("/title", "is required and must be a non-empty string")
    } else if (textLength(title) > Limits.TITLE) {
        bag.add("/title", "must be at most ${Limits.TITLE} code points")
    }

    val createdAt = asStringOrNull(input["createdAt"])
    if (createdAt == null) {
        bag.add("/createdAt", "is required and must be an ISO 8601 timestamp")
    } else if (!ISO_DATE_PATTERN.matches(createdAt) || !isParseableTimestamp(createdAt)) {
        bag.add(
            "/createdAt",
            "must be an ISO 8601 timestamp, e.g. \"2026-07-23T09:41:00Z\"",
        )
    }

    val source = input["source"]
    if (source != null) {
        if (source !is JsonObject) {
            bag.add("/source", "must be an object")
        } else {
            checkExtraKeys(bag, source, SOURCE_KEYS, "/source")
            for (key in SOURCE_TEXT_KEYS) {
                val entry = source[key]
                if (entry != null && asStringOrNull(entry) == null) {
                    bag.add("/source/$key", "must be a string")
                }
            }
            val recipeVersion = source["recipeVersion"]
            if (recipeVersion != null) {
                val text = asStringOrNull(recipeVersion)
                if (text == null || !RECIPE_VERSION_PATTERN.matches(text)) {
                    bag.add(
                        "/source/recipeVersion",
                        "must be a semver string such as \"1.0.0\"",
                    )
                }
            }
        }
    }

    checkSections(bag, input["sections"])

    val quality = input["quality"]
    if (quality != null) {
        if (quality !is JsonObject) {
            bag.add("/quality", "must be an object")
        } else {
            checkExtraKeys(bag, quality, QUALITY_KEYS, "/quality")
            for (key in QUALITY_KEYS) {
                if (quality[key] != null) {
                    checkStringList(bag, quality[key], "/quality/$key")
                }
            }
        }
    }

    val safety = input["safety"]
    if (safety != null) {
        if (safety !is JsonObject) {
            bag.add("/safety", "must be an object")
        } else {
            checkExtraKeys(bag, safety, SAFETY_KEYS, "/safety")
            for (key in SAFETY_KEYS) {
                if (safety[key] != null) {
                    checkStringList(bag, safety[key], "/safety/$key")
                }
            }
        }
    }

    // The extension point. Shape is checked; meaning is not. An entry whose
    // `kind` this implementation has never heard of is valid on purpose.
    val observations = input["observations"]
    if (observations != null) {
        if (observations !is JsonArray) {
            bag.add("/observations", "must be an array of observations")
        } else {
            if (observations.size > Limits.OBSERVATIONS) {
                bag.add(
                    "/observations",
                    "must hold at most ${Limits.OBSERVATIONS} entries",
                )
            }
            observations.forEachIndexed { i, observation ->
                val path = "/observations/$i"
                if (observation !is JsonObject) {
                    bag.add(path, "must be an object with 'kind' and 'data'")
                    return@forEachIndexed
                }
                checkExtraKeys(bag, observation, OBSERVATION_KEYS, path)

                val kind = asStringOrNull(observation["kind"])
                if (kind == null || kind.trim().isEmpty()) {
                    bag.add("$path/kind", "is required and must be a non-empty string")
                } else if (textLength(kind) > Limits.OBSERVATION_KIND) {
                    bag.add(
                        "$path/kind",
                        "must be at most ${Limits.OBSERVATION_KIND} code points",
                    )
                }

                if (observation["data"] !is JsonObject) {
                    bag.add("$path/data", "is required and must be an object")
                }

                for (key in listOf("producedBy", "producedAt")) {
                    val entry = observation[key]
                    if (entry != null && asStringOrNull(entry) == null) {
                        bag.add("$path/$key", "must be a string")
                    }
                }
                val producedAt = asStringOrNull(observation["producedAt"])
                if (
                    producedAt != null &&
                    (!ISO_DATE_PATTERN.matches(producedAt) || !isParseableTimestamp(producedAt))
                ) {
                    bag.add("$path/producedAt", "must be an ISO 8601 timestamp")
                }
            }
        }
    }

    val code = input["code"]
    if (code != null) {
        val text = asStringOrNull(code)
        if (text == null || !CODE_PATTERN.matches(text)) {
            bag.add("/code", "must look like \"#004\": a hash and at least 3 digits")
        }
    }

    // Fail closed on credentials. This runs whatever the structural result was:
    // a malformed document carrying a key is still a key.
    for (finding in findSecretMaterial(input as JsonElement)) {
        bag.add(finding.path, describeSecretFinding(finding), ValidationIssueKind.SAFETY)
    }

    return ValidationResult(bag.issues.isEmpty(), bag.issues)
}

/**
 * Validate and narrow. Returns the document as a [JsonObject] when valid and
 * throws [HandoverValidationException] when it is not.
 */
fun assertHandover(input: JsonElement?): JsonObject {
    val result = validateHandover(input)
    if (!result.valid) {
        throw HandoverValidationException(result.issues)
    }
    return input as JsonObject
}

/** Thrown by [assertHandover]. Carries every issue, not just the first. */
class HandoverValidationException(
    @JvmField val issues: List<ValidationIssue>,
) : RuntimeException(
    "not a valid Soil handover: " +
        issues.joinToString("; ") { "${it.path.ifEmpty { "/" }} ${it.message}" }
)
