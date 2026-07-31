package dev.nativesoil.handover

import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir

private fun handover(title: String, sections: String = "{}"): JsonObject =
    normalized(
        jsonObject("""{"projectId":"store-test","title":"$title","createdAt":"$A_CAPTURE_TIME","sections":$sections}"""))

class StoreTest {

    @TempDir
    lateinit var tmp: Path

    private fun store(): HandoverStore = HandoverStore(tmp.resolve("soil").toString())

    @Test
    fun `pads codes to three digits`() {
        assertEquals("#001", formatCode(1))
        assertEquals("#042", formatCode(42))
        assertEquals("#1234", formatCode(1234))
    }

    @Test
    fun `parses the shapes a person actually types`() {
        assertEquals(4, parseCode("#004"))
        assertEquals(4, parseCode("004"))
        assertEquals(4, parseCode(" 4 "))
        assertNull(parseCode("#abc"))
        assertNull(parseCode("#000"))
    }

    @Test
    fun `prefers soil home`() {
        assertEquals("/tmp/elsewhere", resolveStoreHome(mapOf("SOIL_HOME" to "/tmp/elsewhere")))
    }

    @Test
    fun `falls back to a soil directory in the home directory`() {
        assertTrue(resolveStoreHome(emptyMap()).endsWith(".soil"))
    }

    @Test
    fun `counts by status and never scores`() {
        val doc = normalized(
            jsonObject(
                """
                {"sections":{"decisions":"one","workflow":"two",
                 "architecture":{"status":"blocked","summary":"withheld"}}}
                """.trimIndent()
            ),
        )
        assertEquals(SectionCounts(2, 14, 1, 0, 17), countSections(doc))
    }

    @Test
    fun `counts a section that does not apply on its own`() {
        val doc = normalized(
            jsonObject(
                """
                {"sections":{"decisions":"one",
                 "architecture":{"status":"not_applicable",
                  "summary":"A manuscript has no system to describe."},
                 "safetySummary":{"status":"not_applicable",
                  "summary":"Nothing here holds a value to withhold."}}}
                """.trimIndent()
            ),
        )
        assertEquals(SectionCounts(1, 14, 0, 2, 17), countSections(doc))
    }

    @Test
    fun `starts empty`() {
        assertEquals(emptyList<StoreEntry>(), store().list())
    }

    @Test
    fun `hands out codes in order and never reuses one`() {
        val store = store()
        assertEquals("#001", store.save(handover("first")).code)
        assertEquals("#002", store.save(handover("second")).code)
        assertEquals("#003", store.save(handover("third")).code)
    }

    @Test
    fun `writes one readable json file per handover`() {
        val store = store()
        store.save(handover("readable", """{"decisions":"We chose files."}"""))
        val parsed = jsonObject(store.handoversDir.resolve("001.json").readText())
        assertEquals("#001", str(parsed["code"]))
        assertEquals(
            "available",
            str(obj(obj(parsed["sections"])!!["decisions"])!!["status"]),
        )
    }

    @Test
    fun `reads back by code by bare number and by last`() {
        val store = store()
        store.save(handover("first"))
        store.save(handover("second"))
        assertEquals("first", str(store.read("#001")["title"]))
        assertEquals("first", str(store.read("1")["title"]))
        assertEquals("second", str(store.read("last")["title"]))
    }

    @Test
    fun `lists newest first with the section count`() {
        val store = store()
        store.save(handover("first", """{"decisions":"one"}"""))
        store.save(handover("second"))
        val entries = store.list()
        assertEquals(listOf("#002", "#001"), entries.map { it.code })
        assertEquals(1, entries[1].sectionsWithContent)
    }

    @Test
    fun `assigns a uuidv7 at save time and keeps an existing id`() {
        val store = store()
        val assigned = store.save(handover("fresh"))
        val stored = store.read(assigned.code)
        assertTrue(
            Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
                .matches(str(stored["handoverId"])!!)
        )
        val copied = store.save(stored)
        assertEquals(str(stored["handoverId"]), str(store.read(copied.code)["handoverId"]))
    }

    @Test
    fun `refuses to store an invalid document`() {
        val error = assertThrows<HandoverValidationException> {
            store().save(jsonObject("""{"title":"nope"}"""))
        }
        assertTrue(error.message!!.contains("not a valid Soil handover"))
    }

    @Test
    fun `says so when a code does not exist`() {
        val store = store()
        assertThrows<HandoverNotFoundException> { store.read("#404") }
        assertThrows<HandoverNotFoundException> { store.read("last") }
    }

    @Test
    fun `rebuilds the index because the files are the truth`() {
        val store = store()
        store.save(handover("first"))
        store.save(handover("second"))
        store.indexPath.writeText("""{"indexVersion":1,"nextCode":1,"entries":[]}""")
        val rebuilt = store.reindex()
        assertEquals(listOf("#001", "#002"), rebuilt.entries.map { it.code })
        assertEquals(3, rebuilt.nextCode)
    }

    @Test
    fun `skips unreadable files when rebuilding`() {
        val store = store()
        store.save(handover("good"))
        store.handoversDir.resolve("099.json").writeText("""{"not":"a handover"}""")
        assertEquals(1, store.reindex().entries.size)
    }
}
