using System.Text.Json.Nodes;
using Xunit;

namespace Soil.Handover.Tests;

/// <summary>
/// Cross-SDK parity: the .NET SDK produces the same bytes as the TypeScript
/// SDK for the same inputs.
///
/// The files under <c>golden/</c> were produced by running the TypeScript
/// SDK over fixed inputs (see <c>tools/generate-golden.mjs</c>); every test
/// here rebuilds the same output in .NET and asserts byte identity. The
/// restore prompt and the rail card are the format's user-facing surface,
/// and the store files are shared state, so byte identity is the bar, not
/// resemblance.
/// </summary>
public class ParityTests
{
    /// <summary>
    /// The fixed boundary token the goldens were generated with. Production
    /// takes 128 bits from the platform's cryptographic source on every
    /// render, so a golden of a per-render value would be a golden of nothing.
    /// </summary>
    private const string BoundaryToken = "0123456789abcdef0123456789abcdef";

    [Fact]
    public void TheRestorePromptIsByteIdenticalForTheExample()
    {
        Assert.Equal(
            TestData.Golden("restore-prompt-example.txt"),
            Restore.BuildRestorePrompt(TestData.Example(), BoundaryToken));
    }

    [Fact]
    public void TheRestorePromptIsByteIdenticalForTheObservationsFixture()
    {
        var doc = TestData.ReadJson(TestData.RepoFile(
            "conformance", "fixtures", "valid", "observations-unknown-kinds.json"));
        Assert.Equal(
            TestData.Golden("restore-prompt-observations.txt"),
            Restore.BuildRestorePrompt(doc, BoundaryToken));
    }

    [Fact]
    public void TheWorkingStyleBlockIsByteIdenticalForTheFixtureCarryingTheKind()
    {
        // The block a caller can ask for. A document carrying the kind used to
        // render one way in the reference implementation and another way here,
        // which is the one thing the cross-language byte-identity claim does not
        // survive.
        var doc = TestData.ReadJson(TestData.RepoFile(
            "conformance", "fixtures", "valid", "observation-working-style.json"));
        Assert.Equal(
            TestData.Golden("restore-prompt-working-style.txt"),
            Restore.BuildRestorePrompt(doc, BoundaryToken, workingStyleEvidence: true));
    }

    [Fact]
    public void TheRestorePromptIsByteIdenticalForAThinHandover()
    {
        var thin = TestData.Normalized(new JsonObject
        {
            ["projectId"] = "thin",
            ["title"] = "Thin",
            ["createdAt"] = "2026-07-22T10:00:00Z",
            ["sections"] = new JsonObject
            {
                ["executiveSummary"] = "Almost nothing happened.",
            },
        });
        Assert.Equal(
            TestData.Golden("restore-prompt-thin.txt"),
            Restore.BuildRestorePrompt(thin, BoundaryToken));
    }

    [Fact]
    public void TheSavedCardIsByteIdenticalForTheExample()
    {
        Assert.Equal(
            TestData.Golden("saved-card-example.txt"),
            Render.RenderSaved(TestData.Example(), "#001"));
    }

    [Fact]
    public void TheSavedCardIsByteIdenticalForADocWithGapsAndOmissions()
    {
        var doc = TestData.Normalized(new JsonObject
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
        Assert.Equal(
            TestData.Golden("saved-card-render-test.txt"),
            Render.RenderSaved(doc, "#004"));
    }

    [Fact]
    public void TheLoadedCardIsByteIdenticalForTheExample()
    {
        var doc = TestData.Example();
        doc["code"] = "#004";
        Assert.Equal(
            TestData.Golden("loaded-card-example.txt"),
            Render.RenderLoaded(doc));
    }

    [Fact]
    public void TheListCardIsByteIdentical()
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
            new StoreEntry(
                "#001",
                "render-test",
                "Short",
                "2026-07-22T09:00:00Z",
                17,
                "001.json"),
        });
        Assert.Equal(TestData.Golden("list-card.txt"), card);
        Assert.Equal(TestData.Golden("list-card-empty.txt"), Render.RenderList(Array.Empty<StoreEntry>()));
    }

    [Fact]
    public void TheValidationCardsAreByteIdentical()
    {
        Assert.Equal(
            TestData.Golden("validation-card-valid.txt"),
            Render.RenderValidation(Validate.ValidateHandover(TestData.Example()), "the document"));
        Assert.Equal(
            TestData.Golden("validation-card-invalid.txt"),
            Render.RenderValidation(
                Validate.ValidateHandover(new JsonObject { ["soilHandover"] = "1.0" }),
                "x"));
        var secretDoc = TestData.Normalized(new JsonObject
        {
            ["handoverId"] = TestData.AValidId,
            ["projectId"] = "scan",
            ["title"] = "Scan",
            ["createdAt"] = TestData.ACaptureTime,
            ["sections"] = new JsonObject
            {
                ["architecture"] = "the key is sk-abc123def456",
            },
        });
        Assert.Equal(
            TestData.Golden("validation-card-secret.txt"),
            Render.RenderValidation(Validate.ValidateHandover(secretDoc), "a save"));
    }

    [Fact]
    public void TheNormalizedDocumentSerializesToTheSameBytes()
    {
        var loose = TestData.Normalized(new JsonObject
        {
            ["projectId"] = "loose-shape",
            ["title"] = "A reply in the rescue shape",
            ["createdAt"] = TestData.ACaptureTime,
            ["extractionSections"] = new JsonObject
            {
                ["projectIdentity"] = "A project that exists only to test the loose shape.",
                ["decisions"] = new JsonObject
                {
                    ["status"] = "available",
                    ["summary"] = "One decision was made.",
                },
                ["blockers"] = new JsonObject
                {
                    ["status"] = "missing",
                    ["summary"] = null,
                },
                ["workflow"] = new JsonObject
                {
                    ["status"] = "available",
                    ["summary"] = "  padded  ",
                    ["provenance"] = new JsonArray("model_reported", "vibe_checked"),
                },
            },
            ["quality"] = new JsonObject
            {
                ["missingInputs"] = new JsonArray("the logs", "  "),
            },
            ["safety"] = new JsonObject
            {
                ["unsafeOmissions"] = new JsonArray("a key exists in the platform config"),
            },
        });
        Assert.Equal(
            TestData.Golden("normalized-loose.json"),
            JsonCanon.Stringify(loose) + "\n");
    }

    [Fact]
    public void TheStoreWritesTheSameFileBytesAsTheTypescriptStore()
    {
        using var home = new TestData.TempHome();
        var store = new HandoverStore(home.Path);
        store.Save(TestData.Example());
        var identified = TestData.Normalized(new JsonObject
        {
            ["handoverId"] = "019f7e89-fc00-7000-8000-00000000abcd",
            ["projectId"] = "golden-store",
            ["title"] = "Stored with a fixed identity",
            ["createdAt"] = "2026-07-22T10:00:00Z",
            ["sections"] = new JsonObject
            {
                ["executiveSummary"] = "Fixed bytes for the store parity test.",
            },
        });
        store.Save(identified);
        var observed = TestData.ReadJson(TestData.RepoFile(
            "conformance", "fixtures", "valid", "observations-unknown-kinds.json"));
        store.Save(observed);

        Assert.Equal(
            TestData.Golden("store-001.json"),
            File.ReadAllText(Path.Combine(home.Path, "handovers", "001.json")));
        Assert.Equal(
            TestData.Golden("store-002.json"),
            File.ReadAllText(Path.Combine(home.Path, "handovers", "002.json")));
        Assert.Equal(
            TestData.Golden("store-003.json"),
            File.ReadAllText(Path.Combine(home.Path, "handovers", "003.json")));
        Assert.Equal(
            TestData.Golden("store-index.json"),
            File.ReadAllText(Path.Combine(home.Path, "index.json")));
    }
}
