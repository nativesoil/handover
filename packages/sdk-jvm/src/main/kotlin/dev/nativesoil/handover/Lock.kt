/**
 * The single-writer guarantee.
 *
 * Every state change that touches a store is a read-modify-write: read
 * `index.json`, write a document, write `index.json` back. Inside one thread
 * that is safe enough; across two processes on one directory it is not safe at
 * all, and the failure is silent. Both processes read the same index, both
 * write a document at the same load code, and the second index write erases
 * the first one's row. Both callers were told "saved".
 *
 * Two processes on one directory is not a hypothetical. It is two containers
 * on one volume, and it is two saves against one `~/.soil` — an agent saving
 * beside a person doing the same.
 *
 * ## The mechanism
 *
 * An advisory lock directory, taken with `Files.createDirectory`. It either
 * creates the directory or throws `FileAlreadyExistsException`, in one
 * indivisible step, on every filesystem this code can run on including NFS,
 * where exclusive creation of a plain file historically could not be trusted.
 * No new dependency: `java.nio.file` expresses every part of this.
 *
 * A `holder.json` inside the directory records who holds it. The holder id is
 * random, never a process id. Two containers that both run as pid 1 must not
 * be able to look like each other; that also rules out any "is that pid alive"
 * stale check, which would be wrong across containers anyway.
 *
 * ## What happens when the lock cannot be taken
 *
 * The write is refused. Nothing is written and nothing is half-written: the
 * caller gets [LockBusyException]. A refusal a caller can retry is the honest
 * outcome; the thing that must never happen is an acknowledgement for a write
 * that did not survive.
 *
 * A stale lock, left by a process that was killed mid-write, is broken after
 * [DEFAULT_LOCK_STALE_MS]. Breaking a lock is the one unsound moment in any
 * advisory scheme, so it is deliberately far beyond any honest hold time.
 *
 * The on-disk shape — the `<name>.lock` directory, the `holder.json` inside it
 * and the fields it carries — is the same in all five SDKs, so a JVM writer
 * and a Go writer on one store wait for each other.
 *
 * ## Two refusals, one rule
 *
 * Both ends of the lock are a filesystem call that can be refused for a reason
 * that passes, and both are held to the same rule: retry for
 * [RETRY_BUDGET_MS], then report the refusal as itself.
 *
 * Releasing is a directory removal. It is refused on Windows when another
 * process holds a file inside the directory open, which is exactly what every
 * waiter is doing to `holder.json`. A release whose outcome is discarded is
 * worse than one that fails loudly: the holder carries on believing it
 * released, and every other writer waits the whole staleness window for a lock
 * that nobody holds.
 *
 * Taking is a directory create. It says already-exists when somebody else holds
 * the lock, and that is the ordinary answer, but it is not the only way a
 * platform says the name is unavailable. Windows refuses a create on a name
 * whose deletion has been accepted and not yet finished, with access denied,
 * while a lookup of that same name already reports it as gone: for a few
 * milliseconds the name is neither present nor creatable. Measured on a Windows
 * runner over 180 repetitions of two races: 38 refused creates, all of them
 * access denied, all of them with a lookup reporting the name absent, and every
 * one resolving into a taken lock between 4 and 121 milliseconds.
 *
 * So a create refused for anything but already-exists is treated as contention
 * for as long as the budget, and reported as itself once the budget is spent.
 * It is never turned into [LockBusyException], because a directory that cannot
 * be created is not a busy lock, and the difference has to reach the caller.
 */
@file:JvmName("Lock")

package dev.nativesoil.handover

import java.io.IOException
import java.net.InetAddress
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.security.SecureRandom
import java.util.UUID
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/** How long an acquire waits before giving up. */
const val DEFAULT_LOCK_TIMEOUT_MS: Long = 5_000

/** How old a lock must be before it is treated as abandoned. */
const val DEFAULT_LOCK_STALE_MS: Long = 30_000

/**
 * How long either side of the lock keeps trying a filesystem call that was
 * refused for a reason that passes, before reporting the refusal as itself.
 * Well inside [DEFAULT_LOCK_TIMEOUT_MS], so a retry never itself becomes the
 * reason a waiter is refused, and far short of [DEFAULT_LOCK_STALE_MS].
 */
private const val RETRY_BUDGET_MS: Long = 1_000

private const val HOLDER_FILE = "holder.json"

/** Thrown when a lock could not be taken. Nothing was written. */
class LockBusyException(
    /** The lock that was contended, as a short name, never a path. */
    @JvmField val lockName: String,
) : RuntimeException(
    "another process is writing and the $lockName lock could not be taken; " +
        "nothing was written, try again"
)

/**
 * The host name, looked up once.
 *
 * Informational only: nothing is ever decided from it, so a machine whose name
 * cannot be resolved gets a placeholder rather than an exception, and the
 * lookup is never repeated inside an acquire loop.
 */
private val HOST_NAME: String by lazy {
    try {
        InetAddress.getLocalHost().hostName
    } catch (e: IOException) {
        "unknown"
    }
}

private val JITTER = SecureRandom()

private data class Holder(val holder: String, val acquiredAt: Long)

/**
 * The holder record, or `null` when there is not a readable one.
 *
 * A lock directory with no readable holder file is one that was created a
 * moment ago, or one whose holder died between the two steps. Both are handled
 * by the staleness path in [withLock].
 */
private fun readHolder(directory: Path): Holder? {
    val text = try {
        Files.readString(directory.resolve(HOLDER_FILE))
    } catch (e: IOException) {
        return null
    }
    val parsed = try {
        parseJson(text) as? JsonObject
    } catch (e: Exception) {
        null
    } ?: return null
    val holder = asStringOrNull(parsed["holder"]) ?: return null
    val acquiredAt = (parsed["acquiredAt"] as? JsonPrimitive)?.longOrNull ?: return null
    return Holder(holder, acquiredAt)
}

/** When the lock directory itself was last written, or now if unreadable. */
private fun directoryAge(directory: Path): Long =
    try {
        Files.getLastModifiedTime(directory).toMillis()
    } catch (e: IOException) {
        System.currentTimeMillis()
    }

/**
 * Remove the lock directory and whatever is inside it, once.
 *
 * Hands back `null` when the directory is gone afterwards, and the failure when
 * it is still there. Nobody may assume the removal happened: that assumption is
 * what turns one refused delete into a lock held for the whole staleness
 * window.
 */
private fun removeLockDirectory(directory: Path): IOException? {
    try {
        Files.deleteIfExists(directory.resolve(HOLDER_FILE))
    } catch (e: IOException) {
        // Left to the removal below, which is the call whose outcome is read.
    }
    return try {
        Files.deleteIfExists(directory)
        null
    } catch (e: IOException) {
        e
    }
}

/**
 * Give the lock back, retrying a removal that failed for a passing reason.
 *
 * Deleting a file another process holds open is refused outright on some
 * platforms, and every waiter reads `holder.json` a few times a second, so a
 * release and a waiter's read do collide. The collision lasts as long as one
 * read, which is why retrying is what resolves it, on the same jitter the
 * acquire loop uses. Measured on a Windows runner against the Python port of
 * this file: one release in fifty was refused this way, and the lock it failed
 * to give back stayed held for the full thirty seconds, refusing every save in
 * that window.
 *
 * Whatever is still there when the budget is spent is handed back rather than
 * dropped. A lock this process holds and cannot give back is one every other
 * writer waits the staleness window for, and this process is the only one in a
 * position to say so.
 */
private fun releaseLockDirectory(directory: Path): IOException? {
    val deadline = System.currentTimeMillis() + RETRY_BUDGET_MS
    while (true) {
        val failure = removeLockDirectory(directory)
        if (failure == null || System.currentTimeMillis() >= deadline) return failure
        Thread.sleep(3L + JITTER.nextInt(9))
    }
}

/**
 * Break a lock that looks abandoned, but only the exact one that was seen to
 * be abandoned: the holder id is re-read immediately before the removal, so a
 * lock that changed hands in between is left alone.
 *
 * A removal that fails here is left to the acquire loop, which comes back
 * within milliseconds and tries again. That is the difference between this path
 * and the release path: here the caller is about to look, so nothing is being
 * told that the lock is gone.
 */
private fun breakIfStale(directory: Path, seen: Holder) {
    val again = readHolder(directory) ?: return
    if (again.holder != seen.holder) return
    removeLockDirectory(directory)
}

/**
 * Run [body] while holding the named lock.
 *
 * [locksDir] must sit on the same volume as the data it guards, because that
 * is the only thing two processes are guaranteed to share. [HandoverStore]
 * passes `<store root>/.locks`, which is where every SDK puts it, so the
 * layout stays identical.
 *
 * @throws LockBusyException if the lock could not be taken in time. Nothing
 * ran, and nothing was written.
 */
@JvmOverloads
fun <T> withLock(
    locksDir: Path,
    name: String,
    timeoutMs: Long = DEFAULT_LOCK_TIMEOUT_MS,
    staleMs: Long = DEFAULT_LOCK_STALE_MS,
    body: () -> T,
): T {
    val directory = locksDir.resolve("$name.lock")
    val holderId = UUID.randomUUID().toString()
    val holder: JsonObject = JsonObject(
        linkedMapOf<String, JsonElement>(
            "holder" to JsonPrimitive(holderId),
            "acquiredAt" to JsonPrimitive(System.currentTimeMillis()),
            "host" to JsonPrimitive(HOST_NAME),
            // Informational only. Nothing is ever decided from this.
            "pid" to JsonPrimitive(ProcessHandle.current().pid()),
        )
    )

    Files.createDirectories(locksDir)

    val deadline = System.currentTimeMillis() + timeoutMs
    var taken = false
    // When the first create was refused for a reason other than
    // already-exists. Reset the moment a create is refused for already-exists,
    // because that is the name becoming visible again: whatever the earlier
    // refusal was, it is over.
    var refusedAt = 0L
    while (true) {
        try {
            Files.createDirectory(directory)
            taken = true
            break
        } catch (e: FileAlreadyExistsException) {
            // Somebody else holds it. Fall through to the staleness check.
            refusedAt = 0L
        } catch (e: IOException) {
            // Not already-exists, and not necessarily fatal either. See "Two
            // refusals, one rule" above: this is how one platform says a name
            // is on its way out. Give it the budget, then let it speak.
            if (!Files.isDirectory(directory.parent)) {
                // Except when there is nothing to wait for. No amount of
                // waiting makes a name creatable inside a directory that is
                // not there, and the caller should hear that at once.
                throw e
            }
            if (refusedAt == 0L) refusedAt = System.currentTimeMillis()
            if (System.currentTimeMillis() - refusedAt >= RETRY_BUDGET_MS) throw e
            Thread.sleep(3L + JITTER.nextInt(9))
            continue
        }

        val now = System.currentTimeMillis()
        val current = readHolder(directory)
        if (current != null) {
            if (now - current.acquiredAt > staleMs) {
                breakIfStale(directory, current)
                continue
            }
        } else if (now - directoryAge(directory) > staleMs) {
            // A lock directory with no readable holder file is either one
            // created a microsecond ago, or one whose owner died between the
            // createDirectory and the write. Without this branch the second
            // case would be a lock nothing can ever break, so the directory's
            // own modification time stands in for the holder.
            removeLockDirectory(directory)
            continue
        }

        if (now >= deadline) break
        // A little jitter, so two waiters do not wake in lockstep forever.
        Thread.sleep(3L + JITTER.nextInt(9))
    }

    if (!taken) {
        throw LockBusyException(name)
    }

    Files.writeString(
        directory.resolve(HOLDER_FILE),
        holder.toString(),
        StandardOpenOption.CREATE,
        StandardOpenOption.TRUNCATE_EXISTING,
        StandardOpenOption.WRITE,
    )
    var failure: IOException? = null
    val result: T
    try {
        result = body()
    } finally {
        // Release only what is still ours. If the lock was broken as stale
        // while this body ran, the directory now belongs to somebody else and
        // removing it would hand a third process a lock two processes think
        // they hold.
        val current = readHolder(directory)
        if (current == null || current.holder == holderId) {
            failure = releaseLockDirectory(directory)
        }
    }

    // Reached only when the body returned. A body that threw carries the more
    // informative failure, and it has already left this function.
    failure?.let { throw it }
    return result
}
