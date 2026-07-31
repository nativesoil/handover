// Four saving processes, one store.
//
// HandoverStore.Save was an unlocked read-modify-write, so two processes
// against one store both read the same NextCode, both wrote a document at that
// code, and the second index write erased the first one's row. Both callers
// were told "saved", and both were given the same load code.
//
// Measured on the unlocked store, four processes saving fifteen times each:
// 60 acknowledged and 18, 16 and 18 documents on disk over three runs, so 42,
// 44 and 42 acknowledgements for documents that no longer existed. The store
// now takes the lock in Lock.cs, and this file is what says so.
//
// The checks are the ones the TypeScript CLI's concurrency test makes, because
// it is the same defect:
//
//   1. every save the store acknowledged is on disk afterwards
//   2. no two acknowledgements carry the same load code
//   3. every acknowledged code still holds the document that receipt named
//   4. no half-written temporary file survived the race
//
// Nothing here identifies a writer by its process id. Markers are random ids
// (see SoilHandover.ConcurrentSave): two containers on one volume both run as
// pid 1, and a test that told writers apart by pid would agree with itself for
// the wrong reason.
//
// Threads would prove nothing here: one process is already safe, and what is
// being reproduced is what happens between two. So the workers are real
// processes, built from SoilHandover.ConcurrentSave before the race starts.
//
// ONE UNEXPLAINED FAILURE, RECORDED. This test failed once, on 2026-07-29, on
// macOS 15 (arm64) with .NET SDK 8.0.423, on a tree with no changes to this
// SDK or to the store. It failed at the "nothing was refused" assertion below,
// not at any of the four invariants: one worker reported a refused save whose
// error was `IOException: Invalid argument` against a path under the system
// temp directory. The other 189 tests passed. It did not reproduce on any of
// the four runs afterwards, on the same machine, with the same command.
//
// What that does and does not license. Because the assertion above the
// invariants threw, the four invariants were NOT evaluated on that run, so
// nothing here says they held. No acknowledged save was observed to be
// missing, because nothing got as far as looking. The likely reading is the
// host's temp filesystem rather than the store, since `Invalid argument` on a
// path is an errno from the filesystem layer and not a shape this code
// produces. That reading is INFERRED and was never confirmed.
//
// It is written down rather than dismissed. A failure that happened once and
// then stopped is not proven environmental by not repeating, and a suite that
// quietly forgets its one red run is reporting robustness it did not measure.
// If this returns, the thing to capture is the worker's stderr and the full
// path in the error before rerunning, because the rerun is what has been
// destroying the evidence.
//
// EXPLAINED, 2026-07-30. The environmental reading above was wrong, and the
// instinct to write the failure down was right. Repetition on the same
// machine reproduced this test's whole family of intermittent failures:
// refused saves with IOException `Invalid argument` and
// DirectoryNotFoundException, and runs where the store acknowledged sixty
// saves and held fifty-nine documents, which is the exact loss the four
// invariants exist to catch and which CI's managed leg also hit. All of them
// came from one defect in Lock.cs: .NET answers a stat of a missing path
// with a 1601 sentinel instead of an error, so a waiter that looked at the
// lock directory in the instant after a release read the vanished name as
// four centuries stale, removed it out from under whichever process had just
// taken it, and let two writers into one store. The full account is on
// DirectoryAge in Lock.cs, where the sentinel is now mapped to now, the way
// the other four SDKs' locks already behaved.

using System.Diagnostics;
using System.Text.Json.Nodes;
using Xunit;

namespace Soil.Handover.Tests;

public class ConcurrencyTests : IDisposable
{
    private const int Processes = 4;
    private const int SavesPerProcess = 15;

    /// <summary>How long the workers get before the test gives up on them.</summary>
    private const int WorkerTimeoutMs = 120_000;

    private readonly TestData.TempHome _home = new();

    public void Dispose() => _home.Dispose();

    /// <summary>
    /// The dotnet muxer. The test runner sets DOTNET_HOST_PATH to the one that
    /// launched it, which is the one that can also run the worker; falling back
    /// to the name on PATH is only for a runner that does not.
    /// </summary>
    private static string DotnetHost()
        => Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet";

    /// <summary>Build the worker once, into a directory of this test's own.</summary>
    private static string BuildWorker(string into)
    {
        var project = Path.Combine(
            TestData.RepoRoot,
            "packages", "sdk-dotnet", "SoilHandover.ConcurrentSave",
            "SoilHandover.ConcurrentSave.csproj");
        var build = Process.Start(new ProcessStartInfo(DotnetHost())
        {
            ArgumentList = { "build", project, "-c", "Release", "-o", into },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        })!;
        var output = build.StandardOutput.ReadToEnd() + build.StandardError.ReadToEnd();
        Assert.True(build.WaitForExit(WorkerTimeoutMs), "building the worker timed out");
        Assert.True(build.ExitCode == 0, $"building the worker failed: {output}");
        return Path.Combine(into, "Soil.Handover.ConcurrentSave.dll");
    }

    [Fact]
    public void LosesNothingWhenFourProcessesSaveIntoOneStore()
    {
        var store = Path.Combine(_home.Path, "store");
        var docs = Path.Combine(_home.Path, "docs");
        var acksDir = Path.Combine(_home.Path, "acks");
        Directory.CreateDirectory(store);
        Directory.CreateDirectory(docs);
        Directory.CreateDirectory(acksDir);
        var worker = BuildWorker(Path.Combine(_home.Path, "worker"));

        // Each worker gets its own file to write, rather than one file all
        // four append to. An append is only indivisible if the platform makes
        // it so, and here it is not: the worker appends through
        // File.AppendAllText, so two processes can settle on the same offset
        // and one overwrites the other. The Python race lost acknowledgements
        // exactly this way and was repaired by handing each worker its own
        // file; this is the same repair for the same defect. The count that is
        // supposed to prove the store lost nothing must not be the only thing
        // losing anything.
        //
        // The worker is unchanged and still writes wherever it is told,
        // because the cross-language harness in conformance/interop runs these
        // same workers and hands all of them one file.
        var written = new List<string>();
        for (var i = 0; i < Processes; i += 1)
        {
            written.Add(Path.Combine(acksDir, $"{i}.jsonl"));
        }

        var startAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 2_000;
        var children = new List<Process>();
        foreach (var outPath in written)
        {
            children.Add(Process.Start(new ProcessStartInfo(DotnetHost())
            {
                ArgumentList =
                {
                    worker,
                    store,
                    startAt.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    SavesPerProcess.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    outPath,
                    docs,
                },
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            })!);
        }
        foreach (var child in children)
        {
            var error = child.StandardError.ReadToEnd();
            Assert.True(child.WaitForExit(WorkerTimeoutMs), "a worker did not finish in time");
            Assert.True(child.ExitCode == 0, $"a worker failed: {error}");
        }

        var lines = written
            .SelectMany(File.ReadAllLines)
            .Where(line => line.Trim().Length > 0)
            .Select(line => (JsonObject)JsonNode.Parse(line)!)
            .ToList();
        Assert.Equal(Processes * SavesPerProcess, lines.Count);

        // A save that was refused under contention is honest, and this store is
        // uncontended enough that none should be. Either way the invariants
        // below are about what was acknowledged, never about what was tried.
        var refused = lines.Where(line => !line["ok"]!.GetValue<bool>()).ToList();
        Assert.Equal(
            Array.Empty<string>(),
            refused.Select(line => line["error"]!.GetValue<string>()).ToArray());
        var acknowledged = lines.Where(line => line["ok"]!.GetValue<bool>()).ToList();
        Assert.Equal(Processes * SavesPerProcess, acknowledged.Count);

        var handoverStore = new HandoverStore(store);

        // 1. Nothing the store handed a code back for may be missing afterwards.
        var onDisk = Directory.GetFiles(handoverStore.HandoversDir)
            .Select(Path.GetFileName)
            .Cast<string>()
            .ToList();
        Assert.Equal(
            acknowledged.Count,
            onDisk.Count(name => name.EndsWith(".json", StringComparison.Ordinal)));
        Assert.Equal(acknowledged.Count, handoverStore.List().Count);

        // 2. No two receipts may carry the same load code.
        var codes = acknowledged.Select(line => line["code"]!.GetValue<string>()).ToList();
        Assert.Equal(codes.Count, codes.Distinct().Count());

        // 3. Every receipt's code must still hold the document it named.
        foreach (var line in acknowledged)
        {
            var code = line["code"]!.GetValue<string>();
            var marker = line["marker"]!.GetValue<string>();
            Assert.Equal(marker, handoverStore.Read(code)["title"]!.GetValue<string>());
        }

        // 4. No half-written temporary file survived the race.
        Assert.Equal(
            Array.Empty<string>(),
            onDisk.Where(name => name.Contains(".tmp-", StringComparison.Ordinal)).ToArray());
    }
}
