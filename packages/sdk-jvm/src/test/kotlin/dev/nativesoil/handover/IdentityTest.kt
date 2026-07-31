package dev.nativesoil.handover

import java.time.Instant
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class IdentityTest {

    private val v7 =
        Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    @Test
    fun `emits a canonical lowercase uuidv7`() {
        assertTrue(v7.matches(uuidv7()))
    }

    @Test
    fun `two ids never collide`() {
        assertFalse(uuidv7() == uuidv7())
    }

    @Test
    fun `encodes the unix milliseconds of now in the first 48 bits`() {
        val id = uuidv7(Instant.parse("2026-07-22T10:00:00Z"))
        val ms = id.replace("-", "").substring(0, 12).toLong(16)
        assertEquals(Instant.parse("2026-07-22T10:00:00Z").toEpochMilli(), ms)
    }

    @Test
    fun `recognises the shape of a handover id of any version`() {
        assertTrue(isHandoverId(A_VALID_ID))
        assertTrue(isHandoverId("00000000-0000-4000-8000-000000000000"))
        assertFalse(isHandoverId("handover-42"))
        assertFalse(isHandoverId("019F7E89-FC00-7000-8000-000000000000"))
        assertFalse(isHandoverId(42))
        assertFalse(isHandoverId(null))
    }
}
