package dev.nativesoil.handover

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The numeric domain and the text unit.
 *
 * Both are stated normatively in `spec/value-domain.md` and both are pinned
 * across the five implementations by the conformance corpus. What is here is
 * what only this runtime can show: that a Kotlin string's `length` is a count
 * of UTF-16 code units and not the unit the format counts in.
 */
class ValueDomainTest {

    /** One code point, two UTF-16 code units, four UTF-8 bytes. */
    private val astral = "😀"

    /** Two code points, two UTF-16 code units, one grapheme cluster. */
    private val combined = "é"

    private val aValidId = "019f7e89-fc00-7000-8000-000000000000"

    /** The code and location of a refusal, or `"accepted"`. */
    private fun verdict(text: String): String {
        val issue = ingestText(text).issue ?: return "accepted"
        return "${issue.code} ${issue.path}"
    }

    @Test
    fun `accepts both ends of the safe integer range`() {
        assertEquals("accepted", verdict("""{"n":9007199254740991}"""))
        assertEquals("accepted", verdict("""{"n":-9007199254740991}"""))
        assertEquals("accepted", verdict("""{"a":0,"b":-0,"c":42,"d":-42}"""))
    }

    @Test
    fun `refuses one step beyond either end`() {
        assertEquals("number.out_of_range /n", verdict("""{"n":9007199254740992}"""))
        assertEquals("number.out_of_range /n", verdict("""{"n":-9007199254740992}"""))
    }

    @Test
    fun `refuses a magnitude no double could hold`() {
        assertEquals("number.out_of_range /n", verdict("""{"n":${"9".repeat(40)}}"""))
    }

    @Test
    fun `refuses an integer written with a point or an exponent`() {
        assertEquals("number.not_an_integer /n", verdict("""{"n":100.0}"""))
        assertEquals("number.not_an_integer /n", verdict("""{"n":1e2}"""))
        assertEquals("number.not_an_integer /n", verdict("""{"n":-0.0}"""))
        assertEquals(
            "number.not_an_integer /confidence",
            verdict("""{"confidence":0.92}"""),
        )
    }

    @Test
    fun `locates a refusal in an array and in a nested object`() {
        assertEquals("number.not_an_integer /a/2", verdict("""{"a":[1,2,1e2]}"""))
        assertEquals("number.not_an_integer /a/b/c", verdict("""{"a":{"b":{"c":0.5}}}"""))
        assertEquals("number.not_an_integer ", verdict("0.5"))
    }

    @Test
    fun `leaves the three JSON literals and digits inside strings alone`() {
        assertEquals("accepted", verdict("""{"a":true,"b":false,"c":null}"""))
        assertEquals("accepted", verdict("""{"a":"9007199254740992"}"""))
    }

    @Test
    fun `syntax and duplicates outrank the numeric domain`() {
        assertEquals("structure.duplicate_member /a", verdict("""{"a":1e2,"a":1e2}"""))
        assertEquals("syntax.invalid_json ", verdict("""{"a":1e2,}"""))
    }

    @Test
    fun `the text unit is not a string's length`() {
        val title = astral.repeat(Limits.TITLE)
        assertEquals(200, textLength(title))
        assertEquals(400, title.length)
        assertEquals(800, title.toByteArray(Charsets.UTF_8).size)
    }

    @Test
    fun `counts a combining sequence as its code points, not as one cluster`() {
        assertEquals(2, textLength(combined))
        assertEquals(4, textLength("café"))
    }

    private fun docWithTitle(title: String): JsonObject {
        val base = normalizeHandover(
            JsonObject(
                linkedMapOf<String, JsonElement>(
                    "projectId" to JsonPrimitive("text-unit"),
                    "title" to JsonPrimitive(title),
                    "createdAt" to JsonPrimitive("2026-07-26T10:00:00Z"),
                    "sections" to JsonObject(
                        linkedMapOf<String, JsonElement>(
                            "executiveSummary" to JsonPrimitive("The text unit, exercised."),
                        )
                    ),
                )
            )
        ) as JsonObject
        return JsonObject(
            LinkedHashMap<String, JsonElement>(base).also {
                it["handoverId"] = JsonPrimitive(aValidId)
            }
        )
    }

    @Test
    fun `accepts a title of exactly the limit in astral characters`() {
        val result = validateHandover(docWithTitle(astral.repeat(Limits.TITLE)))
        assertTrue(result.valid, result.issues.joinToString { "${it.path} ${it.message}" })
    }

    @Test
    fun `refuses one code point over and names the unit`() {
        val result = validateHandover(docWithTitle(astral.repeat(Limits.TITLE + 1)))
        assertFalse(result.valid)
        val issue = result.issues.first { it.path == "/title" }
        assertEquals("must be at most 200 code points", issue.message)
    }
}
