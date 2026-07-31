using System.Text.Json.Nodes;
using Xunit;

namespace Soil.Handover.Tests;

/// <summary>
/// The closed-world contract, on the normalization path.
///
/// Version one has no room for an unknown field, and normalization is not
/// allowed to make room by deleting one. Each of these used to be dropped
/// silently, which meant a validation rejected a document and a save stored
/// it, from the same bytes.
/// </summary>
public class ClosedWorldTests
{
    private static JsonObject Base(Action<JsonObject>? mutate = null)
    {
        var document = new JsonObject
        {
            ["soilHandover"] = "1.0",
            ["handoverId"] = TestData.AValidId,
            ["projectId"] = "closed-world",
            ["title"] = "Closed world",
            ["createdAt"] = TestData.ACaptureTime,
            ["sections"] = TestData.AllSections(),
        };
        mutate?.Invoke(document);
        return document;
    }

    public static TheoryData<string, string> UnknownContent() => new()
    {
        { "grade", "/grade" },
        { "section-field", "/sections/decisions/confidence" },
        { "section-key", "/sections/vibes" },
        { "provenance", "/sections/decisions/provenance/1" },
        { "source-member", "/source/temperature" },
        { "unreshapable-section", "/sections/decisions" },
    };

    private static JsonObject Carrying(string what) => Base(document =>
    {
        var sections = (JsonObject)document["sections"]!;
        switch (what)
        {
            case "grade":
                document["grade"] = 0.92;
                break;
            case "section-field":
                sections["decisions"] = new JsonObject
                {
                    ["status"] = "available",
                    ["summary"] = "One.",
                    ["confidence"] = 0.4,
                };
                break;
            case "section-key":
                sections["vibes"] = new JsonObject
                {
                    ["status"] = "available",
                    ["summary"] = "Good.",
                };
                break;
            case "provenance":
                sections["decisions"] = new JsonObject
                {
                    ["status"] = "available",
                    ["summary"] = "One.",
                    ["provenance"] = new JsonArray("repo_verified", "vibe_checked"),
                };
                break;
            case "source-member":
                document["source"] = new JsonObject
                {
                    ["client"] = "a-tool",
                    ["temperature"] = 0.7,
                };
                break;
            case "unreshapable-section":
                sections["decisions"] = 42;
                break;
        }
    });

    [Theory]
    [MemberData(nameof(UnknownContent))]
    public void CarriesUnknownContentToValidation(string what, string path)
    {
        Assert.Contains(
            Validate.ValidateHandover(Carrying(what)).Issues,
            issue => issue.Path == path);
        Assert.Contains(
            Validate.ValidateHandover(TestData.Normalized(Carrying(what))).Issues,
            issue => issue.Path == path);
    }

    [Theory]
    [InlineData("1.7")]
    [InlineData("2.0")]
    [InlineData("0.9")]
    public void DoesNotUpgradeOrDowngradeADeclaredVersion(string declared)
    {
        var doc = TestData.Normalized(Base(d => d["soilHandover"] = declared));
        Assert.Equal(declared, (string?)doc["soilHandover"]);
        Assert.False(Validate.ValidateHandover(doc).Valid);
    }

    [Fact]
    public void DoesNotStampACreatedAtTheDocumentNeverCarried()
    {
        // The anchor every frontier section is read against. A wall clock read
        // at save time is indistinguishable, to a consumer, from a time the
        // session actually reported.
        var doc = TestData.Normalized(new JsonObject
        {
            ["projectId"] = "no-time",
            ["title"] = "No time",
        });
        Assert.False(doc.ContainsKey("createdAt"));
        doc["handoverId"] = TestData.AValidId;
        Assert.Contains(
            Validate.ValidateHandover(doc).Issues,
            issue => issue.Path == "/createdAt");
    }

    [Fact]
    public void KeepsACreatedAtItCannotParseInsteadOfReplacingIt()
    {
        var doc = TestData.Normalized(new JsonObject
        {
            ["projectId"] = "bad-time",
            ["title"] = "Bad time",
            ["createdAt"] = "last Tuesday",
        });
        Assert.Equal("last Tuesday", (string?)doc["createdAt"]);
    }

    [Fact]
    public void DoesNotStampARecipeVersionOntoAnotherWritersDocument()
    {
        var doc = TestData.Normalized(new JsonObject
        {
            ["projectId"] = "recipe",
            ["title"] = "Recipe",
        });
        Assert.False(doc.ContainsKey("source"));

        var kept = TestData.Normalized(new JsonObject
        {
            ["projectId"] = "recipe",
            ["title"] = "Kept",
            ["source"] = new JsonObject { ["recipeVersion"] = "0.9.9" },
        });
        Assert.Equal("0.9.9", (string?)((JsonObject)kept["source"]!)["recipeVersion"]);
    }

    [Fact]
    public void KeepsAMalformedHandoverIdRatherThanLettingAWriterReplaceIt()
    {
        // Dropping it is what makes the replacement possible: the writer then
        // sees a document with no id and mints one, and nobody is ever told
        // the id the document arrived with was wrong.
        JsonNode?[] malformed = [JsonValue.Create(42), JsonValue.Create("handover-42"), JsonValue.Create(""), null];
        foreach (var id in malformed)
        {
            var doc = TestData.Normalized(Base(d => d["handoverId"] = id?.DeepClone()));
            Assert.True(doc.ContainsKey("handoverId"));
            Assert.Contains(
                Validate.ValidateHandover(doc).Issues,
                issue => issue.Path == "/handoverId");
        }
    }

    [Fact]
    public void KeepsAQualityEntryItCannotUseRatherThanDeletingIt()
    {
        var doc = TestData.Normalized(new JsonObject
        {
            ["projectId"] = "notes",
            ["title"] = "Notes",
            ["createdAt"] = TestData.ACaptureTime,
            ["quality"] = new JsonObject
            {
                ["missingInputs"] = new JsonArray("the logs", "  ", 7),
            },
            ["safety"] = new JsonObject
            {
                ["unsafeOmissions"] = new JsonArray("  a key exists in the config  "),
            },
        });
        Assert.Equal(3, ((JsonArray)((JsonObject)doc["quality"]!)["missingInputs"]!).Count);
        Assert.Equal(
            "a key exists in the config",
            (string?)((JsonArray)((JsonObject)doc["safety"]!)["unsafeOmissions"]!)[0]);

        doc["handoverId"] = TestData.AValidId;
        var paths = Validate.ValidateHandover(doc).Issues.Select(issue => issue.Path).ToArray();
        Assert.Contains("/quality/missingInputs/1", paths);
        Assert.Contains("/quality/missingInputs/2", paths);
    }
}
