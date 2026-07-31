/**
 * The pre-schema ingestion boundary.
 *
 * Everything else in this module receives a value. This file is the one place
 * that receives BYTES, and it is the only place where the rules that cannot
 * be seen from a constructed value are enforced:
 *
 *  1. size        the byte count is bounded before anything decodes, and it
 *                 is unrecoverable once a value exists
 *  2. encoding    the bytes must be UTF-8, with no byte order mark, and
 *                 nothing is ever repaired or transcoded
 *  3. duplicates  a member name repeated inside one object refuses the
 *                 document, before any object is built from it
 *  4. depth       nesting is bounded before anything walks the value, so a
 *                 deep document is refused rather than crashing the walker
 *  5. numbers     a number is judged from its token text, because a parser
 *                 rounds an oversized integer in silence
 *
 * Why a boundary rather than the same checks scattered about. A JSON parser is
 * lossy on exactly these points: by the time you hold a `JsonObject`, the
 * second `"a"` has overwritten the first, the byte order mark has been
 * stripped or turned into a stray character, the recursion that would have
 * blown the stack has already run, and the length of what arrived is gone —
 * whitespace, escapes and member order are not recoverable from a value. The
 * safety scan and the validator both walk a constructed value, so neither can
 * see any of it.
 *
 * The security argument for the duplicate rule is the decisive one. With
 * last-wins, the fail-closed secret scan sees one value for `/sections/x` and
 * a consumer parsing the same bytes with a different parser sees another. The
 * document that gets scanned is then not the document that gets read.
 *
 * The depth ceiling is derived, not observed. The deepest structure a handover
 * needs without custom observation data is 4 levels; the deepest fixture in
 * this repository is 6; the lowest hard parser ceiling among the five official
 * implementations is 64. 32 sits at half of that.
 *
 * Mechanism note for this surface: kotlinx-serialization-json is the only
 * runtime dependency and it offers no duplicate-member hook. Its `JsonBuilder`
 * at the pinned version 1.9.0 exposes `allowTrailingComma`, `allowComments`,
 * `allowSpecialFloatingPointValues` and `allowStructuredMapKeys` and nothing
 * about duplicate keys, and `parseToJsonElement` returns a map in which the
 * repetition is already gone. So this surface uses a scanner. The scanner does
 * not build a value and is not a second JSON parser: it walks tokens to answer
 * "how deep" and "was a member name repeated", and `parseToJsonElement`
 * remains the only thing that constructs a value or judges syntax. No
 * dependency is added.
 *
 * The order of the checks is normative and identical on every surface: size,
 * encoding, depth, syntax, duplicate member names, numeric domain. The first
 * five are `spec/ingestion.md`; the sixth is `spec/value-domain.md`.
 */

package dev.nativesoil.handover

import kotlinx.serialization.json.JsonElement
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.nio.ByteBuffer

/** The bounds this boundary enforces. */
object IngestLimits {
    /** Max nesting of containers. The root container counts as level 1. */
    const val MAX_DEPTH: Int = 32

    /** Max bytes in one serialized handover. */
    const val MAX_BYTES: Int = 1048576

    /**
     * The largest integer a handover may hold, and its negative counterpart:
     * the ends of the safe-integer range, 2^53 - 1. Beyond them a double can
     * no longer tell two neighbouring integers apart, so a document carrying
     * such a value means one thing to a reader with 64-bit floats and another
     * to a reader with arbitrary-precision integers. See
     * `spec/value-domain.md`.
     */
    const val MAX_INTEGER: Long = 9007199254740991L
    const val MIN_INTEGER: Long = -9007199254740991L
}

/**
 * The decimal spelling of [IngestLimits.MAX_INTEGER].
 *
 * The range check compares digit strings rather than converting. A `Long`
 * would hold this one fine, and a forty-digit token would overflow it
 * silently; equal-length decimal strings compare correctly under ordinary
 * lexicographic order, so digit count plus one comparison decides the question
 * exactly, with no big-integer type anywhere and the same arithmetic on all
 * five surfaces.
 */
private const val MAX_INTEGER_DIGITS = "9007199254740991"

/** A JSON number token in the integer form: no fraction part, no exponent. */
private val INTEGER_TOKEN = Regex("^-?(?:0|[1-9][0-9]*)$")

/**
 * Judge one JSON number token against the integer domain, from its TEXT.
 * `null` means the token is inside the domain.
 *
 * The two refusals are separate codes because they are separate mistakes: a
 * fraction or an exponent is a producer writing a value the format does not
 * carry, while a twenty-digit integer is a producer writing a value no reader
 * can carry back. 1e2 is 100 and is refused all the same, because deciding
 * integrality of an arbitrary decimal needs exact decimal arithmetic the five
 * runtimes do not share.
 */
private fun judgeNumberToken(token: String): String? {
    if (!INTEGER_TOKEN.matches(token)) return IngestErrorCode.NUMBER_NOT_AN_INTEGER
    val digits = token.removePrefix("-")
    if (digits.length > MAX_INTEGER_DIGITS.length) return IngestErrorCode.NUMBER_OUT_OF_RANGE
    if (digits.length == MAX_INTEGER_DIGITS.length && digits > MAX_INTEGER_DIGITS) {
        return IngestErrorCode.NUMBER_OUT_OF_RANGE
    }
    return null
}

/** The message for one numeric refusal. Names a class, never a value. */
private fun numberMessage(code: String): String =
    if (code == IngestErrorCode.NUMBER_NOT_AN_INTEGER) {
        "a number in a handover must be written as an integer, with no fraction part " +
            "and no exponent"
    } else {
        "a number in a handover must lie between ${IngestLimits.MIN_INTEGER} and " +
            "${IngestLimits.MAX_INTEGER}"
    }

/** The stable error codes. Identical strings on every surface. */
object IngestErrorCode {
    const val DOCUMENT_TOO_LARGE = "document.too_large"
    const val ENCODING_BYTE_ORDER_MARK = "encoding.byte_order_mark"
    const val ENCODING_UNSUPPORTED = "encoding.unsupported_encoding"
    const val ENCODING_INVALID_UTF8 = "encoding.invalid_utf8"
    const val STRUCTURE_DEPTH_EXCEEDED = "structure.depth_exceeded"
    const val SYNTAX_INVALID_JSON = "syntax.invalid_json"
    const val STRUCTURE_DUPLICATE_MEMBER = "structure.duplicate_member"
    const val NUMBER_NOT_AN_INTEGER = "number.not_an_integer"
    const val NUMBER_OUT_OF_RANGE = "number.out_of_range"

    /** Every code this boundary can report. */
    val ALL: List<String> = listOf(
        DOCUMENT_TOO_LARGE,
        ENCODING_BYTE_ORDER_MARK,
        ENCODING_UNSUPPORTED,
        ENCODING_INVALID_UTF8,
        STRUCTURE_DEPTH_EXCEEDED,
        SYNTAX_INVALID_JSON,
        STRUCTURE_DUPLICATE_MEMBER,
        NUMBER_NOT_AN_INTEGER,
        NUMBER_OUT_OF_RANGE,
    )
}

/** One refusal. Carries a class and a location, never document content. */
data class IngestIssue(
    /** The stable code, e.g. `structure.duplicate_member`. */
    val code: String,
    /** JSON Pointer to the offending place, or `""` for the whole document. */
    val path: String,
    /** A sentence a person can act on. Never echoes a value. */
    val message: String,
)

/** What the boundary returns: one controlled canonical parse result. */
data class IngestResult(val value: JsonElement?, val issue: IngestIssue?) {
    val ok: Boolean get() = issue == null
}

/** Thrown by the `orThrow` entry points. */
class IngestException(val issue: IngestIssue) : RuntimeException(issue.message)

private data class ByteOrderMark(val encoding: String, val bytes: ByteArray)

// The four-byte marks come first: a UTF-32LE mark begins with the two bytes of
// a UTF-16LE mark, so testing the short one first would misname it.
private val BYTE_ORDER_MARKS = listOf(
    ByteOrderMark("UTF-32LE", byteArrayOf(0xFF.toByte(), 0xFE.toByte(), 0x00, 0x00)),
    ByteOrderMark("UTF-32BE", byteArrayOf(0x00, 0x00, 0xFE.toByte(), 0xFF.toByte())),
    ByteOrderMark("UTF-8", byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())),
    ByteOrderMark("UTF-16LE", byteArrayOf(0xFF.toByte(), 0xFE.toByte())),
    ByteOrderMark("UTF-16BE", byteArrayOf(0xFE.toByte(), 0xFF.toByte())),
)

private fun ByteArray.startsWith(prefix: ByteArray): Boolean {
    if (size < prefix.size) return false
    for (i in prefix.indices) if (this[i] != prefix[i]) return false
    return true
}

/**
 * The encoding the first four bytes imply, following the detection rule in RFC
 * 4627 section 3: the first token of a JSON text is always ASCII, so the
 * position of the NUL padding names the encoding without decoding anything.
 * `null` means the bytes are consistent with UTF-8.
 */
private fun sniffUnitWidth(data: ByteArray): String? {
    if (data.size < 4) return null
    val a = data[0].toInt() and 0xFF
    val b = data[1].toInt() and 0xFF
    val c = data[2].toInt() and 0xFF
    val d = data[3].toInt() and 0xFF
    return when {
        a == 0 && b == 0 && c == 0 && d != 0 -> "UTF-32BE"
        a != 0 && b == 0 && c == 0 && d == 0 -> "UTF-32LE"
        a == 0 && b != 0 && c == 0 && d != 0 -> "UTF-16BE"
        a != 0 && b == 0 && c != 0 && d == 0 -> "UTF-16LE"
        else -> null
    }
}

/**
 * Decode strictly. `String(bytes, UTF_8)` replaces an undecodable byte with
 * U+FFFD, which is a silent repair: the document that gets scanned is then no
 * longer the document that arrived. `REPORT` is the whole point of this call.
 */
private fun decodeStrictUtf8(data: ByteArray): String? = try {
    StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(data))
        .toString()
} catch (_: CharacterCodingException) {
    null
}

/** RFC 6901: `~` becomes `~0` and `/` becomes `~1`. */
private fun escapePointerSegment(segment: String): String =
    segment.replace("~", "~0").replace("/", "~1")

private class Frame(val isObject: Boolean) {
    val names = HashSet<String>()
    var expectName = isObject
    var cursor: String? = if (isObject) null else "0"
    var index = 0
}

private class StringToken(val content: String, val end: Int)

/**
 * Read a JSON string token whose opening quote sits at [start]. Returns null
 * when the token does not terminate; the parser is the authority on syntax.
 *
 * A note on where the text-length unit did NOT land. This looked like the
 * place for it, and it is not: a length bound belongs to a named field, and a
 * string token here is just a string. The unit is Unicode code points and it
 * is enforced in the validator, where the field is known. See
 * `spec/value-domain.md`.
 */
private fun readStringToken(text: String, start: Int): StringToken? {
    val out = StringBuilder()
    var i = start + 1
    while (i < text.length) {
        val ch = text[i]
        if (ch == '"') return StringToken(out.toString(), i + 1)
        if (ch != '\\') {
            out.append(ch)
            i += 1
            continue
        }
        if (i + 1 >= text.length) return null
        when (val escape = text[i + 1]) {
            'u' -> {
                if (i + 6 > text.length) return null
                val code = text.substring(i + 2, i + 6).toIntOrNull(16) ?: return null
                out.append(code.toChar())
                i += 6
            }
            'b' -> { out.append('\b'); i += 2 }
            'f' -> { out.append(''); i += 2 }
            'n' -> { out.append('\n'); i += 2 }
            'r' -> { out.append('\r'); i += 2 }
            't' -> { out.append('\t'); i += 2 }
            else -> { out.append(escape); i += 2 }
        }
    }
    return null
}

/**
 * Walk the token stream without building a value and without recursing.
 *
 * [checkNames] is what separates the two passes. The depth pass runs before the
 * parser, on text that may be malformed, so it reports nothing but depth. The
 * duplicate pass runs after the parser has already agreed the text is well
 * formed, so its frame tracking cannot be thrown off by malformed input.
 *
 * [checkNumbers] is the third pass. It runs last, after the parser has agreed
 * the text is well formed, so every bare run it meets is either one of the
 * three JSON literals or a valid JSON number, and it can judge that number
 * from its literal text before any conversion.
 */
/**
 * The JSON number grammar, plus the three bare words a JSON document may hold.
 *
 * kotlinx-serialization's `parseToJsonElement` reads an unquoted run such as
 * `NaN` as a primitive rather than refusing it, so on this surface the parser
 * is NOT the whole authority on what a bare token may be. Executed and
 * observed: the `syntax: NaN is not a JSON value` fixture was accepted before
 * this check existed, while the other four surfaces refused it. This restores
 * one shared answer to "what is a well-formed JSON document" and decides
 * nothing about the numeric DOMAIN, which is the other half of this work
 * package.
 */
private val JSON_NUMBER = Regex("^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][-+]?[0-9]+)?$")

private fun isJsonLiteral(run: String): Boolean =
    run == "true" || run == "false" || run == "null" || JSON_NUMBER.matches(run)

private fun scan(
    text: String,
    checkNames: Boolean,
    checkLiterals: Boolean = false,
    checkNumbers: Boolean = false,
): IngestIssue? {
    val frames = ArrayList<Frame>()
    var i = 0
    while (i < text.length) {
        val ch = text[i]
        when {
            ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' -> i += 1

            ch == '{' || ch == '[' -> {
                if (frames.size + 1 > IngestLimits.MAX_DEPTH) {
                    return IngestIssue(
                        IngestErrorCode.STRUCTURE_DEPTH_EXCEEDED,
                        "",
                        "a serialized handover must nest at most ${IngestLimits.MAX_DEPTH} " +
                            "levels, found ${frames.size + 1}",
                    )
                }
                frames.add(Frame(ch == '{'))
                i += 1
            }

            ch == '}' || ch == ']' -> {
                if (frames.isNotEmpty()) frames.removeAt(frames.size - 1)
                i += 1
            }

            ch == ',' -> {
                val top = frames.lastOrNull()
                if (top != null) {
                    if (top.isObject) {
                        top.expectName = true
                        top.cursor = null
                    } else {
                        top.index += 1
                        top.cursor = top.index.toString()
                    }
                }
                i += 1
            }

            ch == ':' -> i += 1

            ch == '"' -> {
                val token = readStringToken(text, i) ?: return null
                val top = frames.lastOrNull()
                if (top != null && top.isObject && top.expectName) {
                    top.expectName = false
                    top.cursor = token.content
                    if (checkNames && !top.names.add(token.content)) {
                        val segments = frames.dropLast(1).mapNotNull { it.cursor } + token.content
                        return IngestIssue(
                            IngestErrorCode.STRUCTURE_DUPLICATE_MEMBER,
                            "/" + segments.joinToString("/") { escapePointerSegment(it) },
                            "a serialized handover must not repeat a member name inside one " +
                                "object: with a repeated name, two readers of the same bytes " +
                                "can hold different documents",
                        )
                    }
                }
                i = token.end
            }

            else -> {
                // A number, `true`, `false` or `null`, consumed as one run of
                // literal characters.
                //
                // `run` is the literal token text, before any conversion,
                // which is exactly what the numeric domain check needs.
                var j = i
                while (j < text.length && text[j] !in ",:{}[]\" \t\n\r") j += 1
                val run = text.substring(i, if (j > i) j else i + 1)
                if (checkLiterals && !isJsonLiteral(run)) {
                    return IngestIssue(
                        IngestErrorCode.SYNTAX_INVALID_JSON,
                        "",
                        "the input is not a single well-formed JSON document",
                    )
                }
                if (checkNumbers && run != "true" && run != "false" && run != "null") {
                    val code = judgeNumberToken(run)
                    if (code != null) {
                        val segments = frames.mapNotNull { it.cursor }
                        return IngestIssue(
                            code,
                            if (segments.isEmpty()) {
                                ""
                            } else {
                                "/" + segments.joinToString("/") { escapePointerSegment(it) }
                            },
                            numberMessage(code),
                        )
                    }
                }
                i = if (j > i) j else i + 1
            }
        }
    }
    return null
}

/**
 * Ingest one serialized handover from bytes. This is the boundary: the value it
 * returns has been checked for encoding, size, depth and duplicate member
 * names, in that order, and nothing was repaired on the way.
 */
fun ingestDocument(data: ByteArray): IngestResult {
    if (data.size > IngestLimits.MAX_BYTES) {
        return refuse(
            IngestErrorCode.DOCUMENT_TOO_LARGE,
            "a serialized handover must be at most ${IngestLimits.MAX_BYTES} bytes, " +
                "got ${data.size}",
        )
    }

    for (mark in BYTE_ORDER_MARKS) {
        if (data.startsWith(mark.bytes)) {
            return refuse(
                IngestErrorCode.ENCODING_BYTE_ORDER_MARK,
                "a serialized handover must not begin with a byte order mark; these bytes " +
                    "open with a ${mark.encoding} mark. A producer must not write one, and a " +
                    "reader must not strip one.",
            )
        }
    }

    val sniffed = sniffUnitWidth(data)
    if (sniffed != null) {
        return refuse(
            IngestErrorCode.ENCODING_UNSUPPORTED,
            "a serialized handover must be UTF-8; these bytes are $sniffed. Other encodings " +
                "are invalid and are never converted.",
        )
    }

    val text = decodeStrictUtf8(data)
        ?: return refuse(
            IngestErrorCode.ENCODING_INVALID_UTF8,
            "a serialized handover must be valid UTF-8; these bytes are not, and malformed " +
                "UTF-8 is refused rather than repaired",
        )

    return ingestText(text)
}

/**
 * Ingest a serialized handover that has already been decoded to text, e.g. a
 * JSON block lifted out of a model's reply. The encoding rules that survive
 * decoding still apply: a leading U+FEFF is a byte order mark whether it
 * arrived as three bytes or as one character.
 */
fun ingestText(text: String): IngestResult {
    val size = text.toByteArray(StandardCharsets.UTF_8).size
    if (size > IngestLimits.MAX_BYTES) {
        return refuse(
            IngestErrorCode.DOCUMENT_TOO_LARGE,
            "a serialized handover must be at most ${IngestLimits.MAX_BYTES} bytes, got $size",
        )
    }
    if (text.startsWith("\uFEFF")) {
        return refuse(
            IngestErrorCode.ENCODING_BYTE_ORDER_MARK,
            "a serialized handover must not begin with a byte order mark; this text opens " +
                "with a UTF-8 mark. A producer must not write one, and a reader must not " +
                "strip one.",
        )
    }

    // Depth first, and before anything recurses: the parser recurses, the
    // safety scan recurses, the validator recurses. A document that would break
    // them is refused here with a structured error instead.
    scan(text, checkNames = false)?.let { return IngestResult(null, it) }

    // kotlinx-serialization accepts bare tokens outside the JSON grammar, so
    // the literal check runs here rather than being left to the parser.
    scan(text, checkNames = false, checkLiterals = true)?.let { return IngestResult(null, it) }

    val value = try {
        parseJson(text)
    } catch (_: Exception) {
        return refuse(
            IngestErrorCode.SYNTAX_INVALID_JSON,
            "the input is not a single well-formed JSON document",
        )
    }

    // Duplicates next, on text the parser has already agreed is well formed.
    scan(text, checkNames = true)?.let { return IngestResult(null, it) }

    // The numeric domain last. It needs a well-formed document to be talking
    // about numbers at all, and it needs the token TEXT, which the parsed
    // element no longer carries in a form the five surfaces agree on.
    scan(text, checkNames = false, checkNumbers = true)?.let {
        return IngestResult(null, it)
    }

    return IngestResult(value, null)
}

/** Ingest bytes, or throw [IngestException]. */
fun ingestDocumentOrThrow(data: ByteArray): JsonElement {
    val result = ingestDocument(data)
    result.issue?.let { throw IngestException(it) }
    return result.value!!
}

/** Ingest decoded text, or throw [IngestException]. */
fun ingestTextOrThrow(text: String): JsonElement {
    val result = ingestText(text)
    result.issue?.let { throw IngestException(it) }
    return result.value!!
}

private fun refuse(code: String, message: String): IngestResult =
    IngestResult(null, IngestIssue(code, "", message))
