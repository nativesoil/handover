/**
 * The SDK from plain Java: the public surface has to be pleasant without
 * Kotlin. Static entry points, no coroutines, no Kotlin-only types beyond
 * kotlinx JsonObject, and overloads where Kotlin uses default arguments.
 */
package dev.nativesoil.handover;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import kotlinx.serialization.json.Json;
import kotlinx.serialization.json.JsonObject;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class JavaApiTest {

    @TempDir
    Path tmp;

    private static JsonObject parse(String text) {
        return (JsonObject) Json.Default.parseToJsonElement(text);
    }

    @Test
    void normalizesValidatesStoresAndRendersFromPlainJava() {
        JsonObject doc = (JsonObject) Normalize.normalizeHandover(parse(
            "{\"projectId\":\"java-test\",\"title\":\"From Java\","
                + "\"createdAt\":\"2026-07-22T10:00:00Z\","
                + "\"sections\":{\"executiveSummary\":\"A save made from Java.\"}}"));

        ValidationResult before = Validate.validateHandover(doc);
        assertFalse(before.valid);
        assertEquals("/handoverId", before.issues.get(0).path);

        HandoverStore store = new HandoverStore(tmp.resolve("soil").toString());
        StoreEntry entry = store.save(doc);
        assertEquals("#001", entry.code);
        assertEquals(1, entry.sectionsWithContent);

        JsonObject read = store.read("last");
        assertTrue(Validate.validateHandover(read).valid);

        String card = Render.renderSaved(read, entry.code);
        assertTrue(card.contains("soil load #001"));
        String prompt = Restore.buildRestorePrompt(read);
        assertTrue(prompt.contains("java-test"));
    }

    @Test
    void refusesSecretMaterialFromPlainJava() {
        JsonObject doc = (JsonObject) Normalize.normalizeHandover(parse(
            "{\"handoverId\":\"019f7e89-fc00-7000-8000-000000000000\","
                + "\"projectId\":\"java-test\",\"title\":\"From Java\","
                + "\"createdAt\":\"2026-07-22T10:00:00Z\","
                + "\"sections\":{\"architecture\":\"the key is sk-abc123def456\"}}"));
        ValidationResult result = Validate.validateHandover(doc);
        assertFalse(result.valid);
        assertEquals(ValidationIssueKind.SAFETY, result.issues.get(0).kind);
        assertFalse(result.issues.get(0).message.contains("sk-abc123def456"));
    }

    @Test
    void exposesTheVocabularyAndTheRecipeTexts() {
        assertEquals(17, Sections.SECTION_KEYS.size());
        assertEquals(11, Sections.PROVENANCE_LABELS.size());
        assertEquals(4, Sections.SECTION_STATUSES.size());
        assertTrue(Sections.SECTION_STATUSES.contains("not_applicable"));
        assertTrue(Identity.isHandoverId(Identity.uuidv7()));
        assertTrue(Recipe.RECIPE_TEXT.startsWith("SOIL HANDOVER EXTRACTION"));
        assertTrue(Rescue.RESCUE_PROMPT.contains("extractionSections"));
        assertEquals("1.4.0", Recipe.RECIPE_VERSION);
        // Both recipe texts print the version the model is asked to report.
        assertTrue(Recipe.RECIPE_TEXT.split("\n")[0].contains("recipe v" + Recipe.RECIPE_VERSION));
        assertTrue(Rescue.RESCUE_PROMPT.split("\n")[0].contains("recipe v" + Recipe.RECIPE_VERSION));
    }
}
