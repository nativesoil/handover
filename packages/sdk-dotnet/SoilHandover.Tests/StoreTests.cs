using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Xunit;

namespace Soil.Handover.Tests;

public class StoreTests : IDisposable
{
    private readonly TestData.TempHome _home = new();
    private HandoverStore Store => new(_home.Path);

    public void Dispose() => _home.Dispose();

    private static JsonObject Doc(string title, JsonObject? sections = null)
        => TestData.Normalized(new JsonObject
        {
            ["projectId"] = "store-test",
            ["title"] = title,
            ["createdAt"] = TestData.ACaptureTime,
            ["sections"] = sections ?? new JsonObject(),
        });

    [Fact]
    public void FormatCodePadsToThreeDigits()
    {
        Assert.Equal("#001", HandoverStore.FormatCode(1));
        Assert.Equal("#042", HandoverStore.FormatCode(42));
        Assert.Equal("#1234", HandoverStore.FormatCode(1234));
    }

    [Fact]
    public void ParseCodeParsesTheShapesAPersonActuallyTypes()
    {
        Assert.Equal(4, HandoverStore.ParseCode("#004"));
        Assert.Equal(4, HandoverStore.ParseCode("004"));
        Assert.Equal(4, HandoverStore.ParseCode(" 4 "));
        Assert.Null(HandoverStore.ParseCode("#abc"));
        Assert.Null(HandoverStore.ParseCode("#000"));
    }

    [Fact]
    public void ResolveStoreHomePrefersSoilHome()
    {
        var env = new Dictionary<string, string?> { ["SOIL_HOME"] = "/tmp/elsewhere" };
        Assert.Equal("/tmp/elsewhere", HandoverStore.ResolveStoreHome(env));
    }

    [Fact]
    public void ResolveStoreHomeFallsBackToADotSoilDirectoryInTheHomeDirectory()
    {
        var resolved = HandoverStore.ResolveStoreHome(new Dictionary<string, string?>());
        Assert.EndsWith(".soil", resolved);
    }

    [Fact]
    public void CountSectionsCountsByStatusAndNeverScores()
    {
        var doc = TestData.Normalized(new JsonObject
        {
            ["sections"] = new JsonObject
            {
                ["decisions"] = "one",
                ["workflow"] = "two",
                ["architecture"] = new JsonObject
                {
                    ["status"] = "blocked",
                    ["summary"] = "withheld",
                },
            },
        });
        var counts = HandoverStore.CountSections(doc);
        Assert.Equal(new SectionCounts(2, 14, 1, 0, 17), counts);
    }

    [Fact]
    public void CountsASectionThatDoesNotApplyOnItsOwn()
    {
        var doc = TestData.Normalized(new JsonObject
        {
            ["sections"] = new JsonObject
            {
                ["decisions"] = "one",
                ["architecture"] = new JsonObject
                {
                    ["status"] = "not_applicable",
                    ["summary"] = "A manuscript has no system to describe.",
                },
                ["safetySummary"] = new JsonObject
                {
                    ["status"] = "not_applicable",
                    ["summary"] = "Nothing here holds a value to withhold.",
                },
            },
        });
        var counts = HandoverStore.CountSections(doc);
        Assert.Equal(new SectionCounts(1, 14, 0, 2, 17), counts);
    }

    [Fact]
    public void StartsEmpty()
    {
        Assert.Empty(Store.List());
    }

    [Fact]
    public void HandsOutCodesInOrderAndNeverReusesOne()
    {
        var store = Store;
        Assert.Equal("#001", store.Save(Doc("first")).Code);
        Assert.Equal("#002", store.Save(Doc("second")).Code);
        Assert.Equal("#003", store.Save(Doc("third")).Code);
    }

    [Fact]
    public void WritesOneReadableJsonFilePerHandover()
    {
        Store.Save(Doc("readable", new JsonObject { ["decisions"] = "We chose files." }));
        var raw = File.ReadAllText(Path.Combine(_home.Path, "handovers", "001.json"));
        var parsed = (JsonObject)JsonNode.Parse(raw)!;
        Assert.Equal("#001", (string?)parsed["code"]);
        var decisions = (JsonObject)((JsonObject)parsed["sections"]!)["decisions"]!;
        Assert.Equal("available", (string?)decisions["status"]);
    }

    [Fact]
    public void ReadsAHandoverBackByCodeByBareNumberAndByLast()
    {
        var store = Store;
        store.Save(Doc("first"));
        store.Save(Doc("second"));
        Assert.Equal("first", (string?)store.Read("#001")["title"]);
        Assert.Equal("first", (string?)store.Read("1")["title"]);
        Assert.Equal("second", (string?)store.Read("last")["title"]);
    }

    [Fact]
    public void ListsNewestFirstWithTheSectionCount()
    {
        var store = Store;
        store.Save(Doc("first", new JsonObject { ["decisions"] = "one" }));
        store.Save(Doc("second"));
        var entries = store.List();
        Assert.Equal(new[] { "#002", "#001" }, entries.Select(entry => entry.Code).ToArray());
        Assert.Equal(1, entries[1].SectionsWithContent);
    }

    [Fact]
    public void AssignsAUuidv7AtSaveTimeAndKeepsAnIdThatIsAlreadyThere()
    {
        var store = Store;
        var assigned = store.Save(Doc("fresh"));
        var stored = store.Read(assigned.Code);
        var id = (string?)stored["handoverId"];
        Assert.NotNull(id);
        Assert.Matches(
            new Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"),
            id!);
        var copied = store.Save(stored);
        Assert.Equal(id, (string?)store.Read(copied.Code)["handoverId"]);
    }

    [Fact]
    public void NeverMutatesTheCallersDocument()
    {
        var doc = Doc("untouched");
        Store.Save(doc);
        Assert.False(doc.ContainsKey("handoverId"));
        Assert.False(doc.ContainsKey("code"));
    }

    [Fact]
    public void RefusesToStoreAnInvalidDocument()
    {
        var thrown = Assert.Throws<HandoverValidationException>(
            () => Store.Save(new JsonObject { ["title"] = "nope" }));
        Assert.Contains("not a valid Soil handover", thrown.Message);
    }

    [Fact]
    public void SaysSoWhenACodeDoesNotExist()
    {
        Assert.Throws<HandoverNotFoundException>(() => Store.Read("#404"));
        Assert.Throws<HandoverNotFoundException>(() => Store.Read("last"));
    }

    [Fact]
    public void RebuildsTheIndexFromTheFilesBecauseTheFilesAreTheTruth()
    {
        var store = Store;
        store.Save(Doc("first"));
        store.Save(Doc("second"));
        File.WriteAllText(
            Path.Combine(_home.Path, "index.json"),
            "{\"indexVersion\":1,\"nextCode\":1,\"entries\":[]}");
        var rebuilt = store.Reindex();
        Assert.Equal(new[] { "#001", "#002" }, rebuilt.Entries.Select(entry => entry.Code).ToArray());
        Assert.Equal(3, rebuilt.NextCode);
    }

    [Fact]
    public void SkipsUnreadableFilesWhenRebuildingRatherThanGivingUp()
    {
        var store = Store;
        store.Save(Doc("good"));
        File.WriteAllText(
            Path.Combine(_home.Path, "handovers", "099.json"),
            "{\"not\":\"a handover\"}");
        Assert.Single(store.Reindex().Entries);
    }
}
