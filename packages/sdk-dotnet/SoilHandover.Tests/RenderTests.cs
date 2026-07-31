using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Xunit;

namespace Soil.Handover.Tests;

public class RenderTests
{
    private static JsonObject RenderDoc()
        => TestData.Normalized(new JsonObject
        {
            ["handoverId"] = TestData.AValidId,
            ["projectId"] = "render-test",
            ["title"] = "A short title",
            ["createdAt"] = "2026-07-22T10:00:00Z",
            ["source"] = new JsonObject
            {
                ["client"] = "claude-code",
                ["model"] = "opus-4.8",
            },
            ["sections"] = new JsonObject
            {
                ["executiveSummary"] = "What this is.",
                ["decisions"] = "What was decided.",
                ["architecture"] = new JsonObject
                {
                    ["status"] = "blocked",
                    ["summary"] = "Host names withheld.",
                },
            },
            ["quality"] = new JsonObject
            {
                ["missingInputs"] = new JsonArray("the deploy logs were not available"),
            },
            ["safety"] = new JsonObject
            {
                ["unsafeOmissions"] = new JsonArray("an API key exists in the platform config"),
            },
        });

    [Fact]
    public void WrapBreaksOnWordsAndNeverMidWord()
    {
        Assert.Equal(new[] { "one two", "three", "four" }, Render.Wrap("one two three four", 9));
    }

    [Fact]
    public void WrapKeepsAWordLongerThanTheWidthOnItsOwnLine()
    {
        Assert.Equal(new[] { "supercalifragilistic" }, Render.Wrap("supercalifragilistic", 5));
    }

    [Fact]
    public void SavedCardLeadsWithTheLoadCode()
    {
        var card = Render.RenderSaved(RenderDoc(), "#004");
        Assert.Contains("#004", card.Split('\n')[0]);
    }

    [Fact]
    public void SavedCardReportsCountsAndNeverAScore()
    {
        var card = Render.RenderSaved(RenderDoc(), "#004");
        Assert.Contains("2 / 17 sections carrying content", card);
        Assert.DoesNotMatch(new Regex(@"\d+\s*%"), card);
        Assert.DoesNotMatch(new Regex("score|grade|readiness", RegexOptions.IgnoreCase), card);
    }

    [Fact]
    public void SavedCardNamesWhatDidNotSurvive()
    {
        var card = Render.RenderSaved(RenderDoc(), "#004");
        Assert.Contains("no content", card);
        Assert.Contains("held back   architecture", card);
    }

    [Fact]
    public void SavedCardShowsTheStatedGapsAndTheSafetyOmissions()
    {
        var card = Render.RenderSaved(RenderDoc(), "#004");
        Assert.Contains("stated gaps", card);
        Assert.Contains("the deploy logs were not available", card);
        Assert.Contains("held back · by design", card);
    }

    [Fact]
    public void SavedCardEndsWithTheCommandThatLoadsItBack()
    {
        var card = Render.RenderSaved(RenderDoc(), "#004");
        Assert.EndsWith("❯ soil load #004", card.TrimEnd());
    }

    [Fact]
    public void SavedCardIsDeterministic()
    {
        Assert.Equal(Render.RenderSaved(RenderDoc(), "#004"), Render.RenderSaved(RenderDoc(), "#004"));
    }

    [Fact]
    public void SavedCardKeepsEveryLineInsideTheCardWidth()
    {
        foreach (var line in Render.RenderSaved(RenderDoc(), "#004").Split('\n'))
        {
            Assert.True(line.Length <= 70, $"line too wide: {line}");
        }
    }

    [Fact]
    public void LoadedCardSaysWhichSectionsAreEmptyAndHowToReadTheRest()
    {
        var doc = RenderDoc();
        doc["code"] = "#004";
        var card = Render.RenderLoaded(doc);
        Assert.Contains("what this document carries", card);
        Assert.Contains("no content", card);
        Assert.Contains("moment of capture", card);
    }

    [Fact]
    public void ListCardSaysSoWhenNothingIsStored()
    {
        Assert.Contains("nothing saved yet", Render.RenderList(Array.Empty<StoreEntry>()));
    }

    [Fact]
    public void ListCardShowsACodeATitleAndACountPerRow()
    {
        var card = Render.RenderList(new[]
        {
            new StoreEntry(
                "#002",
                "render-test",
                "A very long title that will not fit in the column at all",
                "2026-07-22T10:00:00Z",
                9,
                "002.json"),
        });
        Assert.Contains("#002", card);
        Assert.Contains("…", card);
        Assert.Contains("9/17", card);
    }

    [Fact]
    public void ValidationCardSaysStructureOnlyWhenADocumentIsValid()
    {
        var card = Render.RenderValidation(Validate.ValidateHandover(RenderDoc()), "the document");
        Assert.Contains("valid handover", card);
        Assert.Contains("says nothing about how good the content is", card);
    }

    [Fact]
    public void ValidationCardListsEveryProblemWhenItIsNot()
    {
        var card = Render.RenderValidation(
            Validate.ValidateHandover(new JsonObject { ["soilHandover"] = "1.0" }),
            "x");
        Assert.Contains("not a handover", card);
        Assert.Contains("/projectId", card);
    }
}
