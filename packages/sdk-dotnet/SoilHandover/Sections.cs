namespace Soil.Handover;

/// <summary>
/// The 17 sections of the Soil Handover Specification v1, their tiers, and
/// the provenance label set.
///
/// The key list and the label list are the format's contract: an
/// implementation that renames, reorders, drops or adds a key is not
/// producing a Soil handover. Both are locked for the whole v1 line (see
/// spec/versioning.md).
/// </summary>
public static class Sections
{
    /// <summary>
    /// The 17 section keys, in canonical order.
    ///
    /// Tier A (durable project truth) carries what stays true across
    /// sessions. Tier B (this session's frontier) carries what was true at
    /// capture. Tier C (handover meta) carries the boot prompt and the
    /// honesty record.
    /// </summary>
    public static readonly IReadOnlyList<string> SectionKeys = new[]
    {
        // Tier A: the project (durable).
        "projectIdentity",
        "decisions",
        "workflow",
        "architecture",
        "constraints",
        "rejectedPaths",
        // Tier B: the latest (this session's frontier).
        "executiveSummary",
        "currentTask",
        "latestUserIntent",
        "sessionDelta",
        "blockers",
        "nextSteps",
        "openQuestions",
        // Tier C: handover meta.
        "sessionActivity",
        "restoreInstructions",
        "provenanceMap",
        "safetySummary",
    };

    /// <summary>Which tier each section key belongs to.</summary>
    public static readonly IReadOnlyDictionary<string, string> SectionTiers =
        new Dictionary<string, string>
        {
            ["projectIdentity"] = "durable",
            ["decisions"] = "durable",
            ["workflow"] = "durable",
            ["architecture"] = "durable",
            ["constraints"] = "durable",
            ["rejectedPaths"] = "durable",
            ["executiveSummary"] = "frontier",
            ["currentTask"] = "frontier",
            ["latestUserIntent"] = "frontier",
            ["sessionDelta"] = "frontier",
            ["blockers"] = "frontier",
            ["nextSteps"] = "frontier",
            ["openQuestions"] = "frontier",
            ["sessionActivity"] = "meta",
            ["restoreInstructions"] = "meta",
            ["provenanceMap"] = "meta",
            ["safetySummary"] = "meta",
        };

    /// <summary>Short human labels used by the renderer and the CLI surface.</summary>
    public static readonly IReadOnlyDictionary<string, string> SectionLabels =
        new Dictionary<string, string>
        {
            ["projectIdentity"] = "project identity",
            ["decisions"] = "decisions",
            ["workflow"] = "workflow",
            ["architecture"] = "architecture",
            ["constraints"] = "constraints",
            ["rejectedPaths"] = "rejected paths",
            ["executiveSummary"] = "executive summary",
            ["currentTask"] = "current task",
            ["latestUserIntent"] = "latest user intent",
            ["sessionDelta"] = "session delta",
            ["blockers"] = "blockers",
            ["nextSteps"] = "next steps",
            ["openQuestions"] = "open questions",
            ["sessionActivity"] = "session activity",
            ["restoreInstructions"] = "restore instructions",
            ["provenanceMap"] = "provenance map",
            ["safetySummary"] = "safety summary",
        };

    /// <summary>
    /// The four statuses a section may carry.
    ///
    /// <c>available</c> carries content. The other three are the kinds of
    /// nothing, and they are not interchangeable: <c>missing</c> says the
    /// extractor could not see it and the next session should look,
    /// <c>blocked</c> says it exists and was withheld so the next session
    /// should ask elsewhere, and <c>not_applicable</c> says the project has no
    /// such thing so the next session should stop looking.
    /// <c>not_applicable</c> carries a required reason, because it is the one
    /// status that tells a reader to stop.
    /// </summary>
    public static readonly IReadOnlyList<string> SectionStatuses = new[]
    {
        "available",
        "missing",
        "blocked",
        "not_applicable",
    };

    /// <summary>
    /// The provenance labels a section may carry, so a cold reader can tell
    /// what was checked from what was merely reported or guessed.
    ///
    /// The set is fixed so that a label means the same thing in every
    /// implementation and a handover written by one tool reads the same in
    /// another. Labels are additive facts about a claim's origin; they are
    /// not a grade, and nothing here scores them.
    /// </summary>
    public static readonly IReadOnlyList<string> ProvenanceLabels = new[]
    {
        "repo_verified",
        "soil_observed",
        "prompt_report",
        "user_locked_memory",
        "model_reported",
        "inferred",
        "owner_observed",
        "live_verified",
        "emulator_verified",
        "planned_only",
        "blocked",
    };

    /// <summary>
    /// The unit every length bound in this format is counted in: the number of
    /// Unicode code points in the string.
    ///
    /// Why this and not <c>string.Length</c>. A .NET string is a sequence of
    /// UTF-16 code units, so an emoji costs two and a Deseret letter costs
    /// two, while the same string is one code point per character in Python
    /// and one to four bytes per character in Go. Three languages, three
    /// answers, one document: the bound then means something different
    /// depending on who is reading, which is the failure this format exists to
    /// prevent. The published JSON Schema's <c>maxLength</c> is already
    /// defined in code points (JSON Schema validation, section 6.3.1, on top
    /// of RFC 8259), so this is the unit the normative artefact has always
    /// stated.
    ///
    /// Code points cost no Unicode table: the count is a property of the
    /// encoding, not of the character database, and it does not change when a
    /// new Unicode version ships. That is exactly what a grapheme-cluster
    /// count could not promise, and it is why <c>StringInfo</c> is not what is
    /// called here. The normative statement is <c>spec/value-domain.md</c>.
    /// </summary>
    public static int TextLength(string text)
    {
        var count = 0;
        for (var i = 0; i < text.Length; i++)
        {
            // A low surrogate continues the code point its high surrogate
            // began, so it is not counted. A lone surrogate of either kind
            // counts as one, which is what every other surface does with the
            // same input.
            if (char.IsLowSurrogate(text[i]) && i > 0 && char.IsHighSurrogate(text[i - 1]))
            {
                continue;
            }
            count++;
        }
        return count;
    }

    /// <summary>
    /// Length and count bounds. A handover is a document, never a dump.
    /// Every bound named "code points" is counted with <see cref="TextLength"/>.
    /// </summary>
    public static class Limits
    {
        /// <summary>Max code points in <c>title</c>.</summary>
        public const int Title = 200;

        /// <summary>Max code points in <c>projectId</c>.</summary>
        public const int ProjectId = 120;

        /// <summary>Max code points in a section <c>summary</c>.</summary>
        public const int SectionSummary = 20000;

        /// <summary>Max provenance labels on one section.</summary>
        public const int ProvenanceLabelCount = 11;

        /// <summary>Max entries in a <c>quality</c> or <c>safety</c> list.</summary>
        public const int ListEntries = 200;

        /// <summary>Max code points in one <c>quality</c> or <c>safety</c> list entry.</summary>
        public const int ListEntry = 1000;

        /// <summary>Max attached observations.</summary>
        public const int Observations = 100;

        /// <summary>Max code points in an observation <c>kind</c>.</summary>
        public const int ObservationKind = 200;
    }
}
