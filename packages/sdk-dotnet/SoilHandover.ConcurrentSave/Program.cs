// One saving writer process for the .NET concurrency test.
//
// The failure this file exists to reproduce cannot be written inside one
// process. Documents are only lost when two *processes* share one store, and
// two processes on one store is not exotic: it is an agent saving while a
// person saves, or two containers on one volume.
//
// Usage:
//   Soil.Handover.ConcurrentSave <soilHome> <startAtMs> <count> <out> <docDir>
//
// Every acknowledgement the store hands back is appended to <out> as one JSON
// line, together with the marker the document carried, so the test can check
// each receipt against the disk. A refused save is recorded as one line too:
// a refusal is a legitimate answer under contention, an acknowledgement for a
// write that did not survive is not.
//
// Nothing here identifies a writer by its process id. Markers are random ids:
// two containers on one volume both run as pid 1, so a test that told writers
// apart by pid would agree with itself for the wrong reason.

using System.Text.Json.Nodes;

using Soil.Handover;

if (args.Length != 5)
{
    Console.Error.WriteLine(
        "usage: Soil.Handover.ConcurrentSave <soilHome> <startAtMs> <count> <out> <docDir>");
    return 2;
}

var home = args[0];
var startAt = long.Parse(args[1], System.Globalization.CultureInfo.InvariantCulture);
var count = int.Parse(args[2], System.Globalization.CultureInfo.InvariantCulture);
var outPath = args[3];

var workerId = Guid.NewGuid().ToString();
var store = new HandoverStore(home);

// A deliberate busy wait, so the processes collide instead of queueing.
while (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < startAt)
{
}

for (var i = 0; i < count; i += 1)
{
    var marker = $"{workerId}-{i}";
    JsonObject line;
    try
    {
        var entry = store.Save(Document(marker));
        line = new JsonObject
        {
            ["ok"] = true,
            ["code"] = entry.Code,
            ["marker"] = marker,
        };
    }
    catch (Exception error)
    {
        line = new JsonObject
        {
            ["ok"] = false,
            ["marker"] = marker,
            ["error"] = $"{error.GetType().Name}: {error.Message}",
        };
    }
    // ToJsonString is compact by default: one acknowledgement per line, so
    // the reader can split on newlines.
    File.AppendAllText(outPath, line.ToJsonString() + "\n");
}

return 0;

static JsonObject Document(string marker)
{
    var sections = new JsonObject();
    foreach (var key in Sections.SectionKeys)
    {
        sections[key] = new JsonObject { ["status"] = "missing", ["summary"] = null };
    }
    sections["projectIdentity"] = new JsonObject
    {
        ["status"] = "available",
        ["summary"] = marker,
    };
    return new JsonObject
    {
        ["soilHandover"] = "1.0",
        ["projectId"] = "billing-rework",
        ["title"] = marker,
        ["createdAt"] = "2026-07-24T10:00:00.000Z",
        ["sections"] = sections,
    };
}
