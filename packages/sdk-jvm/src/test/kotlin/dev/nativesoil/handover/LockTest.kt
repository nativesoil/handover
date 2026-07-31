package dev.nativesoil.handover

import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.exists
import kotlin.io.path.readText
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir

/** The write lock, the same properties the TypeScript reference holds. */
class LockTest {

    /** Leave behind exactly what another process holding the lock leaves. */
    private fun holdFromElsewhere(locks: Path, name: String, holder: String): Path {
        val directory = locks.resolve("$name.lock")
        Files.createDirectories(directory)
        Files.writeString(directory.resolve("holder.json"), holder)
        return directory
    }

    private fun holderJson(id: String, acquiredAt: Long, pid: Long): String =
        """{"holder":"$id","acquiredAt":$acquiredAt,"host":"elsewhere","pid":$pid}"""

    @Test
    fun `runs the body and leaves nothing behind`(@TempDir home: Path) {
        val locks = home.resolve(".locks")
        assertEquals(42, withLock(locks, "store") { 42 })
        assertFalse(locks.resolve("store.lock").exists())
    }

    @Test
    fun `releases when the body throws`(@TempDir home: Path) {
        val locks = home.resolve(".locks")
        val thrown = assertThrows<IllegalStateException> {
            withLock<Unit>(locks, "store") { error("boom") }
        }
        assertEquals("boom", thrown.message)
        assertFalse(locks.resolve("store.lock").exists())
    }

    @Test
    fun `refuses rather than running the body while somebody else holds it`(
        @TempDir home: Path,
    ) {
        val locks = home.resolve(".locks")
        holdFromElsewhere(
            locks,
            "store",
            holderJson("11111111-1111-4111-8111-111111111111", System.currentTimeMillis(), 1),
        )
        var ran = false
        assertThrows<LockBusyException> {
            withLock(locks, "store", timeoutMs = 60) { ran = true }
        }
        // The point of the refusal: nothing was written, not even partly.
        assertFalse(ran)
    }

    @Test
    fun `does not decide anything from a process id`(@TempDir home: Path) {
        // Two containers on one volume both run as pid 1. A lock whose holder
        // carries *this* process's own pid must still be treated as somebody
        // else's, or a fix that leans on pids being distinct silently opens the
        // race it was meant to close.
        val locks = home.resolve(".locks")
        holdFromElsewhere(
            locks,
            "store",
            holderJson(
                "22222222-2222-4222-8222-222222222222",
                System.currentTimeMillis(),
                ProcessHandle.current().pid(),
            ),
        )
        assertThrows<LockBusyException> {
            withLock(locks, "store", timeoutMs = 60) { }
        }
    }

    @Test
    fun `takes over a lock whose holder died`(@TempDir home: Path) {
        val locks = home.resolve(".locks")
        holdFromElsewhere(
            locks,
            "store",
            holderJson(
                "33333333-3333-4333-8333-333333333333",
                System.currentTimeMillis() - 120_000,
                1,
            ),
        )
        assertEquals(
            "taken",
            withLock(locks, "store", timeoutMs = 500, staleMs = 1_000) { "taken" },
        )
    }

    @Test
    fun `takes over a lock directory whose owner died before writing a holder`(
        @TempDir home: Path,
    ) {
        // The window between the createDirectory and the holder write. Without
        // a fallback this would be a lock nothing could ever break.
        val locks = home.resolve(".locks")
        Files.createDirectories(locks.resolve("store.lock"))
        assertEquals(
            "taken",
            withLock(locks, "store", timeoutMs = 500, staleMs = 0) { "taken" },
        )
    }

    @Test
    fun `keeps different names apart`(@TempDir home: Path) {
        val locks = home.resolve(".locks")
        holdFromElsewhere(
            locks,
            "personal-a",
            holderJson("44444444-4444-4444-8444-444444444444", System.currentTimeMillis(), 1),
        )
        // A held personal store must not block a different store's writer.
        assertEquals("fine", withLock(locks, "personal-b", timeoutMs = 60) { "fine" })
    }

    @Test
    fun `writes a random holder id, never a predictable one`(@TempDir home: Path) {
        val locks = home.resolve(".locks")
        val seen = mutableSetOf<String>()
        repeat(3) {
            withLock(locks, "store") {
                val record = parseJson(
                    locks.resolve("store.lock").resolve("holder.json").readText()
                ) as JsonObject
                seen.add(asStringOrNull(record["holder"])!!)
            }
        }
        assertEquals(3, seen.size)
    }

    @Test
    fun `the store locks where every other SDK puts it`(@TempDir home: Path) {
        // The on-disk contract: one store, five SDKs, one lock directory.
        val store = HandoverStore(home.toString())
        assertEquals(home.resolve(".locks"), store.locksDir)
        assertTrue(store.locksDir.startsWith(store.root))
    }

    @Test
    fun `a create that can never work fails at once, saying why`(@TempDir home: Path) {
        // A create refused for something other than already-exists is treated
        // as contention, because on Windows that is how a name on its way out
        // is reported. That must not swallow a create that will never work: a
        // lock inside a directory that is not there is not a busy lock, and the
        // caller has to be told the difference, immediately and in the
        // platform's own words.
        val locks = home.resolve(".locks")
        val started = System.currentTimeMillis()
        val thrown = assertThrows<Exception> {
            withLock<Unit>(locks, "missing/child") { }
        }
        assertFalse(
            thrown is LockBusyException,
            "reported as a busy lock rather than as itself"
        )
        assertTrue(
            thrown is java.io.IOException,
            "the platform's own reason did not survive: $thrown"
        )
        // Fast, not after the retry budget and not after the acquire timeout.
        assertTrue(System.currentTimeMillis() - started < 500)
    }
}
