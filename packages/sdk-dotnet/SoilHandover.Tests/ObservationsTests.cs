using System.Text.Json.Nodes;
using Xunit;

namespace Soil.Handover.Tests;

/// <summary>
/// The extension point, tested from the angle that matters: a reader meeting
/// a producer it has never heard of.
/// </summary>
public class ObservationsTests
{
    private static JsonObject WithObservations(JsonNode? observations)
        => TestData.Normalized(new JsonObject
        {
            ["handoverId"] = TestData.AValidId,
            ["projectId"] = "extension-test",
            ["title"] = "Extension point",
            ["createdAt"] = TestData.ACaptureTime,
            ["sections"] = new JsonObject { ["executiveSummary"] = "A project." },
            ["observations"] = observations,
        });

    [Fact]
    public void AreOptionalAHandoverWithoutAnyIsComplete()
    {
        var doc = TestData.Normalized(new JsonObject
        {
            ["handoverId"] = TestData.AValidId,
            ["projectId"] = "none",
            ["title"] = "None",
            ["createdAt"] = TestData.ACaptureTime,
            ["sections"] = new JsonObject { ["decisions"] = "one" },
        });
        Assert.False(doc.ContainsKey("observations"));
        Assert.True(Validate.ValidateHandover(doc).Valid);
    }

    [Fact]
    public void AcceptAKindThisImplementationHasNeverHeardOf()
    {
        var doc = WithObservations(new JsonArray(
            new JsonObject
            {
                ["kind"] = "com.example.kind.from.the.future",
                ["data"] = new JsonObject { ["anything"] = new JsonArray(1, 2) },
            }));
        Assert.True(Validate.ValidateHandover(doc).Valid);
    }

    [Fact]
    public void CarryUnknownEntriesThroughNormalizationUnchanged()
    {
        var entries = new JsonArray(
            new JsonObject
            {
                ["kind"] = "com.example.measurement",
                ["producedBy"] = "example-service 3.2",
                ["producedAt"] = "2026-07-20T09:00:00Z",
                ["data"] = new JsonObject
                {
                    ["nested"] = new JsonObject
                    {
                        ["deeply"] = new JsonObject { ["value"] = 4 },
                    },
                },
            },
            new JsonObject
            {
                ["kind"] = "dev.example.annotation",
                ["data"] = new JsonObject(),
            });
        var doc = WithObservations(entries);
        Assert.True(JsonNode.DeepEquals(entries, doc["observations"]));
    }

    [Fact]
    public void DoNotChangeHowTheSectionsAreRead()
    {
        var baseline = TestData.Normalized(new JsonObject
        {
            ["projectId"] = "extension-test",
            ["title"] = "Extension point",
            ["createdAt"] = "2026-07-22T10:00:00Z",
            ["sections"] = new JsonObject
            {
                ["executiveSummary"] = "A project.",
                ["decisions"] = "One decision.",
            },
        });
        var observed = (JsonObject)baseline.DeepClone();
        observed["observations"] = new JsonArray(
            new JsonObject
            {
                ["kind"] = "com.example.anything",
                ["data"] = new JsonObject { ["score"] = 11 },
            });
        // A fixed boundary token, because production takes a fresh one from
        // the platform's cryptographic source on every render and the point
        // here is the sections, not the boundary.
        const string token = "0123456789abcdef0123456789abcdef";
        Assert.Equal(
            Restore.BuildRestorePrompt(baseline, token),
            Restore.BuildRestorePrompt(observed, token));
    }

    [Fact]
    public void RejectAnEntryWithAKeyOutsideTheEnvelope()
    {
        var result = Validate.ValidateHandover(WithObservations(new JsonArray(
            new JsonObject
            {
                ["kind"] = "a.kind",
                ["data"] = new JsonObject(),
                ["extra"] = "no",
            })));
        Assert.Equal("/observations/0/extra", result.Issues[0].Path);
    }

    [Fact]
    public void RejectAnEntryWithNoKindOrNoData()
    {
        var noKind = Validate.ValidateHandover(WithObservations(new JsonArray(
            new JsonObject { ["data"] = new JsonObject() })));
        Assert.Equal("/observations/0/kind", noKind.Issues[0].Path);

        var noData = Validate.ValidateHandover(WithObservations(new JsonArray(
            new JsonObject { ["kind"] = "a.kind" })));
        Assert.Equal("/observations/0/data", noData.Issues[0].Path);
    }

    [Fact]
    public void RejectAProducedAtThatIsNotATimestamp()
    {
        var result = Validate.ValidateHandover(WithObservations(new JsonArray(
            new JsonObject
            {
                ["kind"] = "a.kind",
                ["producedAt"] = "recently",
                ["data"] = new JsonObject(),
            })));
        Assert.Equal("/observations/0/producedAt", result.Issues[0].Path);
    }

    [Fact]
    public void RejectObservationsThatAreNotAnArray()
    {
        var doc = WithObservations(new JsonObject
        {
            ["kind"] = "a.kind",
            ["data"] = new JsonObject(),
        });
        Assert.False(Validate.ValidateHandover(doc).Valid);
    }

    [Fact]
    public void AreCoveredByTheSecretScanHoweverDeepThePayloadGoes()
    {
        var doc = WithObservations(new JsonArray(
            new JsonObject
            {
                ["kind"] = "com.example.measurement",
                ["data"] = new JsonObject
                {
                    ["call"] = new JsonObject
                    {
                        ["header"] = "Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e",
                    },
                },
            }));
        Assert.Equal(
            "/observations/0/data/call/header",
            Safety.FindSecretMaterial(doc)[0].Path);
        var result = Validate.ValidateHandover(doc);
        Assert.False(result.Valid);
        Assert.Equal(ValidationIssueKind.Safety, result.Issues[0].Kind);
    }
}
