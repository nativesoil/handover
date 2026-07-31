using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Soil.Handover;

/// <summary>
/// Validation: does this document obey the Soil Handover Specification v1?
///
/// Two normative rules are checked, and only two. First the shape: the 17
/// sections, the statuses, the labels, the bounds. Then the fail-closed
/// secret scan: a handover that carries credentials or private absolute
/// paths is rejected, because a handover is written to be moved and anything
/// inside it has already left the machine.
///
/// Neither rule is a judgement about content. This answers "is this a
/// handover and is it safe to move", never "is this a good handover". A thin
/// but honest handover is valid, and so is one whose every section is
/// missing.
///
/// spec/handover.schema.json is the normative statement of these same
/// rules. The conformance suite asserts that this method and that schema
/// agree on every fixture, so the two cannot drift apart.
///
/// Zero dependencies on purpose: the SDK should be usable anywhere without
/// a validator package, and the error messages here can say what a JSON
/// Schema error cannot.
/// </summary>
public static partial class Validate
{
    /// <summary>
    /// Why <c>not_applicable</c> is the one gap status that must say
    /// something. It is a positive assertion about the project rather than a
    /// report about the extractor, and it is the only status that tells the
    /// next model to stop looking. A writer that cannot say why a section does
    /// not apply has not established that it does not apply; it has
    /// established that it could not see it, and <c>missing</c> says exactly
    /// that and carries no such requirement.
    /// </summary>
    private const string NotApplicableNeedsReason =
        "must say why the section does not apply when status is 'not_applicable': "
        + "a gap that tells the next model to stop looking has to carry its reason, "
        + "and a gap with no reason is 'missing'";

    private static readonly Regex ProjectIdPattern = new("^[A-Za-z0-9][A-Za-z0-9._-]*$");
    private static readonly Regex CodePattern = new(@"^#\d{3,}$");
    private static readonly Regex IsoDatePattern =
        new(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$");
    private static readonly Regex RecipeVersionPattern = new(@"^\d+\.\d+\.\d+$");

    private static readonly string[] SourceTextKeys = { "client", "model", "provider" };
    private static readonly string[] SourceKeys = { "client", "model", "provider", "recipeVersion" };
    private static readonly string[] ObservationKeys = { "kind", "producedBy", "producedAt", "data" };
    private static readonly string[] QualityKeys = { "missingInputs", "contradictions" };
    private static readonly string[] SafetyKeys = { "unsafeOmissions" };
    private static readonly string[] RootKeys =
    {
        "soilHandover",
        "handoverId",
        "projectId",
        "title",
        "createdAt",
        "source",
        "sections",
        "quality",
        "safety",
        "observations",
        "code",
    };

    private sealed class IssueBag
    {
        public List<ValidationIssue> Issues { get; } = new();

        public void Add(string path, string message, string kind = ValidationIssueKind.Structure)
            => Issues.Add(new ValidationIssue(path, message, kind));
    }

    private static string? AsString(JsonNode? node)
        => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static bool IsString(JsonNode? node)
        => node is JsonValue value && value.TryGetValue<string>(out _);

    private static void CheckStringList(IssueBag bag, JsonNode? value, string path)
    {
        if (value is not JsonArray array)
        {
            bag.Add(path, "must be an array of strings");
            return;
        }
        if (array.Count > Sections.Limits.ListEntries)
        {
            bag.Add(path, $"must hold at most {Sections.Limits.ListEntries} entries");
        }
        for (var i = 0; i < array.Count; i += 1)
        {
            var entry = AsString(array[i]);
            if (entry is null)
            {
                bag.Add($"{path}/{i}", "must be a string");
                continue;
            }
            if (entry.Trim().Length == 0)
            {
                bag.Add($"{path}/{i}", "must not be empty");
            }
            if (Sections.TextLength(entry) > Sections.Limits.ListEntry)
            {
                bag.Add($"{path}/{i}", $"must be at most {Sections.Limits.ListEntry} code points");
            }
        }
    }

    private static void CheckExtraKeys(
        IssueBag bag,
        JsonObject record,
        IReadOnlyCollection<string> allowed,
        string path)
    {
        foreach (var property in record)
        {
            if (!allowed.Contains(property.Key))
            {
                bag.Add($"{path}/{property.Key}", "is not a field of this object");
            }
        }
    }

    private static void CheckSections(IssueBag bag, JsonNode? value)
    {
        if (value is not JsonObject sections)
        {
            bag.Add("/sections", "must be an object holding all 17 sections");
            return;
        }
        CheckExtraKeys(bag, sections, (IReadOnlyCollection<string>)Sections.SectionKeys, "/sections");

        foreach (var key in Sections.SectionKeys)
        {
            var path = $"/sections/{key}";
            if (!sections.TryGetPropertyValue(key, out var sectionNode))
            {
                bag.Add(
                    path,
                    "is required: every section is declared, and a gap is stated with status 'missing'");
                continue;
            }
            if (sectionNode is not JsonObject section)
            {
                bag.Add(path, "must be an object with 'status' and 'summary'");
                continue;
            }
            CheckExtraKeys(bag, section, new[] { "status", "summary", "provenance" }, path);

            var status = AsString(section.TryGetPropertyValue("status", out var statusNode) ? statusNode : null);
            if (status is null || !Sections.SectionStatuses.Contains(status))
            {
                bag.Add(
                    $"{path}/status",
                    $"must be one of {string.Join(", ", Sections.SectionStatuses)}");
            }

            var hasSummary = section.TryGetPropertyValue("summary", out var summaryNode);
            var summary = AsString(summaryNode);
            if (!hasSummary || (summaryNode is not null && summary is null))
            {
                bag.Add($"{path}/summary", "must be a string or null");
            }
            else if (summary is not null)
            {
                if (Sections.TextLength(summary) > Sections.Limits.SectionSummary)
                {
                    bag.Add(
                        $"{path}/summary",
                        $"must be at most {Sections.Limits.SectionSummary} code points");
                }
                if (status == "available" && summary.Trim().Length == 0)
                {
                    bag.Add($"{path}/summary", "must hold content when status is 'available'");
                }
                if (status == "not_applicable" && summary.Trim().Length == 0)
                {
                    bag.Add($"{path}/summary", NotApplicableNeedsReason);
                }
            }
            else if (status == "available")
            {
                bag.Add($"{path}/summary", "must hold content when status is 'available'");
            }
            else if (status == "not_applicable")
            {
                bag.Add($"{path}/summary", NotApplicableNeedsReason);
            }

            if (section.TryGetPropertyValue("provenance", out var provenanceNode))
            {
                if (provenanceNode is not JsonArray provenance)
                {
                    bag.Add($"{path}/provenance", "must be an array of provenance labels");
                }
                else
                {
                    if (provenance.Count > Sections.Limits.ProvenanceLabelCount)
                    {
                        bag.Add(
                            $"{path}/provenance",
                            $"must hold at most {Sections.Limits.ProvenanceLabelCount} labels");
                    }
                    var seen = new HashSet<string>();
                    for (var i = 0; i < provenance.Count; i += 1)
                    {
                        var label = AsString(provenance[i]);
                        if (label is null || !Sections.ProvenanceLabels.Contains(label))
                        {
                            bag.Add(
                                $"{path}/provenance/{i}",
                                $"must be one of {string.Join(", ", Sections.ProvenanceLabels)}");
                            continue;
                        }
                        if (seen.Contains(label))
                        {
                            bag.Add($"{path}/provenance/{i}", "is a duplicate label");
                        }
                        seen.Add(label);
                    }
                }
            }
        }
    }

    private static bool IsParsableTimestamp(string text)
        => DateTimeOffset.TryParse(
            text,
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out _);

    /// <summary>
    /// Validate a candidate handover against the spec.
    ///
    /// Every problem is reported, not just the first, so a model fixing its
    /// output needs one round trip rather than five.
    /// </summary>
    public static ValidationResult ValidateHandover(JsonNode? input)
    {
        var bag = new IssueBag();

        if (input is not JsonObject root)
        {
            bag.Add("", "a handover must be a JSON object");
            // Fail closed even here. A document with the wrong root shape is
            // still a document, and a credential inside one has still left
            // the machine. The scan runs before this early return so that no
            // document the ingestion boundary accepted is refused without
            // also being scanned.
            foreach (var finding in Safety.FindSecretMaterial(input))
            {
                bag.Add(finding.Path, Safety.DescribeSecretFinding(finding), ValidationIssueKind.Safety);
            }
            return new ValidationResult(false, bag.Issues);
        }

        CheckExtraKeys(bag, root, RootKeys, "");

        var version = AsString(root.TryGetPropertyValue("soilHandover", out var versionNode) ? versionNode : null);
        if (version is null)
        {
            bag.Add("/soilHandover", "is required and must be a string, e.g. \"1.0\"");
        }
        else if (!Spec.SupportedVersions.Contains(version))
        {
            // Exact versions, never a pattern. A reader that accepts a minor
            // it does not implement is claiming to implement a version nobody
            // has written; version one is a closed world, so whatever that
            // minor allowed would arrive unrecognised. See
            // spec/versioning.md.
            var supported = string.Join(", ", Spec.SupportedVersions);
            bag.Add(
                "/soilHandover",
                $"must be a format version this reader supports ({supported}), got \"{version}\"");
        }

        if (!root.TryGetPropertyValue("handoverId", out var handoverIdNode))
        {
            bag.Add(
                "/handoverId",
                "is required: the globally unique id a writer assigns when the handover is stored");
        }
        else
        {
            var handoverId = AsString(handoverIdNode);
            if (handoverId is null || !Identity.HandoverIdPattern.IsMatch(handoverId))
            {
                bag.Add(
                    "/handoverId",
                    "must be a UUID in canonical form: lowercase hex as 8-4-4-4-12");
            }
        }

        var projectId = AsString(root.TryGetPropertyValue("projectId", out var projectIdNode) ? projectIdNode : null);
        if (projectId is null || projectId.Length == 0)
        {
            bag.Add("/projectId", "is required and must be a non-empty string");
        }
        else
        {
            if (Sections.TextLength(projectId) > Sections.Limits.ProjectId)
            {
                bag.Add("/projectId", $"must be at most {Sections.Limits.ProjectId} code points");
            }
            if (!ProjectIdPattern.IsMatch(projectId))
            {
                bag.Add(
                    "/projectId",
                    "must be a slug: letters, digits, dot, dash or underscore, no spaces");
            }
        }

        var title = AsString(root.TryGetPropertyValue("title", out var titleNode) ? titleNode : null);
        if (title is null || title.Trim().Length == 0)
        {
            bag.Add("/title", "is required and must be a non-empty string");
        }
        else if (Sections.TextLength(title) > Sections.Limits.Title)
        {
            bag.Add("/title", $"must be at most {Sections.Limits.Title} code points");
        }

        var createdAt = AsString(root.TryGetPropertyValue("createdAt", out var createdAtNode) ? createdAtNode : null);
        if (createdAt is null)
        {
            bag.Add("/createdAt", "is required and must be an ISO 8601 timestamp");
        }
        else if (!IsoDatePattern.IsMatch(createdAt) || !IsParsableTimestamp(createdAt))
        {
            bag.Add("/createdAt", "must be an ISO 8601 timestamp, e.g. \"2026-07-23T09:41:00Z\"");
        }

        if (root.TryGetPropertyValue("source", out var sourceNode))
        {
            if (sourceNode is not JsonObject source)
            {
                bag.Add("/source", "must be an object");
            }
            else
            {
                CheckExtraKeys(bag, source, SourceKeys, "/source");
                foreach (var key in SourceTextKeys)
                {
                    if (source.TryGetPropertyValue(key, out var entry) && !IsString(entry))
                    {
                        bag.Add($"/source/{key}", "must be a string");
                    }
                }
                if (source.TryGetPropertyValue("recipeVersion", out var recipeNode))
                {
                    var recipeVersion = AsString(recipeNode);
                    if (recipeVersion is null || !RecipeVersionPattern.IsMatch(recipeVersion))
                    {
                        bag.Add("/source/recipeVersion", "must be a semver string such as \"1.0.0\"");
                    }
                }
            }
        }

        CheckSections(bag, root.TryGetPropertyValue("sections", out var sectionsNode) ? sectionsNode : null);

        if (root.TryGetPropertyValue("quality", out var qualityNode))
        {
            if (qualityNode is not JsonObject quality)
            {
                bag.Add("/quality", "must be an object");
            }
            else
            {
                CheckExtraKeys(bag, quality, QualityKeys, "/quality");
                foreach (var key in QualityKeys)
                {
                    if (quality.TryGetPropertyValue(key, out var list))
                    {
                        CheckStringList(bag, list, $"/quality/{key}");
                    }
                }
            }
        }

        if (root.TryGetPropertyValue("safety", out var safetyNode))
        {
            if (safetyNode is not JsonObject safety)
            {
                bag.Add("/safety", "must be an object");
            }
            else
            {
                CheckExtraKeys(bag, safety, SafetyKeys, "/safety");
                foreach (var key in SafetyKeys)
                {
                    if (safety.TryGetPropertyValue(key, out var list))
                    {
                        CheckStringList(bag, list, $"/safety/{key}");
                    }
                }
            }
        }

        // The extension point. Shape is checked; meaning is not. An entry
        // whose kind this implementation has never heard of is valid on
        // purpose.
        if (root.TryGetPropertyValue("observations", out var observationsNode))
        {
            if (observationsNode is not JsonArray observations)
            {
                bag.Add("/observations", "must be an array of observations");
            }
            else
            {
                if (observations.Count > Sections.Limits.Observations)
                {
                    bag.Add(
                        "/observations",
                        $"must hold at most {Sections.Limits.Observations} entries");
                }
                for (var i = 0; i < observations.Count; i += 1)
                {
                    var path = $"/observations/{i}";
                    if (observations[i] is not JsonObject observation)
                    {
                        bag.Add(path, "must be an object with 'kind' and 'data'");
                        continue;
                    }
                    CheckExtraKeys(bag, observation, ObservationKeys, path);

                    var kind = AsString(observation.TryGetPropertyValue("kind", out var kindNode) ? kindNode : null);
                    if (kind is null || kind.Trim().Length == 0)
                    {
                        bag.Add($"{path}/kind", "is required and must be a non-empty string");
                    }
                    else if (Sections.TextLength(kind) > Sections.Limits.ObservationKind)
                    {
                        bag.Add(
                            $"{path}/kind",
                            $"must be at most {Sections.Limits.ObservationKind} code points");
                    }

                    if (!observation.TryGetPropertyValue("data", out var dataNode)
                        || dataNode is not JsonObject)
                    {
                        bag.Add($"{path}/data", "is required and must be an object");
                    }

                    foreach (var key in new[] { "producedBy", "producedAt" })
                    {
                        if (observation.TryGetPropertyValue(key, out var entry) && !IsString(entry))
                        {
                            bag.Add($"{path}/{key}", "must be a string");
                        }
                    }
                    var producedAt = AsString(
                        observation.TryGetPropertyValue("producedAt", out var producedAtNode)
                            ? producedAtNode
                            : null);
                    if (producedAt is not null
                        && (!IsoDatePattern.IsMatch(producedAt) || !IsParsableTimestamp(producedAt)))
                    {
                        bag.Add($"{path}/producedAt", "must be an ISO 8601 timestamp");
                    }
                }
            }
        }

        if (root.TryGetPropertyValue("code", out var codeNode))
        {
            var code = AsString(codeNode);
            if (code is null || !CodePattern.IsMatch(code))
            {
                bag.Add("/code", "must look like \"#004\": a hash and at least 3 digits");
            }
        }

        // Fail closed on credentials. This runs whatever the structural
        // result was: a malformed document carrying a key is still a key.
        foreach (var finding in Safety.FindSecretMaterial(input))
        {
            bag.Add(finding.Path, Safety.DescribeSecretFinding(finding), ValidationIssueKind.Safety);
        }

        return new ValidationResult(bag.Issues.Count == 0, bag.Issues);
    }

    /// <summary>
    /// Validate and return the same object. Throws
    /// <see cref="HandoverValidationException"/> when invalid.
    /// </summary>
    public static JsonObject AssertHandover(JsonNode? input)
    {
        var result = ValidateHandover(input);
        if (!result.Valid)
        {
            throw new HandoverValidationException(result.Issues);
        }
        return (JsonObject)input!;
    }
}

/// <summary>
/// Thrown by <see cref="Validate.AssertHandover"/>. Carries every issue, not
/// just the first.
/// </summary>
public sealed class HandoverValidationException : Exception
{
    public IReadOnlyList<ValidationIssue> Issues { get; }

    public HandoverValidationException(IReadOnlyList<ValidationIssue> issues)
        : base("not a valid Soil handover: "
               + string.Join("; ", issues.Select(issue =>
                   $"{(issue.Path.Length == 0 ? "/" : issue.Path)} {issue.Message}")))
    {
        Issues = issues;
    }
}
