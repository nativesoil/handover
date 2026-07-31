/**
 * Handover identity: the `handoverId`.
 *
 * Every stored handover carries one globally unique id, a UUIDv7 (RFC 9562).
 * It is assigned by the writer at store time when the document does not
 * already carry one; the extraction recipe never asks a model to invent an
 * id, because an id a model makes up is an id two documents can share.
 *
 * The id is opaque. It is never derived from the document's content, never
 * reused, and carries no meaning beyond identity: the timestamp embedded in a
 * UUIDv7 is an implementation detail of how uniqueness is generated, not a
 * fact a reader may lean on. A byte-for-byte copy of a handover keeps its
 * handoverId; a new capture, even of the same project a minute later, gets a
 * new one; migration never changes it.
 *
 * The local `#NNN` code is a different thing entirely: a short human handle
 * assigned by one store, for typing. Two stores can both hold a `#001`
 * without any identity collision, because identity lives here.
 *
 * Mirrors `packages/sdk-ts/src/identity.ts`. The UUIDv7 layout is written
 * out by hand because `java.util.UUID` has no version 7 factory on JVM 17.
 */
@file:JvmName("Identity")

package dev.nativesoil.handover

import java.security.SecureRandom
import java.time.Instant

/**
 * The shape of a `handoverId`: canonical lowercase UUID text, 8-4-4-4-12 hex.
 *
 * The pattern accepts any UUID version on purpose. The official writers emit
 * UUIDv7, but a reader treats the id as opaque, so it does not police which
 * version another writer chose.
 */
@JvmField
val HANDOVER_ID_PATTERN: Regex =
    Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

/** Does this value have the shape of a `handoverId`? */
fun isHandoverId(value: Any?): Boolean =
    value is String && HANDOVER_ID_PATTERN.matches(value)

private val RANDOM = SecureRandom()

/**
 * Generate a UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then the
 * version and variant bits, then 74 random bits.
 *
 * `now` exists for tests; production callers let it default. The randomness
 * comes from the platform CSPRNG, and nothing about the result is derived
 * from any document.
 */
@JvmOverloads
fun uuidv7(now: Instant = Instant.now()): String {
    val bytes = ByteArray(16)
    RANDOM.nextBytes(bytes)
    var ms = now.toEpochMilli()
    for (i in 5 downTo 0) {
        bytes[i] = (ms and 0xFF).toByte()
        ms = ms shr 8
    }
    bytes[6] = ((bytes[6].toInt() and 0x0F) or 0x70).toByte()
    bytes[8] = ((bytes[8].toInt() and 0x3F) or 0x80).toByte()

    val hex = buildString(32) {
        for (b in bytes) append(String.format("%02x", b.toInt() and 0xFF))
    }
    return listOf(
        hex.substring(0, 8),
        hex.substring(8, 12),
        hex.substring(12, 16),
        hex.substring(16, 20),
        hex.substring(20, 32),
    ).joinToString("-")
}
