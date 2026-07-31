using System.Text.Json.Nodes;
using Xunit;

namespace Soil.Handover.Tests;

/// <summary>
/// The open save-time baseline, held to the reference byte for byte.
///
/// The corpus under <c>golden/check/</c> is shared across the ports and was
/// designed to attack this one: every rule firing and none, counts on each
/// grade-band edge, thresholds met and missed by one unit, content outside
/// the Basic Multilingual Plane, and a decisions section whose entry order
/// punishes a wrong sort. The expected files beside each document were
/// produced by the built TypeScript reference through
/// <c>tools/generate-golden.mjs</c>, never by hand.
/// </summary>
public sealed class CheckParityTests
{
    private const string ProducedBy = "soil-cli/0.1.0";
    private const string ProducedAt = "2026-07-22T10:00:00Z";

    private static string CorpusDir
        => Path.Combine(AppContext.BaseDirectory, "golden", "check");

    private static IReadOnlyList<string> CorpusNames()
        => Directory.GetFiles(CorpusDir, "*.card.txt")
            .Select(path => Path.GetFileName(path)![..^".card.txt".Length])
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

    private static JsonObject CorpusDocument(string name)
        => TestData.ReadJson(Path.Combine(CorpusDir, $"{name}.json"));

    private static string CorpusText(string name)
        => File.ReadAllText(Path.Combine(CorpusDir, name));

    [Fact]
    public void TheCorpusIsPresentAndWhole()
    {
        // A deleted corpus directory must fail loudly rather than pass an
        // empty loop.
        Assert.Equal(18, CorpusNames().Count);
    }

    [Fact]
    public void TheCheckCardIsByteIdenticalToTheReference()
    {
        foreach (var name in CorpusNames())
        {
            var document = CorpusDocument(name);
            var report = Check.CheckHandover(document);
            Assert.Equal(
                CorpusText($"{name}.card.txt"),
                Render.RenderCheck(document, report));
        }
    }

    [Fact]
    public void TheReportJsonIsByteIdenticalToTheReference()
    {
        foreach (var name in CorpusNames())
        {
            var document = CorpusDocument(name);
            var report = Check.CheckHandover(document);
            Assert.Equal(
                CorpusText($"{name}.report.json"),
                JsonCanon.Stringify(Check.CheckReportJson(report)) + "\n");
        }
    }

    [Fact]
    public void TheObservationIsByteIdenticalToTheReference()
    {
        foreach (var name in CorpusNames())
        {
            var document = CorpusDocument(name);
            var report = Check.CheckHandover(document);
            var observation =
                Check.CheckObservation(document, report, ProducedBy, ProducedAt);
            Assert.Equal(
                CorpusText($"{name}.observation.json"),
                JsonCanon.Stringify(observation) + "\n");
        }
    }
}

public sealed class CheckBehaviourTests
{
    private const string ProducedBy = "soil-cli/0.1.0";
    private const string ProducedAt = "2026-07-22T10:00:00Z";

    [Fact]
    public void CheckingIsDeterministicAndDoesNotTouchTheDocument()
    {
        var example = TestData.Example();
        var before = JsonCanon.Stringify(example);
        var first = Check.CheckHandover(example);
        var second = Check.CheckHandover(example);
        Assert.Equal(
            JsonCanon.Stringify(Check.CheckReportJson(first)),
            JsonCanon.Stringify(Check.CheckReportJson(second)));
        Assert.Equal(before, JsonCanon.Stringify(example));
    }

    [Fact]
    public void TheGradeMappingMatchesTheDocumentedTableExactly()
    {
        Assert.Equal("strong", Check.GradeFromCounts(new CheckCounts(0, 0, 0)));
        Assert.Equal("strong", Check.GradeFromCounts(new CheckCounts(0, 0, 9)));
        Assert.Equal("adequate", Check.GradeFromCounts(new CheckCounts(0, 1, 0)));
        Assert.Equal("adequate", Check.GradeFromCounts(new CheckCounts(0, 5, 0)));
        Assert.Equal("thin", Check.GradeFromCounts(new CheckCounts(0, 6, 0)));
        Assert.Equal("thin", Check.GradeFromCounts(new CheckCounts(1, 0, 0)));
        Assert.Equal("thin", Check.GradeFromCounts(new CheckCounts(2, 9, 0)));
        Assert.Equal("failing", Check.GradeFromCounts(new CheckCounts(3, 0, 0)));
    }

    [Fact]
    public void SplitEntriesSplitsNumberedItemsBulletsAndParagraphs()
    {
        Assert.Equal(
            new[] { "Intro line:", "1. First.", "2. Second continued.", "- Third." },
            Check.SplitEntries("Intro line:\n\n1. First.\n2. Second\ncontinued.\n- Third."));
    }

    [Fact]
    public void EveryFindingCarriesADocumentedRuleId()
    {
        var bare = TestData.Normalized(JsonNode.Parse(
            "{\"handoverId\": \"" + TestData.AValidId + "\"," +
            " \"projectId\": \"check-test\"," +
            " \"title\": \"Check test\", \"sections\": {}}"));
        var report = Check.CheckHandover(bare);
        Assert.NotEmpty(report.Findings);
        foreach (var finding in report.Findings)
        {
            Assert.True(Check.CheckRules.ContainsKey(finding.Rule), finding.Rule);
            Assert.NotEmpty(finding.Message);
        }
    }

    [Fact]
    public void TheObservationCarriesTheClosedFieldSetAndNothingElse()
    {
        var example = TestData.Example();
        var report = Check.CheckHandover(example);
        var observation =
            Check.CheckObservation(example, report, ProducedBy, ProducedAt);
        var data = (JsonObject)observation["data"]!;
        Assert.Equal(
            new[]
            {
                "blockedSections", "checkVersion", "findings",
                "missingSections", "notes", "sectionsWithContent",
            },
            data.Select(pair => pair.Key).OrderBy(key => key, StringComparer.Ordinal));
        // No band, no score and no aggregate, under any key.
        var serialized = JsonCanon.Stringify(observation);
        foreach (var band in Check.CheckGrades)
        {
            Assert.DoesNotContain($"\"{band}\"", serialized);
        }
    }

    [Fact]
    public void AnAttachedObservationKeepsTheDocumentValid()
    {
        var example = TestData.Example();
        var report = Check.CheckHandover(example);
        var observation =
            Check.CheckObservation(example, report, ProducedBy, ProducedAt);
        var attached = (JsonObject)example.DeepClone();
        attached["observations"] = new JsonArray(observation);
        Assert.True(Validate.ValidateHandover(attached).Valid);
    }

    [Fact]
    public void NotesAreBoundedInCodePointsAndRefusedRatherThanTruncated()
    {
        var example = TestData.Example();
        var report = Check.CheckHandover(example);
        Assert.True(
            Sections.TextLength(Check.CheckDefaultNotes) <= Check.CheckNotesMaxChars);
        var custom = Check.CheckObservation(
            example, report, ProducedBy, ProducedAt, "Ran offline.");
        Assert.Equal(
            "Ran offline.",
            ((JsonObject)custom["data"]!)["notes"]!.GetValue<string>());
        Assert.Throws<ArgumentException>(() => Check.CheckObservation(
            example, report, ProducedBy, ProducedAt,
            new string('x', Check.CheckNotesMaxChars + 1)));
        // The bound is code points, so a note of astral characters is refused
        // at the same count and not at half of it.
        var emoji = char.ConvertFromUtf32(0x1F600);
        Check.CheckObservation(
            example, report, ProducedBy, ProducedAt,
            string.Concat(Enumerable.Repeat(emoji, Check.CheckNotesMaxChars)));
        Assert.Throws<ArgumentException>(() => Check.CheckObservation(
            example, report, ProducedBy, ProducedAt,
            string.Concat(Enumerable.Repeat(emoji, Check.CheckNotesMaxChars + 1))));
    }
}

public sealed class StoreUpdateTests
{
    private const string ProducedBy = "soil-cli/0.1.0";
    private const string ProducedAt = "2026-07-22T10:00:00Z";

    private static HandoverStore TempStore()
    {
        var home = Path.Combine(
            Path.GetTempPath(), $"soil-update-{Guid.NewGuid():N}");
        Directory.CreateDirectory(home);
        return new HandoverStore(home);
    }

    [Fact]
    public void UpdateAttachesAnObservationAndKeepsIdAndCode()
    {
        var store = TempStore();
        var entry = store.Save(TestData.Example());
        var stored = store.Read(entry.Code);
        var report = Check.CheckHandover(stored);
        var observation =
            Check.CheckObservation(stored, report, ProducedBy, ProducedAt);
        var updated = (JsonObject)stored.DeepClone();
        updated["observations"] = new JsonArray(observation);

        var row = store.Update(entry.Code, updated);
        Assert.Equal(entry.Code, row.Code);

        var readBack = store.Read(entry.Code);
        Assert.Equal(
            stored["handoverId"]!.GetValue<string>(),
            readBack["handoverId"]!.GetValue<string>());
        Assert.Equal(entry.Code, readBack["code"]!.GetValue<string>());
        Assert.Single((JsonArray)readBack["observations"]!);
        // Checking again after an attach produces the same grade:
        // observations never change how the document is read.
        Assert.Equal(report.Grade, Check.CheckHandover(readBack).Grade);
    }

    [Fact]
    public void UpdateRefusesAChangedHandoverId()
    {
        var store = TempStore();
        var entry = store.Save(TestData.Example());
        var stored = store.Read(entry.Code);
        var impostor = (JsonObject)stored.DeepClone();
        impostor["handoverId"] = "019f7e89-fc00-7000-8000-999999999999";
        Assert.Throws<ArgumentException>(() => store.Update(entry.Code, impostor));
    }

    [Fact]
    public void UpdateNeverChangesTheLoadCode()
    {
        var store = TempStore();
        var entry = store.Save(TestData.Example());
        var relabelled = (JsonObject)store.Read(entry.Code).DeepClone();
        relabelled["code"] = "#999";
        store.Update(entry.Code, relabelled);
        Assert.Equal(
            entry.Code,
            store.Read(entry.Code)["code"]!.GetValue<string>());
    }

    [Fact]
    public void UpdateValidatesBeforeWriting()
    {
        var store = TempStore();
        var entry = store.Save(TestData.Example());
        var stored = store.Read(entry.Code);
        var broken = (JsonObject)stored.DeepClone();
        broken["title"] = "";
        Assert.Throws<HandoverValidationException>(
            () => store.Update(entry.Code, broken));
        // The stored document is untouched.
        Assert.Equal(
            stored["title"]!.GetValue<string>(),
            store.Read(entry.Code)["title"]!.GetValue<string>());
    }
}
