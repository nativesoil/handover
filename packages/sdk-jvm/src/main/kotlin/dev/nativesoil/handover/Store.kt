/**
 * The local store: plain JSON files under `~/.soil`.
 *
 * One handover is one file. The index is one more file. There is no database,
 * no account, no network call, and no format you cannot read with `cat`. If
 * this repo disappeared tomorrow your handovers would still be readable, which
 * is the whole point of writing them down.
 *
 * Layout (documented in `docs/architecture.md`):
 *
 *   ~/.soil/
 *     index.json                 the code counter and one row per handover
 *     handovers/001.json         the handover documents
 *     .locks/                    runtime only: the single-writer lock
 *
 * `SOIL_HOME` overrides the root, which is how the tests and the conformance
 * suite run without touching a real home directory. The layout, the code
 * allocation and the file bytes match `packages/sdk-ts/src/store.ts`, so the
 * SDKs read and write the same store.
 *
 * ## Why the writes are locked
 *
 * `save`, `update` and `reindex` are each a read-modify-write: read the index, write a
 * document, write the index back. Two processes doing that at the same time
 * against one root both read the same `nextCode`, both write a document at
 * that code, and the second index write erases the first one's row. One
 * document survives and both callers were told it was saved.
 *
 * That is not a server-only story. It is two saves against one `~/.soil`: an
 * agent saving while a person saves, or a shell loop. Measured on this store
 * before the lock, four processes saving fifteen times each acknowledged 58,
 * 59 and 60 saves across three runs and left 12, 6 and 14 documents on disk.
 *
 * So every write path runs inside the advisory lock in `Lock.kt`, keyed on
 * this store's own root, with the same on-disk shape every other SDK uses. A
 * write that cannot take the lock throws [LockBusyException] and writes
 * nothing, because a refusal the caller can retry is honest and an
 * acknowledgement for a lost write is not. Reads are not locked and do not
 * need to be: every write lands through an atomic rename, so a reader sees the
 * whole old file or the whole new one.
 */
@file:JvmName("Store")

package dev.nativesoil.handover

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.UUID
import kotlin.io.path.exists
import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.name
import kotlin.io.path.readBytes
import kotlin.io.path.readText
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The number of digits in a load code, e.g. `#004`. */
private const val CODE_DIGITS = 3

/** Resolve the store root: `SOIL_HOME`, else `~/.soil`. */
@JvmOverloads
fun resolveStoreHome(env: Map<String, String> = System.getenv()): String {
    val override = env["SOIL_HOME"]
    if (override != null && override.trim().isNotEmpty()) {
        return override.trim()
    }
    return Path.of(System.getProperty("user.home"), ".soil").toString()
}

/** Format a numeric code as a load code, e.g. `4` becomes `#004`. */
fun formatCode(n: Int): String = "#${n.toString().padStart(CODE_DIGITS, '0')}"

private val CODE_SHAPE = Regex("^#?(\\d+)$")

/** Parse a load code into its number. Accepts `#004`, `004` and `4`. */
fun parseCode(code: String): Int? {
    val match = CODE_SHAPE.find(code.trim()) ?: return null
    val n = match.groupValues[1].toIntOrNull() ?: return null
    return if (n > 0) n else null
}

/**
 * Section counts for a handover. Structural content presence, never a grade.
 *
 * The field is `withContent`, not `captured`: a section holding two characters
 * has content present and nothing more. "Captured" asserts that the thing was
 * successfully taken, which a count of non-empty summaries cannot know.
 */
data class SectionCounts(
    /** Sections with `status: "available"`. */
    @JvmField val withContent: Int,
    /** Sections with `status: "missing"`. */
    @JvmField val missing: Int,
    /** Sections with `status: "blocked"`. */
    @JvmField val blocked: Int,
    /** Sections with `status: "not_applicable"`. */
    @JvmField val notApplicable: Int,
    /** Always 17. */
    @JvmField val total: Int,
)

/**
 * Count sections by status. Structural content presence, never a grade: a
 * section holding two characters counts exactly like one holding two pages.
 */
fun countSections(handover: JsonObject): SectionCounts {
    var withContent = 0
    var missing = 0
    var blocked = 0
    var notApplicable = 0
    val sections = handover["sections"] as? JsonObject
    for (key in SECTION_KEYS) {
        when (asStringOrNull((sections?.get(key) as? JsonObject)?.get("status"))) {
            "available" -> withContent += 1
            "blocked" -> blocked += 1
            "not_applicable" -> notApplicable += 1
            else -> missing += 1
        }
    }
    return SectionCounts(withContent, missing, blocked, notApplicable, SECTION_KEYS.size)
}

/** A row in the local index. */
data class StoreEntry(
    /** The load code, e.g. `#004`. */
    @JvmField val code: String,
    @JvmField val projectId: String,
    @JvmField val title: String,
    @JvmField val createdAt: String,
    /**
     * How many of the 17 sections have `status: "available"`. Structural
     * content presence, never a claim that the capture succeeded.
     */
    @JvmField val sectionsWithContent: Int,
    /** File name inside the store's `handovers/` directory. */
    @JvmField val file: String,
)

/** The on-disk index document. */
data class StoreIndex(
    @JvmField val indexVersion: Int,
    /** The next numeric code the store will hand out. */
    @JvmField val nextCode: Int,
    @JvmField val entries: List<StoreEntry>,
)

private fun entryToJson(entry: StoreEntry): JsonObject = JsonObject(
    linkedMapOf<String, JsonElement>(
        "code" to JsonPrimitive(entry.code),
        "projectId" to JsonPrimitive(entry.projectId),
        "title" to JsonPrimitive(entry.title),
        "createdAt" to JsonPrimitive(entry.createdAt),
        "sectionsWithContent" to JsonPrimitive(entry.sectionsWithContent),
        "file" to JsonPrimitive(entry.file),
    )
)

private fun indexToJson(index: StoreIndex): JsonObject = JsonObject(
    linkedMapOf<String, JsonElement>(
        "indexVersion" to JsonPrimitive(index.indexVersion),
        "nextCode" to JsonPrimitive(index.nextCode),
        "entries" to JsonArray(index.entries.map { entryToJson(it) }),
    )
)

private fun entryFromJson(value: JsonObject): StoreEntry = StoreEntry(
    code = asStringOrNull(value["code"]) ?: "",
    projectId = asStringOrNull(value["projectId"]) ?: "",
    title = asStringOrNull(value["title"]) ?: "",
    createdAt = asStringOrNull(value["createdAt"]) ?: "",
    // Accepts an index written before the rename. Pre-existing indexes are
    // not migrated on read and not rewritten: a row carrying only the old
    // `sectionsCaptured` key is understood, and the honest name is what gets
    // written the next time that row is touched. `reindex()` rewrites the
    // whole file from the handover documents, which is the one-step way to
    // convert an old index deliberately.
    sectionsWithContent = (value["sectionsWithContent"] as? JsonPrimitive)
        ?.content?.toIntOrNull()
        ?: (value["sectionsCaptured"] as? JsonPrimitive)?.content?.toIntOrNull()
        ?: 0,
    file = asStringOrNull(value["file"]) ?: "",
)

private fun writeJsonAtomic(path: Path, value: JsonElement) {
    // Same bytes as the TypeScript store: two-space indent, unescaped
    // non-ASCII, a trailing newline, and an atomic rename into place.
    //
    // The temporary name carries a random id, never the process id. Two
    // containers on one volume both run as pid 1, so a pid makes two different
    // writers look like one writer resuming, and the second would silently
    // rename the first's half-written bytes into place.
    val tmp = Path.of("$path.tmp-${UUID.randomUUID()}")
    Files.writeString(tmp, stringifyPretty(value) + "\n")
    Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING)
}

/** Thrown when a load code does not resolve to a stored handover. */
class HandoverNotFoundException(code: String) :
    RuntimeException("no handover stored as $code")

/** A local handover store rooted at one directory. */
class HandoverStore @JvmOverloads constructor(
    root: String = resolveStoreHome(),
    private val lockTimeoutMs: Long = DEFAULT_LOCK_TIMEOUT_MS,
    private val lockStaleMs: Long = DEFAULT_LOCK_STALE_MS,
) {
    @JvmField val root: Path = Path.of(root)
    @JvmField val handoversDir: Path = this.root.resolve("handovers")
    @JvmField val indexPath: Path = this.root.resolve("index.json")

    /** Where the single-writer lock lives. Runtime state, never content. */
    @JvmField val locksDir: Path = this.root.resolve(".locks")

    /**
     * Run one read-modify-write as this store's only writer, across processes.
     *
     * The lock is keyed on the store root, so two stores under one home never
     * wait on each other, and two processes on one root always do.
     *
     * @throws LockBusyException if the lock could not be taken. Nothing ran,
     * and nothing was written.
     */
    private fun <T> locked(body: () -> T): T =
        withLock(locksDir, "store", lockTimeoutMs, lockStaleMs, body)

    /** Create the directories if they are not there yet. */
    fun init() {
        Files.createDirectories(handoversDir)
    }

    /** Read the index, rebuilding an empty one when the store is new. */
    fun readIndex(): StoreIndex {
        if (!indexPath.exists()) {
            return StoreIndex(1, 1, emptyList())
        }
        val parsed = ingestDocumentOrThrow(indexPath.readBytes())
        val record = parsed as? JsonObject
        val entries = record?.get("entries") as? JsonArray
            ?: throw IllegalStateException("the index at $indexPath is not readable")
        return StoreIndex(
            indexVersion = 1,
            nextCode = (record["nextCode"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 1,
            entries = entries.mapNotNull { (it as? JsonObject)?.let(::entryFromJson) },
        )
    }

    /** Every stored handover, newest code first. */
    fun list(): List<StoreEntry> =
        readIndex().entries.sortedByDescending { parseCode(it.code) ?: 0 }

    /** The path a handover with this code lives at. */
    fun pathFor(code: String): Path {
        val n = parseCode(code) ?: throw HandoverNotFoundException(code)
        return handoversDir.resolve("${n.toString().padStart(CODE_DIGITS, '0')}.json")
    }

    /**
     * Read one handover. `code` accepts `#004`, `004`, `4`, or `last` for the
     * most recently saved one.
     */
    fun read(code: String): JsonObject {
        val wanted = code.trim().lowercase()
        if (wanted == "last" || wanted == "latest") {
            val newest = list().firstOrNull() ?: throw HandoverNotFoundException("last")
            return read(newest.code)
        }
        val path = pathFor(code)
        if (!path.exists()) {
            throw HandoverNotFoundException(formatCode(parseCode(code) ?: 0))
        }
        // Through the ingestion boundary, not `parseJson`: a file on disk is
        // bytes, and the encoding, duplicate-member and depth rules can only be
        // enforced before a value exists. See `Ingest.kt`.
        return assertHandover(ingestDocumentOrThrow(path.readBytes()))
    }

    /**
     * Store a handover and hand back its index row. The document is validated
     * first: an invalid document is never written, because a store that accepts
     * anything is a store you cannot trust to load.
     *
     * The store is a writer, so it assigns identity: a document that arrives
     * without a `handoverId` gets a fresh UUIDv7 here, and a document that
     * already carries one keeps it, because a copy keeps its identity. An id
     * that is present but malformed is a validation error, never silently
     * replaced.
     *
     * Reading the index, claiming the code and writing both files is one
     * section under this store's lock. Validation and identity assignment stay
     * outside it: they touch no disk, and a document that is going to be
     * refused should never make another writer wait.
     *
     * @throws LockBusyException if another process holds the lock. Nothing was
     * written, and the caller has not been told otherwise.
     */
    fun save(handover: JsonObject): StoreEntry {
        val identified =
            if (!handover.containsKey("handoverId")) {
                JsonObject(
                    LinkedHashMap<String, JsonElement>(handover).also {
                        it["handoverId"] = JsonPrimitive(uuidv7())
                    }
                )
            } else {
                handover
            }
        assertHandover(identified)
        init()

        return locked {
            val index = readIndex()
            val code = formatCode(index.nextCode)
            val stored = JsonObject(
                LinkedHashMap<String, JsonElement>(identified).also {
                    it["code"] = JsonPrimitive(code)
                }
            )
            val file = "${index.nextCode.toString().padStart(CODE_DIGITS, '0')}.json"

            writeJsonAtomic(handoversDir.resolve(file), stored)

            val entry = StoreEntry(
                code = code,
                projectId = asStringOrNull(stored["projectId"]) ?: "",
                title = asStringOrNull(stored["title"]) ?: "",
                createdAt = asStringOrNull(stored["createdAt"]) ?: "",
                sectionsWithContent = countSections(stored).withContent,
                file = file,
            )
            writeJsonAtomic(
                indexPath,
                indexToJson(StoreIndex(1, index.nextCode + 1, index.entries + entry)),
            )
            entry
        }
    }

    /**
     * Update a stored handover in place, e.g. to attach an observation. This
     * is the one write path that touches an existing file, and it holds two
     * rules absolutely: the `handoverId` never changes, because identity
     * survives every edit, and the load code never changes, because a code in
     * an old note must keep pointing at the thing it pointed at. The updated
     * document is validated before anything is written, and the index row is
     * refreshed to match.
     *
     * The whole section is locked, the read of the current document included:
     * an update that decided what to write from a document another process
     * replaced in the meantime would write back a merge nobody made.
     *
     * @throws LockBusyException if another process holds the lock. Nothing
     * was written.
     */
    fun update(code: String, next: JsonObject): StoreEntry = locked {
        val current = read(code)
        val storedCode = asStringOrNull(current["code"])
            ?: formatCode(parseCode(code) ?: 0)
        if (asStringOrNull(next["handoverId"]) != asStringOrNull(current["handoverId"])) {
            throw IllegalArgumentException(
                "the handoverId never changes: an update to $storedCode must keep its identity"
            )
        }
        val stored = JsonObject(
            LinkedHashMap<String, JsonElement>(next).also {
                it["code"] = JsonPrimitive(storedCode)
            }
        )
        assertHandover(stored)

        val n = parseCode(storedCode) ?: throw HandoverNotFoundException(code)
        val file = "${n.toString().padStart(CODE_DIGITS, '0')}.json"
        writeJsonAtomic(handoversDir.resolve(file), stored)

        val entry = StoreEntry(
            code = storedCode,
            projectId = asStringOrNull(stored["projectId"]) ?: "",
            title = asStringOrNull(stored["title"]) ?: "",
            createdAt = asStringOrNull(stored["createdAt"]) ?: "",
            sectionsWithContent = countSections(stored).withContent,
            file = file,
        )
        val index = readIndex()
        writeJsonAtomic(
            indexPath,
            indexToJson(
                StoreIndex(
                    1,
                    index.nextCode,
                    index.entries.map { row ->
                        if (row.code == storedCode) entry else row
                    },
                )
            ),
        )
        entry
    }

    /**
     * Rebuild the index from the handover files on disk. The files are the
     * truth; the index is a convenience, so losing it should never lose a
     * handover.
     *
     * Locked like `save`: a rebuild that scanned the directory while a save
     * was landing would write an index missing the document that save just
     * wrote, and hand the next save a code that is already taken.
     *
     * @throws LockBusyException if another process holds the lock. The
     * existing index is left exactly as it was.
     */
    fun reindex(): StoreIndex {
        init()
        return locked { reindexLocked() }
    }

    private fun reindexLocked(): StoreIndex {
        val entries = mutableListOf<StoreEntry>()
        var highest = 0
        for (path in handoversDir.listDirectoryEntries().sortedBy { it.name }) {
            val file = path.name
            if (!file.endsWith(".json")) continue
            // A rebuilt index never silently promotes a document nothing has
            // checked, so a file the boundary refuses is skipped exactly as a
            // structurally invalid one is.
            val ingested = ingestDocument(path.readBytes()).value ?: continue
            val document = validateForReindex(ingested) ?: continue
            val n = parseCode(
                asStringOrNull(document["code"]) ?: file.removeSuffix(".json")
            ) ?: continue
            highest = maxOf(highest, n)
            entries.add(
                StoreEntry(
                    code = formatCode(n),
                    projectId = asStringOrNull(document["projectId"]) ?: "",
                    title = asStringOrNull(document["title"]) ?: "",
                    createdAt = asStringOrNull(document["createdAt"]) ?: "",
                    sectionsWithContent = countSections(document).withContent,
                    file = file,
                )
            )
        }
        val index = StoreIndex(1, highest + 1, entries)
        writeJsonAtomic(indexPath, indexToJson(index))
        return index
    }
}

private fun validateForReindex(parsed: JsonElement): JsonObject? =
    try {
        assertHandover(parsed)
    } catch (e: HandoverValidationException) {
        null
    }
