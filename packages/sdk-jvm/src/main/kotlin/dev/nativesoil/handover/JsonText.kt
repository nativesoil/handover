/**
 * JSON helpers shared by the modules.
 *
 * The writer here mirrors `JSON.stringify(value, null, 2)` byte for byte: two
 * space indentation, a space after each colon, minimal string escaping, and
 * non-ASCII characters written raw. The store depends on this so that a
 * handover saved by this SDK, the TypeScript SDK or the Python SDK is the same
 * file. Parsed number primitives keep their source text through
 * kotlinx-serialization, so a stored document round trips untouched.
 */

package dev.nativesoil.handover

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal val JSON: Json = Json

/** Parse a JSON text into an element tree, preserving object key order. */
internal fun parseJson(text: String): JsonElement = JSON.parseToJsonElement(text)

/** The string content of a JSON string primitive, else null. */
internal fun asStringOrNull(element: JsonElement?): String? {
    val primitive = element as? JsonPrimitive ?: return null
    return if (primitive.isString) primitive.content else null
}

/** A trimmed non-empty string primitive's content, else null. */
internal fun asTrimmedString(element: JsonElement?): String? {
    val text = asStringOrNull(element) ?: return null
    val trimmed = text.trim()
    return trimmed.ifEmpty { null }
}

/** True when the element is a JSON object (the JS `isRecord`). */
internal fun isRecord(element: JsonElement?): Boolean = element is JsonObject

private fun escapeJsonString(text: String, out: StringBuilder) {
    out.append('"')
    for (ch in text) {
        when (ch) {
            '"' -> out.append("\\\"")
            '\\' -> out.append("\\\\")
            '\b' -> out.append("\\b")
            '\t' -> out.append("\\t")
            '\n' -> out.append("\\n")
            '\u000C' -> out.append("\\f")
            '\r' -> out.append("\\r")
            else ->
                if (ch < ' ') {
                    out.append("\\u").append(String.format("%04x", ch.code))
                } else {
                    out.append(ch)
                }
        }
    }
    out.append('"')
}

private fun writeElement(
    element: JsonElement,
    indent: String?,
    out: StringBuilder,
) {
    val inner = if (indent == null) null else "$indent  "
    when (element) {
        is JsonNull -> out.append("null")
        is JsonPrimitive ->
            if (element.isString) escapeJsonString(element.content, out)
            else out.append(element.content)
        is JsonArray -> {
            if (element.isEmpty()) {
                out.append("[]")
                return
            }
            out.append('[')
            if (inner != null) out.append('\n')
            element.forEachIndexed { i, item ->
                if (i > 0 && inner == null) out.append(',')
                if (inner != null) out.append(inner)
                writeElement(item, inner, out)
                if (inner != null) {
                    if (i < element.size - 1) out.append(',')
                    out.append('\n')
                }
            }
            if (indent != null) out.append(indent)
            out.append(']')
        }
        is JsonObject -> {
            if (element.isEmpty()) {
                out.append("{}")
                return
            }
            out.append('{')
            if (inner != null) out.append('\n')
            val entries = element.entries.toList()
            entries.forEachIndexed { i, (key, value) ->
                if (i > 0 && inner == null) out.append(',')
                if (inner != null) out.append(inner)
                escapeJsonString(key, out)
                out.append(if (inner == null) ":" else ": ")
                writeElement(value, inner, out)
                if (inner != null) {
                    if (i < entries.size - 1) out.append(',')
                    out.append('\n')
                }
            }
            if (indent != null) out.append(indent)
            out.append('}')
        }
    }
}

/** Serialize with the exact bytes of `JSON.stringify(value, null, 2)`. */
internal fun stringifyPretty(element: JsonElement): String {
    val out = StringBuilder()
    writeElement(element, "", out)
    return out.toString()
}

/**
 * Serialize with the exact bytes of `JSON.stringify(value)`: no line breaks, no
 * space after a colon or a comma. It is what a value inside an observation
 * payload is shown as when it is not text, so a reader loses nothing to a shape
 * this renderer has no layout for.
 */
internal fun stringifyCompact(element: JsonElement): String {
    val out = StringBuilder()
    writeElement(element, null, out)
    return out.toString()
}
