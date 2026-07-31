/**
 * Four saving processes, one store.
 *
 * `HandoverStore.save` was an unlocked read-modify-write, so two processes
 * against one `~/.soil` both read the same `nextCode`, both wrote a document at
 * that code, and the second index write erased the first one's row. Both
 * callers were told "saved".
 *
 * Measured on the unlocked store, four processes saving fifteen times each:
 * 58, 59 and 60 saves acknowledged over three runs and 12, 6 and 14 documents
 * on disk, so 46, 53 and 46 acknowledgements for documents that no longer
 * existed. One of those runs also left a half-written temporary file behind,
 * and one save died outright when the index it was reading was replaced under
 * it. The store now takes the lock in `Lock.kt`, and this file is what says so.
 *
 * The checks are the ones the TypeScript CLI's concurrency test makes, because
 * it is the same defect:
 *
 *   1. every save the store acknowledged is on disk afterwards
 *   2. no two acknowledgements carry the same load code
 *   3. every acknowledged code still holds the document that receipt named
 *   4. no half-written temporary file survived the race
 *
 * Nothing here identifies a writer by its process id. Markers are random ids
 * (see `ConcurrentSaveWorker.kt`): two containers on one volume both run as pid
 * 1, and a test that told writers apart by pid would agree with itself for the
 * wrong reason.
 *
 * Threads would prove nothing here: one process is already safe, and what is
 * being reproduced is what happens between two. So the workers are real JVMs,
 * launched on this test's own classpath, which the Gradle build hands over as
 * `soil.test.classpath`.
 */
package dev.nativesoil.handover

import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import kotlin.io.path.readText
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

private const val PROCESSES = 4
private const val SAVES_PER_PROCESS = 15

/** How long the workers get before the test gives up on them. */
private const val WORKER_TIMEOUT_SECONDS = 120L

class ConcurrencyTest {

    private fun worker(store: Path, startAt: Long, acks: Path, docs: Path): ProcessBuilder {
        val java = Path.of(System.getProperty("java.home"), "bin", "java").toString()
        val classpath = System.getProperty("soil.test.classpath")
            ?: error("run the tests through Gradle so soil.test.classpath is set")
        return ProcessBuilder(
            java,
            "-cp",
            classpath,
            "dev.nativesoil.handover.ConcurrentSaveWorkerKt",
            store.toString(),
            startAt.toString(),
            SAVES_PER_PROCESS.toString(),
            acks.toString(),
            docs.toString(),
        ).redirectErrorStream(true)
    }

    @Test
    fun `loses nothing when four processes save into one store`(@TempDir home: Path) {
        val store = home.resolve("store")
        val docs = home.resolve("docs")
        val acks = home.resolve("acks.jsonl")
        Files.createDirectories(store)
        Files.createDirectories(docs)

        val startAt = System.currentTimeMillis() + 2_000
        val processes = (1..PROCESSES).map { worker(store, startAt, acks, docs).start() }
        for (process in processes) {
            assertTrue(
                process.waitFor(WORKER_TIMEOUT_SECONDS, TimeUnit.SECONDS),
                "a worker process did not finish in time",
            )
            val output = process.inputStream.readBytes().decodeToString()
            assertEquals(0, process.exitValue(), "a worker process failed: $output")
        }

        val lines = acks.readText().lineSequence()
            .filter { it.isNotBlank() }
            .map { parseJson(it) as JsonObject }
            .toList()
        assertEquals(PROCESSES * SAVES_PER_PROCESS, lines.size)

        // A save that was refused under contention is honest, and this store is
        // uncontended enough that none should be. Either way the invariants
        // below are about what was acknowledged, never about what was tried.
        val refused = lines.filter { (it["ok"] as? JsonPrimitive)?.booleanOrNull != true }
        assertEquals(
            emptyList<String?>(),
            refused.map { asStringOrNull(it["error"]) },
        )
        val acknowledged = lines - refused.toSet()
        assertEquals(PROCESSES * SAVES_PER_PROCESS, acknowledged.size)

        val handoverStore = HandoverStore(store.toString())

        // 1. Nothing the store handed a code back for may be missing afterwards.
        val onDisk = Files.list(handoverStore.handoversDir).use { paths ->
            paths.map { it.fileName.toString() }.toList()
        }
        assertEquals(acknowledged.size, onDisk.count { it.endsWith(".json") })
        assertEquals(acknowledged.size, handoverStore.list().size)

        // 2. No two receipts may carry the same load code.
        val codes = acknowledged.map { asStringOrNull(it["code"])!! }
        assertEquals(codes.size, codes.toSet().size)

        // 3. Every receipt's code must still hold the document it named.
        for (line in acknowledged) {
            val code = asStringOrNull(line["code"])!!
            val marker = asStringOrNull(line["marker"])!!
            assertEquals(marker, asStringOrNull(handoverStore.read(code)["title"]))
        }

        // 4. No half-written temporary file survived the race.
        assertEquals(emptyList<String>(), onDisk.filter { it.contains(".tmp-") })
    }
}
