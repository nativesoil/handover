/**
 * The extraction recipe: the words that make a model produce a good handover.
 *
 * The canonical text lives in `recipes/handover-recipe-v1.txt` at the repo
 * root and is BYTE-NORMATIVE: a paraphrase is a bug. This SDK does not embed a
 * copy by hand; the file is packaged into the jar as a resource at build time,
 * generated from the canonical file, and a test holds the resource bytes to
 * byte identity with the repo file. The TypeScript and Python SDKs embed the
 * same text, and the conformance suite holds every copy to the same bytes.
 */
@file:JvmName("Recipe")

package dev.nativesoil.handover

/**
 * The version of the recipe text, independent of the format version.
 *
 * Nobody in this repository stamps it into a document. A writer is handed a
 * finished document and is in no position to attest which recipe produced it,
 * so `source.recipeVersion` is reported by the only party that observed the
 * recipe: the model. Both recipe texts print this version on their first line
 * and ask the model to copy it back. Improving the recipe bumps this version
 * and never moves the format version.
 */
const val RECIPE_VERSION: String = "1.4.0"

private object ResourceAnchor

internal fun loadRecipeResource(name: String): String {
    val stream = ResourceAnchor.javaClass.getResourceAsStream("recipes/$name")
        ?: throw IllegalStateException(
            "the packaged recipe resource $name is missing; the SDK was not built from the repo"
        )
    return stream.use { String(it.readAllBytes(), Charsets.UTF_8) }
}

/**
 * The full extraction recipe text, exactly as a user pastes it into a model.
 * Byte-identical to `recipes/handover-recipe-v1.txt`.
 */
@JvmField
val RECIPE_TEXT: String = loadRecipeResource("handover-recipe-v1.txt")

/** The recipe text, for callers that prefer a method to a field. */
fun recipeText(): String = RECIPE_TEXT
