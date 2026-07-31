using System.Text.Json.Nodes;
using Xunit;

namespace Soil.Handover.Tests;

public class NormalizeTests
{
    [Fact]
    public void DeclaresAll17SectionsEvenFromAnEmptyObject()
    {
        var doc = TestData.Normalized(new JsonObject());
        var sections = (JsonObject)doc["sections"]!;
        Assert.Equal(Sections.SectionKeys, sections.Select(p => p.Key).ToList());
        var decisions = (JsonObject)sections["decisions"]!;
        Assert.Equal("missing", (string?)decisions["status"]);
        Assert.True(decisions.ContainsKey("summary"));
        Assert.Null(decisions["summary"]);
    }

    [Fact]
    public void AcceptsTheLooseExtractionSectionsKey()
    {
        var doc = TestData.Normalized(new JsonObject
        {
            ["projectId"] = "loose",
            ["title"] = "Loose",
            ["extractionSections"] = new JsonObject
            {
                ["decisions"] = "We picked Postgres.",
            },
        });
        var decisions = (JsonObject)((JsonObject)doc["sections"]!)["decisions"]!;
        Assert.Equal("available", (string?)decisions["status"]);
        Assert.Equal("We picked Postgres.", (string?)decisions["summary"]);
    }

    [Fact]
    public void TurnsABareStringIntoAnAvailableSection()
    {
        var doc = TestData.Normalized(new JsonObject
        {
            ["sections"] = new JsonObject { ["workflow"] = "  Review before merge.  " },
        });
        var workflow = (JsonObject)((JsonObject)doc["sections"]!)["workflow"]!;
        Assert.Equal("available", (string?)workflow["status"]);
        Assert.Equal("Review before merge.", (string?)workflow["summary"]);
    }

    [Fact]
    public void TreatsAnEmptyStringAsAGapRatherThanAsContent()
    {
        var doc = TestData.Normalized(new JsonObject
        {
            ["sections"] = new JsonObject { ["workflow"] = "   " },
        });
        var workflow = (JsonObject)((JsonObject)doc["sections"]!)["workflow"]!;
        Assert.Equal("missing", (string?)workflow["status"]);
    }

    [Fact]
    public void InfersAvailableWhenAnObjectHasASummaryButNoStatus()
    {
        var doc = TestData.Normalized(new JsonObject
        {
            ["sections"] = new JsonObject
            {
                ["blockers"] = new JsonObject { ["summary"] = "The sandbox is down." },
            },
        });
        var blockers = (JsonObject)((JsonObject)doc["sections"]!)["blockers"]!;
        Assert.Equal("available", (string?)blockers["status"]);
    }

    [Fact]
    public void KeepsAnExplicitBlockedStatusAndItsNote()
    {
        var doc = TestData.Normalized(new JsonObject
        {
            ["sections"] = new JsonObject
            {
                ["architecture"] = new JsonObject
                {
                    ["status"] = "blocked",
                    ["summary"] = "Host names withheld.",
                },
            },
        });
        var architecture = (JsonObject)((JsonObject)doc["sections"]!)["architecture"]!;
        Assert.Equal("blocked", (string?)architecture["status"]);
        Assert.Equal("Host names withheld.", (string?)architecture["summary"]);
    }

    [Fact]
    public void DoesNotInventAProjectIdSoValidationCanSaySo()
    {
        var doc = TestData.Normalized(new JsonObject { ["title"] = "No slug" });
        Assert.Equal("", (string?)doc["projectId"]);
        Assert.False(Validate.ValidateHandover(doc).Valid);
    }

    [Fact]
    public void LeavesACompleteReplyOneWriterAssignedIdFromValid()
    {
        var doc = TestData.Normalized(new JsonObject
        {
            ["projectId"] = "rescue-test",
            ["title"] = "Rescued from a full thread",
            ["createdAt"] = TestData.ACaptureTime,
            ["extractionSections"] = new JsonObject
            {
                ["projectIdentity"] = "A test project.",
                ["decisions"] = new JsonObject
                {
                    ["status"] = "available",
                    ["summary"] = "One decision.",
                },
                ["blockers"] = new JsonObject
                {
                    ["status"] = "missing",
                    ["summary"] = null,
                },
            },
        });
        var result = Validate.ValidateHandover(doc);
        Assert.False(result.Valid);
        Assert.Equal(new[] { "/handoverId" }, result.Issues.Select(issue => issue.Path).ToArray());

        doc["handoverId"] = TestData.AValidId;
        Assert.True(Validate.ValidateHandover(doc).Valid);
    }

    [Fact]
    public void KeepsAnExistingHandoverIdAndNeverMintsOne()
    {
        var kept = TestData.Normalized(new JsonObject
        {
            ["handoverId"] = TestData.AValidId,
            ["projectId"] = "identified",
            ["title"] = "Identified",
        });
        Assert.Equal(TestData.AValidId, (string?)kept["handoverId"]);

        var fresh = TestData.Normalized(new JsonObject
        {
            ["projectId"] = "unidentified",
            ["title"] = "Unidentified",
        });
        Assert.False(fresh.ContainsKey("handoverId"));
    }

    [Fact]
    public void ExtractsJsonOutOfAFencedBlockWrappedInProse()
    {
        var text = "Sure!\n\n```json\n{\"a\":1}\n```\n\nAnything else?";
        Assert.Equal("{\"a\":1}", Normalize.ExtractJsonBlock(text));
    }

    [Fact]
    public void HandlesAFenceWithNoLanguageTag()
    {
        Assert.Equal("{\"a\":1}", Normalize.ExtractJsonBlock("```\n{\"a\":1}\n```"));
    }

    [Fact]
    public void FallsBackToTheOutermostBraces()
    {
        Assert.Equal(
            "{\"a\":{\"b\":2}}",
            Normalize.ExtractJsonBlock("here you go: {\"a\":{\"b\":2}} done"));
    }

    [Fact]
    public void ReturnsNullWhenThereIsNoJsonAtAll()
    {
        Assert.Null(Normalize.ExtractJsonBlock("I could not do that"));
    }

    // Wrong capitalisation is the common case. Rewriting it to "available"
    // would let a typo become content that counts as captured, and the author
    // would never be told.
    [Theory]
    [InlineData("Available")]
    [InlineData("AVAILABLE")]
    [InlineData("partial")]
    [InlineData("done")]
    public void KeepsAnUnrecognisedStatusSoValidationRefusesIt(string wrong)
    {
        var doc = TestData.Normalized(new JsonObject
        {
            ["handoverId"] = TestData.AValidId,
            ["projectId"] = "status-test",
            ["title"] = "Status",
            ["createdAt"] = TestData.ACaptureTime,
            ["sections"] = new JsonObject
            {
                ["decisions"] = new JsonObject
                {
                    ["status"] = wrong,
                    ["summary"] = "One decision.",
                },
            },
        });
        Assert.Equal(
            wrong,
            (string?)((JsonObject)((JsonObject)doc["sections"]!)["decisions"]!)["status"]);
        var result = Validate.ValidateHandover(doc);
        Assert.False(result.Valid);
        Assert.Contains(
            result.Issues,
            issue => issue.Path == "/sections/decisions/status"
                && issue.Kind == ValidationIssueKind.Structure);
    }
}
