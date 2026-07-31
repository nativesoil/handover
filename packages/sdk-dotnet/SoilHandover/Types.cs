namespace Soil.Handover;

/// <summary>Constants about the specification itself.</summary>
public static class Spec
{
    /// <summary>The format version this SDK writes.</summary>
    public const string Version = "1.0";

    /// <summary>
    /// The format versions this SDK reads, exactly.
    ///
    /// Support is a set of versions, not a pattern. A reader that accepts
    /// <c>1.4</c> because the string starts with <c>1.</c> is claiming to
    /// implement a version nobody has written yet, and version one is a closed
    /// world: whatever a later minor allowed, this reader would meet it having
    /// never been told what it means. Refusing is the honest answer. See
    /// <c>spec/versioning.md</c>.
    /// </summary>
    public static readonly string[] SupportedVersions = ["1.0"];
}

/// <summary>A row in the local index.</summary>
/// <param name="Code">The load code, e.g. <c>#004</c>.</param>
/// <param name="ProjectId">The project slug.</param>
/// <param name="Title">The handover title.</param>
/// <param name="CreatedAt">When the handover was written (ISO 8601).</param>
/// <param name="SectionsWithContent">How many of the 17 sections have status <c>available</c>. Structural content presence, never a claim that the capture succeeded.</param>
/// <param name="File">File name inside the store's <c>handovers/</c> directory.</param>
public sealed record StoreEntry(
    string Code,
    string ProjectId,
    string Title,
    string CreatedAt,
    int SectionsWithContent,
    string File);

/// <summary>The on-disk index document.</summary>
/// <param name="IndexVersion">Always 1.</param>
/// <param name="NextCode">The next numeric code the store will hand out.</param>
/// <param name="Entries">One row per stored handover.</param>
public sealed record StoreIndex(
    int IndexVersion,
    int NextCode,
    IReadOnlyList<StoreEntry> Entries);

/// <summary>
/// What kind of rule an issue broke. <c>structure</c> is the shape of the
/// document. <c>safety</c> is the fail-closed secret scan, which is a spec
/// rule rather than a schema rule because JSON Schema cannot express "this
/// string looks like a token".
/// </summary>
public static class ValidationIssueKind
{
    public const string Structure = "structure";
    public const string Safety = "safety";
}

/// <summary>One problem found by <see cref="Validate.ValidateHandover"/>.</summary>
/// <param name="Path">JSON Pointer-ish path to the offending value, e.g. <c>/sections/decisions</c>.</param>
/// <param name="Message">What is wrong, in plain language. Never quotes the offending value.</param>
/// <param name="Kind">Which rule was broken: <c>structure</c> or <c>safety</c>.</param>
public sealed record ValidationIssue(
    string Path,
    string Message,
    string Kind = ValidationIssueKind.Structure);

/// <summary>The result of validating a candidate handover.</summary>
public sealed record ValidationResult(
    bool Valid,
    IReadOnlyList<ValidationIssue> Issues);

/// <summary>
/// Section counts for a handover. Structural content presence, never a grade.
/// The field is <c>WithContent</c>, not <c>Captured</c>: a section holding two
/// characters has content present and nothing more.
/// </summary>
/// <param name="WithContent">Sections with status <c>available</c>.</param>
/// <param name="Missing">Sections with status <c>missing</c>.</param>
/// <param name="Blocked">Sections with status <c>blocked</c>.</param>
/// <param name="NotApplicable">Sections with status <c>not_applicable</c>.</param>
/// <param name="Total">Always 17.</param>
public sealed record SectionCounts(
    int WithContent,
    int Missing,
    int Blocked,
    int NotApplicable,
    int Total);

/// <summary>The assembled recipe, as data.</summary>
public sealed record HandoverRecipe(
    string SpecVersion,
    IReadOnlyList<string> Instructions,
    IReadOnlyDictionary<string, string> SectionGuidance,
    IReadOnlyList<string> SectionKeys);
