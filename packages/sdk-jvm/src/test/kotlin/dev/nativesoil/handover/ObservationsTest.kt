/** The extension point, tested from the angle that matters: a reader meeting
 * a producer it has never heard of. */
package dev.nativesoil.handover

import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

private fun withObservations(observationsJson: String): JsonObject = normalized(
    jsonObject(
        """
        {"handoverId":"$A_VALID_ID","projectId":"extension-test","title":"Extension point",
         "createdAt":"$A_CAPTURE_TIME",
         "sections":{"executiveSummary":"A project."},
         "observations":$observationsJson}
        """.trimIndent()
    ),
)

class ObservationsTest {

    @Test
    fun `are optional a handover without any is complete`() {
        val doc = normalized(
            jsonObject(
                """
                {"handoverId":"$A_VALID_ID","projectId":"none","title":"None",
                 "createdAt":"$A_CAPTURE_TIME",
                 "sections":{"decisions":"one"}}
                """.trimIndent()
            ),
        )
        assertFalse(doc.containsKey("observations"))
        assertTrue(validateHandover(doc).valid)
    }

    @Test
    fun `accept a kind this implementation has never heard of`() {
        val doc = withObservations(
            """[{"kind":"com.example.kind.from.the.future","data":{"anything":[1,2]}}]"""
        )
        assertTrue(validateHandover(doc).valid)
    }

    @Test
    fun `carry unknown entries through normalization unchanged`() {
        val entries = """
            [{"kind":"com.example.measurement","producedBy":"example-service 3.2",
              "producedAt":"2026-07-20T09:00:00Z","data":{"nested":{"deeply":{"value":4}}}},
             {"kind":"dev.example.annotation","data":{}}]
        """.trimIndent()
        val doc = withObservations(entries)
        assertEquals(json(entries), doc["observations"])
    }

    @Test
    fun `do not change how the sections are read`() {
        val base = normalized(
            jsonObject(
                """
                {"projectId":"extension-test","title":"Extension point",
                 "createdAt":"2026-07-22T10:00:00Z",
                 "sections":{"executiveSummary":"A project.","decisions":"One decision."}}
                """.trimIndent()
            ),
        )
        val observed = withKey(
            base,
            "observations",
            json("""[{"kind":"com.example.anything","data":{"score":11}}]"""),
        )
        // A fixed boundary token, because production takes a fresh one from
        // the platform's cryptographic source on every render and the point
        // here is the sections, not the boundary.
        val token = "0123456789abcdef0123456789abcdef"
        assertEquals(
            buildRestorePrompt(base, token),
            buildRestorePrompt(observed, token),
        )
    }

    @Test
    fun `reject an entry with a key outside the envelope`() {
        val result =
            validateHandover(withObservations("""[{"kind":"a.kind","data":{},"extra":"no"}]"""))
        assertEquals("/observations/0/extra", result.issues[0].path)
    }

    @Test
    fun `reject an entry with no kind or no data`() {
        assertEquals(
            "/observations/0/kind",
            validateHandover(withObservations("""[{"data":{}}]""")).issues[0].path,
        )
        assertEquals(
            "/observations/0/data",
            validateHandover(withObservations("""[{"kind":"a.kind"}]""")).issues[0].path,
        )
    }

    @Test
    fun `reject a produced at that is not a timestamp`() {
        val result = validateHandover(
            withObservations("""[{"kind":"a.kind","producedAt":"recently","data":{}}]""")
        )
        assertEquals("/observations/0/producedAt", result.issues[0].path)
    }

    @Test
    fun `reject observations that are not an array`() {
        assertFalse(
            validateHandover(withObservations("""{"kind":"a.kind","data":{}}""")).valid
        )
    }

    @Test
    fun `are covered by the secret scan however deep`() {
        val doc = withObservations(
            """
            [{"kind":"com.example.measurement",
              "data":{"call":{"header":"Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e"}}}]
            """.trimIndent()
        )
        assertEquals("/observations/0/data/call/header", findSecretMaterial(doc)[0].path)
        val result = validateHandover(doc)
        assertFalse(result.valid)
        assertEquals(ValidationIssueKind.SAFETY, result.issues[0].kind)
    }
}
