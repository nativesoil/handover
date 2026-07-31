using System.Text;
using Xunit;

namespace Soil.Handover.Tests;

/// <summary>
/// The pre-schema ingestion boundary.
///
/// Parity with the other four surfaces is asserted by the shared fixture
/// corpus in conformance/fixtures/boundary; these are the cases that corpus
/// does not carry, plus the store path that has to go through the same door.
/// </summary>
public class IngestTests : IDisposable
{
    private readonly TestData.TempHome _home = new();

    public void Dispose() => _home.Dispose();

    /// <summary>The code and location of a refusal, or <c>"accepted"</c>.</summary>
    private static string Verdict(byte[] data)
    {
        var result = Ingest.IngestDocument(data);
        return result.Issue is null ? "accepted" : $"{result.Issue.Code} {result.Issue.Path}";
    }

    private static byte[] Nested(int levels) => Encoding.UTF8.GetBytes(
        string.Concat(Enumerable.Repeat("{\"n\":", levels - 1))
        + "{}"
        + new string('}', levels - 1));

    private static byte[] Padded(int total) =>
        Encoding.UTF8.GetBytes("{\"pad\":\"" + new string('x', total - 10) + "\"}");

    [Fact]
    public void RefusesAByteOrderMarkAndNamesTheEncoding()
    {
        var result = Ingest.IngestDocument(
            new byte[] { 0xEF, 0xBB, 0xBF }.Concat(Encoding.UTF8.GetBytes("{}")).ToArray());
        Assert.Equal(Ingest.ErrorCode.EncodingByteOrderMark, result.Issue!.Code);
        Assert.Contains("UTF-8", result.Issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void NamesUtf32LeRatherThanTheUtf16LeMarkItStartsWith()
    {
        var result = Ingest.IngestDocument(new byte[] { 0xFF, 0xFE, 0x00, 0x00 });
        Assert.Contains("UTF-32LE", result.Issue!.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusesALeadingBomThatArrivedAsText()
    {
        Assert.Equal(
            Ingest.ErrorCode.EncodingByteOrderMark,
            Ingest.IngestText("﻿{}").Issue!.Code);
    }

    [Fact]
    public void RefusesMalformedUtf8InsteadOfSubstituting()
    {
        // File.ReadAllText would hand back a document with U+FFFD in it and
        // call that a read.
        var data = Encoding.UTF8.GetBytes("{\"t\":\"caf")
            .Concat(new byte[] { 0xE9 })
            .Concat(Encoding.UTF8.GetBytes("\"}"))
            .ToArray();
        Assert.Equal("encoding.invalid_utf8 ", Verdict(data));
    }

    [Fact]
    public void AcceptsValidMultibyteUtf8()
        => Assert.Equal("accepted", Verdict(Encoding.UTF8.GetBytes("{\"t\":\"café · 引き継ぎ\"}")));

    [Theory]
    [InlineData("{\"a\":1,\"a\":2}", "structure.duplicate_member /a")]
    [InlineData("{\"o\":[{\"d\":{\"n\":1,\"n\":2}}]}", "structure.duplicate_member /o/0/d/n")]
    [InlineData("{\"a/b~c\":1,\"a/b~c\":2}", "structure.duplicate_member /a~1b~0c")]
    public void RefusesADuplicateMemberAndPointsAtIt(string input, string expected)
        => Assert.Equal(expected, Verdict(Encoding.UTF8.GetBytes(input)));

    [Fact]
    public void AcceptsTheSameNameInTwoDifferentObjects()
        => Assert.Equal(
            "accepted",
            Verdict(Encoding.UTF8.GetBytes("{\"x\":{\"status\":1},\"y\":{\"status\":2}}")));

    [Fact]
    public void NeverEchoesTheRepeatedName()
    {
        var result = Ingest.IngestDocument(
            Encoding.UTF8.GetBytes("{\"secretish\":1,\"secretish\":2}"));
        Assert.DoesNotContain("secretish", result.Issue!.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ReportsSyntaxBeforeDuplicatesOnMalformedInput()
        => Assert.Equal("syntax.invalid_json ", Verdict(Encoding.UTF8.GetBytes("{\"a\":1,\"a\":2")));

    [Fact]
    public void AcceptsExactlyTheDepthCeilingAndRefusesOneOver()
    {
        Assert.Equal("accepted", Verdict(Nested(Ingest.MaxDepth)));
        var result = Ingest.IngestDocument(Nested(Ingest.MaxDepth + 1));
        Assert.Equal(Ingest.ErrorCode.StructureDepthExceeded, result.Issue!.Code);
        Assert.Contains("33", result.Issue.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusesADocumentDeepEnoughToBreakARecursiveWalker()
    {
        // 20000 levels. JsonNode.Parse and the safety scan both recurse; the
        // boundary must answer with an issue rather than a stack overflow,
        // which on this runtime cannot even be caught.
        Assert.Equal(
            Ingest.ErrorCode.StructureDepthExceeded,
            Ingest.IngestDocument(Nested(20000)).Issue!.Code);
    }

    [Fact]
    public void DoesNotCountBracesInsideStrings()
        => Assert.Equal(
            "accepted",
            Verdict(Encoding.UTF8.GetBytes("{\"a\":\"" + new string('{', 200) + "\"}")));

    [Fact]
    public void AcceptsExactlyTheSizeCeilingAndRefusesOneByteOver()
    {
        Assert.Equal("accepted", Verdict(Padded(Ingest.MaxBytes)));
        Assert.Equal("document.too_large ", Verdict(Padded(Ingest.MaxBytes + 1)));
    }

    [Fact]
    public void TheStoreReadsThroughTheBoundary()
    {
        var store = new HandoverStore(_home.Path);
        store.Init();
        File.WriteAllBytes(
            Path.Combine(store.HandoversDir, "001.json"),
            new byte[] { 0xEF, 0xBB, 0xBF }
                .Concat(Encoding.UTF8.GetBytes("{\"soilHandover\":\"1.0\"}"))
                .ToArray());
        var thrown = Assert.Throws<IngestException>(() => store.Read("#001"));
        Assert.Equal(Ingest.ErrorCode.EncodingByteOrderMark, thrown.Issue.Code);
    }
}
