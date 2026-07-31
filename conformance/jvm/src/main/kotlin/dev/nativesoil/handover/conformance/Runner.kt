/**
 * The conformance suite, run against the JVM SDK.
 *
 * This is what "Soil Compatible" means, executed. It runs the golden fixtures
 * against `packages/sdk-jvm` and checks the behaviours that make handovers
 * portable rather than merely well-formed:
 *
 *   1. fixtures      the valid ones validate, the invalid ones fail where the
 *                    manifest says they fail, compared as an abstract semantic
 *                    location rather than as pointer text
 *   1b. boundary     the pre-schema ingestion boundary: encoding, duplicate
 *                    member names, nesting depth and the numeric domain,
 *                    judged on the BYTES
 *   1c. text-unit    every length bound in the format counted in Unicode code
 *                    points, on strings where the candidate units disagree
 *   2. identity      the handoverId rules: writer-assigned UUIDv7, copies keep
 *                    it, new captures get a new one, codes are not identity
 *   3. observations  the extension point stays forward compatible: unknown kinds
 *                    survive a round trip and change nothing about the sections
 *   4. safety        a handover carrying credentials or private absolute paths
 *                    is refused, and the refusal never echoes the value
 *   5. normalization the loose shapes a model actually emits become documents
 *   6. store         save, list and read round trip through plain files
 *   7. restore       a loaded handover carries its gaps and its framing, and
 *                    every field a writer supplied reaches the reader
 *   8. determinism   the renderer returns identical bytes for identical input
 *   9. recipe        the packaged recipe texts match `recipes/` byte for byte,
 *                    and the recipe version travels
 *
 * The schema-agreement category runs in the TypeScript runner (`run.ts`),
 * which pins the published JSON Schema to these same fixtures; every SDK is
 * pinned to the fixtures here and there, so the schema and the validators
 * cannot drift apart. Byte parity of the user-facing surfaces against the
 * TypeScript SDK is asserted by `packages/sdk-jvm`'s own test suite.
 *
 * Run it from packages/sdk-jvm with `./gradlew :conformance:run --quiet`. It
 * exits non-zero on failure, and it prints what failed rather than a count.
 */

package dev.nativesoil.handover.conformance

import dev.nativesoil.handover.HandoverStore
import dev.nativesoil.handover.IngestLimits
import dev.nativesoil.handover.Limits
import dev.nativesoil.handover.RECIPE_TEXT
import dev.nativesoil.handover.RECIPE_VERSION
import dev.nativesoil.handover.RESCUE_PROMPT
import dev.nativesoil.handover.SECTION_KEYS
import dev.nativesoil.handover.SECTION_LABELS
import dev.nativesoil.handover.buildRestorePrompt
import dev.nativesoil.handover.extractJsonBlock
import dev.nativesoil.handover.findSecretMaterial
import dev.nativesoil.handover.ingestDocument
import dev.nativesoil.handover.normalizeHandover
import dev.nativesoil.handover.renderSaved
import dev.nativesoil.handover.textLength
import dev.nativesoil.handover.ValidationIssueKind
import dev.nativesoil.handover.validateHandover
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import kotlin.io.path.readBytes
import kotlin.io.path.readText
import kotlin.system.exitProcess
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private val ROOT: Path =
    Path.of(System.getProperty("soil.repo.root") ?: "../..").toAbsolutePath().normalize()
private val FIXTURES: Path = ROOT.resolve("conformance/fixtures")

private val NOW: Instant = Instant.parse("2026-07-22T10:00:00Z")

/** A capture time, stated by the document. Nothing here reads a clock. */
private const val A_CAPTURE_TIME: String = "2026-07-22T10:00:00Z"

/**
 * Normalize and assert the object shape, which is what every call in this
 * runner feeds it. normalizeHandover itself returns a JsonElement, because a
 * root that is not an object is carried through as it arrived rather than
 * replaced with a document built around it.
 */
private fun normalized(input: JsonElement?): JsonObject =
    normalizeHandover(input) as JsonObject

// A syntactically valid UUID used where a check needs a document that is
// complete but is not exercising the writer's assignment path.
private const val A_VALID_ID = "019f7e89-fc00-7000-8000-000000000000"

// The exact shape the official writers emit: UUIDv7, RFC 9562 variant.
private val UUID_V7_PATTERN =
    Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

// The two conformance classes, reported separately and never as one green
// blob. "Soil Document Conformant" is a claim about DOCUMENTS: the schema,
// the section semantics, round trips, identity. "Soil Secure Writer
// Conformant" is a claim about BEHAVIOUR: the safety fixtures that must be
// refused, with the right category, storing nothing.
private const val DOCUMENT = "document"
private const val SECURE_WRITER = "secure-writer"

private fun classOf(category: String): String =
    if (category == "safety") SECURE_WRITER else DOCUMENT

private class Suite {
    var checks = 0
    val checksByClass = mutableMapOf(DOCUMENT to 0, SECURE_WRITER to 0)
    val failures = mutableListOf<Triple<String, String, String>>()

    fun check(
        category: String,
        condition: Boolean,
        detail: String,
        conformanceClass: String = classOf(category),
    ) {
        checks += 1
        checksByClass[conformanceClass] = checksByClass.getValue(conformanceClass) + 1
        if (!condition) {
            failures.add(Triple(conformanceClass, category, detail))
        }
    }
}

private fun readJson(path: Path): JsonElement = Json.parseToJsonElement(path.readText())

private fun fixturePath(file: String): Path = FIXTURES.resolve(file).normalize()

private fun str(element: JsonElement?): String? =
    (element as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun obj(element: JsonElement?): JsonObject? = element as? JsonObject

/**
 * An abstract semantic location: an ordered sequence of object member names
 * and array indices, from the root of the document to the offending value. The
 * empty sequence means the document itself.
 *
 * This is what the harness compares, and it is deliberately not a string. The
 * manifest used to bind exact JSON Pointer text, which made a formatting
 * choice into a conformance requirement the specification never states: an
 * implementation that reports the same place in a different notation was
 * failed by the official suite for being spelled differently. A pointer is
 * still a fine representation; each runner parses its own representation into
 * segments before comparing, and [locationOf] is this runner's adapter.
 *
 * Segments are compared as text, which is all the comparison needs: an index
 * and a member name only ever appear where the document's own shape puts them.
 */
private fun locationOf(pointer: String): List<String> {
    if (pointer.isEmpty() || pointer == "/") return emptyList()
    return pointer.removePrefix("/").split("/").map {
        it.replace("~1", "/").replace("~0", "~")
    }
}

/** One manifest `location` array, read as segments. */
private fun manifestLocation(element: JsonElement?): List<String> {
    val array = element as? JsonArray ?: return emptyList()
    return array.map { (it as JsonPrimitive).content }
}

/** A semantic location, for a failure message. Never compared. */
private fun showLocation(location: List<String>): String =
    if (location.isEmpty()) "the document" else location.joinToString(" > ")

/**
 * The fixed boundary token every restore-prompt check injects. Production
 * takes 128 bits from the platform's cryptographic source instead, which is
 * what makes the boundary unforgeable; a fixed token here is what makes a
 * check on the rendered bytes possible at all.
 */
private val RESTORE_TOKEN: String =
    str(obj(readJson(FIXTURES.resolve("manifest.json")))!!["restoreBoundaryToken"])!!

private val RESTORE_MARK = "soil:$RESTORE_TOKEN"

private val STRUCTURE_SHAPED = Regex("^\\s*(?:===|##)")

private fun withKey(base: JsonObject, key: String, value: JsonElement): JsonObject =
    JsonObject(LinkedHashMap<String, JsonElement>(base).also { it[key] = value })

private fun withoutKey(base: JsonObject, key: String): JsonObject =
    JsonObject(LinkedHashMap<String, JsonElement>(base).also { it.remove(key) })

/**
 * Materialise one boundary fixture: bytes on disk, or a padded document,
 * because the size fixtures are a megabyte each and do not belong in a
 * repository.
 */
private fun boundaryBytes(entry: JsonObject): ByteArray {
    val file = str(entry["file"])
    if (file != null) return fixturePath(file).readBytes()
    val total = (entry.getValue("generateBytes") as JsonPrimitive).content.toInt()
    return ("{\"pad\":\"" + "x".repeat(total - 10) + "\"}").toByteArray(Charsets.UTF_8)
}

/**
 * The pre-schema ingestion boundary: encoding, duplicate member names and
 * nesting depth, all judged on the bytes before a value exists.
 *
 * The category is its own because none of it can be seen from a constructed
 * value, which is exactly why the three defects survived this long. The
 * published JSON Schema and the reference validator are both handed an
 * already-parsed value, so both are structurally blind here; that is a fact
 * about layers, not a gap in the schema.
 */
private fun checkIngestionBoundary(suite: Suite) {
    val manifest = obj(readJson(FIXTURES.resolve("manifest.json")))!!
    for (entryElement in manifest.getValue("boundary") as JsonArray) {
        val entry = obj(entryElement)!!
        val name = str(entry["name"])!!
        val expected = str(entry["ingest"])!!
        val result = ingestDocument(boundaryBytes(entry))

        if (expected == "accepted") {
            suite.check(
                "boundary",
                result.ok,
                "$name: must be accepted, was refused with ${result.issue?.code}",
            )
            val value = result.value ?: continue

            // An accepted document is never merely accepted. The validator runs
            // on it and must return a result, because the one outcome worse
            // than a rejection is a document that is accepted and never
            // scanned.
            val validation = validateHandover(value)
            when (str(entry["afterIngest"])) {
                "valid" -> {
                    val problems =
                        validation.issues.joinToString("; ") { "${it.path} ${it.message}" }
                    suite.check(
                        "boundary",
                        validation.valid,
                        "$name: accepted at the boundary, then rejected by the validator: " +
                            problems,
                    )
                }
                "refused-by-safety" ->
                    suite.check(
                        "boundary",
                        validation.issues.any { it.kind.label == "safety" },
                        "$name: accepted at the boundary, so the fail-closed secret scan " +
                            "must reach it and refuse it",
                        SECURE_WRITER,
                    )
                else ->
                    suite.check(
                        "boundary",
                        !validation.valid,
                        "$name: is not a handover, so the validator must say so rather than " +
                            "accept it",
                    )
            }
            continue
        }

        suite.check(
            "boundary",
            result.issue?.code == expected,
            "$name: must be refused with $expected, got ${result.issue?.code ?: "acceptance"}",
        )
        val issue = result.issue
        val wanted = entry["location"]?.let { manifestLocation(it) }
        if (issue != null && wanted != null) {
            suite.check(
                "boundary",
                locationOf(issue.path) == wanted,
                "$name: must report the issue at \"${showLocation(wanted)}\", " +
                    "reported \"${showLocation(locationOf(issue.path))}\"",
            )
        }
    }

    suite.check(
        "boundary",
        IngestLimits.MAX_DEPTH == 32 && IngestLimits.MAX_BYTES == 1048576,
        "the boundary limits must be 32 levels and 1048576 bytes, found " +
            "${IngestLimits.MAX_DEPTH} and ${IngestLimits.MAX_BYTES}",
    )
    suite.check(
        "boundary",
        IngestLimits.MAX_INTEGER == 9007199254740991L &&
            IngestLimits.MIN_INTEGER == -9007199254740991L,
        "the integer domain must run from -9007199254740991 to 9007199254740991, found " +
            "${IngestLimits.MIN_INTEGER} to ${IngestLimits.MAX_INTEGER}",
    )
}

/** One code point, two UTF-16 code units, four UTF-8 bytes. */
private const val ASTRAL = "\uD83D\uDE00"

/** Two code points, two UTF-16 code units, three UTF-8 bytes, one cluster. */
private const val COMBINED = "e\u0301"

/** A complete, valid handover with nothing near a limit. */
private fun textUnitBase(): JsonObject = withKey(
    normalized(
        JsonObject(
            linkedMapOf<String, JsonElement>(
                "projectId" to JsonPrimitive("text-unit"),
                "title" to JsonPrimitive("The text unit"),
                "createdAt" to JsonPrimitive(A_CAPTURE_TIME),
                "sections" to JsonObject(
                    linkedMapOf<String, JsonElement>(
                        "executiveSummary" to JsonPrimitive("The text unit, exercised."),
                    )
                ),
            )
        )
    ),
    "handoverId",
    JsonPrimitive(A_VALID_ID),
)

private fun textUnitSummary(text: String): JsonObject {
    val base = textUnitBase()
    val sections = LinkedHashMap<String, JsonElement>(base["sections"] as JsonObject)
    sections["architecture"] = JsonObject(
        linkedMapOf<String, JsonElement>(
            "status" to JsonPrimitive("available"),
            "summary" to JsonPrimitive(text),
        )
    )
    return withKey(base, "sections", JsonObject(sections))
}

private fun textUnitList(entry: String): JsonObject = withKey(
    textUnitBase(),
    "quality",
    JsonObject(
        linkedMapOf<String, JsonElement>(
            "missingInputs" to JsonArray(listOf(JsonPrimitive(entry)))
        )
    ),
)

private fun textUnitObservation(kind: String): JsonObject = withKey(
    textUnitBase(),
    "observations",
    JsonArray(
        listOf(
            JsonObject(
                linkedMapOf<String, JsonElement>(
                    "kind" to JsonPrimitive(kind),
                    "data" to JsonObject(linkedMapOf()),
                )
            )
        )
    ),
)

/**
 * The text unit, exercised at every individually bounded string in the format.
 *
 * The fixtures pin three of these sites and this pins all five, including the
 * 20000-code-point section summary, which is deliberately not a fixture: at
 * four bytes per astral character it would be an eighty-kilobyte file in a
 * repository whose largest real document is eighteen kilobytes, and a string
 * built here costs nothing and proves the same thing.
 *
 * Everything here is deliberately NOT ASCII. On ASCII the three candidate
 * units, code points and UTF-16 code units and UTF-8 bytes, all give the same
 * answer, so an ASCII test cannot tell a conformant implementation from one
 * counting the wrong thing.
 */
private fun checkTextUnit(suite: Suite) {
    val cases = listOf(
        Triple(
            "title at ${Limits.TITLE} code points" to "/title",
            withKey(textUnitBase(), "title", JsonPrimitive(ASTRAL.repeat(Limits.TITLE))),
            withKey(textUnitBase(), "title", JsonPrimitive(ASTRAL.repeat(Limits.TITLE + 1))),
        ),
        Triple(
            "title at ${Limits.TITLE} code points of combining sequences" to "/title",
            withKey(
                textUnitBase(),
                "title",
                JsonPrimitive(COMBINED.repeat(Limits.TITLE / 2)),
            ),
            withKey(
                textUnitBase(),
                "title",
                JsonPrimitive(COMBINED.repeat(Limits.TITLE / 2) + "x"),
            ),
        ),
        Triple(
            "section summary at ${Limits.SECTION_SUMMARY} code points" to
                "/sections/architecture/summary",
            textUnitSummary(ASTRAL.repeat(Limits.SECTION_SUMMARY)),
            textUnitSummary(ASTRAL.repeat(Limits.SECTION_SUMMARY + 1)),
        ),
        Triple(
            "a stated gap at ${Limits.LIST_ENTRY} code points" to
                "/quality/missingInputs/0",
            textUnitList(COMBINED.repeat(Limits.LIST_ENTRY / 2)),
            textUnitList(COMBINED.repeat(Limits.LIST_ENTRY / 2) + "x"),
        ),
        Triple(
            "an observation kind at ${Limits.OBSERVATION_KIND} code points" to
                "/observations/0/kind",
            textUnitObservation(ASTRAL.repeat(Limits.OBSERVATION_KIND)),
            textUnitObservation(ASTRAL.repeat(Limits.OBSERVATION_KIND + 1)),
        ),
        Triple(
            // projectId is pattern-restricted to ASCII, so all three candidate
            // units agree on it. It is here for the bound, not for the unit.
            "projectId at ${Limits.PROJECT_ID} code points" to "/projectId",
            withKey(
                textUnitBase(),
                "projectId",
                JsonPrimitive("p".repeat(Limits.PROJECT_ID)),
            ),
            withKey(
                textUnitBase(),
                "projectId",
                JsonPrimitive("p".repeat(Limits.PROJECT_ID + 1)),
            ),
        ),
    )

    for ((label, at, over) in cases) {
        val (what, path) = label
        val result = validateHandover(at)
        val problems = result.issues.joinToString("; ") { "${it.path} ${it.message}" }
        suite.check("text-unit", result.valid, "$what must be accepted, refused: $problems")

        val refused = validateHandover(over)
        suite.check(
            "text-unit",
            !refused.valid && refused.issues.any { it.path == path },
            "one code point over $what must be refused at $path",
        )
    }

    // The unit itself, on the three cases that separate the candidates.
    suite.check(
        "text-unit",
        textLength(ASTRAL) == 1 && ASTRAL.length == 2,
        "a character outside the basic plane is one code point and two UTF-16 code units",
    )
    suite.check(
        "text-unit",
        textLength(COMBINED) == 2,
        "one perceived character written as a base plus a combining mark is two code " +
            "points, not one",
    )
    suite.check(
        "text-unit",
        textLength("caf\u00e9") == 4 && "caf\u00e9".toByteArray(Charsets.UTF_8).size == 5,
        "a precomposed accented character is one code point and two UTF-8 bytes",
    )
}

private fun checkFixtures(suite: Suite) {
    val manifest = obj(readJson(FIXTURES.resolve("manifest.json")))!!

    for (entryElement in manifest.getValue("valid") as JsonArray) {
        val entry = obj(entryElement)!!
        val file = str(entry["file"])!!
        val result = validateHandover(readJson(fixturePath(file)))
        val problems = result.issues.joinToString("; ") { "${it.path} ${it.message}" }
        suite.check(
            "fixtures",
            result.valid,
            "$file should be valid but the validator reported: $problems",
        )
    }

    for (entryElement in manifest.getValue("invalid") as JsonArray) {
        val entry = obj(entryElement)!!
        val file = str(entry["file"])!!
        val expectedLocation = manifestLocation(entry["location"])
        val reason = str(entry["reason"])!!
        val result = validateHandover(readJson(fixturePath(file)))
        // Refusing a safety fixture is writer behaviour, so those two checks
        // count toward the Secure Writer class; structural rejections are
        // document checks.
        val entryClass =
            if (str(entry["kind"]) == "safety") SECURE_WRITER else DOCUMENT
        suite.check(
            "fixtures",
            !result.valid,
            "$file should be rejected ($reason) but validated",
            entryClass,
        )
        val reported =
            result.issues
                .joinToString(", ") { showLocation(locationOf(it.path)) }
                .ifEmpty { "nothing" }
        suite.check(
            "fixtures",
            result.issues.any { locationOf(it.path) == expectedLocation },
            "$file should report a problem at ${showLocation(expectedLocation)}, " +
                "reported: $reported",
            entryClass,
        )
        if (str(entry["kind"]) == "safety") {
            suite.check(
                "safety",
                result.issues.any { it.kind.label == "safety" },
                "$file should be refused by the secret scan, not merely by shape",
            )
        }
    }
}

/**
 * Every provenance label the document's sections carry, without duplicates and
 * in the document's own order of first appearance.
 */
private fun documentProvenance(handover: JsonObject): List<String> {
    val sections = obj(handover["sections"])
    val out = mutableListOf<String>()
    for (key in SECTION_KEYS) {
        val labels = obj(sections?.get(key))?.get("provenance") as? JsonArray ?: continue
        for (entry in labels) {
            val label = str(entry) ?: continue
            if (!out.contains(label)) out.add(label)
        }
    }
    return out
}

private fun checkIdentity(suite: Suite) {
    // Identity: the handoverId rules, exercised one by one. The letters match
    // the fixture list in the specification work: (a) a new handover gets a
    // new UUIDv7, (b) a byte-for-byte copy keeps its id, (c) a new capture of
    // the same project gets a new one, (d) local codes may collide across
    // stores without identity collision, (e) the id survives the store's own
    // update path, (f) an invalid or missing id is handled deterministically,
    // and (g) is these same checks run by the other runners over the same
    // fixtures.
    val homeA = Files.createTempDirectory("soil-identity-a-")
    val homeB = Files.createTempDirectory("soil-identity-b-")
    try {
        val storeA = HandoverStore(homeA.toString())
        val storeB = HandoverStore(homeB.toString())
        fun fresh(): JsonObject = normalized(
            Json.parseToJsonElement(
                """{"projectId":"identity","title":"Identity","createdAt":"2026-07-22T10:00:00Z","sections":{"executiveSummary":"The identity rules, exercised."}}"""
            ))

        // (a) a new handover gets a new UUIDv7, assigned by the writer.
        val first = storeA.save(fresh())
        val firstDoc = storeA.read(first.code)
        val firstId = str(firstDoc["handoverId"])
        suite.check(
            "identity",
            firstId != null && UUID_V7_PATTERN.matches(firstId),
            "(a) a handover stored without an id must be assigned a UUIDv7 by the writer",
        )

        // (c) a new capture, even of the same project, gets a new handoverId.
        val second = storeA.save(fresh())
        val secondDoc = storeA.read(second.code)
        suite.check(
            "identity",
            str(secondDoc["handoverId"]) != null &&
                str(secondDoc["handoverId"]) != firstId,
            "(c) a new capture of the same project must get a new handoverId",
        )

        // (d) local codes may collide across two stores; identity does not.
        val other = storeB.save(fresh())
        val otherDoc = storeB.read(other.code)
        suite.check(
            "identity",
            other.code == first.code && str(otherDoc["handoverId"]) != firstId,
            "(d) two stores may both hold a #001, and the two documents must still have different handoverIds",
        )

        // (b) a byte-for-byte copy keeps its handoverId, in any store.
        val copy = obj(Json.parseToJsonElement(firstDoc.toString()))!!
        val copyEntry = storeB.save(copy)
        val copyDoc = storeB.read(copyEntry.code)
        suite.check(
            "identity",
            str(copyDoc["handoverId"]) == firstId,
            "(b) a byte-for-byte copy must keep its handoverId when stored again",
        )

        // (e) the store's own update path never changes an id. There is no
        // migration tooling yet, so the rule is pinned on reindex: the files
        // are rewritten around, and identity must come out untouched.
        storeA.reindex()
        suite.check(
            "identity",
            str(storeA.read(first.code)["handoverId"]) == firstId,
            "(e) rebuilding the store's index must leave every handoverId unchanged",
        )

        // (f) an invalid or missing id is handled deterministically on
        // validate: a structure issue at /handoverId, never a replacement.
        val missing = validateHandover(withoutKey(firstDoc, "handoverId"))
        suite.check(
            "identity",
            !missing.valid &&
                missing.issues.any {
                    it.path == "/handoverId" && it.kind.label == "structure"
                },
            "(f) a document claiming validity without an id must fail with a structure issue at /handoverId",
        )
        val malformed =
            validateHandover(withKey(firstDoc, "handoverId", JsonPrimitive("handover-42")))
        suite.check(
            "identity",
            !malformed.valid && malformed.issues.any { it.path == "/handoverId" },
            "(f) a malformed id must fail at /handoverId rather than be replaced",
        )
    } finally {
        homeA.toFile().deleteRecursively()
        homeB.toFile().deleteRecursively()
    }
}

private fun checkObservations(suite: Suite) {
    // The extension point: unknown kinds survive a full round trip, and the
    // sections are read the same with them as without them.
    val home = Files.createTempDirectory("soil-observations-")
    try {
        val store = HandoverStore(home.toString())
        val doc = obj(readJson(fixturePath("valid/observations-unknown-kinds.json")))!!

        val entry = store.save(doc)
        val read = store.read(entry.code)
        suite.check(
            "observations",
            (read["observations"] as? JsonArray)?.size == 3,
            "an unrecognised observation must survive a save and a read, not be dropped",
        )
        suite.check(
            "observations",
            read["observations"] == doc["observations"],
            "an unrecognised observation must round trip unchanged",
        )

        val normalized = normalized(doc)
        suite.check(
            "observations",
            normalized["observations"] == doc["observations"],
            "normalization must not interpret, filter or reorder observations",
        )

        val without = withoutKey(read, "observations")
        suite.check(
            "observations",
            buildRestorePrompt(read, RESTORE_TOKEN) ==
                buildRestorePrompt(without, RESTORE_TOKEN),
            "observations must not change how the 17 sections are read",
        )

        val unknownOnly = validateHandover(
            withKey(
                doc,
                "observations",
                Json.parseToJsonElement("""[{"kind":"kind.from.the.future","data":{"x":1}}]"""),
            )
        )
        suite.check(
            "observations",
            unknownOnly.valid,
            "a kind this implementation has never heard of must be accepted, not treated as an error",
        )
    } finally {
        home.toFile().deleteRecursively()
    }
}

private fun scanDoc(text: String): JsonObject = normalized(
    JsonObject(
        linkedMapOf<String, JsonElement>(
            "handoverId" to JsonPrimitive(A_VALID_ID),
            "projectId" to JsonPrimitive("scan"),
            "title" to JsonPrimitive("Scan"),
            "createdAt" to JsonPrimitive(A_CAPTURE_TIME),
            "sections" to JsonObject(
                linkedMapOf<String, JsonElement>("architecture" to JsonPrimitive(text))
            ),
        )
    ),
)

private fun checkSecretScan(suite: Suite) {
    val clean = readJson(ROOT.resolve("examples/orchard-checkout.json"))
    suite.check(
        "safety",
        findSecretMaterial(clean).isEmpty(),
        "the worked example must be free of secret material",
    )

    // One unsafe positive per mandatory class, plus the vendor formats and
    // the precedence case. spec/safety-patterns.md is the normative
    // statement; this table is the minimum an implementation must refuse.
    val cases = listOf(
        "the key is sk-abc123def456" to "provider_api_key",
        "clone https://ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/o/r.git" to
            "provider_api_key",
        "the runner env holds AKIAIOSFODNN7EXAMPLE" to "provider_api_key",
        "the bot posts with xoxb-2314789012-4567890123456-AbCdEfGhIjKlMnOpQrStUvWx" to
            "provider_api_key",
        "maps is keyed with AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY" to "provider_api_key",
        "Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e" to "bearer_token",
        "Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1lMTIzNDU2" to "authorization_header",
        "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln" to "jwt",
        "-----BEGIN PRIVATE KEY-----" to "private_key_pem",
        """the app reads client_secret="9f8a7b6c5d4e3f2a1b0c"""" to "client_secret",
        """the runner loads {"type": "service_account", "project_id": "x"}""" to
            "google_application_credentials",
        "GOOGLE_APPLICATION_CREDENTIALS=/opt/keys/orchard-sa.json" to
            "google_application_credentials",
        "it lives at /Users/example/code/app" to "private_path",
        "it lives at /home/deploy/app" to "private_path",
        "it lives at C:\\Users\\example\\app" to "private_path",
        "postgres://orchard:9f8a7b6c5d4e3f@db.internal:5432/orchard" to "url_credentials",
        "The token was redacted: ghp_16C7e42F292c6912E7710c838347Ae178B4a is gone." to
            "provider_api_key",
    )

    for ((text, label) in cases) {
        val doc = scanDoc(text)
        val findings = findSecretMaterial(doc)
        suite.check(
            "safety",
            findings.any { it.label == label },
            "a section carrying $label must be detected",
        )
        val result = validateHandover(doc)
        suite.check(
            "safety",
            !result.valid,
            "a handover carrying $label must be rejected, not merely flagged",
        )
        for (issue in result.issues) {
            suite.check(
                "safety",
                !issue.message.contains(text),
                "a $label finding must not echo the matched value back",
            )
        }
    }

    // The safe near-neighbour of every class. Refusing any of these would
    // make the format contradict its own section requirements: architecture
    // asks for flag and command names quoted exactly, and safetySummary asks
    // for what was withheld and where it is configured.
    val safeCases = listOf(
        "A provider API key exists and is set in the deployment platform. Its value is not carried here.",
        "The service uses an Authorization header.",
        "GOOGLE_APPLICATION_CREDENTIALS is set outside the handover.",
        "The client_secret value was intentionally omitted.",
        "The endpoint expects bearer credentials; the token is not carried here.",
        "Login returns a JWT; the value is not carried here.",
        "The signing key is a PEM private key held in the platform's secret manager.",
        "Run `soil save --project orchard`; SOIL_HOME selects the store and PORT defaults to 3000.",
        "Send it as `Authorization: Bearer <token>`, or as `Authorization: Bearer ${'$'}TOKEN`.",
        "The config template ships client_secret=YOUR_CLIENT_SECRET.",
        "Initialised /home/ada/.soil-server, and the container mounts /home/agent/.soil.",
        "The URL is documented as postgres://app:password@db.internal:5432/app.",
        "See src/checkout/window.ts and https://example.com/docs",
    )
    for (text in safeCases) {
        val result = validateHandover(scanDoc(text))
        val refused = result.issues.joinToString(", ") { "${'$'}{it.path} ${'$'}{it.kind}" }
        suite.check(
            "safety",
            result.valid,
            "naming a credential type, header, environment variable, flag or documented placeholder must stay valid, refused: ${'$'}refused",
        )
    }
}

private fun checkNormalization(suite: Suite) {
    val modelReply = listOf(
        "Sure, here is the save:",
        "",
        "```json",
        """{"projectId":"loose-shape","title":"A reply in the rescue shape","createdAt":"2026-07-22T10:00:00Z","extractionSections":{"projectIdentity":"A project that exists only to test the loose shape.","decisions":{"status":"available","summary":"One decision was made."},"blockers":{"status":"missing","summary":null}}}""",
        "```",
        "",
        "Let me know if you want anything changed.",
    ).joinToString("\n")

    val block = extractJsonBlock(modelReply)
    suite.check(
        "normalization",
        block != null,
        "a fenced JSON block inside prose should be extracted",
    )

    val doc = normalized(Json.parseToJsonElement(block ?: "{}"))

    // Normalization is not a writer, so the id is still absent here. The only
    // thing standing between this reply and validity must be the id the
    // writer assigns at store time.
    val beforeId = validateHandover(doc)
    val beforeProblems =
        beforeId.issues.joinToString("; ") { "${it.path} ${it.message}" }
    suite.check(
        "normalization",
        !beforeId.valid &&
            beforeId.issues.size == 1 &&
            beforeId.issues[0].path == "/handoverId",
        "a normalized reply should be one writer-assigned id away from valid, got: $beforeProblems",
    )

    val result = validateHandover(withKey(doc, "handoverId", JsonPrimitive(A_VALID_ID)))
    val problems = result.issues.joinToString("; ") { "${it.path} ${it.message}" }
    suite.check(
        "normalization",
        result.valid,
        "a normalized rescue-shaped reply should be valid once identified, got: $problems",
    )
    suite.check(
        "normalization",
        obj(doc["sections"])!!.size == 17,
        "normalization should declare all 17 sections",
    )
    suite.check(
        "normalization",
        str(obj(obj(doc["sections"])!!["projectIdentity"])!!["status"]) == "available",
        "a bare string section should become an available section",
    )
    suite.check(
        "normalization",
        str(obj(obj(doc["sections"])!!["workflow"])!!["status"]) == "missing",
        "a section the model never wrote should be recorded as missing, not invented",
    )
    suite.check(
        "normalization",
        RESCUE_PROMPT.contains("extractionSections"),
        "the rescue prompt should ask for the shape normalization accepts",
    )

    // An unrecognised status, wrong capitalisation included, must reach
    // validate and be refused there. Silently rewriting it to "available"
    // would turn a typo into content that counts as captured.
    for (wrong in listOf(
        "Available",
        "AVAILABLE",
        "partial",
        "notApplicable",
        "not applicable",
        "NOT_APPLICABLE",
    )) {
        val written = normalized(
            JsonObject(
                linkedMapOf<String, JsonElement>(
                    "handoverId" to JsonPrimitive(A_VALID_ID),
                    "projectId" to JsonPrimitive("status"),
                    "title" to JsonPrimitive("Status"),
                    "createdAt" to JsonPrimitive(A_CAPTURE_TIME),
                    "sections" to JsonObject(
                        linkedMapOf<String, JsonElement>(
                            "decisions" to JsonObject(
                                linkedMapOf<String, JsonElement>(
                                    "status" to JsonPrimitive(wrong),
                                    "summary" to JsonPrimitive("One decision."),
                                )
                            )
                        )
                    ),
                )
            ),
        )
        suite.check(
            "normalization",
            str(obj(obj(written["sections"])!!["decisions"])!!["status"]) == wrong,
            "normalization must keep the unrecognised status ${'$'}wrong rather than rewrite it",
        )
        val statusResult = validateHandover(written)
        suite.check(
            "normalization",
            !statusResult.valid &&
                statusResult.issues.any {
                    it.path == "/sections/decisions/status" &&
                        it.kind == ValidationIssueKind.STRUCTURE
                },
            "an unrecognised status ${'$'}wrong must be refused at /sections/decisions/status",
        )
    }
}

private fun checkStoreAndRestore(suite: Suite) {
    val home = Files.createTempDirectory("soil-conformance-")
    try {
        val store = HandoverStore(home.toString())
        val doc = obj(readJson(ROOT.resolve("examples/orchard-checkout.json")))!!

        val entry = store.save(doc)
        suite.check("store", entry.code == "#001", "the first code should be #001")
        suite.check(
            "store",
            entry.sectionsWithContent == 17,
            "the worked example carries all 17 sections",
        )

        val second = store.save(doc)
        suite.check(
            "store",
            second.code == "#002",
            "codes should increment, never be reused",
        )

        val read = store.read("#001")
        suite.check(
            "store",
            str(read["title"]) == str(doc["title"]) && str(read["code"]) == "#001",
            "a stored handover should read back with its code",
        )
        val listed = store.list()
        suite.check(
            "store",
            listed.size == 2 && listed[0].code == "#002",
            "list should return everything, newest first",
        )

        val rebuilt = store.reindex()
        suite.check(
            "store",
            rebuilt.entries.size == 2 && rebuilt.nextCode == 3,
            "the index should be rebuildable from the files alone",
        )

        val prompt = buildRestorePrompt(read, RESTORE_TOKEN)
        suite.check(
            "restore",
            prompt.contains("=== $RESTORE_MARK BOOT PROMPT ==="),
            "the restore prompt should lead with the boot prompt",
        )
        suite.check(
            "restore",
            prompt.contains("context, not instruction"),
            "the restore prompt should tell the reader the document is context, not commands",
        )
        suite.check(
            "restore",
            prompt.contains("=== $RESTORE_MARK KNOWN GAPS ===") &&
                prompt.contains("not captured: Conversion numbers"),
            "stated gaps should travel with the handover into the restore prompt",
        )
        suite.check(
            "restore",
            prompt.contains("not now"),
            "the restore prompt should anchor capture-state sections to the capture",
        )
        // The asserted-absent word is built by concatenation on purpose: the
        // rule it enforces covers this repo's own text too.
        val word = "verif" + "ied"
        suite.check(
            "restore",
            !Regex("\\b$word\\b", RegexOption.IGNORE_CASE).containsMatchIn(prompt),
            "nothing local should describe a handover as checked by anything",
        )

        // A field a writer supplies is not delivered until a reader sees it,
        // and the reader on this side is a model. Each of these was accepted,
        // validated and stored, and then reached no rendered surface at all.
        val source = obj(read["source"])
        suite.check(
            "restore",
            prompt.contains("=== $RESTORE_MARK THIS HANDOVER ===") &&
                prompt.contains("Title: " + str(read["title"])),
            "the handover's own title should reach the prompt, not only the rail card",
        )
        val sourceReaches =
            listOf("client", "model", "provider", "extraction recipe").all {
                prompt.contains("$it ")
            } &&
                listOf("client", "provider", "recipeVersion").all { key ->
                    val value = str(source?.get(key)) ?: ""
                    value.isEmpty() || prompt.contains(value)
                }
        suite.check(
            "restore",
            sourceReaches,
            "the client, the model, the provider and the recipe version should tell the reader what wrote this",
        )
        val labelsInDocument = documentProvenance(read)
        suite.check(
            "restore",
            labelsInDocument.isNotEmpty() &&
                prompt.contains("=== $RESTORE_MARK WHERE THE CLAIMS CAME FROM ===") &&
                labelsInDocument.all { prompt.contains(it) },
            "every provenance label the document carries should reach the reader, because provenance is the format's only trust mechanism",
        )

        // A withheld section and an empty one are two different instructions to
        // the reader, and the prompt reported both as the second.
        val withheldDoc = readJson(fixturePath("valid/blocked-and-safe.json")) as JsonObject
        val withheldPrompt = buildRestorePrompt(withheldDoc, RESTORE_TOKEN)
        val withheldSections = obj(withheldDoc["sections"])
        val withheldKeys = SECTION_KEYS.filter { key ->
            str(obj(withheldSections?.get(key))?.get("status")) == "blocked"
        }
        val emptyLine = withheldPrompt.split("\n")
            .firstOrNull { it.startsWith("Sections with nothing in them") } ?: ""
        suite.check(
            "restore",
            withheldKeys.isNotEmpty() &&
                withheldKeys.all { key ->
                    val label = SECTION_LABELS.getValue(key)
                    !emptyLine.contains(label) &&
                        withheldPrompt.contains("withheld from $label")
                },
            "a withheld section should be named as withheld rather than counted among the empty ones",
        )
        suite.check(
            "restore",
            withheldKeys.all { key ->
                val note = str(obj(withheldSections?.get(key))?.get("summary")) ?: ""
                note.isEmpty() || withheldPrompt.contains(note.take(40))
            },
            "the note a writer left on a withheld section should travel to the reader",
        )
    } finally {
        home.toFile().deleteRecursively()
    }
}

/** Recover the original content line: exactly one backslash comes off. */
private fun unescapeRestoreLine(line: String): String = line.removePrefix("\\")

/**
 * The restore-prompt boundary, on adversarial documents.
 *
 * Every fixture in the manifest's `restore` list is a VALID handover whose
 * content is written to be mistaken for the rendered prompt's own structure.
 * The rule in spec/restore-prompt.md is that content cannot be mistaken for
 * structure, and it is checked here as three outcomes rather than as a
 * mechanism: every line a reader could take for structure carries this
 * render's marker; after the first structural line, a line carrying the marker
 * is either structure or is visibly escaped; and removing one leading
 * backslash from each line of a section's rendered block returns that
 * section's summary byte for byte.
 *
 * What is NOT checked, because it is not what the boundary claims: that
 * instruction-shaped text is absent. It travels on purpose.
 */
private fun checkRestoreBoundary(suite: Suite) {
    val manifest = obj(readJson(FIXTURES.resolve("manifest.json")))!!
    val bannerLine = Regex("^=== ${Regex.escape(RESTORE_MARK)} .+ ===$")
    val headingLine = Regex("^## ${Regex.escape(RESTORE_MARK)} .+$")

    for (entryElement in manifest["restore"] as JsonArray) {
        val entry = obj(entryElement)!!
        val name = str(entry["name"])!!
        val doc = obj(readJson(fixturePath(str(entry["file"])!!)))!!

        suite.check(
            "restore",
            validateHandover(doc).valid,
            "$name: an adversarial fixture must be a valid handover, or it is testing the validator instead",
        )

        val prompt = buildRestorePrompt(doc, RESTORE_TOKEN)
        val lines = prompt.split("\n")

        val unmarked = lines.filter {
            STRUCTURE_SHAPED.containsMatchIn(it) && !it.contains(RESTORE_MARK)
        }
        suite.check(
            "restore",
            unmarked.isEmpty(),
            "$name: ${unmarked.size} line(s) read as structure without this render's marker, " +
                "the first being ${unmarked.firstOrNull().orEmpty()}",
        )

        val firstStructural = lines.indexOfFirst { bannerLine.matches(it) }
        val borrowed = lines.drop(firstStructural + 1).filter {
            it.contains(RESTORE_MARK) &&
                !bannerLine.matches(it) &&
                !headingLine.matches(it) &&
                !it.startsWith("\\")
        }
        suite.check(
            "restore",
            borrowed.isEmpty(),
            "$name: ${borrowed.size} content line(s) carry the marker unescaped, " +
                "the first being ${borrowed.firstOrNull().orEmpty()}",
        )

        val sections = obj(doc["sections"])!!
        for (key in SECTION_KEYS) {
            val section = obj(sections[key]) ?: continue
            val summary = str(section["summary"])
            if (str(section["status"]) != "available" || summary.isNullOrEmpty()) continue

            val heading = if (key == "restoreInstructions") {
                "=== $RESTORE_MARK BOOT PROMPT ==="
            } else {
                "## $RESTORE_MARK ${SECTION_LABELS.getValue(key)}"
            }
            val offset = if (key == "restoreInstructions") 2 else 1
            val headingAt = lines.indexOf(heading)
            suite.check(
                "restore",
                headingAt >= 0,
                "$name: the rendering has no marked heading for $key",
            )
            if (headingAt < 0) continue
            val anchor = headingAt + offset
            val summaryLines = summary.split("\n")
            val block = lines.subList(anchor, anchor + summaryLines.size)
            suite.check(
                "restore",
                block.joinToString("\n") { unescapeRestoreLine(it) } == summary,
                "$name: the rendered block for $key does not decode back to the section's summary",
            )
        }
    }
}

private fun checkDeterminism(suite: Suite) {
    val doc = obj(readJson(ROOT.resolve("examples/orchard-checkout.json")))!!
    val once = renderSaved(doc, "#001")
    val twice = renderSaved(doc, "#001")
    suite.check(
        "determinism",
        once == twice,
        "the renderer should return identical bytes for identical input",
    )
    suite.check(
        "determinism",
        !Regex("\\d+\\s*%").containsMatchIn(once) &&
            !Regex("score", RegexOption.IGNORE_CASE).containsMatchIn(once),
        "a local save card should report counts, never a score",
    )
}

private fun checkRecipe(suite: Suite) {
    // The packaged recipe texts are byte-identical to the canonical files in
    // recipes/, the recipe is complete, and the recipe version travels with
    // every document the official writers produce.
    val recipeFile = ROOT.resolve("recipes/handover-recipe-v1.txt").readText()
    suite.check(
        "recipe",
        RECIPE_TEXT == recipeFile,
        "the SDK's packaged recipe must be byte-identical to recipes/handover-recipe-v1.txt, the single source of truth",
    )
    val rescueFile = ROOT.resolve("recipes/rescue-recipe-v1.txt").readText()
    suite.check(
        "recipe",
        RESCUE_PROMPT + "\n" == rescueFile,
        "the SDK's rescue prompt must be byte-identical to recipes/rescue-recipe-v1.txt, the single source of truth",
    )
    suite.check(
        "recipe",
        Regex("^\\d+\\.\\d+\\.\\d+$").matches(RECIPE_VERSION),
        "the recipe version must be a semver string",
    )

    // The recipe version travels, and it is never invented: an ingestion path
    // is handed a document somebody else wrote, so it may not attribute its own
    // recipe to that document. An input that already states one keeps it, a
    // stored document round-trips it untouched, and a document without one is
    // still valid.
    val unstamped = normalized(
        Json.parseToJsonElement(
            """{"projectId":"recipe-version","title":"Not stamped","createdAt":"${'$'}A_CAPTURE_TIME"}"""
        ))
    suite.check(
        "recipe",
        !unstamped.containsKey("source"),
        "normalization must not write its own recipeVersion onto a document it did not produce",
    )
    val kept = normalized(
        Json.parseToJsonElement(
            """{"projectId":"recipe-version","title":"Kept","createdAt":"${'$'}A_CAPTURE_TIME",""" +
                """"source":{"recipeVersion":"0.9.9"}}"""
        ))
    suite.check(
        "recipe",
        str(obj(kept["source"])?.get("recipeVersion")) == "0.9.9",
        "an input that already states a recipeVersion must keep it untouched",
    )
    val home = Files.createTempDirectory("soil-recipe-version-")
    try {
        val store = HandoverStore(home.toString())
        val example = obj(readJson(ROOT.resolve("examples/orchard-checkout.json")))!!
        val entry = store.save(example)
        suite.check(
            "recipe",
            str(obj(store.read(entry.code)["source"])?.get("recipeVersion")) ==
                str(obj(example["source"])?.get("recipeVersion")),
            "a document's recipeVersion must round-trip through the store untouched",
        )
    } finally {
        home.toFile().deleteRecursively()
    }
    val withoutOne = obj(readJson(fixturePath("valid/thin-but-honest.json")))!!
    suite.check(
        "recipe",
        !withoutOne.containsKey("source") && validateHandover(withoutOne).valid,
        "a document without a recipeVersion is still valid: other writers may lack one",
    )

    // The recipe text renders each section as one `key: guidance` line, so
    // the guidance depth can be held to the same bar as the other SDKs.
    val recipeLines = RECIPE_TEXT.split("\n")
    suite.check(
        "recipe",
        SECTION_KEYS.all { key ->
            recipeLines.any { it.startsWith("$key: ") && it.length - key.length - 2 > 200 }
        },
        "every one of the 17 sections needs real guidance, not a label",
    )
    suite.check(
        "recipe",
        RECIPE_TEXT.contains("You are creating a Soil handover") &&
            recipeLines.count { it.startsWith("RULE ") } == 5,
        "the recipe should carry the opening rule and RULES 1 to 5",
    )
    suite.check(
        "recipe",
        RECIPE_TEXT.contains("If a brand-new AI had ONLY this handover") &&
            RECIPE_TEXT.contains("This is a SELF-SUFFICIENT handover") &&
            RECIPE_TEXT.contains("Fill the schema comprehensively"),
        "the instruction block should be the rules, the lens, the framing and the close",
    )
    for (rule in listOf("RULE 1", "RULE 2", "RULE 3", "RULE 4", "RULE 5")) {
        suite.check(
            "recipe",
            recipeLines.any { it.startsWith(rule) },
            "$rule should be present verbatim",
        )
    }
}


/**
 * The closed-world contract, and the one invariant that follows from it: a
 * save path and a validation of the same bytes give the same verdict.
 *
 * Version one is closed. The top-level field set, the section field set and
 * the eleven provenance labels are fixed, and a reader refuses anything
 * outside them. A normalizing implementation therefore may not delete unknown
 * content to make a document acceptable, because then the same bytes are
 * rejected by validate and accepted by save. It may not invent the facts a
 * reader depends on either: the capture time, the recipe attribution and the
 * declared version are all claims only their real author is in a position to
 * make.
 */
private fun checkClosedWorld(suite: Suite) {
    val canonical = obj(readJson(fixturePath("valid/version-exactly-supported.json")))!!

    // Support is a set of exact versions, not a pattern over the 1.x line.
    suite.check(
        "closed-world",
        validateHandover(canonical).valid,
        "a document at exactly the supported version must validate",
    )
    for (unsupported in listOf("0.9", "1.1", "1.10", "2.0", "1", "1.0.0", "")) {
        val candidate = withKey(canonical, "soilHandover", JsonPrimitive(unsupported))
        suite.check(
            "closed-world",
            validateHandover(candidate).issues.any { it.path == "/soilHandover" },
            "an unsupported format version ${'$'}unsupported must be refused at" +
                " /soilHandover, never inferred from the shape of the string",
        )
    }

    val baseSections = obj(canonical["sections"])!!
    fun withSections(overlayJson: String): JsonObject {
        val merged = LinkedHashMap<String, JsonElement>(baseSections)
        merged.putAll(Json.parseToJsonElement(overlayJson) as JsonObject)
        return withKey(canonical, "sections", JsonObject(merged))
    }

    val unknownContent = listOf(
        Triple(
            "an unknown top-level field",
            withKey(canonical, "grade", JsonPrimitive(0.92)),
            "/grade",
        ),
        Triple(
            "an unknown field on a section",
            withSections(
                """{"decisions":{"status":"missing","summary":null,"confidence":0.4}}"""),
            "/sections/decisions/confidence",
        ),
        Triple(
            "an unknown section key",
            withSections("""{"vibes":{"status":"available","summary":"Good."}}"""),
            "/sections/vibes",
        ),
        Triple(
            "a provenance label outside the eleven",
            withSections(
                """{"decisions":{"status":"available","summary":"One.",""" +
                    """"provenance":["repo_verified","vibe_checked"]}}"""),
            "/sections/decisions/provenance/1",
        ),
        Triple(
            "an unknown member of source",
            withKey(
                canonical,
                "source",
                Json.parseToJsonElement("""{"client":"a-tool","temperature":0.7}"""),
            ),
            "/source/temperature",
        ),
    )

    for ((what, document, path) in unknownContent) {
        suite.check(
            "closed-world",
            validateHandover(document).issues.any { it.path == path },
            "${'$'}what must be refused at ${'$'}path",
        )
        suite.check(
            "closed-world",
            validateHandover(normalized(document)).issues.any { it.path == path },
            "${'$'}what must survive normalization and still be refused at ${'$'}path:" +
                " a save that strips it and a validation that refuses it are two" +
                " answers about the same bytes",
        )
    }

    // Nothing is invented. Each of these was measured being stamped in.
    val bare = normalized(
        Json.parseToJsonElement(
            """{"projectId":"invents-nothing","title":"Invents nothing"}"""))
    suite.check(
        "closed-world",
        !bare.containsKey("createdAt"),
        "normalization must not supply a createdAt the document does not carry:" +
            " it is the anchor every frontier section is read against",
    )
    suite.check(
        "closed-world",
        validateHandover(withKey(bare, "handoverId", JsonPrimitive(A_VALID_ID)))
            .issues.any { it.path == "/createdAt" },
        "a document with no createdAt must be refused, not completed",
    )
    suite.check(
        "closed-world",
        !bare.containsKey("source"),
        "normalization must not attribute its own recipe to a document it did not produce",
    )

    for (declared in listOf("1.7", "2.0", "0.9")) {
        val carried = normalized(withKey(canonical, "soilHandover", JsonPrimitive(declared)))
        suite.check(
            "closed-world",
            str(carried["soilHandover"]) == declared,
            "normalization must leave a declared version ${'$'}declared exactly as written," +
                " neither upgrading nor downgrading it",
        )
    }

    // A malformed identifier is refused rather than replaced. Dropping it here
    // is what let a writer mint a fresh one over the top of it.
    for (malformed in listOf(JsonPrimitive(42), JsonPrimitive("handover-42"), JsonPrimitive(""))) {
        val carried = normalized(withKey(canonical, "handoverId", malformed))
        suite.check(
            "closed-world",
            carried.containsKey("handoverId") &&
                validateHandover(carried).issues.any { it.path == "/handoverId" },
            "a malformed handoverId must reach validation and be refused there," +
                " never be dropped and replaced",
        )
    }
}

private fun runConformance(): Suite {
    val suite = Suite()
    checkFixtures(suite)
    checkIngestionBoundary(suite)
    checkTextUnit(suite)
    checkIdentity(suite)
    checkObservations(suite)
    checkSecretScan(suite)
    checkNormalization(suite)
    checkClosedWorld(suite)
    checkStoreAndRestore(suite)
    checkRestoreBoundary(suite)
    checkDeterminism(suite)
    checkRecipe(suite)
    return suite
}

fun main() {
    val suite = runConformance()
    // The two classes are reported separately, always. A single green blob
    // would let a writer claim the safety behaviour it never proved.
    println("soil conformance (jvm, spec 1.0)")
    println("Soil Document Conformant       ${suite.checksByClass.getValue(DOCUMENT)} checks")
    println("Soil Secure Writer Conformant  ${suite.checksByClass.getValue(SECURE_WRITER)} checks")
    if (suite.failures.isNotEmpty()) {
        println()
        println("${suite.failures.size} of ${suite.checks} checks failed")
        println()
        for ((conformanceClass, category, detail) in suite.failures) {
            println("  [$conformanceClass/$category] $detail")
        }
        println()
        exitProcess(1)
    }
}
