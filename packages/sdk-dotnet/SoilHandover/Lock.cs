using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Soil.Handover;

/// <summary>
/// Thrown when a lock could not be taken. Nothing was written.
/// </summary>
public sealed class LockBusyException : Exception
{
    public LockBusyException(string lockName)
        : base($"another process is writing and the {lockName} lock could not be taken; " +
               "nothing was written, try again")
    {
        LockName = lockName;
    }

    /// <summary>The lock that was contended, as a short name, never a path.</summary>
    public string LockName { get; }
}

/// <summary>
/// The single-writer guarantee.
///
/// Every state change that touches a store is a read-modify-write: read
/// <c>index.json</c>, write a document, write <c>index.json</c> back. Inside
/// one thread that is safe enough; across two processes on one directory it
/// is not safe at all, and the failure is silent. Both processes read the
/// same index, both write a document at the same load code, and the second
/// index write erases the first one's row. Both callers were told "saved".
///
/// Two processes on one directory is not a hypothetical. It is two containers
/// on one volume, and it is two saves against one <c>~/.soil</c> — an agent
/// saving beside a person doing the same.
///
/// <para><b>The mechanism.</b> An advisory lock directory, taken atomically.
/// Creating a directory either succeeds or fails because one is already
/// there, in one indivisible step, on every filesystem this code can run on
/// including NFS, where exclusive creation of a plain file historically could
/// not be trusted.</para>
///
/// <para>A <c>holder.json</c> inside the directory records who holds it. The
/// holder id is random, never a process id. Two containers that both run as
/// pid 1 must not be able to look like each other; that also rules out any
/// "is that pid alive" stale check, which would be wrong across containers
/// anyway.</para>
///
/// <para><b>When the lock cannot be taken</b> the write is refused. Nothing
/// is written and nothing is half-written: the caller gets a
/// <see cref="LockBusyException"/>. A refusal a caller can retry is the
/// honest outcome; the thing that must never happen is an acknowledgement for
/// a write that did not survive.</para>
///
/// <para>A stale lock, left by a process that was killed mid-write, is broken
/// after <see cref="DefaultStaleMs"/>. Breaking a lock is the one unsound
/// moment in any advisory scheme, so it is deliberately far beyond any honest
/// hold time.</para>
///
/// <para>The on-disk shape — the <c>&lt;name&gt;.lock</c> directory, the
/// <c>holder.json</c> inside it and the fields it carries — is the same in all
/// five SDKs, so a .NET writer and a Go writer on one store wait for each
/// other.</para>
///
/// <para><b>Two refusals, one rule.</b> Both ends of the lock are a filesystem
/// call that can be refused for a reason that passes, and both are held to the
/// same rule: retry for <see cref="RetryBudgetMs"/>, then report the refusal as
/// itself.</para>
///
/// <para>Releasing is a directory removal. It is refused on Windows when
/// another process holds a file inside the directory open, which is exactly
/// what every waiter is doing to <c>holder.json</c>. A release whose outcome is
/// discarded is worse than one that fails loudly: the holder carries on
/// believing it released, and every other writer waits the whole staleness
/// window for a lock that nobody holds.</para>
///
/// <para>Taking is a directory create. It says already-exists when somebody
/// else holds the lock, and that is the ordinary answer, but it is not the only
/// way a platform says the name is unavailable. Windows refuses a create on a
/// name whose deletion has been accepted and not yet finished, with access
/// denied, while a lookup of that same name already reports it as gone: for a
/// few milliseconds the name is neither present nor creatable. Measured on a
/// Windows runner over 180 repetitions of two races: 38 refused creates, all of
/// them access denied, all of them with a lookup reporting the name absent, and
/// every one resolving into a taken lock between 4 and 121 milliseconds.</para>
///
/// <para>So a create refused for anything but already-exists is treated as
/// contention for as long as the budget, and reported as itself once the budget
/// is spent. It is never turned into a <see cref="LockBusyException"/>, because
/// a directory that cannot be created is not a busy lock, and the difference
/// has to reach the caller.</para>
/// </summary>
public static class WriteLock
{
    /// <summary>How long an acquire waits before giving up.</summary>
    public const int DefaultTimeoutMs = 5_000;

    /// <summary>How old a lock must be before it is treated as abandoned.</summary>
    public const int DefaultStaleMs = 30_000;

    /// <summary>
    /// How long either side of the lock keeps trying a filesystem call that was
    /// refused for a reason that passes, before reporting the refusal as
    /// itself. Well inside <see cref="DefaultTimeoutMs"/>, so a retry never
    /// itself becomes the reason a waiter is refused, and far short of
    /// <see cref="DefaultStaleMs"/>.
    /// </summary>
    private const int RetryBudgetMs = 1_000;

    private const string HolderFile = "holder.json";

    /// <summary>
    /// The host name, looked up once. Informational only: nothing is ever
    /// decided from it.
    /// </summary>
    private static readonly string HostName = ReadHostName();

    private static string ReadHostName()
    {
        try
        {
            return Environment.MachineName;
        }
        catch (InvalidOperationException)
        {
            return "unknown";
        }
    }

    /// <summary>
    /// Run <paramref name="body"/> while holding the named lock.
    ///
    /// <paramref name="locksDir"/> must sit on the same volume as the data it
    /// guards, because that is the only thing two processes are guaranteed to
    /// share. <see cref="HandoverStore"/> passes <c>&lt;store root&gt;/.locks</c>,
    /// which is where every SDK puts it, so the layout stays identical.
    /// </summary>
    /// <exception cref="LockBusyException">
    /// The lock could not be taken in time. Nothing ran, and nothing was
    /// written.
    /// </exception>
    public static T With<T>(
        string locksDir,
        string name,
        Func<T> body,
        int timeoutMs = DefaultTimeoutMs,
        int staleMs = DefaultStaleMs)
    {
        var directory = Path.Combine(locksDir, $"{name}.lock");
        var holderId = RandomId();
        var holder = new JsonObject
        {
            ["holder"] = holderId,
            ["acquiredAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["host"] = HostName,
            // Informational only. Nothing is ever decided from this.
            ["pid"] = Environment.ProcessId,
        };

        Directory.CreateDirectory(locksDir);

        var deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + timeoutMs;
        var taken = false;
        // When the first create was refused for a reason other than
        // already-exists. Reset the moment a create is refused for
        // already-exists, because that is the name becoming visible again:
        // whatever the earlier refusal was, it is over.
        var refusedAt = 0L;
        while (true)
        {
            var created = false;
            try
            {
                created = NativeDirectory.TryCreateExclusive(directory);
                refusedAt = 0L;
            }
            catch (IOException)
            {
                // Not already-exists, and not necessarily fatal either. See
                // "Two refusals, one rule" above: this is how one platform says
                // a name is on its way out. Give it the budget, then let it
                // speak.
                if (!Directory.Exists(Path.GetDirectoryName(directory)))
                {
                    // Except when there is nothing to wait for. No amount of
                    // waiting makes a name creatable inside a directory that is
                    // not there, and the caller should hear that at once.
                    throw;
                }
                if (refusedAt == 0L)
                {
                    refusedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                }
                if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - refusedAt
                    >= RetryBudgetMs)
                {
                    throw;
                }
                Thread.Sleep(3 + RandomNumberGenerator.GetInt32(9));
                continue;
            }
            if (created)
            {
                taken = true;
                break;
            }

            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var current = ReadHolder(directory);
            if (current is not null)
            {
                if (now - current.Value.AcquiredAt > staleMs)
                {
                    BreakIfStale(directory, current.Value);
                    continue;
                }
            }
            else if (now - DirectoryAge(directory) > staleMs)
            {
                // A lock directory with no readable holder file is either one
                // created a microsecond ago, or one whose owner died between
                // the create and the write. Without this branch the second
                // case would be a lock nothing can ever break, so the
                // directory's own modification time stands in for the holder.
                RemoveLockDirectory(directory);
                continue;
            }

            if (now >= deadline)
            {
                break;
            }
            // A little jitter, so two waiters do not wake in lockstep forever.
            Thread.Sleep(3 + RandomNumberGenerator.GetInt32(9));
        }

        if (!taken)
        {
            throw new LockBusyException(name);
        }

        File.WriteAllText(Path.Combine(directory, HolderFile), holder.ToJsonString());
        Exception? failure = null;
        T result;
        try
        {
            result = body();
        }
        finally
        {
            // Release only what is still ours. If the lock was broken as stale
            // while this body ran, the directory now belongs to somebody else
            // and removing it would hand a third process a lock two processes
            // think they hold.
            var current = ReadHolder(directory);
            if (current is null || current.Value.Id == holderId)
            {
                failure = ReleaseLockDirectory(directory);
            }
        }

        // Reached only when the body returned. A body that threw carries the
        // more informative failure, and it has already left this method.
        if (failure is not null)
        {
            throw failure;
        }
        return result;
    }

    /// <summary>The same, for a body that hands nothing back.</summary>
    public static void With(
        string locksDir,
        string name,
        Action body,
        int timeoutMs = DefaultTimeoutMs,
        int staleMs = DefaultStaleMs)
        => With<object?>(locksDir, name, () => { body(); return null; }, timeoutMs, staleMs);

    private readonly record struct HolderRecord(string Id, long AcquiredAt);

    /// <summary>A random identifier, never anything derived from the process.</summary>
    private static string RandomId()
        => Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();

    /// <summary>
    /// The holder record, or null when there is not a readable one. A lock
    /// directory with no readable holder file is one that was created a moment
    /// ago, or one whose holder died between the two steps; both are handled
    /// by the staleness path in <see cref="With{T}"/>.
    /// </summary>
    private static HolderRecord? ReadHolder(string directory)
    {
        string text;
        try
        {
            text = File.ReadAllText(Path.Combine(directory, HolderFile));
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }

        try
        {
            if (JsonNode.Parse(text) is not JsonObject record)
            {
                return null;
            }
            if (record["holder"] is not JsonValue holderValue
                || !holderValue.TryGetValue<string>(out var holder))
            {
                return null;
            }
            if (record["acquiredAt"] is not JsonValue acquiredValue
                || !acquiredValue.TryGetValue<long>(out var acquiredAt))
            {
                return null;
            }
            return new HolderRecord(holder, acquiredAt);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// The value <see cref="Directory.GetLastWriteTimeUtc(string)"/> hands
    /// back for a path that is not there: 1601-01-01, instead of an error.
    /// </summary>
    private static readonly DateTime MissingPathSentinel = DateTime.FromFileTimeUtc(0);

    /// <summary>
    /// When the lock directory itself was last written, or now if unreadable
    /// or absent.
    ///
    /// <para>Absent needs saying here and nowhere else. Every other SDK's lock
    /// asks its platform with a stat call that refuses on a missing path, and
    /// maps the refusal to now. This one asks an API that answers a missing
    /// path with the 1601 sentinel, and read literally that answer is stale by
    /// four centuries. It made the ordinary instant after a release, when the
    /// name is briefly gone between one waiter's failed create and its look at
    /// the age, read as an abandoned lock: the waiter would remove the name,
    /// removing it out from under whichever process had just taken it, and two
    /// writers were inside one store. The store then lost documents it had
    /// acknowledged, which is the exact thing the lock exists to make
    /// impossible. A directory that is not there is not an abandoned lock; it
    /// is the next chance to take the name, so it reports as brand new and the
    /// acquire loop goes back to the create, which is the resolution that
    /// already existed.</para>
    /// </summary>
    private static long DirectoryAge(string directory)
    {
        try
        {
            var written = Directory.GetLastWriteTimeUtc(directory);
            if (written == MissingPathSentinel)
            {
                return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
            return new DateTimeOffset(written, TimeSpan.Zero).ToUnixTimeMilliseconds();
        }
        catch (IOException)
        {
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }
    }

    /// <summary>
    /// Break a lock that looks abandoned, but only the exact one that was seen
    /// to be abandoned: the holder id is re-read immediately before the
    /// removal, so a lock that changed hands in between is left alone.
    ///
    /// <para>A removal that fails here is left to the acquire loop, which comes
    /// back within milliseconds and tries again. That is the difference between
    /// this path and the release path: here the caller is about to look, so
    /// nothing is being told that the lock is gone.</para>
    /// </summary>
    private static void BreakIfStale(string directory, HolderRecord seen)
    {
        var again = ReadHolder(directory);
        if (again is null || again.Value.Id != seen.Id)
        {
            return;
        }
        RemoveLockDirectory(directory);
    }

    /// <summary>
    /// Remove the lock directory and whatever is inside it, once.
    ///
    /// <para>Hands back null when the directory is gone afterwards, and the
    /// failure when it is still there. Nobody may assume the removal happened:
    /// that assumption is what turns one refused delete into a lock held for
    /// the whole staleness window.</para>
    /// </summary>
    private static Exception? RemoveLockDirectory(string directory)
    {
        try
        {
            File.Delete(Path.Combine(directory, HolderFile));
        }
        catch (IOException)
        {
            // Left to the removal below, which is the call whose outcome is
            // read.
        }
        catch (UnauthorizedAccessException)
        {
        }

        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (DirectoryNotFoundException)
        {
            return null;
        }
        catch (IOException error)
        {
            return error;
        }
        catch (UnauthorizedAccessException error)
        {
            return error;
        }
        return null;
    }

    /// <summary>
    /// Give the lock back, retrying a removal that failed for a passing reason.
    ///
    /// <para>Deleting a file another process holds open is refused outright on
    /// some platforms, and every waiter reads <c>holder.json</c> a few times a
    /// second, so a release and a waiter's read do collide. The collision lasts
    /// as long as one read, which is why retrying is what resolves it, on the
    /// same jitter the acquire loop uses. Measured on a Windows runner against
    /// the Python port of this file: one release in fifty was refused this way,
    /// and the lock it failed to give back stayed held for the full thirty
    /// seconds, refusing every save in that window.</para>
    ///
    /// <para>Whatever is still there when the budget is spent is handed back
    /// rather than dropped. A lock this process holds and cannot give back is
    /// one every other writer waits the staleness window for, and this process
    /// is the only one in a position to say so.</para>
    /// </summary>
    private static Exception? ReleaseLockDirectory(string directory)
    {
        var deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + RetryBudgetMs;
        while (true)
        {
            var failure = RemoveLockDirectory(directory);
            if (failure is null || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= deadline)
            {
                return failure;
            }
            Thread.Sleep(3 + RandomNumberGenerator.GetInt32(9));
        }
    }
}

/// <summary>
/// Creating a directory, exclusively, in one indivisible step.
///
/// The .NET standard library cannot express this. <c>Directory.CreateDirectory</c>
/// succeeds whether or not the directory was already there, so it can never
/// tell a lock's holder from a lock's waiter; <c>Directory.Move</c> onto an
/// existing directory does throw, but by testing for the destination first,
/// which is a check two processes can both pass. Both were measured on this
/// machine before this file was written.
///
/// So the platform's own call is used directly: <c>mkdir(2)</c>, which fails
/// with <c>EEXIST</c>, and <c>CreateDirectoryW</c>, which fails with
/// <c>ERROR_ALREADY_EXISTS</c>. Both are atomic and both are documented to be.
/// This is an interop call into the operating system, not a package: the SDK
/// still has no external dependency.
/// </summary>
internal static class NativeDirectory
{
    private const int EEXIST = 17;
    private const int ErrorAlreadyExists = 183;

    /// <summary>0o777, left for the process umask to narrow, as mkdir(2) expects.</summary>
    private const uint DirectoryMode = 0x1FF;

    /// <summary>
    /// Create the directory, and report whether this call is the one that
    /// created it. False means somebody else already holds that name.
    /// </summary>
    /// <exception cref="IOException">
    /// The directory could not be created for any reason other than already
    /// existing. A lock that cannot say why it failed is worse than one that
    /// throws.
    /// </exception>
    internal static bool TryCreateExclusive(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            if (CreateDirectoryW(path, IntPtr.Zero))
            {
                return true;
            }
            var windowsError = Marshal.GetLastWin32Error();
            if (windowsError == ErrorAlreadyExists)
            {
                return false;
            }
            throw new IOException(
                $"could not create the lock directory {path}: Windows error {windowsError}");
        }

        if (Mkdir(path, DirectoryMode) == 0)
        {
            return true;
        }
        var errno = Marshal.GetLastWin32Error();
        if (errno == EEXIST)
        {
            return false;
        }
        throw new IOException($"could not create the lock directory {path}: errno {errno}");
    }

    [DllImport("libc", EntryPoint = "mkdir", SetLastError = true)]
    private static extern int Mkdir(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string path,
        uint mode);

    [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", SetLastError = true,
        CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateDirectoryW(string path, IntPtr securityAttributes);
}
