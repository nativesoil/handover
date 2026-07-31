/**
 * The canonical recipe texts in `recipes/` at the repo root are the single
 * source of truth. The SDK packages them as resources generated from those
 * files at build time, and this test holds the packaged bytes to byte
 * identity with the repo files, so the jar can never ship a paraphrase.
 */
package dev.nativesoil.handover

import kotlin.io.path.readText
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class RecipeResourcesTest {

    @Test
    fun `the packaged recipe is byte identical to the canonical file`() {
        assertEquals(
            REPO_ROOT.resolve("recipes/handover-recipe-v1.txt").readText(),
            RECIPE_TEXT,
        )
    }

    @Test
    fun `the packaged rescue prompt is byte identical to the canonical file`() {
        assertEquals(
            REPO_ROOT.resolve("recipes/rescue-recipe-v1.txt").readText(),
            RESCUE_PROMPT + "\n",
        )
    }

    @Test
    fun `the recipe version is a semver string`() {
        assertTrue(Regex("^\\d+\\.\\d+\\.\\d+$").matches(RECIPE_VERSION))
    }

    @Test
    fun `the recipe carries the rules and guidance for all 17 sections`() {
        val lines = RECIPE_TEXT.split("\n")
        assertEquals(5, lines.count { it.startsWith("RULE ") })
        for (key in SECTION_KEYS) {
            assertTrue(
                lines.any { it.startsWith("$key: ") },
                "no guidance line for $key",
            )
        }
    }

    @Test
    fun `the rescue prompt asks for the shape normalization accepts`() {
        assertTrue(RESCUE_PROMPT.contains("extractionSections"))
        assertFalse(RESCUE_PROMPT.endsWith("\n"))
    }
}
