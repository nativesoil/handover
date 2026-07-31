using System.Text.Json.Nodes;
using Xunit;

namespace Soil.Handover.Tests;

public class ValidateTests
{
    [Fact]
    public void AcceptsAHandoverWhereEverySectionIsMissing()
    {
        Assert.True(Validate.ValidateHandover(TestData.Handover()).Valid);
    }

    [Fact]
    public void AcceptsAnOffsetTimestampNotOnlyZ()
    {
        var doc = TestData.Handover(d => d["createdAt"] = "2026-07-20T08:00:00+02:00");
        Assert.True(Validate.ValidateHandover(doc).Valid);
    }

    [Fact]
    public void ReportsEveryProblemAtOnceNotJustTheFirst()
    {
        var doc = new JsonObject
        {
            ["soilHandover"] = "1.0",
            ["handoverId"] = TestData.AValidId,
            ["title"] = "",
            ["createdAt"] = "yesterday",
            ["sections"] = TestData.AllSections(),
        };
        var result = Validate.ValidateHandover(doc);
        Assert.False(result.Valid);
        Assert.Equal(
            new[] { "/createdAt", "/projectId", "/title" },
            result.Issues.Select(issue => issue.Path).OrderBy(p => p, StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public void RejectsADroppedSectionBecauseAGapIsStatedNotOmitted()
    {
        var doc = TestData.Handover();
        ((JsonObject)doc["sections"]!).Remove("decisions");
        var result = Validate.ValidateHandover(doc);
        Assert.False(result.Valid);
        Assert.Equal("/sections/decisions", result.Issues[0].Path);
    }

    [Fact]
    public void RejectsASectionKeyNobodyHasHeardOf()
    {
        var doc = TestData.Handover(d =>
            ((JsonObject)d["sections"]!)["vibes"] = new JsonObject
            {
                ["status"] = "missing",
                ["summary"] = null,
            });
        var result = Validate.ValidateHandover(doc);
        Assert.Contains("/sections/vibes", result.Issues.Select(issue => issue.Path));
    }

    [Fact]
    public void RejectsAvailableWithNoContent()
    {
        var doc = TestData.Handover(d =>
            ((JsonObject)d["sections"]!)["decisions"] = new JsonObject
            {
                ["status"] = "available",
                ["summary"] = "  ",
            });
        var result = Validate.ValidateHandover(doc);
        Assert.Equal("/sections/decisions/summary", result.Issues[0].Path);
    }

    [Fact]
    public void RejectsAStatusOutsideTheThreeWordVocabulary()
    {
        var doc = TestData.Handover(d =>
            ((JsonObject)d["sections"]!)["decisions"] = new JsonObject
            {
                ["status"] = "partial",
                ["summary"] = "half",
            });
        var result = Validate.ValidateHandover(doc);
        Assert.Equal("/sections/decisions/status", result.Issues[0].Path);
    }

    [Fact]
    public void AcceptsASectionThatDoesNotApplyWhenItSaysWhy()
    {
        var doc = TestData.Handover(d =>
            ((JsonObject)d["sections"]!)["architecture"] = new JsonObject
            {
                ["status"] = "not_applicable",
                ["summary"] = "A one-author manuscript has no system to describe.",
            });
        Assert.True(Validate.ValidateHandover(doc).Valid);
    }

    [Fact]
    public void RejectsASectionThatDoesNotApplyWithoutAReason()
    {
        foreach (var summary in new JsonNode?[] { null, "", "   " })
        {
            var doc = TestData.Handover(d =>
                ((JsonObject)d["sections"]!)["architecture"] = new JsonObject
                {
                    ["status"] = "not_applicable",
                    ["summary"] = summary,
                });
            var result = Validate.ValidateHandover(doc);
            Assert.False(result.Valid);
            Assert.Equal("/sections/architecture/summary", result.Issues[0].Path);
        }
    }

    [Fact]
    public void RefusesANearNeighbourOfTheFourthStatus()
    {
        foreach (var status in new[] { "notApplicable", "not applicable", "NOT_APPLICABLE" })
        {
            var doc = TestData.Handover(d =>
                ((JsonObject)d["sections"]!)["architecture"] = new JsonObject
                {
                    ["status"] = status,
                    ["summary"] = "There is no system here.",
                });
            var result = Validate.ValidateHandover(doc);
            Assert.False(result.Valid);
            Assert.Equal("/sections/architecture/status", result.Issues[0].Path);
        }
    }

    [Fact]
    public void RejectsAnUnknownProvenanceLabel()
    {
        var doc = TestData.Handover(d =>
            ((JsonObject)d["sections"]!)["decisions"] = new JsonObject
            {
                ["status"] = "available",
                ["summary"] = "one",
                ["provenance"] = new JsonArray("model_reported", "vibes_based"),
            });
        var result = Validate.ValidateHandover(doc);
        Assert.Equal("/sections/decisions/provenance/1", result.Issues[0].Path);
    }

    [Fact]
    public void RejectsADuplicatedProvenanceLabel()
    {
        var doc = TestData.Handover(d =>
            ((JsonObject)d["sections"]!)["decisions"] = new JsonObject
            {
                ["status"] = "available",
                ["summary"] = "one",
                ["provenance"] = new JsonArray("inferred", "inferred"),
            });
        var result = Validate.ValidateHandover(doc);
        Assert.Contains("duplicate", result.Issues[0].Message);
    }

    [Fact]
    public void RejectsAnUnknownTopLevelFieldIncludingAGrade()
    {
        var doc = TestData.Handover(d => d["grade"] = "A");
        var result = Validate.ValidateHandover(doc);
        Assert.Contains("/grade", result.Issues.Select(issue => issue.Path));
    }

    [Fact]
    public void SupportsExactVersionsAndRefusesEverythingElse()
    {
        // Support is a set, not a pattern. A reader that accepts 1.4 because
        // the string starts with "1." is claiming to implement a version
        // nobody has written, and version one is a closed world: whatever that
        // minor allowed would arrive here unrecognised.
        Assert.True(Validate.ValidateHandover(TestData.Handover(d => d["soilHandover"] = "1.0")).Valid);
        foreach (var unsupported in new[] { "0.9", "1.1", "1.4", "1.10", "2.0", "1", "1.0.0", "" })
        {
            var result = Validate.ValidateHandover(
                TestData.Handover(d => d["soilHandover"] = unsupported));
            Assert.False(result.Valid, unsupported);
            Assert.Contains(result.Issues, issue => issue.Path == "/soilHandover");
        }
    }

    [Fact]
    public void RequiresAHandoverIdOnADocumentClaimingValidity()
    {
        var doc = TestData.Handover();
        doc.Remove("handoverId");
        var result = Validate.ValidateHandover(doc);
        Assert.False(result.Valid);
        Assert.Equal("/handoverId", result.Issues[0].Path);
        Assert.Equal(ValidationIssueKind.Structure, result.Issues[0].Kind);
    }

    [Fact]
    public void RejectsAHandoverIdThatIsNotAUuidRatherThanReplaceIt()
    {
        var result = Validate.ValidateHandover(TestData.Handover(d => d["handoverId"] = "handover-42"));
        Assert.False(result.Valid);
        Assert.Equal("/handoverId", result.Issues[0].Path);
    }

    [Fact]
    public void RejectsAProjectIdWithSpaces()
    {
        var result = Validate.ValidateHandover(TestData.Handover(d => d["projectId"] = "two words"));
        Assert.Equal("/projectId", result.Issues[0].Path);
    }

    [Fact]
    public void AcceptsAStoreAssignedCodeAndRejectsAMalformedOne()
    {
        Assert.True(Validate.ValidateHandover(TestData.Handover(d => d["code"] = "#004")).Valid);
        Assert.False(Validate.ValidateHandover(TestData.Handover(d => d["code"] = "4")).Valid);
    }

    [Fact]
    public void AcceptsStatedGapsAndSafetyOmissions()
    {
        var doc = TestData.Handover(d =>
        {
            d["quality"] = new JsonObject
            {
                ["missingInputs"] = new JsonArray("the deploy logs"),
                ["contradictions"] = new JsonArray(),
            };
            d["safety"] = new JsonObject
            {
                ["unsafeOmissions"] = new JsonArray("an API key exists in the platform config"),
            };
        });
        Assert.True(Validate.ValidateHandover(doc).Valid);
    }

    [Fact]
    public void RejectsANoteThatIsNotText()
    {
        var doc = TestData.Handover(d =>
            d["quality"] = new JsonObject { ["missingInputs"] = new JsonArray(7) });
        var result = Validate.ValidateHandover(doc);
        Assert.Equal("/quality/missingInputs/0", result.Issues[0].Path);
    }

    [Fact]
    public void RejectsSomethingThatIsNotAnObjectAtAll()
    {
        Assert.False(Validate.ValidateHandover(JsonValue.Create("a handover, honest")).Valid);
        Assert.False(Validate.ValidateHandover(null).Valid);
    }

    [Fact]
    public void AssertHandoverReturnsAValidDocument()
    {
        var doc = TestData.Handover();
        var returned = Validate.AssertHandover(doc);
        Assert.Same(doc, returned);
    }

    [Fact]
    public void AssertHandoverThrowsWithEveryIssueAttached()
    {
        var thrown = Assert.Throws<HandoverValidationException>(
            () => Validate.AssertHandover(new JsonObject { ["soilHandover"] = "1.0" }));
        Assert.True(thrown.Issues.Count > 1);
        Assert.Contains("not a valid Soil handover", thrown.Message);
    }
}
