package dev.nativesoil.handover

import java.nio.file.Path
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The repo root, handed to the tests by the Gradle build. */
val REPO_ROOT: Path = Path.of(
    System.getProperty("soil.repo.root")
        ?: error("run the tests through Gradle so soil.repo.root is set")
)

val NOW: Instant = Instant.parse("2026-07-22T10:00:00Z")

const val A_VALID_ID: String = "019f7e89-fc00-7000-8000-000000000000"

/** A capture time, stated by the document. Nothing here reads a clock. */
const val A_CAPTURE_TIME: String = "2026-07-22T10:00:00Z"

/**
 * Normalize and assert the object shape, which is what every test here feeds
 * it. [normalizeHandover] itself returns a JsonElement, because a root that is
 * not an object is carried through as it arrived rather than replaced with a
 * document built around it.
 */
fun normalized(input: JsonElement?): JsonObject = normalizeHandover(input) as JsonObject

fun json(text: String): JsonElement = Json.parseToJsonElement(text)

fun jsonObject(text: String): JsonObject = json(text) as JsonObject

fun str(element: JsonElement?): String? =
    (element as? JsonPrimitive)?.takeIf { it.isString }?.content

fun obj(element: JsonElement?): JsonObject? = element as? JsonObject

fun arr(element: JsonElement?): JsonArray? = element as? JsonArray

fun withKey(base: JsonObject, key: String, value: JsonElement): JsonObject =
    JsonObject(LinkedHashMap<String, JsonElement>(base).also { it[key] = value })

fun withoutKey(base: JsonObject, key: String): JsonObject =
    JsonObject(LinkedHashMap<String, JsonElement>(base).also { it.remove(key) })

/** All 17 sections declared missing, with optional overrides. */
fun allSections(overrides: Map<String, JsonElement> = emptyMap()): JsonObject {
    val sections = LinkedHashMap<String, JsonElement>()
    for (key in SECTION_KEYS) {
        sections[key] = jsonObject("""{"status":"missing","summary":null}""")
    }
    sections.putAll(overrides)
    return JsonObject(sections)
}

/** A minimal valid handover, with optional overrides. */
fun validHandover(overrides: Map<String, JsonElement> = emptyMap()): JsonObject {
    val base = linkedMapOf<String, JsonElement>(
        "soilHandover" to JsonPrimitive("1.0"),
        "handoverId" to JsonPrimitive(A_VALID_ID),
        "projectId" to JsonPrimitive("test-project"),
        "title" to JsonPrimitive("A handover"),
        "createdAt" to JsonPrimitive("2026-07-20T08:00:00Z"),
        "sections" to allSections(),
    )
    base.putAll(overrides)
    return JsonObject(base)
}
