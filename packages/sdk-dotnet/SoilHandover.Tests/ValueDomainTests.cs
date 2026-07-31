using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace Soil.Handover.Tests;

/// <summary>
/// The numeric domain and the text unit.
///
/// Both are stated normatively in spec/value-domain.md and both are pinned
/// across the five implementations by the conformance corpus. What is here is
/// what only this runtime can show: that a .NET string's Length is a count of
/// UTF-16 code units and not the unit the format counts in, and that this
/// runtime has exact numeric types that would have seen nothing wrong with a
/// forty-digit integer.
/// </summary>
public class ValueDomainTests
{
    /// <summary>One code point, two UTF-16 code units, four UTF-8 bytes.</summary>
    private const string Astral = "\U0001F600";

    /// <summary>Two code points, two UTF-16 code units, one grapheme cluster.</summary>
    private const string Combined = "é";

    private const string AValidId = "019f7e89-fc00-7000-8000-000000000000";

    /// <summary>The code and location of a refusal, or <c>"accepted"</c>.</summary>
    private static string Verdict(string text)
    {
        var result = Ingest.IngestText(text);
        return result.Issue is null ? "accepted" : $"{result.Issue.Code} {result.Issue.Path}";
    }

    [Theory]
    [InlineData("{\"n\":9007199254740991}", "accepted")]
    [InlineData("{\"n\":-9007199254740991}", "accepted")]
    [InlineData("{\"a\":0,\"b\":-0,\"c\":42,\"d\":-42}", "accepted")]
    [InlineData("{\"n\":9007199254740992}", "number.out_of_range /n")]
    [InlineData("{\"n\":-9007199254740992}", "number.out_of_range /n")]
    [InlineData("{\"n\":100.0}", "number.not_an_integer /n")]
    [InlineData("{\"n\":1e2}", "number.not_an_integer /n")]
    [InlineData("{\"n\":-0.0}", "number.not_an_integer /n")]
    [InlineData("{\"confidence\":0.92}", "number.not_an_integer /confidence")]
    public void JudgesTheIntegerDomainFromTheTokenText(string text, string expected)
        => Assert.Equal(expected, Verdict(text));

    [Fact]
    public void RefusesAMagnitudeNoDoubleCouldHold()
        => Assert.Equal(
            "number.out_of_range /n",
            Verdict("{\"n\":" + new string('9', 40) + "}"));

    [Fact]
    public void LocatesARefusalInAnArrayAndInANestedObject()
    {
        Assert.Equal("number.not_an_integer /a/2", Verdict("{\"a\":[1,2,1e2]}"));
        Assert.Equal("number.not_an_integer /a/b/c", Verdict("{\"a\":{\"b\":{\"c\":0.5}}}"));
        Assert.Equal("number.not_an_integer ", Verdict("0.5"));
    }

    [Fact]
    public void LeavesTheThreeJsonLiteralsAndDigitsInsideStringsAlone()
    {
        Assert.Equal("accepted", Verdict("{\"a\":true,\"b\":false,\"c\":null}"));
        Assert.Equal("accepted", Verdict("{\"a\":\"9007199254740992\"}"));
    }

    [Fact]
    public void SyntaxAndDuplicatesOutrankTheNumericDomain()
    {
        Assert.Equal("structure.duplicate_member /a", Verdict("{\"a\":1e2,\"a\":1e2}"));
        Assert.Equal("syntax.invalid_json ", Verdict("{\"a\":1e2,}"));
    }

    [Fact]
    public void TheTextUnitIsNotAStringsLength()
    {
        var title = string.Concat(Enumerable.Repeat(Astral, Sections.Limits.Title));
        Assert.Equal(200, Sections.TextLength(title));
        Assert.Equal(400, title.Length);
        Assert.Equal(800, Encoding.UTF8.GetByteCount(title));
    }

    [Fact]
    public void CountsACombiningSequenceAsItsCodePointsNotAsOneCluster()
    {
        Assert.Equal(2, Sections.TextLength(Combined));
        Assert.Equal(4, Sections.TextLength("café"));
    }

    [Fact]
    public void CountsALoneSurrogateAsOneCodePoint()
    {
        // A JSON document may carry \uD800 with no pair. Counting it as zero
        // would let a string smuggle unbounded content past a bound.
        Assert.Equal(1, Sections.TextLength("\ud800"));
        Assert.Equal(3, Sections.TextLength("a\ud800b"));
    }

    private static JsonObject DocWithTitle(string title)
    {
        var doc = (JsonObject)Normalize.NormalizeHandover(new JsonObject
        {
            ["projectId"] = "text-unit",
            ["title"] = title,
            ["createdAt"] = "2026-07-26T10:00:00Z",
            ["sections"] = new JsonObject
            {
                ["executiveSummary"] = "The text unit, exercised.",
            },
        })!;
        doc["handoverId"] = AValidId;
        return doc;
    }

    [Fact]
    public void AcceptsATitleOfExactlyTheLimitInAstralCharacters()
    {
        var result = Validate.ValidateHandover(
            DocWithTitle(string.Concat(Enumerable.Repeat(Astral, Sections.Limits.Title))));
        Assert.True(result.Valid, string.Join("; ", result.Issues.Select(i => i.Message)));
    }

    [Fact]
    public void RefusesOneCodePointOverAndNamesTheUnit()
    {
        var result = Validate.ValidateHandover(
            DocWithTitle(string.Concat(Enumerable.Repeat(Astral, Sections.Limits.Title + 1))));
        Assert.False(result.Valid);
        var issue = result.Issues.First(i => i.Path == "/title");
        Assert.Equal("must be at most 200 code points", issue.Message);
    }
}
