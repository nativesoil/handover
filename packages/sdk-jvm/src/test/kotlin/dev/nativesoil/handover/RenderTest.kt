package dev.nativesoil.handover

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

private val DOC = normalized(
    jsonObject(
        """
        {"handoverId":"$A_VALID_ID","projectId":"render-test","title":"A short title",
         "createdAt":"2026-07-22T10:00:00Z",
         "source":{"client":"claude-code","model":"opus-4.8"},
         "sections":{
           "executiveSummary":"What this is.",
           "decisions":"What was decided.",
           "architecture":{"status":"blocked","summary":"Host names withheld."}},
         "quality":{"missingInputs":["the deploy logs were not available"]},
         "safety":{"unsafeOmissions":["an API key exists in the platform config"]}}
        """.trimIndent()
    ),
)

class RenderTest {

    private val card = renderSaved(DOC, "#004")

    @Test
    fun `wrap breaks on words and never mid word`() {
        assertEquals(listOf("one two", "three", "four"), wrap("one two three four", 9))
    }

    @Test
    fun `wrap keeps a word longer than the width on its own line`() {
        assertEquals(listOf("supercalifragilistic"), wrap("supercalifragilistic", 5))
    }

    @Test
    fun `saved card leads with the load code`() {
        assertTrue(card.split("\n")[0].contains("#004"))
    }

    @Test
    fun `saved card reports counts and never a score`() {
        assertTrue(card.contains("2 / 17 sections carrying content"))
        assertFalse(Regex("\\d+\\s*%").containsMatchIn(card))
        assertFalse(Regex("score|grade|readiness", RegexOption.IGNORE_CASE).containsMatchIn(card))
    }

    @Test
    fun `saved card names what did not survive`() {
        assertTrue(card.contains("no content"))
        assertTrue(card.contains("held back   architecture"))
    }

    @Test
    fun `saved card shows the stated gaps and the safety omissions`() {
        assertTrue(card.contains("stated gaps"))
        assertTrue(card.contains("the deploy logs were not available"))
        assertTrue(card.contains("held back · by design"))
    }

    @Test
    fun `saved card ends with the command that loads it back`() {
        assertTrue(card.trimEnd().endsWith("❯ soil load #004"))
    }

    @Test
    fun `saved card is deterministic`() {
        assertEquals(card, renderSaved(DOC, "#004"))
    }

    @Test
    fun `saved card keeps every line inside the card width`() {
        for (line in card.split("\n")) {
            assertTrue(line.length <= 70, "line too wide: $line")
        }
    }

    @Test
    fun `loaded card says which sections are empty and how to read the rest`() {
        val loaded = renderLoaded(
            withKey(DOC, "code", kotlinx.serialization.json.JsonPrimitive("#004"))
        )
        assertTrue(loaded.contains("what this document carries"))
        assertTrue(loaded.contains("no content"))
        assertTrue(loaded.contains("moment of capture"))
    }

    @Test
    fun `list card says so when nothing is stored`() {
        assertTrue(renderList(emptyList()).contains("nothing saved yet"))
    }

    @Test
    fun `list card shows a code a title and a count per row`() {
        val card = renderList(
            listOf(
                StoreEntry(
                    code = "#002",
                    projectId = "render-test",
                    title = "A very long title that will not fit in the column at all",
                    createdAt = "2026-07-22T10:00:00Z",
                    sectionsWithContent = 9,
                    file = "002.json",
                )
            )
        )
        assertTrue(card.contains("#002"))
        assertTrue(card.contains("…"))
        assertTrue(card.contains("9/17"))
    }

    @Test
    fun `validation card says structure only when a document is valid`() {
        val card = renderValidation(validateHandover(DOC), "the document")
        assertTrue(card.contains("valid handover"))
        assertTrue(card.contains("says nothing about how good the content is"))
    }

    @Test
    fun `validation card lists every problem when it is not`() {
        val card = renderValidation(validateHandover(jsonObject("""{"soilHandover":"1.0"}""")), "x")
        assertTrue(card.contains("not a handover"))
        assertTrue(card.contains("/projectId"))
    }
}
