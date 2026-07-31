using System.Text.Json.Nodes;

namespace Soil.Handover.Tests;

/// <summary>Shared helpers: repo paths, golden files, and document builders.</summary>
internal static class TestData
{
    /// <summary>A fixed clock shared by every test that needs one.</summary>
    public static readonly DateTimeOffset Now =
        new(2026, 7, 22, 10, 0, 0, TimeSpan.Zero);

    /// <summary>
    /// A syntactically valid UUID used where a test needs a document that is
    /// complete but is not exercising the writer's assignment path.
    /// </summary>
    public const string AValidId = "019f7e89-fc00-7000-8000-000000000000";

    /// <summary>A capture time, stated by the document. Nothing reads a clock.</summary>
    public const string ACaptureTime = "2026-07-22T10:00:00Z";

    /// <summary>
    /// Normalize and assert the object shape, which is what every test here
    /// feeds it. <see cref="Normalize.NormalizeHandover"/> itself returns a
    /// JsonNode, because a root that is not an object is carried through as it
    /// arrived rather than replaced with a document built around it.
    /// </summary>
    public static JsonObject Normalized(JsonNode? input)
        => (JsonObject)Normalize.NormalizeHandover(input)!;

    /// <summary>The repo root, found by walking up from the test binary.</summary>
    public static string RepoRoot { get; } = FindRepoRoot();

    private static string FindRepoRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "spec", "handover.schema.json")))
            {
                return directory.FullName;
            }
            directory = directory.Parent!;
        }
        throw new InvalidOperationException("could not find the repo root above the test binary");
    }

    public static string RepoFile(params string[] parts)
        => Path.Combine(new[] { RepoRoot }.Concat(parts).ToArray());

    /// <summary>Read a golden file produced from the TypeScript SDK.</summary>
    public static string Golden(string name)
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "golden", name));

    public static JsonObject ReadJson(string path)
        => (JsonObject)JsonNode.Parse(File.ReadAllText(path))!;

    /// <summary>The worked example from <c>examples/</c>.</summary>
    public static JsonObject Example()
        => ReadJson(RepoFile("examples", "orchard-checkout.json"));

    /// <summary>All 17 sections, each declared missing, with optional overrides.</summary>
    public static JsonObject AllSections(Action<JsonObject>? mutate = null)
    {
        var sections = new JsonObject();
        foreach (var key in Sections.SectionKeys)
        {
            sections[key] = new JsonObject
            {
                ["status"] = "missing",
                ["summary"] = null,
            };
        }
        mutate?.Invoke(sections);
        return sections;
    }

    /// <summary>A complete valid handover, with optional overrides applied after.</summary>
    public static JsonObject Handover(Action<JsonObject>? mutate = null)
    {
        var document = new JsonObject
        {
            ["soilHandover"] = "1.0",
            ["handoverId"] = AValidId,
            ["projectId"] = "test-project",
            ["title"] = "A handover",
            ["createdAt"] = "2026-07-20T08:00:00Z",
            ["sections"] = AllSections(),
        };
        mutate?.Invoke(document);
        return document;
    }

    /// <summary>A temp directory that deletes itself.</summary>
    public sealed class TempHome : IDisposable
    {
        public string Path { get; }

        public TempHome()
        {
            Path = Directory.CreateTempSubdirectory("soil-dotnet-test-").FullName;
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(Path, recursive: true);
            }
            catch (IOException)
            {
                // Best effort; temp cleanup is not part of any assertion.
            }
        }
    }
}
