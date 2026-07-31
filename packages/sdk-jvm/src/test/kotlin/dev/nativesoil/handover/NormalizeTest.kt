package dev.nativesoil.handover

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class NormalizeTest {

    @Test
    fun `declares all 17 sections even from an empty object`() {
        val doc = normalized(jsonObject("{}"))
        assertEquals(SECTION_KEYS, obj(doc["sections"])!!.keys.toList())
        assertEquals(
            jsonObject("""{"status":"missing","summary":null}"""),
            obj(doc["sections"])!!["decisions"],
        )
    }

    @Test
    fun `accepts the loose extraction sections key`() {
        val doc = normalized(
            jsonObject(
                """{"projectId":"loose","title":"Loose","extractionSections":{"decisions":"We picked Postgres."}}"""
            ))
        assertEquals(
            jsonObject("""{"status":"available","summary":"We picked Postgres."}"""),
            obj(doc["sections"])!!["decisions"],
        )
    }

    @Test
    fun `turns a bare string into an available section`() {
        val doc = normalized(
            jsonObject("""{"sections":{"workflow":"  Review before merge.  "}}"""))
        assertEquals(
            jsonObject("""{"status":"available","summary":"Review before merge."}"""),
            obj(doc["sections"])!!["workflow"],
        )
    }

    @Test
    fun `treats an empty string as a gap rather than as content`() {
        val doc = normalized(jsonObject("""{"sections":{"workflow":"   "}}"""))
        assertEquals("missing", str(obj(obj(doc["sections"])!!["workflow"])!!["status"]))
    }

    @Test
    fun `infers available when an object has a summary but no status`() {
        val doc = normalized(
            jsonObject("""{"sections":{"blockers":{"summary":"The sandbox is down."}}}"""))
        assertEquals("available", str(obj(obj(doc["sections"])!!["blockers"])!!["status"]))
    }

    @Test
    fun `keeps an explicit blocked status and its note`() {
        val doc = normalized(
            jsonObject(
                """{"sections":{"architecture":{"status":"blocked","summary":"Host names withheld."}}}"""
            ))
        assertEquals(
            jsonObject("""{"status":"blocked","summary":"Host names withheld."}"""),
            obj(doc["sections"])!!["architecture"],
        )
    }

    @Test
    fun `does not invent a project id so validation can say so`() {
        val doc = normalized(jsonObject("""{"title":"No slug"}"""))
        assertEquals("", str(doc["projectId"]))
        assertFalse(validateHandover(doc).valid)
    }

    @Test
    fun `leaves a complete reply one writer assigned id from valid`() {
        val doc = normalized(
            jsonObject(
                """
                {"projectId":"rescue-test","title":"Rescued from a full thread",
                 "createdAt":"$A_CAPTURE_TIME",
                 "extractionSections":{
                   "projectIdentity":"A test project.",
                   "decisions":{"status":"available","summary":"One decision."},
                   "blockers":{"status":"missing","summary":null}}}
                """.trimIndent()
            ),
        )
        val result = validateHandover(doc)
        assertFalse(result.valid)
        assertEquals(listOf("/handoverId"), result.issues.map { it.path })
        assertTrue(
            validateHandover(withKey(doc, "handoverId", JsonPrimitive(A_VALID_ID))).valid
        )
    }

    @Test
    fun `keeps an existing handover id and never mints one`() {
        val kept = normalized(
            jsonObject(
                """{"handoverId":"$A_VALID_ID","projectId":"identified","title":"Identified"}"""
            ))
        assertEquals(A_VALID_ID, str(kept["handoverId"]))
        val fresh = normalized(
            jsonObject("""{"projectId":"unidentified","title":"Unidentified"}"""))
        assertFalse(fresh.containsKey("handoverId"))
    }

    @Test
    fun `pulls json out of a fenced block wrapped in prose`() {
        val text = "Sure!\n\n```json\n{\"a\":1}\n```\n\nAnything else?"
        assertEquals("""{"a":1}""", extractJsonBlock(text))
    }

    @Test
    fun `handles a fence with no language tag`() {
        assertEquals("""{"a":1}""", extractJsonBlock("```\n{\"a\":1}\n```"))
    }

    @Test
    fun `falls back to the outermost braces`() {
        assertEquals("""{"a":{"b":2}}""", extractJsonBlock("""here you go: {"a":{"b":2}} done"""))
    }

    @Test
    fun `returns null when there is no json at all`() {
        assertNull(extractJsonBlock("I could not do that"))
    }

    // Wrong capitalisation is the common case. Rewriting it to "available"
    // would let a typo become content that counts as captured, and the author
    // would never be told.
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(
        strings = ["Available", "AVAILABLE", "partial", "done"]
    )
    fun `keeps an unrecognised status so validation refuses it`(wrong: String) {
        val doc = normalized(
            jsonObject(
                """
                {"handoverId":"$A_VALID_ID","projectId":"status-test","title":"Status",
                 "createdAt":"$A_CAPTURE_TIME",
                 "sections":{"decisions":{"status":"$wrong","summary":"One decision."}}}
                """.trimIndent()
            ),
        )
        assertEquals(wrong, str(obj(obj(doc["sections"])!!["decisions"])!!["status"]))
        val result = validateHandover(doc)
        assertFalse(result.valid)
        assertTrue(
            result.issues.any {
                it.path == "/sections/decisions/status" &&
                    it.kind == ValidationIssueKind.STRUCTURE
            }
        )
    }
}

/**
 * The closed-world contract, on the normalization path.
 *
 * Version one has no room for an unknown field, and normalization is not
 * allowed to make room by deleting one. Each of these used to be dropped
 * silently, which meant `soil validate` rejected a document and `soil save`
 * stored it, from the same bytes.
 */
class NormalizeClosedWorldTest {

    private fun base(extra: String = ""): JsonObject = jsonObject(
        """{"soilHandover":"1.0","handoverId":"$A_VALID_ID","projectId":"closed-world",""" +
            """"title":"Closed world","createdAt":"$A_CAPTURE_TIME"$extra}"""
    )

    @Test
    fun `carries unknown content to validation`() {
        val cases = listOf(
            Triple("an unknown top-level field", ""","grade":0.92""", "/grade"),
            Triple(
                "an unknown field on a section",
                ""","sections":{"decisions":{"status":"available","summary":"One.","confidence":0.4}}""",
                "/sections/decisions/confidence",
            ),
            Triple(
                "an unknown section key",
                ""","sections":{"vibes":{"status":"available","summary":"Good."}}""",
                "/sections/vibes",
            ),
            Triple(
                "a provenance label outside the eleven",
                ""","sections":{"decisions":{"status":"available","summary":"one",""" +
                    """"provenance":["repo_verified","vibe_checked"]}}""",
                "/sections/decisions/provenance/1",
            ),
            Triple(
                "an unknown member of source",
                ""","source":{"client":"a-tool","temperature":0.7}""",
                "/source/temperature",
            ),
            Triple(
                "a section value it cannot reshape",
                ""","sections":{"decisions":42}""",
                "/sections/decisions",
            ),
        )
        for ((what, extra, path) in cases) {
            val document = base(extra)
            assertTrue(validateHandover(document).issues.any { it.path == path }, what)
            assertTrue(
                validateHandover(normalized(document)).issues.any { it.path == path },
                "$what must survive normalization: a save that strips it and a" +
                    " validation that refuses it are two answers about the same bytes",
            )
        }
    }

    @Test
    fun `does not upgrade or downgrade a declared version`() {
        for (declared in listOf("1.7", "2.0", "0.9")) {
            val doc = normalized(
                jsonObject("""{"soilHandover":"$declared","projectId":"v","title":"V"}"""))
            assertEquals(declared, str(doc["soilHandover"]))
            assertFalse(validateHandover(doc).valid)
        }
    }

    // The anchor every frontier section is read against. A wall clock read at
    // save time is indistinguishable, to a consumer, from a time the session
    // actually reported.
    @Test
    fun `does not stamp a created at the document never carried`() {
        val doc = normalized(jsonObject("""{"projectId":"no-time","title":"No time"}"""))
        assertFalse(doc.containsKey("createdAt"))
        val identified = withKey(doc, "handoverId", JsonPrimitive(A_VALID_ID))
        assertTrue(validateHandover(identified).issues.any { it.path == "/createdAt" })
    }

    @Test
    fun `keeps a created at it cannot parse instead of replacing it`() {
        val doc = normalized(
            jsonObject("""{"projectId":"bad-time","title":"Bad","createdAt":"last Tuesday"}"""))
        assertEquals("last Tuesday", str(doc["createdAt"]))
    }

    @Test
    fun `does not stamp a recipe version onto another writers document`() {
        val doc = normalized(jsonObject("""{"projectId":"recipe","title":"Recipe"}"""))
        assertFalse(doc.containsKey("source"))
        val kept = normalized(
            jsonObject("""{"projectId":"a","title":"A","source":{"recipeVersion":"0.9.9"}}"""))
        assertEquals("0.9.9", str(obj(kept["source"])!!["recipeVersion"]))
    }

    // Dropping it is what makes the replacement possible: the writer then sees
    // a document with no id and mints one, and nobody is ever told the id the
    // document arrived with was wrong.
    @Test
    fun `keeps a malformed handover id rather than letting a writer replace it`() {
        for (malformed in listOf("42", """"handover-42"""", """""""", "null")) {
            val doc = normalized(
                jsonObject(
                    """{"soilHandover":"1.0","handoverId":$malformed,"projectId":"identity",""" +
                        """"title":"Identity","createdAt":"$A_CAPTURE_TIME"}"""
                )
            )
            assertTrue(doc.containsKey("handoverId"), malformed)
            assertTrue(
                validateHandover(doc).issues.any { it.path == "/handoverId" }, malformed)
        }
    }

    @Test
    fun `keeps a quality entry it cannot use rather than deleting it`() {
        val doc = normalized(
            jsonObject(
                """
                {"projectId":"notes","title":"Notes","createdAt":"$A_CAPTURE_TIME",
                 "quality":{"missingInputs":["the logs","  ",7]},
                 "safety":{"unsafeOmissions":["  a key exists in the config  "]}}
                """.trimIndent()
            ),
        )
        assertEquals(json("""["the logs","  ",7]"""), obj(doc["quality"])!!["missingInputs"])
        assertEquals(
            json("""["a key exists in the config"]"""),
            obj(doc["safety"])!!["unsafeOmissions"],
        )
    }
}
