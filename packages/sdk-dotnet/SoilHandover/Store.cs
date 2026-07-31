using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Soil.Handover;

/// <summary>
/// Thrown when a load code does not resolve to a stored handover.
/// </summary>
public sealed class HandoverNotFoundException : Exception
{
    public HandoverNotFoundException(string code)
        : base($"no handover stored as {code}")
    {
    }
}

/// <summary>
/// The local store: plain JSON files under <c>~/.soil</c>.
///
/// One handover is one file. The index is one more file. There is no
/// database, no account, no network call, and no format you cannot read
/// with <c>cat</c>. If this repo disappeared tomorrow your handovers would
/// still be readable, which is the whole point of writing them down.
///
/// Layout (documented in docs/architecture.md):
///
/// <code>
///   ~/.soil/
///     index.json                 the code counter and one row per handover
///     handovers/001.json         the handover documents
///     .locks/                    runtime only: the single-writer lock
/// </code>
///
/// <c>SOIL_HOME</c> overrides the root, which is how the tests and the
/// conformance suite run without touching a real home directory. The
/// layout, the code allocation and the file bytes match
/// packages/sdk-ts/src/store.ts, so the SDKs read and write the same store.
///
/// <para><b>Why the writes are locked.</b> <c>Save</c>, <c>Update</c> and <c>Reindex</c> are
/// each a read-modify-write: read the index, write a document, write the
/// index back. Two processes doing that at the same time against one root
/// both read the same <c>NextCode</c>, both write a document at that code,
/// and the second index write erases the first one's row. One document
/// survives and both callers were told it was saved.</para>
///
/// <para>That is not a server-only story. It is two saves against one
/// <c>~/.soil</c>: an agent saving while a person saves, or a shell loop.
/// Measured on this store before the lock, four processes saving fifteen
/// times each acknowledged 60 saves and left 18, 16 and 18 documents on disk
/// across three runs.</para>
///
/// <para>So every write path runs inside the advisory lock in Lock.cs, keyed
/// on this store's own root, with the same on-disk shape every other SDK
/// uses. A write that cannot take the lock throws
/// <see cref="LockBusyException"/> and writes nothing, because a refusal the
/// caller can retry is honest and an acknowledgement for a lost write is not.
/// Reads are not locked and do not need to be: every write lands through an
/// atomic rename, so a reader sees the whole old file or the whole new
/// one.</para>
/// </summary>
public sealed class HandoverStore
{
    /// <summary>The number of digits in a load code, e.g. <c>#004</c>.</summary>
    private const int CodeDigits = 3;

    private static readonly Regex CodeShape = new(@"^#?(\d+)$");

    public string Root { get; }
    public string HandoversDir { get; }
    public string IndexPath { get; }

    /// <summary>Where the single-writer lock lives. Runtime state, never content.</summary>
    public string LocksDir { get; }

    private readonly int _lockTimeoutMs;
    private readonly int _lockStaleMs;

    public HandoverStore(
        string? root = null,
        int lockTimeoutMs = WriteLock.DefaultTimeoutMs,
        int lockStaleMs = WriteLock.DefaultStaleMs)
    {
        Root = root ?? ResolveStoreHome();
        HandoversDir = Path.Combine(Root, "handovers");
        IndexPath = Path.Combine(Root, "index.json");
        LocksDir = Path.Combine(Root, ".locks");
        _lockTimeoutMs = lockTimeoutMs;
        _lockStaleMs = lockStaleMs;
    }

    /// <summary>
    /// Run one read-modify-write as this store's only writer, across
    /// processes. The lock is keyed on the store root, so two stores under one
    /// home never wait on each other, and two processes on one root always do.
    /// </summary>
    /// <exception cref="LockBusyException">
    /// The lock could not be taken. Nothing ran, and nothing was written.
    /// </exception>
    private T Locked<T>(Func<T> body)
        => WriteLock.With(LocksDir, "store", body, _lockTimeoutMs, _lockStaleMs);

    /// <summary>Resolve the store root: <c>SOIL_HOME</c>, else <c>~/.soil</c>.</summary>
    public static string ResolveStoreHome(IReadOnlyDictionary<string, string?>? env = null)
    {
        var candidate = env is not null
            ? (env.TryGetValue("SOIL_HOME", out var value) ? value : null)
            : Environment.GetEnvironmentVariable("SOIL_HOME");
        if (candidate is not null && candidate.Trim().Length > 0)
        {
            return candidate.Trim();
        }
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(home, ".soil");
    }

    /// <summary>Format a numeric code as a load code, e.g. <c>4</c> becomes <c>#004</c>.</summary>
    public static string FormatCode(int n)
        => "#" + n.ToString(System.Globalization.CultureInfo.InvariantCulture).PadLeft(CodeDigits, '0');

    /// <summary>Parse a load code into its number. Accepts <c>#004</c>, <c>004</c> and <c>4</c>.</summary>
    public static int? ParseCode(string code)
    {
        var match = CodeShape.Match(code.Trim());
        if (!match.Success)
        {
            return null;
        }
        if (!int.TryParse(match.Groups[1].Value, out var n))
        {
            return null;
        }
        return n > 0 ? n : null;
    }

    /// <summary>
    /// Count sections by status. Structural content presence, never a grade: a
    /// section holding two characters counts exactly like one holding two pages.
    /// </summary>
    public static SectionCounts CountSections(JsonObject handover)
    {
        var withContent = 0;
        var missing = 0;
        var blocked = 0;
        var notApplicable = 0;
        var sections = handover.TryGetPropertyValue("sections", out var node) && node is JsonObject s
            ? s
            : new JsonObject();
        foreach (var key in Sections.SectionKeys)
        {
            var section = sections.TryGetPropertyValue(key, out var sectionNode) && sectionNode is JsonObject o
                ? o
                : null;
            var status = section is not null
                && section.TryGetPropertyValue("status", out var statusNode)
                && statusNode is JsonValue v
                && v.TryGetValue<string>(out var text)
                    ? text
                    : null;
            if (status == "available")
            {
                withContent += 1;
            }
            else if (status == "blocked")
            {
                blocked += 1;
            }
            else if (status == "not_applicable")
            {
                notApplicable += 1;
            }
            else
            {
                missing += 1;
            }
        }
        return new SectionCounts(withContent, missing, blocked, notApplicable, Sections.SectionKeys.Count);
    }

    /// <summary>Create the directories if they are not there yet.</summary>
    public void Init() => Directory.CreateDirectory(HandoversDir);

    /// <summary>Read the index, rebuilding an empty one when the store is new.</summary>
    public StoreIndex ReadIndex()
    {
        if (!File.Exists(IndexPath))
        {
            return new StoreIndex(1, 1, Array.Empty<StoreEntry>());
        }
        var parsed = Ingest.IngestDocumentOrThrow(File.ReadAllBytes(IndexPath));
        if (parsed is not JsonObject index
            || !index.TryGetPropertyValue("entries", out var entriesNode)
            || entriesNode is not JsonArray entries)
        {
            throw new InvalidOperationException($"the index at {IndexPath} is not readable");
        }
        var nextCode = index.TryGetPropertyValue("nextCode", out var nextNode)
            && nextNode is JsonValue nextValue
            && nextValue.TryGetValue<int>(out var next)
                ? next
                : 1;
        var rows = new List<StoreEntry>();
        foreach (var entryNode in entries)
        {
            if (entryNode is not JsonObject entry)
            {
                continue;
            }
            rows.Add(new StoreEntry(
                GetString(entry, "code"),
                GetString(entry, "projectId"),
                GetString(entry, "title"),
                GetString(entry, "createdAt"),
                SectionsWithContentOf(entry),
                GetString(entry, "file")));
        }
        return new StoreIndex(1, nextCode, rows);
    }

    /// <summary>
    /// Read one index row's count, accepting an index written before the
    /// rename. Pre-existing indexes are not migrated on read and not
    /// rewritten: a row carrying only the old <c>sectionsCaptured</c> key is
    /// understood, and the honest name is what gets written the next time that
    /// row is touched. <c>Reindex</c> rewrites the whole file from the handover
    /// documents, which is the one-step way to convert an old index
    /// deliberately.
    /// </summary>
    private static int SectionsWithContentOf(JsonObject entry)
        => entry.TryGetPropertyValue("sectionsWithContent", out var node) && node is JsonValue
            ? GetInt(entry, "sectionsWithContent")
            : GetInt(entry, "sectionsCaptured");

    private static string GetString(JsonObject record, string key)
        => record.TryGetPropertyValue(key, out var node)
            && node is JsonValue value
            && value.TryGetValue<string>(out var text)
                ? text
                : "";

    private static int GetInt(JsonObject record, string key)
        => record.TryGetPropertyValue(key, out var node)
            && node is JsonValue value
            && value.TryGetValue<int>(out var n)
                ? n
                : 0;

    /// <summary>Every stored handover, newest code first.</summary>
    public IReadOnlyList<StoreEntry> List()
        => ReadIndex().Entries
            .OrderByDescending(entry => ParseCode(entry.Code) ?? 0)
            .ToList();

    /// <summary>The path a handover with this code lives at.</summary>
    public string PathFor(string code)
    {
        var n = ParseCode(code);
        if (n is null)
        {
            throw new HandoverNotFoundException(code);
        }
        var name = n.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)
            .PadLeft(CodeDigits, '0');
        return Path.Combine(HandoversDir, $"{name}.json");
    }

    /// <summary>
    /// Read one handover. <paramref name="code"/> accepts <c>#004</c>,
    /// <c>004</c>, <c>4</c>, or <c>last</c> for the most recently saved one.
    /// </summary>
    public JsonObject Read(string code)
    {
        var wanted = code.Trim().ToLowerInvariant();
        if (wanted is "last" or "latest")
        {
            var newest = List().FirstOrDefault();
            if (newest is null)
            {
                throw new HandoverNotFoundException("last");
            }
            return Read(newest.Code);
        }
        var path = PathFor(code);
        if (!File.Exists(path))
        {
            throw new HandoverNotFoundException(FormatCode(ParseCode(code) ?? 0));
        }
        // Through the ingestion boundary, not File.ReadAllText: that helper
        // detects and strips a byte order mark and transcodes UTF-16, so the
        // document a reader saw would not be the document on disk. The
        // encoding, duplicate-member and depth rules can only be enforced
        // before a value exists. See Ingest.cs.
        var parsed = Ingest.IngestDocumentOrThrow(File.ReadAllBytes(path));
        return Validate.AssertHandover(parsed);
    }

    /// <summary>
    /// Store a handover and hand back its index row. The document is
    /// validated first: an invalid document is never written, because a
    /// store that accepts anything is a store you cannot trust to load.
    ///
    /// The store is a writer, so it assigns identity: a document that
    /// arrives without a <c>handoverId</c> gets a fresh UUIDv7 here, and a
    /// document that already carries one keeps it, because a copy keeps its
    /// identity. An id that is present but malformed is a validation error,
    /// never silently replaced.
    ///
    /// The caller's document is never mutated.
    ///
    /// Reading the index, claiming the code and writing both files is one
    /// section under this store's lock. Validation and identity assignment
    /// stay outside it: they touch no disk, and a document that is going to be
    /// refused should never make another writer wait.
    /// </summary>
    /// <exception cref="LockBusyException">
    /// Another process holds the lock. Nothing was written, and the caller has
    /// not been told otherwise.
    /// </exception>
    public StoreEntry Save(JsonObject handover)
    {
        var identified = (JsonObject)handover.DeepClone();
        if (!identified.ContainsKey("handoverId"))
        {
            identified["handoverId"] = Identity.Uuidv7();
        }
        Validate.AssertHandover(identified);
        Init();

        return Locked(() =>
        {
            var index = ReadIndex();
            var code = FormatCode(index.NextCode);
            identified["code"] = code;
            var file = index.NextCode.ToString(System.Globalization.CultureInfo.InvariantCulture)
                .PadLeft(CodeDigits, '0') + ".json";

            WriteJsonAtomic(Path.Combine(HandoversDir, file), identified);

            var entry = new StoreEntry(
                code,
                GetString(identified, "projectId"),
                GetString(identified, "title"),
                GetString(identified, "createdAt"),
                CountSections(identified).WithContent,
                file);
            var entries = index.Entries.Append(entry).ToList();
            WriteJsonAtomic(IndexPath, IndexToJson(new StoreIndex(1, index.NextCode + 1, entries)));

            return entry;
        });
    }

    /// <summary>
    /// Update a stored handover in place, e.g. to attach an observation.
    /// This is the one write path that touches an existing file, and it
    /// holds two rules absolutely: the <c>handoverId</c> never changes,
    /// because identity survives every edit, and the load code never
    /// changes, because a code in an old note must keep pointing at the
    /// thing it pointed at. The updated document is validated before
    /// anything is written, and the index row is refreshed to match.
    ///
    /// The whole section is locked, the read of the current document
    /// included: an update that decided what to write from a document
    /// another process replaced in the meantime would write back a merge
    /// nobody made.
    /// </summary>
    /// <exception cref="LockBusyException">
    /// Another process holds the lock. Nothing was written.
    /// </exception>
    public StoreEntry Update(string code, JsonObject next)
    {
        return Locked(() =>
        {
            var current = Read(code);
            var storedCode = GetString(current, "code");
            if (storedCode.Length == 0)
            {
                storedCode = FormatCode(ParseCode(code) ?? 0);
            }
            if (GetString(next, "handoverId") != GetString(current, "handoverId"))
            {
                throw new ArgumentException(
                    $"the handoverId never changes: an update to {storedCode} must keep its identity");
            }
            var stored = (JsonObject)next.DeepClone();
            stored["code"] = storedCode;
            Validate.AssertHandover(stored);

            var n = ParseCode(storedCode);
            if (n is null)
            {
                throw new HandoverNotFoundException(code);
            }
            var file = n.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)
                .PadLeft(CodeDigits, '0') + ".json";
            WriteJsonAtomic(Path.Combine(HandoversDir, file), stored);

            var entry = new StoreEntry(
                storedCode,
                GetString(stored, "projectId"),
                GetString(stored, "title"),
                GetString(stored, "createdAt"),
                CountSections(stored).WithContent,
                file);
            var index = ReadIndex();
            var entries = index.Entries
                .Select(row => row.Code == storedCode ? entry : row)
                .ToList();
            WriteJsonAtomic(IndexPath, IndexToJson(new StoreIndex(1, index.NextCode, entries)));
            return entry;
        });
    }

    /// <summary>
    /// Rebuild the index from the handover files on disk. The files are the
    /// truth; the index is a convenience, so losing it should never lose a
    /// handover.
    ///
    /// Locked like <c>Save</c>: a rebuild that scanned the directory while a
    /// save was landing would write an index missing the document that save
    /// just wrote, and hand the next save a code that is already taken.
    /// </summary>
    /// <exception cref="LockBusyException">
    /// Another process holds the lock. The existing index is left exactly as
    /// it was.
    /// </exception>
    public StoreIndex Reindex()
    {
        Init();
        return Locked(ReindexLocked);
    }

    private StoreIndex ReindexLocked()
    {
        var entries = new List<StoreEntry>();
        var highest = 0;
        var files = Directory.GetFiles(HandoversDir)
            .Select(Path.GetFileName)
            .Where(name => name is not null)
            .Cast<string>()
            .OrderBy(name => name, StringComparer.Ordinal);
        foreach (var file in files)
        {
            if (!file.EndsWith(".json", StringComparison.Ordinal))
            {
                continue;
            }
            // A rebuilt index never silently promotes a document nothing has
            // checked, so a file the boundary refuses is skipped exactly as a
            // structurally invalid one is.
            var ingested = Ingest.IngestDocument(File.ReadAllBytes(Path.Combine(HandoversDir, file)));
            if (!ingested.Ok)
            {
                continue;
            }
            var document = ValidateForReindex(ingested.Value);
            if (document is null)
            {
                continue;
            }
            var codeText = GetString(document, "code");
            var n = ParseCode(codeText.Length > 0 ? codeText : file[..^".json".Length]);
            if (n is null)
            {
                continue;
            }
            highest = Math.Max(highest, n.Value);
            entries.Add(new StoreEntry(
                FormatCode(n.Value),
                GetString(document, "projectId"),
                GetString(document, "title"),
                GetString(document, "createdAt"),
                CountSections(document).WithContent,
                file));
        }
        var index = new StoreIndex(1, highest + 1, entries);
        WriteJsonAtomic(IndexPath, IndexToJson(index));
        return index;
    }

    private static JsonObject IndexToJson(StoreIndex index)
    {
        var entries = new JsonArray();
        foreach (var entry in index.Entries)
        {
            entries.Add(new JsonObject
            {
                ["code"] = entry.Code,
                ["projectId"] = entry.ProjectId,
                ["title"] = entry.Title,
                ["createdAt"] = entry.CreatedAt,
                ["sectionsWithContent"] = entry.SectionsWithContent,
                ["file"] = entry.File,
            });
        }
        return new JsonObject
        {
            ["indexVersion"] = index.IndexVersion,
            ["nextCode"] = index.NextCode,
            ["entries"] = entries,
        };
    }

    /// <summary>
    /// Write through a temporary file and rename, so a reader never sees half
    /// a document.
    ///
    /// The temporary name carries a random id, never <c>Environment.ProcessId</c>.
    /// Two containers on one volume both run as pid 1, so a pid makes two
    /// different writers look like one writer resuming, and the second would
    /// silently rename the first's half-written bytes into place.
    /// </summary>
    private static void WriteJsonAtomic(string path, JsonNode value)
    {
        var tmp = $"{path}.tmp-{Guid.NewGuid()}";
        File.WriteAllText(tmp, JsonCanon.Stringify(value) + "\n");
        File.Move(tmp, path, overwrite: true);
    }

    private static JsonObject? ValidateForReindex(JsonNode? parsed)
    {
        try
        {
            return Validate.AssertHandover(parsed);
        }
        catch (HandoverValidationException)
        {
            return null;
        }
    }
}
