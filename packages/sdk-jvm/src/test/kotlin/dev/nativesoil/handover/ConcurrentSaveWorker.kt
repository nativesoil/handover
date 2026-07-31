/**
 * One saving writer process for the JVM concurrency test.
 *
 * The failure this file exists to reproduce cannot be written inside one
 * process, and cannot be written with threads either: documents are only lost
 * when two *processes* share one store. Two processes on one `~/.soil` is not
 * exotic — it is an agent saving while a person saves, or two containers on
 * one volume.
 *
 * It is a `main`, not a test, because it runs as its own JVM. The test spawns
 * several of them on the same classpath it was given.
 *
 * Usage:
 *   java -cp <test classpath> dev.nativesoil.handover.ConcurrentSaveWorkerKt \
 *     <soilHome> <startAtMs> <count> <out> <docDir>
 *
 * Every acknowledgement the store hands back is appended to <out> as one JSON
 * line, together with the marker the document carried, so the test can check
 * each receipt against the disk. A refused save is recorded as one line too:
 * a refusal is a legitimate answer under contention, an acknowledgement for a
 * write that did not survive is not.
 *
 * Nothing here identifies a writer by its process id. Markers are random ids:
 * two containers on one volume both run as pid 1, so a test that told writers
 * apart by pid would agree with itself for the wrong reason.
 */
package dev.nativesoil.handover

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.util.UUID
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private fun workerDocument(marker: String): JsonObject {
    val sections = LinkedHashMap<String, JsonElement>()
    for (key in SECTION_KEYS) {
        sections[key] = JsonObject(
            linkedMapOf("status" to JsonPrimitive("missing"), "summary" to JsonNull)
        )
    }
    sections["projectIdentity"] = JsonObject(
        linkedMapOf<String, JsonElement>(
            "status" to JsonPrimitive("available"),
            "summary" to JsonPrimitive(marker),
        )
    )
    return JsonObject(
        linkedMapOf<String, JsonElement>(
            "soilHandover" to JsonPrimitive("1.0"),
            "projectId" to JsonPrimitive("billing-rework"),
            "title" to JsonPrimitive(marker),
            "createdAt" to JsonPrimitive("2026-07-24T10:00:00.000Z"),
            "sections" to JsonObject(sections),
        )
    )
}

private fun record(out: Path, line: JsonObject) {
    // `JsonObject.toString()` is compact JSON on one line, which is what the
    // reader of this file expects: one acknowledgement per line.
    Files.writeString(
        out,
        line.toString() + "\n",
        StandardOpenOption.CREATE,
        StandardOpenOption.APPEND,
    )
}

fun main(args: Array<String>) {
    val home = args[0]
    val startAt = args[1].toLong()
    val count = args[2].toInt()
    val outPath = Path.of(args[3])
    val workerId = UUID.randomUUID().toString()
    val store = HandoverStore(home)

    // A deliberate busy wait, so the processes collide instead of queueing.
    while (System.currentTimeMillis() < startAt) {
        // nothing: a sleep would hand the scheduler back and blur the start
    }

    for (i in 0 until count) {
        val marker = "$workerId-$i"
        val line = try {
            val entry = store.save(workerDocument(marker))
            linkedMapOf<String, JsonElement>(
                "ok" to JsonPrimitive(true),
                "code" to JsonPrimitive(entry.code),
                "marker" to JsonPrimitive(marker),
            )
        } catch (error: Exception) {
            linkedMapOf<String, JsonElement>(
                "ok" to JsonPrimitive(false),
                "marker" to JsonPrimitive(marker),
                "error" to JsonPrimitive("${error.javaClass.simpleName}: ${error.message}"),
            )
        }
        record(outPath, JsonObject(line))
    }
}
