package dev.nativesoil.handover

import java.nio.file.Path
import kotlin.io.path.createDirectories
import kotlin.io.path.writeBytes
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir

/**
 * The pre-schema ingestion boundary.
 *
 * Parity with the other four surfaces is asserted by the shared fixture corpus
 * in `conformance/fixtures/boundary`; these are the cases that corpus does not
 * carry, plus the store path that has to go through the same door.
 */
class IngestTest {

    @TempDir
    lateinit var tmp: Path

    /** The code and location of a refusal, or `"accepted"`. */
    private fun verdict(data: ByteArray): String {
        val issue = ingestDocument(data).issue ?: return "accepted"
        return "${issue.code} ${issue.path}"
    }

    private fun nested(levels: Int): ByteArray =
        ("{\"n\":".repeat(levels - 1) + "{}" + "}".repeat(levels - 1)).toByteArray()

    private fun padded(total: Int): ByteArray =
        ("{\"pad\":\"" + "x".repeat(total - 10) + "\"}").toByteArray()

    @Test
    fun `refuses a byte order mark and names the encoding`() {
        val issue = ingestDocument(
            byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + "{}".toByteArray(),
        ).issue
        assertEquals(IngestErrorCode.ENCODING_BYTE_ORDER_MARK, issue?.code)
        assertTrue(issue!!.message.contains("UTF-8"))
    }

    @Test
    fun `names a UTF-32LE mark rather than the UTF-16LE mark it starts with`() {
        val issue = ingestDocument(
            byteArrayOf(0xFF.toByte(), 0xFE.toByte(), 0x00, 0x00),
        ).issue
        assertTrue(issue!!.message.contains("UTF-32LE"))
    }

    @Test
    fun `refuses a leading BOM that arrived as text`() {
        assertEquals(
            IngestErrorCode.ENCODING_BYTE_ORDER_MARK,
            ingestText("﻿{}").issue?.code,
        )
    }

    @Test
    fun `refuses malformed UTF-8 instead of substituting U+FFFD`() {
        // `String(bytes, UTF_8)` would hand back a document with a replacement
        // character in it and call that a read.
        val data = "{\"t\":\"caf".toByteArray() + byteArrayOf(0xE9.toByte()) + "\"}".toByteArray()
        assertEquals("encoding.invalid_utf8 ", verdict(data))
    }

    @Test
    fun `accepts valid multibyte UTF-8`() {
        assertEquals("accepted", verdict("{\"t\":\"café · 引き継ぎ\"}".toByteArray()))
    }

    @Test
    fun `refuses a duplicate member and points at it`() {
        assertEquals(
            "structure.duplicate_member /a",
            verdict("{\"a\":1,\"a\":2}".toByteArray()),
        )
        assertEquals(
            "structure.duplicate_member /o/0/d/n",
            verdict("{\"o\":[{\"d\":{\"n\":1,\"n\":2}}]}".toByteArray()),
        )
        assertEquals(
            "structure.duplicate_member /a~1b~0c",
            verdict("{\"a/b~c\":1,\"a/b~c\":2}".toByteArray()),
        )
    }

    @Test
    fun `accepts the same name in two different objects`() {
        assertEquals(
            "accepted",
            verdict("{\"x\":{\"status\":1},\"y\":{\"status\":2}}".toByteArray()),
        )
    }

    @Test
    fun `never echoes the repeated name`() {
        val issue = ingestDocument("{\"secretish\":1,\"secretish\":2}".toByteArray()).issue
        assertFalse(issue!!.message.contains("secretish"))
    }

    @Test
    fun `reports syntax before duplicates on malformed input`() {
        assertEquals("syntax.invalid_json ", verdict("{\"a\":1,\"a\":2".toByteArray()))
    }

    @Test
    fun `refuses NaN, which this runtime otherwise reads as a primitive`() {
        assertEquals("syntax.invalid_json ", verdict("{\"a\":NaN}".toByteArray()))
    }

    @Test
    fun `accepts exactly the depth ceiling and refuses one over`() {
        assertEquals("accepted", verdict(nested(IngestLimits.MAX_DEPTH)))
        val issue = ingestDocument(nested(IngestLimits.MAX_DEPTH + 1)).issue
        assertEquals(IngestErrorCode.STRUCTURE_DEPTH_EXCEEDED, issue?.code)
        assertTrue(issue!!.message.contains("33"))
    }

    @Test
    fun `refuses a document deep enough to break a recursive walker`() {
        // 20000 levels. The parser and the safety scan both recurse; the
        // boundary must answer with an issue rather than a StackOverflowError.
        assertEquals(
            IngestErrorCode.STRUCTURE_DEPTH_EXCEEDED,
            ingestDocument(nested(20000)).issue?.code,
        )
    }

    @Test
    fun `does not count braces inside strings`() {
        assertEquals("accepted", verdict(("{\"a\":\"" + "{".repeat(200) + "\"}").toByteArray()))
    }

    @Test
    fun `accepts exactly the size ceiling and refuses one byte over`() {
        assertEquals("accepted", verdict(padded(IngestLimits.MAX_BYTES)))
        assertEquals("document.too_large ", verdict(padded(IngestLimits.MAX_BYTES + 1)))
    }

    @Test
    fun `the store reads through the boundary`() {
        val store = HandoverStore(tmp.resolve("soil").toString())
        store.init()
        store.handoversDir.createDirectories()
        store.handoversDir.resolve("001.json").writeBytes(
            byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) +
                "{\"soilHandover\":\"1.0\"}".toByteArray(),
        )
        val thrown = assertThrows<IngestException> { store.read("#001") }
        assertEquals(IngestErrorCode.ENCODING_BYTE_ORDER_MARK, thrown.issue.code)
    }
}
