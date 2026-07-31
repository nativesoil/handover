using System.Text.Json.Nodes;
using Xunit;

namespace Soil.Handover.Tests;

/// <summary>The write lock, the same properties the TypeScript reference holds.</summary>
public class LockTests : IDisposable
{
    private readonly TestData.TempHome _home = new();

    private string Locks => Path.Combine(_home.Path, ".locks");

    public void Dispose() => _home.Dispose();

    /// <summary>Leave behind exactly what another process holding the lock leaves.</summary>
    private string HoldFromElsewhere(string name, string holder, long acquiredAt, int pid)
    {
        var directory = Path.Combine(Locks, $"{name}.lock");
        Directory.CreateDirectory(directory);
        var record = new JsonObject
        {
            ["holder"] = holder,
            ["acquiredAt"] = acquiredAt,
            ["host"] = "elsewhere",
            ["pid"] = pid,
        };
        File.WriteAllText(Path.Combine(directory, "holder.json"), record.ToJsonString());
        return directory;
    }

    private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    [Fact]
    public void RunsTheBodyAndLeavesNothingBehind()
    {
        Assert.Equal(42, WriteLock.With(Locks, "store", () => 42));
        Assert.False(Directory.Exists(Path.Combine(Locks, "store.lock")));
    }

    [Fact]
    public void ReleasesWhenTheBodyThrows()
    {
        var thrown = Assert.Throws<InvalidOperationException>(
            () => WriteLock.With<int>(Locks, "store", () => throw new InvalidOperationException("boom")));
        Assert.Equal("boom", thrown.Message);
        Assert.False(Directory.Exists(Path.Combine(Locks, "store.lock")));
    }

    [Fact]
    public void RefusesRatherThanRunningTheBodyWhileSomebodyElseHoldsIt()
    {
        HoldFromElsewhere("store", "11111111-1111-4111-8111-111111111111", NowMs(), 1);
        var ran = false;
        Assert.Throws<LockBusyException>(
            () => WriteLock.With(Locks, "store", () => ran = true, timeoutMs: 60));
        // The point of the refusal: nothing was written, not even partly.
        Assert.False(ran);
    }

    [Fact]
    public void DoesNotDecideAnythingFromAProcessId()
    {
        // Two containers on one volume both run as pid 1. A lock whose holder
        // carries *this* process's own pid must still be treated as somebody
        // else's, or a fix that leans on pids being distinct silently opens the
        // race it was meant to close.
        HoldFromElsewhere(
            "store", "22222222-2222-4222-8222-222222222222", NowMs(), Environment.ProcessId);
        Assert.Throws<LockBusyException>(
            () => WriteLock.With(Locks, "store", () => 0, timeoutMs: 60));
    }

    [Fact]
    public void TakesOverALockWhoseHolderDied()
    {
        HoldFromElsewhere(
            "store", "33333333-3333-4333-8333-333333333333", NowMs() - 120_000, 1);
        Assert.Equal(
            "taken",
            WriteLock.With(Locks, "store", () => "taken", timeoutMs: 500, staleMs: 1_000));
    }

    [Fact]
    public void TakesOverALockDirectoryWhoseOwnerDiedBeforeWritingAHolder()
    {
        // The window between the create and the holder write. Without a
        // fallback this would be a lock nothing could ever break.
        Directory.CreateDirectory(Path.Combine(Locks, "store.lock"));
        Assert.Equal(
            "taken",
            WriteLock.With(Locks, "store", () => "taken", timeoutMs: 500, staleMs: 0));
    }

    [Fact]
    public void KeepsDifferentNamesApart()
    {
        HoldFromElsewhere("personal-a", "44444444-4444-4444-8444-444444444444", NowMs(), 1);
        // A held personal store must not block a different store's writer.
        Assert.Equal("fine", WriteLock.With(Locks, "personal-b", () => "fine", timeoutMs: 60));
    }

    [Fact]
    public void WritesARandomHolderIdNeverAPredictableOne()
    {
        var seen = new HashSet<string>();
        for (var i = 0; i < 3; i += 1)
        {
            WriteLock.With(Locks, "store", () =>
            {
                var record = (JsonObject)JsonNode.Parse(
                    File.ReadAllText(Path.Combine(Locks, "store.lock", "holder.json")))!;
                return seen.Add(record["holder"]!.GetValue<string>());
            });
        }
        Assert.Equal(3, seen.Count);
    }

    [Fact]
    public void CreatingTheLockDirectoryIsExclusive()
    {
        // The property the whole mechanism rests on, and the one the .NET
        // standard library cannot give: the first caller creates it, the
        // second is told it was already there rather than being handed it.
        var directory = Path.Combine(Locks, "exclusive.lock");
        Directory.CreateDirectory(Locks);
        Assert.True(NativeDirectory.TryCreateExclusive(directory));
        Assert.False(NativeDirectory.TryCreateExclusive(directory));
    }

    [Fact]
    public void TheStoreLocksWhereEveryOtherSdkPutsIt()
    {
        // The on-disk contract: one store, five SDKs, one lock directory.
        var store = new HandoverStore(_home.Path);
        Assert.Equal(Path.Combine(_home.Path, ".locks"), store.LocksDir);
    }

    [Fact]
    public void ACreateThatCanNeverWorkFailsAtOnceSayingWhy()
    {
        // A create refused for something other than already-exists is treated
        // as contention, because on Windows that is how a name on its way out
        // is reported. That must not swallow a create that will never work: a
        // lock inside a directory that is not there is not a busy lock, and the
        // caller has to be told the difference, immediately and in the
        // platform's own words.
        var started = DateTimeOffset.UtcNow;
        var thrown = Assert.ThrowsAny<Exception>(
            () => WriteLock.With(Locks, Path.Combine("missing", "child"), () => "never"));
        Assert.IsNotType<LockBusyException>(thrown);
        Assert.IsAssignableFrom<IOException>(thrown);
        // Fast, not after the retry budget and not after the acquire timeout.
        Assert.True((DateTimeOffset.UtcNow - started).TotalMilliseconds < 500);
    }
}
