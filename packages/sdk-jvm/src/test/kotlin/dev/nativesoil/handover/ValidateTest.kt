package dev.nativesoil.handover

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class ValidateTest {

    @Test
    fun `accepts a handover where every section is missing`() {
        assertTrue(validateHandover(validHandover()).valid)
    }

    @Test
    fun `accepts an offset timestamp not only z`() {
        val doc = validHandover(
            mapOf("createdAt" to JsonPrimitive("2026-07-20T08:00:00+02:00"))
        )
        assertTrue(validateHandover(doc).valid)
    }

    @Test
    fun `reports every problem at once not just the first`() {
        val result = validateHandover(
            jsonObject(
                """
                {"soilHandover":"1.0","handoverId":"$A_VALID_ID","title":"",
                 "createdAt":"yesterday","sections":${allSections()}}
                """.trimIndent()
            )
        )
        assertFalse(result.valid)
        assertEquals(
            listOf("/createdAt", "/projectId", "/title"),
            result.issues.map { it.path }.sorted(),
        )
    }

    @Test
    fun `rejects a dropped section because a gap is stated not omitted`() {
        val doc = validHandover(
            mapOf("sections" to withoutKey(allSections(), "decisions"))
        )
        val result = validateHandover(doc)
        assertFalse(result.valid)
        assertEquals("/sections/decisions", result.issues[0].path)
    }

    @Test
    fun `rejects a section key nobody has heard of`() {
        val doc = validHandover(
            mapOf(
                "sections" to allSections(
                    mapOf("vibes" to jsonObject("""{"status":"missing","summary":null}"""))
                )
            )
        )
        assertTrue(validateHandover(doc).issues.any { it.path == "/sections/vibes" })
    }

    @Test
    fun `rejects available with no content`() {
        val doc = validHandover(
            mapOf(
                "sections" to allSections(
                    mapOf("decisions" to jsonObject("""{"status":"available","summary":"  "}"""))
                )
            )
        )
        assertEquals("/sections/decisions/summary", validateHandover(doc).issues[0].path)
    }

    @Test
    fun `rejects a status outside the four word vocabulary`() {
        val doc = validHandover(
            mapOf(
                "sections" to allSections(
                    mapOf("decisions" to jsonObject("""{"status":"partial","summary":"half"}"""))
                )
            )
        )
        assertEquals("/sections/decisions/status", validateHandover(doc).issues[0].path)
    }

    @Test
    fun `accepts a section that does not apply when it says why`() {
        val doc = validHandover(
            mapOf(
                "sections" to allSections(
                    mapOf(
                        "architecture" to jsonObject(
                            """{"status":"not_applicable",""" +
                                """"summary":"A one-author manuscript has no system to describe."}"""
                        )
                    )
                )
            )
        )
        assertTrue(validateHandover(doc).valid)
    }

    @Test
    fun `rejects a section that does not apply without a reason`() {
        for (summary in listOf("null", "\"\"", "\"   \"")) {
            val doc = validHandover(
                mapOf(
                    "sections" to allSections(
                        mapOf(
                            "architecture" to jsonObject(
                                """{"status":"not_applicable","summary":$summary}"""
                            )
                        )
                    )
                )
            )
            val result = validateHandover(doc)
            assertFalse(result.valid)
            assertEquals("/sections/architecture/summary", result.issues[0].path)
        }
    }

    @Test
    fun `refuses a near neighbour of the fourth status`() {
        for (status in listOf("notApplicable", "not applicable", "NOT_APPLICABLE")) {
            val doc = validHandover(
                mapOf(
                    "sections" to allSections(
                        mapOf(
                            "architecture" to jsonObject(
                                """{"status":"$status","summary":"There is no system here."}"""
                            )
                        )
                    )
                )
            )
            val result = validateHandover(doc)
            assertFalse(result.valid)
            assertEquals("/sections/architecture/status", result.issues[0].path)
        }
    }

    @Test
    fun `rejects an unknown provenance label`() {
        val doc = validHandover(
            mapOf(
                "sections" to allSections(
                    mapOf(
                        "decisions" to jsonObject(
                            """{"status":"available","summary":"one","provenance":["model_reported","vibes_based"]}"""
                        )
                    )
                )
            )
        )
        assertEquals(
            "/sections/decisions/provenance/1",
            validateHandover(doc).issues[0].path,
        )
    }

    @Test
    fun `rejects a duplicated provenance label`() {
        val doc = validHandover(
            mapOf(
                "sections" to allSections(
                    mapOf(
                        "decisions" to jsonObject(
                            """{"status":"available","summary":"one","provenance":["inferred","inferred"]}"""
                        )
                    )
                )
            )
        )
        assertTrue(validateHandover(doc).issues[0].message.contains("duplicate"))
    }

    @Test
    fun `rejects an unknown top level field including a grade`() {
        val doc = validHandover(mapOf("grade" to JsonPrimitive("A")))
        assertTrue(validateHandover(doc).issues.any { it.path == "/grade" })
    }

    @Test
    fun `supports exact versions and refuses everything else`() {
        // Support is a set, not a pattern. A reader that accepts 1.4 because
        // the string starts with "1." is claiming to implement a version
        // nobody has written, and version one is a closed world: whatever
        // that minor allowed would arrive here unrecognised.
        assertTrue(
            validateHandover(validHandover(mapOf("soilHandover" to JsonPrimitive("1.0")))).valid
        )
        for (unsupported in listOf("0.9", "1.1", "1.4", "1.10", "2.0", "1", "1.0.0", "")) {
            val result = validateHandover(
                validHandover(mapOf("soilHandover" to JsonPrimitive(unsupported)))
            )
            assertFalse(result.valid, unsupported)
            assertTrue(result.issues.any { it.path == "/soilHandover" }, unsupported)
        }
    }

    @Test
    fun `requires a handover id on a document claiming validity`() {
        val result = validateHandover(withoutKey(validHandover(), "handoverId"))
        assertFalse(result.valid)
        assertEquals("/handoverId", result.issues[0].path)
        assertEquals(ValidationIssueKind.STRUCTURE, result.issues[0].kind)
    }

    @Test
    fun `rejects a handover id that is not a uuid`() {
        val result =
            validateHandover(validHandover(mapOf("handoverId" to JsonPrimitive("handover-42"))))
        assertFalse(result.valid)
        assertEquals("/handoverId", result.issues[0].path)
    }

    @Test
    fun `rejects a project id with spaces`() {
        val result =
            validateHandover(validHandover(mapOf("projectId" to JsonPrimitive("two words"))))
        assertEquals("/projectId", result.issues[0].path)
    }

    @Test
    fun `accepts a store assigned code and rejects a malformed one`() {
        assertTrue(validateHandover(validHandover(mapOf("code" to JsonPrimitive("#004")))).valid)
        assertFalse(validateHandover(validHandover(mapOf("code" to JsonPrimitive("4")))).valid)
    }

    @Test
    fun `accepts stated gaps and safety omissions`() {
        val doc = validHandover(
            mapOf(
                "quality" to jsonObject(
                    """{"missingInputs":["the deploy logs"],"contradictions":[]}"""
                ),
                "safety" to jsonObject(
                    """{"unsafeOmissions":["an API key exists in the platform config"]}"""
                ),
            )
        )
        assertTrue(validateHandover(doc).valid)
    }

    @Test
    fun `rejects a note that is not text`() {
        val doc = validHandover(mapOf("quality" to jsonObject("""{"missingInputs":[7]}""")))
        assertEquals("/quality/missingInputs/0", validateHandover(doc).issues[0].path)
    }

    @Test
    fun `rejects something that is not an object at all`() {
        assertFalse(validateHandover(JsonPrimitive("a handover, honest")).valid)
        assertFalse(validateHandover(JsonNull).valid)
        assertFalse(validateHandover(null).valid)
    }

    @Test
    fun `assertHandover passes a valid document and returns it`() {
        val doc = validHandover()
        assertEquals("test-project", str(assertHandover(doc)["projectId"]))
    }

    @Test
    fun `assertHandover raises with every issue attached`() {
        val error = assertThrows<HandoverValidationException> {
            assertHandover(jsonObject("""{"soilHandover":"1.0"}"""))
        }
        assertTrue(error.issues.size > 1)
        assertTrue(error.message!!.startsWith("not a valid Soil handover"))
    }
}
