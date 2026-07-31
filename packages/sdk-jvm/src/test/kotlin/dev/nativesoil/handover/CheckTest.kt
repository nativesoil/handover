/**
 * The open save-time baseline, held to the reference byte for byte.
 *
 * The corpus under `src/test/resources/parity/check/` is shared across the
 * ports and was designed to attack this one: every rule firing and none,
 * counts on each grade-band edge, thresholds met and missed by one unit,
 * content outside the Basic Multilingual Plane, and a decisions section
 * whose entry order punishes a wrong sort. The expected files beside each
 * document were produced by the built TypeScript reference through
 * `scripts/generate-check-parity.mjs`, never by hand.
 */
package dev.nativesoil.handover

import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.name
import kotlin.io.path.readText
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

private val CORPUS_DIR =
    REPO_ROOT.resolve("packages/sdk-jvm/src/test/resources/parity/check")

private const val PRODUCED_BY = "soil-cli/0.1.0"
private const val PRODUCED_AT = "2026-07-22T10:00:00Z"

class CheckParityTest {

    private fun corpusNames(): List<String> =
        CORPUS_DIR.listDirectoryEntries("*.card.txt")
            .map { it.name.removeSuffix(".card.txt") }
            .sorted()

    private fun corpusDocument(name: String): JsonObject =
        jsonObject(CORPUS_DIR.resolve("$name.json").readText())

    @Test
    fun `the corpus is present and whole`() {
        // A deleted corpus directory must fail loudly rather than pass an
        // empty loop.
        assertEquals(18, corpusNames().size)
    }

    @TestFactory
    fun `the check card is byte identical to the reference`(): List<DynamicTest> =
        corpusNames().map { name ->
            DynamicTest.dynamicTest(name) {
                val document = corpusDocument(name)
                val report = checkHandover(document)
                assertEquals(
                    CORPUS_DIR.resolve("$name.card.txt").readText(),
                    renderCheck(document, report),
                )
            }
        }

    @TestFactory
    fun `the report json is byte identical to the reference`(): List<DynamicTest> =
        corpusNames().map { name ->
            DynamicTest.dynamicTest(name) {
                val document = corpusDocument(name)
                val report = checkHandover(document)
                assertEquals(
                    CORPUS_DIR.resolve("$name.report.json").readText(),
                    stringifyPretty(checkReportJson(report)) + "\n",
                )
            }
        }

    @TestFactory
    fun `the observation is byte identical to the reference`(): List<DynamicTest> =
        corpusNames().map { name ->
            DynamicTest.dynamicTest(name) {
                val document = corpusDocument(name)
                val report = checkHandover(document)
                val observation =
                    checkObservation(document, report, PRODUCED_BY, PRODUCED_AT)
                assertEquals(
                    CORPUS_DIR.resolve("$name.observation.json").readText(),
                    stringifyPretty(observation) + "\n",
                )
            }
        }
}

class CheckBehaviourTest {

    private val example: JsonObject =
        jsonObject(REPO_ROOT.resolve("examples/orchard-checkout.json").readText())

    @Test
    fun `checking is deterministic and does not touch the document`() {
        val before = stringifyPretty(example)
        val first = checkHandover(example)
        val second = checkHandover(example)
        assertEquals(first, second)
        assertEquals(before, stringifyPretty(example))
    }

    @Test
    fun `the grade mapping matches the documented table exactly`() {
        assertEquals("strong", gradeFromCounts(CheckCounts(0, 0, 0)))
        assertEquals("strong", gradeFromCounts(CheckCounts(0, 0, 9)))
        assertEquals("adequate", gradeFromCounts(CheckCounts(0, 1, 0)))
        assertEquals("adequate", gradeFromCounts(CheckCounts(0, 5, 0)))
        assertEquals("thin", gradeFromCounts(CheckCounts(0, 6, 0)))
        assertEquals("thin", gradeFromCounts(CheckCounts(1, 0, 0)))
        assertEquals("thin", gradeFromCounts(CheckCounts(2, 9, 0)))
        assertEquals("failing", gradeFromCounts(CheckCounts(3, 0, 0)))
    }

    @Test
    fun `splitEntries splits numbered items, bullets and paragraphs`() {
        assertEquals(
            listOf("Intro line:", "1. First.", "2. Second continued.", "- Third."),
            splitEntries("Intro line:\n\n1. First.\n2. Second\ncontinued.\n- Third."),
        )
    }

    @Test
    fun `every finding carries a documented rule id`() {
        val bare = normalized(
            json(
                """{"handoverId": "$A_VALID_ID", "projectId": "check-test",
                   "title": "Check test", "sections": {}}"""
            )
        )
        val report = checkHandover(bare)
        assertTrue(report.findings.isNotEmpty())
        for (finding in report.findings) {
            assertTrue(CHECK_RULES.containsKey(finding.rule))
            assertTrue(finding.message.isNotEmpty())
        }
    }

    @Test
    fun `the observation carries the closed field set and nothing else`() {
        val report = checkHandover(example)
        val observation = checkObservation(example, report, PRODUCED_BY, PRODUCED_AT)
        val data = observation["data"] as JsonObject
        assertEquals(
            listOf(
                "blockedSections", "checkVersion", "findings",
                "missingSections", "notes", "sectionsWithContent",
            ),
            data.keys.sorted(),
        )
        // No band, no score and no aggregate, under any key.
        val serialized = stringifyPretty(observation)
        for (band in CHECK_GRADES) {
            assertFalse(serialized.contains("\"$band\""), band)
        }
    }

    @Test
    fun `an attached observation keeps the document valid`() {
        val report = checkHandover(example)
        val observation = checkObservation(example, report, PRODUCED_BY, PRODUCED_AT)
        val attached = withKey(example, "observations", JsonArray(listOf(observation)))
        assertTrue(validateHandover(attached).valid)
    }

    @Test
    fun `notes are bounded in code points and refused rather than truncated`() {
        val report = checkHandover(example)
        assertTrue(textLength(CHECK_DEFAULT_NOTES) <= CHECK_NOTES_MAX_CHARS)
        assertEquals(
            "Ran offline.",
            asStringOrNull(
                (
                    checkObservation(
                        example, report, PRODUCED_BY, PRODUCED_AT, "Ran offline.",
                    )["data"] as JsonObject
                )["notes"]
            ),
        )
        assertThrows(IllegalArgumentException::class.java) {
            checkObservation(
                example, report, PRODUCED_BY, PRODUCED_AT,
                "x".repeat(CHECK_NOTES_MAX_CHARS + 1),
            )
        }
        // The bound is code points, so a note of astral characters is refused
        // at the same count and not at half of it.
        val emoji = String(Character.toChars(0x1F600))
        checkObservation(
            example, report, PRODUCED_BY, PRODUCED_AT,
            emoji.repeat(CHECK_NOTES_MAX_CHARS),
        )
        assertThrows(IllegalArgumentException::class.java) {
            checkObservation(
                example, report, PRODUCED_BY, PRODUCED_AT,
                emoji.repeat(CHECK_NOTES_MAX_CHARS + 1),
            )
        }
    }
}

class StoreUpdateTest {

    private fun tempStore(): HandoverStore {
        val home = java.nio.file.Files.createTempDirectory("soil-update-")
        return HandoverStore(home.toString())
    }

    private fun example(): JsonObject =
        jsonObject(REPO_ROOT.resolve("examples/orchard-checkout.json").readText())

    @Test
    fun `update attaches an observation and keeps id and code`() {
        val store = tempStore()
        val entry = store.save(example())
        val stored = store.read(entry.code)
        val report = checkHandover(stored)
        val observation = checkObservation(stored, report, PRODUCED_BY, PRODUCED_AT)
        val updated = withKey(stored, "observations", JsonArray(listOf(observation)))

        val row = store.update(entry.code, updated)
        assertEquals(entry.code, row.code)

        val readBack = store.read(entry.code)
        assertEquals(
            asStringOrNull(stored["handoverId"]),
            asStringOrNull(readBack["handoverId"]),
        )
        assertEquals(entry.code, asStringOrNull(readBack["code"]))
        assertEquals(1, (readBack["observations"] as JsonArray).size)
        // Checking again after an attach produces the same grade:
        // observations never change how the document is read.
        assertEquals(report.grade, checkHandover(readBack).grade)
    }

    @Test
    fun `update refuses a changed handoverId`() {
        val store = tempStore()
        val entry = store.save(example())
        val stored = store.read(entry.code)
        val impostor = withKey(
            stored, "handoverId",
            JsonPrimitive("019f7e89-fc00-7000-8000-999999999999"),
        )
        assertThrows(IllegalArgumentException::class.java) {
            store.update(entry.code, impostor)
        }
    }

    @Test
    fun `update never changes the load code`() {
        val store = tempStore()
        val entry = store.save(example())
        val stored = store.read(entry.code)
        val relabelled = withKey(stored, "code", JsonPrimitive("#999"))
        store.update(entry.code, relabelled)
        assertEquals(entry.code, asStringOrNull(store.read(entry.code)["code"]))
    }

    @Test
    fun `update validates before writing`() {
        val store = tempStore()
        val entry = store.save(example())
        val stored = store.read(entry.code)
        val broken = withKey(stored, "title", JsonPrimitive(""))
        assertThrows(HandoverValidationException::class.java) {
            store.update(entry.code, broken)
        }
        // The stored document is untouched.
        assertEquals(
            asStringOrNull(stored["title"]),
            asStringOrNull(store.read(entry.code)["title"]),
        )
    }
}
