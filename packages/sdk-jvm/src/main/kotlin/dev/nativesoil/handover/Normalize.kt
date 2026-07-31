/**
 * Normalization: turn what a model actually emitted into a spec-shaped
 * document.
 *
 * Models write JSON by hand under pressure. They use the loose
 * `extractionSections` key, they write a section as a bare string, they skip
 * sections they had nothing for, they forget `soilHandover`. None of that is
 * interesting, and none of it should cost a user their capture.
 *
 * One rule governs the whole file, and it is the rule that makes a save and a
 * validation of the same bytes agree:
 *
 *   Every member present in the input is present in the output. A member is
 *   rewritten only in the ways `spec/normalization-profile.md` enumerates, a
 *   value that cannot be rewritten is carried through verbatim, and nothing is
 *   invented.
 *
 * So an unknown top-level field, an unknown field on a section, an unknown
 * section key and an unrecognised provenance label all survive this function
 * and are refused by `validate`, at the path they actually occupy. Version one
 * is a closed world (`spec/versioning.md`): none of those is an extension
 * point, and deleting them here would mean the same bytes were rejected by
 * `validate` and accepted by `save`.
 *
 * Three things this deliberately does NOT do, each of which it used to:
 *
 *  - It does not stamp a `createdAt`. A document that does not say when it was
 *    captured is refused by `validate`, not completed here.
 *  - It does not stamp `source.recipeVersion`. This function is handed a
 *    document somebody else wrote, so attributing its own recipe to that
 *    document destroys the field's only use.
 *  - It does not drop a `handoverId` it cannot use. A malformed id reaches
 *    `validate` and is refused there, rather than being dropped here and
 *    replaced, over the top, with a freshly minted one by the writer.
 *
 * Mirrors `packages/sdk-ts/src/normalize.ts` rewrite for rewrite.
 */
@file:JvmName("Normalize")

package dev.nativesoil.handover

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// The members each object may carry. Everything else is carried through.
private val SECTION_FIELDS = listOf("status", "summary", "provenance")
private val SOURCE_FIELDS = listOf("client", "model", "provider", "recipeVersion")
private val QUALITY_FIELDS = listOf("missingInputs", "contradictions")
private val SAFETY_FIELDS = listOf("unsafeOmissions")
private val ROOT_FIELDS = listOf(
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

/**
 * Copy the members of [record] that are neither known nor consumed, in input
 * order. This is the carry-through that keeps `validate` able to see what the
 * model actually wrote. It never inspects the values.
 */
private fun carryUnknown(
    out: MutableMap<String, JsonElement>,
    record: JsonObject,
    known: List<String>,
    consumed: List<String> = emptyList(),
) {
    for ((key, value) in record) {
        if (key in known || key in consumed) continue
        out[key] = value
    }
}

private fun missingSection(): JsonObject = JsonObject(
    linkedMapOf<String, JsonElement>(
        "status" to JsonPrimitive("missing"),
        "summary" to JsonNull,
    )
)

/**
 * Normalize one section value.
 *
 * A bare non-empty string becomes an available section. A string with nothing
 * in it, `null` and an absent key all become a declared gap, because "nothing
 * here" is exactly what `missing` states. An object is kept, with its status
 * inferred when absent and its unknown members carried through. Anything else
 * — a number, an array, a boolean — is carried through untouched, so
 * `validate` reports it at `/sections/<key>` instead of this function quietly
 * recording a gap where the model wrote something.
 */
private fun normalizeSection(value: JsonElement?): JsonElement {
    val text = asTrimmedString(value)
    if (text != null) {
        return JsonObject(
            linkedMapOf<String, JsonElement>(
                "status" to JsonPrimitive("available"),
                "summary" to JsonPrimitive(text),
            )
        )
    }
    if (value == null || value is JsonNull || asStringOrNull(value) != null) {
        return missingSection()
    }
    if (value !is JsonObject) {
        return value
    }

    val summary = asTrimmedString(value["summary"])
    val rawSummary = value["summary"]
    val rawStatus = asTrimmedString(value["status"])
    // A status the model actually wrote is kept exactly as written, even when
    // it is not one of the three. Validate then refuses it at
    // /sections/<key>/status. Rewriting "Available" to "available" would be
    // normalization inventing a claim: the section would count as carrying
    // content and would vanish from the list of what is not captured, and the
    // author would never learn the word was wrong.
    val status: JsonElement = when {
        rawStatus != null -> JsonPrimitive(rawStatus)
        value.containsKey("status") -> value.getValue("status")
        summary != null -> JsonPrimitive("available")
        else -> JsonPrimitive("missing")
    }

    val summaryOut: JsonElement = when {
        summary != null -> JsonPrimitive(summary)
        rawSummary == null || rawSummary is JsonNull -> JsonNull
        asStringOrNull(rawSummary) != null -> JsonNull
        else -> rawSummary
    }

    val normalized = linkedMapOf<String, JsonElement>(
        "status" to status,
        "summary" to summaryOut,
    )
    // Provenance is carried verbatim whenever it is there at all. Filtering
    // out a label this implementation does not know would delete the one thing
    // that lets a cold reader tell a check from a guess, and the label set is
    // closed for the whole of version one: an unrecognised label is an error,
    // not noise.
    if (value.containsKey("provenance")) {
        normalized["provenance"] = value.getValue("provenance")
    }
    carryUnknown(normalized, value, SECTION_FIELDS)
    return JsonObject(normalized)
}

/**
 * Trim a list of prose, or return null when any entry is not usable prose, so
 * the caller leaves the list exactly as written and `validate` reports the
 * entry that is wrong rather than this function deleting it.
 */
private fun normalizeStringList(value: JsonElement?): JsonArray? {
    if (value !is JsonArray) return null
    val entries = value.map { asTrimmedString(it) ?: return null }
    return JsonArray(entries.map { JsonPrimitive(it) })
}

/**
 * Trim the string members this object is known to carry, and leave everything
 * else — unknown members, and known members holding something other than
 * usable text — exactly where it was.
 */
private fun normalizeNamedObject(value: JsonElement?, known: List<String>): JsonElement? {
    if (value !is JsonObject) return value
    val out = linkedMapOf<String, JsonElement>()
    for ((key, entry) in value) {
        val text = if (key in known) asTrimmedString(entry) else null
        out[key] = if (text == null) entry else JsonPrimitive(text)
    }
    return JsonObject(out)
}

/** The same, for the two objects whose members are lists of prose. */
private fun normalizeListObject(value: JsonElement?, known: List<String>): JsonElement? {
    if (value !is JsonObject) return value
    val out = linkedMapOf<String, JsonElement>()
    for ((key, entry) in value) {
        val entries = if (key in known) normalizeStringList(entry) else null
        out[key] = entries ?: entry
    }
    return JsonObject(out)
}

/** All 17 keys declared, in canonical order, then whatever else was written. */
private fun normalizeSections(raw: JsonObject): JsonObject {
    val sections = linkedMapOf<String, JsonElement>()
    for (key in SECTION_KEYS) {
        sections[key] = normalizeSection(raw[key])
    }
    carryUnknown(sections, raw, SECTION_KEYS)
    return JsonObject(sections)
}

/**
 * Normalize a parsed JSON value into a spec-shaped document.
 *
 * The result is not guaranteed valid: run [validateHandover] on it. What is
 * guaranteed is that nothing the input carried was thrown away, and that when
 * the input's `sections` is an object or absent, all 17 section keys are
 * declared. A value whose root is not an object is returned as it arrived,
 * because building a document around it would replace the value rather than
 * report it.
 *
 * Observations pass through unchanged. Nothing here interprets them, reorders
 * them, filters them by `kind`, rewrites `data`, or repairs a malformed entry.
 * An entry whose `kind` this implementation has never heard of is the exact
 * case the extension point exists for, so dropping or rewriting it would make
 * the format lossy in the one place it promises not to be; and unlike the 17
 * sections, observations are produced by tools, so a malformed envelope should
 * be told so by `validate`, not quietly patched here.
 */
fun normalizeHandover(input: JsonElement?): JsonElement {
    if (input == null) return normalizeHandover(JsonObject(emptyMap()))
    if (input !is JsonObject) return input
    val root = input

    val document = linkedMapOf<String, JsonElement>()
    val consumed = mutableListOf<String>()

    // The declared version of this document. An input that states one keeps
    // it, whatever it says: normalization never upgrades a document and never
    // downgrades one. An input that states none is declared 1.0, which is a
    // claim about the shape this function just produced, not a claim about
    // where the content came from.
    document["soilHandover"] = if (root.containsKey("soilHandover")) {
        asTrimmedString(root["soilHandover"])?.let { JsonPrimitive(it) }
            ?: root.getValue("soilHandover")
    } else {
        JsonPrimitive(SPEC_VERSION)
    }

    // An id that is already there is kept, whatever shape it is in: a copy
    // keeps its identity, and an id that is present but malformed is a
    // validation error rather than something to drop. Dropping it would hand
    // the writer a document with no id, and the writer would mint a fresh one
    // over the top of the malformed one nobody was ever told about. A missing
    // id stays missing, because assigning it is the writer's job and
    // normalization is not a writer.
    if (root.containsKey("handoverId")) {
        document["handoverId"] = asTrimmedString(root["handoverId"])?.let { JsonPrimitive(it) }
            ?: root.getValue("handoverId")
    }

    for (key in listOf("projectId", "title")) {
        document[key] = if (root.containsKey(key)) {
            asTrimmedString(root[key])?.let { JsonPrimitive(it) } ?: root.getValue(key)
        } else {
            JsonPrimitive("")
        }
    }

    // No wall clock. A document that does not carry a capture time is refused
    // by `validate`, not completed here.
    if (root.containsKey("createdAt")) {
        document["createdAt"] = asTrimmedString(root["createdAt"])?.let { JsonPrimitive(it) }
            ?: root.getValue("createdAt")
    }

    // No recipe version is stamped: this function did not write the content,
    // so it is in no position to say which recipe did. `source` appears in the
    // output only when the input carried one.
    if (root.containsKey("source")) {
        document["source"] = normalizeNamedObject(root["source"], SOURCE_FIELDS)
            ?: root.getValue("source")
    }

    val rawSections = root["sections"]
    val loose = root["extractionSections"]
    when {
        rawSections is JsonObject -> document["sections"] = normalizeSections(rawSections)
        root.containsKey("sections") -> document["sections"] = root.getValue("sections")
        loose is JsonObject -> {
            // The loose key the rescue prompt asks for. It is consumed only
            // when it is actually the source of `sections`; a document
            // carrying both is carrying content under a key nothing read,
            // which is `validate`'s to report.
            document["sections"] = normalizeSections(loose)
            consumed.add("extractionSections")
        }
        else -> document["sections"] = normalizeSections(JsonObject(emptyMap()))
    }

    if (root.containsKey("quality")) {
        document["quality"] = normalizeListObject(root["quality"], QUALITY_FIELDS)
            ?: root.getValue("quality")
    }
    if (root.containsKey("safety")) {
        document["safety"] = normalizeListObject(root["safety"], SAFETY_FIELDS)
            ?: root.getValue("safety")
    }
    if (root.containsKey("observations")) {
        document["observations"] = root.getValue("observations")
    }
    if (root.containsKey("code")) {
        document["code"] = asTrimmedString(root["code"])?.let { JsonPrimitive(it) }
            ?: root.getValue("code")
    }

    carryUnknown(document, root, ROOT_FIELDS, consumed)
    return JsonObject(document)
}

private val FENCED =
    Regex("```(?:json)?\\s*\\n([\\s\\S]*?)```", RegexOption.IGNORE_CASE)

/**
 * Pull the first fenced JSON block out of a model's reply, or fall back to the
 * first `{...}` span. Returns the raw text, not a parsed value.
 *
 * Models wrap JSON in prose no matter how firmly the prompt says not to, and a
 * user pasting a reply should not have to clean it up by hand.
 */
fun extractJsonBlock(text: String): String? {
    val fenced = FENCED.find(text)
    if (fenced != null) {
        return fenced.groupValues[1].trim()
    }
    val start = text.indexOf('{')
    val end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
        return text.substring(start, end + 1).trim()
    }
    return null
}
