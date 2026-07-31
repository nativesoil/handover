using System.Reflection;

namespace Soil.Handover;

/// <summary>
/// Reads the byte-normative texts embedded at build time from the canonical
/// files in <c>recipes/</c> at the repo root. Embedding preserves the exact
/// bytes, and a test compares the embedded copies to the repo files so they
/// cannot drift apart.
/// </summary>
internal static class Embedded
{
    public static string Read(string logicalName)
    {
        var assembly = typeof(Embedded).Assembly;
        using var stream = assembly.GetManifestResourceStream(logicalName)
            ?? throw new InvalidOperationException($"missing embedded resource {logicalName}");
        using var reader = new StreamReader(stream, System.Text.Encoding.UTF8);
        return reader.ReadToEnd();
    }
}
