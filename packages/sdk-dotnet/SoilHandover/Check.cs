using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Soil.Handover;

/// <summary>
/// One finding from one rule. <paramref name="Section"/> is the section key
/// the finding points at, or null for a document-level finding.
/// </summary>
public sealed record CheckFinding(
    string Rule,
    string Severity,
    string? Section,
    string Message);

/// <summary>Findings counted by severity.</summary>
public sealed record CheckCounts(int Problems, int Cautions, int Advice);

/// <summary>
/// The whole report. Ephemeral output: nothing in it is part of the
/// document. <paramref name="Grade"/> is the band, report only: it is never
/// written onto a handover.
/// </summary>
public sealed record CheckReport(
    string CheckVersion,
    string Grade,
    CheckCounts Counts,
    IReadOnlyList<CheckFinding> Findings,
    SectionCounts Sections);

/// <summary>
/// Save-time checking and grading: the open baseline.
///
/// <see cref="CheckHandover"/> is deterministic, lint-style analysis of the
/// handover document itself. Every rule has an id, a severity and a
/// plain-language explanation, all documented openly in docs/checking.md.
/// Same input, same report, byte for byte, and byte-identical to the
/// TypeScript reference in packages/sdk-ts/src/check.ts for the same
/// document. Nothing here calls a model, reaches the network, or measures
/// anything outside the document.
///
/// <para>The boundary, stated plainly: the baseline checker is deterministic
/// analysis of the document itself. Whether a handover actually restores a
/// session is a different question, answered only by a real load.</para>
///
/// <para>The grade band belongs to the report and stops there. It is printed
/// on the card, present in <c>--json</c>, and it decides the exit code. It
/// is NOT written into the document: the <c>quality.capture</c> observation
/// this class builds carries counts, names and findings, and no band, no
/// score and no aggregate of any kind. A judgement made by a producer the
/// reader never met has no business travelling inside the thing it
/// judges.</para>
///
/// <para>Two string units live in this class and they answer two different
/// questions. The notes bound is counted in Unicode code points with
/// <see cref="Sections.TextLength"/>, the format's unit. The rule thresholds
/// and the numbers quoted inside finding messages are counted in UTF-16 code
/// units, which is what <c>String.Length</c> already is on this runtime and
/// what the reference measures with JavaScript's
/// <c>String.prototype.length</c>.</para>
/// </summary>
public static class Check
{
    /// <summary>
    /// The version of this rule set. It moves when a rule is added or tuned,
    /// so a report always says which rules produced it.
    /// </summary>
    public const string CheckVersion = "1.0.0";

    /// <summary>The grade bands, best first.</summary>
    public static readonly IReadOnlyList<string> CheckGrades =
        new[] { "strong", "adequate", "thin", "failing" };

    /// <summary>
    /// The three severities. A problem undermines the document's ability to
    /// restore anything. A caution is a concrete weakness worth fixing.
    /// Advice is a soft signal that never lowers the grade.
    ///
    /// Severity classifies the individual rule outcome. It is never a
    /// judgement of the handover, and summing severities into one word is
    /// the report's business, not the document's.
    /// </summary>
    public static readonly IReadOnlyList<string> CheckSeverities =
        new[] { "problem", "caution", "advice" };

    /// <summary>
    /// Every rule in the baseline, with its one-line explanation, in the
    /// order the reference declares them. The full rationale for each lives
    /// in docs/checking.md.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string> CheckRules =
        new Dictionary<string, string>
        {
            ["completeness.missing-without-reason"] =
                "a section is declared missing with no reason stated anywhere",
            ["completeness.no-durable-truth"] =
                "no durable-tier section carries content, so nothing outlives the session",
            ["self-containment.fetch-pointer"] =
                "the text sends the reader somewhere else instead of carrying the content",
            ["time.unanchored"] =
                "a frontier section uses time words with no capture-time anchor",
            ["decisions.entry-without-reason"] =
                "a decision is stated with no recorded reason, which invites relitigation",
            ["anchors.no-exact-values"] =
                "the section talks about configuration but carries no exact values",
            ["gaps.blocked-without-omission-note"] =
                "a section was withheld but the safety record does not say what or where",
            ["restore.absent"] =
                "content was captured but there are no restore instructions to boot it",
            ["restore.thin"] =
                "the restore instructions are far shorter than the content they must boot",
            ["size.one-liner"] =
                "a one-line section in an otherwise rich document reads as thinness",
        };

    /// <summary>
    /// The grade mapping, documented in docs/checking.md and applied nowhere
    /// else. Counts in, band out, no judgement calls: failing is 3 or more
    /// problems; thin is 1 or 2 problems, or 6 or more cautions; adequate is
    /// no problems, 1 to 5 cautions; strong is no problems and no cautions,
    /// and advice never lowers the grade.
    /// </summary>
    public static string GradeFromCounts(CheckCounts counts)
    {
        if (counts.Problems >= 3)
        {
            return "failing";
        }
        if (counts.Problems >= 1 || counts.Cautions >= 6)
        {
            return "thin";
        }
        return counts.Cautions >= 1 ? "adequate" : "strong";
    }

    // The reference implementation runs on JavaScript strings, so its trim
    // and its regex \s are ECMAScript's. .NET's String.Trim and default \s
    // read the Unicode table differently at the edges (a byte order mark is
    // not .NET whitespace), and a checker that trims or matches differently
    // produces a different report for the same document. So the ECMAScript
    // whitespace set is spelled out once here and used everywhere in this
    // file, and every pattern compiles with RegexOptions.ECMAScript, which
    // pins \b, \d and \w to the ASCII sets ECMAScript uses.
    private static readonly char[] JsWhitespace =
        ("\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff").ToCharArray();

    private const string WsClass =
        @"\t\n\v\f\r \u00a0\u1680\u2000-\u200a"
        + @"\u2028\u2029\u202f\u205f\u3000\ufeff";

    internal static string JsTrim(string text) => text.Trim(JsWhitespace);

    private static Regex Ecma(string pattern)
        => new(pattern, RegexOptions.ECMAScript | RegexOptions.IgnoreCase);

    /// <summary>
    /// Phrases that point away from the document. A handover assumes its
    /// reader has nothing else, so "see the repo" is content that failed to
    /// travel. Each pattern is a heuristic: deterministic, documented, and
    /// tuned to phrases that present somewhere else as where the content
    /// lives.
    /// </summary>
    private static readonly Regex[] FetchPointers =
    {
        Ecma(@"\bsee (?:the )?(?:repo|repository|docs|documentation|readme|wiki|codebase|source|thread|conversation|chat)\b"),
        Ecma(@"\bin the (?:docs|documentation|readme|wiki)\b"),
        Ecma(@"\bconsult\b"),
        Ecma(@"\brefer to\b"),
        Ecma(@"\b(?:see|check|visit|read|browse)[" + WsClass + @"]+https?://"),
        Ecma(@"\b(?:described|documented|explained|detailed|available|found)[" + WsClass + @"]+(?:at|in)[" + WsClass + @"]+https?://"),
    };

    /// <summary>Words that are true only at one moment.</summary>
    private static readonly Regex VolatileTerms =
        Ecma(@"\b(?:currently|right now|now|today|tonight|yesterday|tomorrow|this week|last week|this morning|this afternoon|at the moment|just now|recently)\b");

    /// <summary>Phrases that pin volatile words to the capture.</summary>
    private static readonly Regex CaptureAnchors =
        Ecma(@"\b(?:at capture|at the capture|as of (?:this|the) capture|at the time of capture|when this was (?:captured|written)|at save time|as of \d{4}-\d{2}-\d{2})\b");

    /// <summary>
    /// Verbs that state a decision. Scoped to the decisions section only.
    /// </summary>
    private static readonly Regex DecisionVerbs =
        Ecma(@"\b(?:decided|decision|locked|chose|chosen|agreed|settled|adopted|picked|selected|went with|opted|will use|use[sd]?|switched to|migrated to|standardi[sz]ed)\b");

    /// <summary>
    /// Markers that a reason was recorded. "cannot" and "could not" count
    /// because a stated inability is a stated reason.
    /// </summary>
    private static readonly Regex ReasonMarkers =
        Ecma(@"\b(?:because|since|due to|so that|reason|why|after|caused|led to|avoid|avoids|avoided|prevent|prevents|prevented|otherwise|rather than|instead of|cannot|could not)\b");

    /// <summary>
    /// Terms that say the section is talking about configuration.
    /// </summary>
    private static readonly Regex ConfigTerms =
        Ecma(@"\b(?:config|configuration|configured|environment variable|env var|port|version|pinned|flag|timeout|limit|ceiling|budget|quota|threshold)\b");

    private static readonly Regex AsciiDigit =
        new(@"\d", RegexOptions.ECMAScript);

    private static readonly Regex WsRun =
        new("[" + WsClass + "]+", RegexOptions.ECMAScript);

    private static readonly Regex EntryMarker =
        new(@"^(?:\d+[.)][" + WsClass + @"]+|[-*•▸][" + WsClass + @"]+)", RegexOptions.ECMAScript);

    /// <summary>The floor parameters for the restore-instructions rule.</summary>
    private const int RestoreMinChars = 300;
    private const double RestoreFraction = 0.05;
    private const int RestoreAppliesFrom = 1000;

    /// <summary>The parameters for the one-liner rule.</summary>
    private const int OneLinerMaxChars = 40;
    private const int OneLinerMinSections = 5;
    private const int OneLinerMinMedian = 200;

    private static JsonObject? SectionObject(JsonObject handover, string key)
        => handover.TryGetPropertyValue("sections", out var sectionsNode)
            && sectionsNode is JsonObject sections
            && sections.TryGetPropertyValue(key, out var sectionNode)
            && sectionNode is JsonObject section
                ? section
                : null;

    private static string? StringField(JsonObject? record, string key)
        => record is not null
            && record.TryGetPropertyValue(key, out var node)
            && node is JsonValue value
            && value.TryGetValue<string>(out var text)
                ? text
                : null;

    private static string? SectionStatus(JsonObject handover, string key)
        => StringField(SectionObject(handover, key), "status");

    private static string? AvailableSummary(JsonObject handover, string key)
    {
        var section = SectionObject(handover, key);
        if (StringField(section, "status") != "available")
        {
            return null;
        }
        var summary = StringField(section, "summary");
        return summary is not null && JsTrim(summary).Length > 0 ? summary : null;
    }

    private static string? FirstMatch(string text, Regex[] patterns)
    {
        foreach (var pattern in patterns)
        {
            var match = pattern.Match(text);
            if (match.Success)
            {
                return match.Value;
            }
        }
        return null;
    }

    /// <summary>
    /// Split a section's prose into entries: numbered items, bulleted items,
    /// and blank-line-separated paragraphs. Deterministic, no
    /// interpretation.
    /// </summary>
    public static IReadOnlyList<string> SplitEntries(string text)
    {
        var entries = new List<string>();
        var current = new List<string>();
        void Flush()
        {
            if (current.Count > 0)
            {
                entries.Add(string.Join(" ", current));
            }
            current.Clear();
        }
        foreach (var raw in text.Split('\n'))
        {
            var line = JsTrim(raw);
            if (line.Length == 0)
            {
                Flush();
                continue;
            }
            if (EntryMarker.IsMatch(line))
            {
                Flush();
            }
            current.Add(line);
        }
        Flush();
        return entries;
    }

    /// <summary>The lower median of a list of numbers.</summary>
    private static int LowerMedian(IReadOnlyList<int> values)
    {
        if (values.Count == 0)
        {
            return 0;
        }
        var ordered = values.OrderBy(value => value).ToList();
        return ordered[(ordered.Count - 1) / 2];
    }

    /// <summary>
    /// The prefix of <paramref name="text"/> that fits in at most
    /// <paramref name="units"/> UTF-16 code units, never splitting a
    /// surrogate pair.
    /// </summary>
    private static string U16Slice(string text, int units)
    {
        if (text.Length <= units)
        {
            return text;
        }
        var end = units;
        if (end > 0 && char.IsHighSurrogate(text[end - 1]))
        {
            end--;
        }
        return text[..end];
    }

    private static string Preview(string text, int max = 60)
    {
        var flat = JsTrim(WsRun.Replace(text, " "));
        return flat.Length <= max ? flat : $"{U16Slice(flat, max - 1)}…";
    }

    private static int NoteCount(JsonObject handover, string group, string key)
        => handover.TryGetPropertyValue(group, out var groupNode)
            && groupNode is JsonObject record
            && record.TryGetPropertyValue(key, out var listNode)
            && listNode is JsonArray list
                ? list.Count
                : 0;

    /// <summary>
    /// Check a handover: run every rule, count the findings, map the counts
    /// to a grade band. The input is assumed structurally valid; run
    /// <see cref="Validate.ValidateHandover"/> first, the way the CLI does.
    ///
    /// Pure and deterministic on purpose. No I/O, no clock, no randomness,
    /// no model. The report is honest exactly because every finding can be
    /// traced to a documented rule and re-produced by anyone from the same
    /// bytes.
    /// </summary>
    public static CheckReport CheckHandover(JsonObject handover)
    {
        var findings = new List<CheckFinding>();
        void Add(string rule, string severity, string message, string? section = null)
            => findings.Add(new CheckFinding(rule, severity, section, message));

        var missingInputs = NoteCount(handover, "quality", "missingInputs");
        var unsafeOmissions = NoteCount(handover, "safety", "unsafeOmissions");

        // completeness.missing-without-reason: a gap is fine, an unexplained
        // gap is not. A reason can live in the section's own note or in the
        // document-level quality.missingInputs list.
        if (missingInputs == 0)
        {
            foreach (var key in Sections.SectionKeys)
            {
                var section = SectionObject(handover, key);
                if (section is null || StringField(section, "status") != "missing")
                {
                    continue;
                }
                var summary = StringField(section, "summary");
                if (summary is null || JsTrim(summary).Length == 0)
                {
                    Add(
                        "completeness.missing-without-reason",
                        "caution",
                        "declared missing, with no note here and nothing in quality.missingInputs saying why",
                        key);
                }
            }
        }

        // gaps.blocked-without-omission-note: blocked means withheld for
        // safety, and the safety record is where the withheld fact is
        // supposed to be.
        foreach (var key in Sections.SectionKeys)
        {
            if (SectionStatus(handover, key) == "blocked" && unsafeOmissions == 0)
            {
                Add(
                    "gaps.blocked-without-omission-note",
                    "caution",
                    "withheld for safety, but safety.unsafeOmissions does not name what exists or where it is configured",
                    key);
            }
        }

        // completeness.no-durable-truth: with zero durable sections, nothing
        // in the document outlives the session it came from.
        var durableAvailable = Sections.SectionKeys.Count(key =>
            Sections.SectionTiers[key] == "durable"
            && AvailableSummary(handover, key) is not null);
        if (durableAvailable == 0)
        {
            Add(
                "completeness.no-durable-truth",
                "problem",
                "none of the six durable-tier sections carries content, so the project's lasting truth did not travel");
        }

        // self-containment.fetch-pointer: per section. A pointer inside the
        // restore instructions is a problem, because the boot prompt must
        // stand alone; in any other section it is a caution.
        foreach (var key in Sections.SectionKeys)
        {
            var text = AvailableSummary(handover, key);
            if (text is null)
            {
                continue;
            }
            var match = FirstMatch(text, FetchPointers);
            if (match is not null)
            {
                Add(
                    "self-containment.fetch-pointer",
                    key == "restoreInstructions" ? "problem" : "caution",
                    $"sends the reader elsewhere (\"{Preview(match, 40)}\"), but a handover reader has no repo, no docs and no earlier thread",
                    key);
            }
        }

        // time.unanchored: frontier sections describe a moment. Time words
        // with no capture anchor in the same section will read as the
        // present to a reader arriving later.
        foreach (var key in Sections.SectionKeys)
        {
            if (Sections.SectionTiers[key] != "frontier")
            {
                continue;
            }
            var text = AvailableSummary(handover, key);
            if (text is null)
            {
                continue;
            }
            var volatileMatch = VolatileTerms.Match(text);
            if (volatileMatch.Success && !CaptureAnchors.IsMatch(text))
            {
                Add(
                    "time.unanchored",
                    "caution",
                    $"uses \"{volatileMatch.Value}\" with no capture-time anchor, so a later reader cannot tell when it was true",
                    key);
            }
        }

        // decisions.entry-without-reason: a decision with no recorded reason
        // is the exact thing a later session relitigates.
        var decisionsText = AvailableSummary(handover, "decisions");
        if (decisionsText is not null)
        {
            var entries = SplitEntries(decisionsText);
            for (var i = 0; i < entries.Count; i++)
            {
                var entry = entries[i];
                if (DecisionVerbs.IsMatch(entry) && !ReasonMarkers.IsMatch(entry))
                {
                    Add(
                        "decisions.entry-without-reason",
                        "caution",
                        $"entry {i + 1} states a decision with no recorded reason (\"{Preview(entry)}\")",
                        "decisions");
                }
            }
        }

        // anchors.no-exact-values: architecture and constraints that mention
        // configuration but carry no digits have probably lost their pins.
        foreach (var key in new[] { "architecture", "constraints" })
        {
            var text = AvailableSummary(handover, key);
            if (text is not null && ConfigTerms.IsMatch(text) && !AsciiDigit.IsMatch(text))
            {
                Add(
                    "anchors.no-exact-values",
                    "advice",
                    "mentions configuration but holds no numbers, versions or pins; exact values are what survive a move",
                    key);
            }
        }

        // restore.absent and restore.thin: the restore instructions are the
        // boot prompt. Captured content with no boot prompt, or a boot
        // prompt far smaller than the content, will not bring a cold session
        // back.
        var restoreText = AvailableSummary(handover, "restoreInstructions");
        var otherAvailableChars = Sections.SectionKeys
            .Where(key => key != "restoreInstructions")
            .Sum(key => AvailableSummary(handover, key)?.Length ?? 0);
        if (restoreText is null && otherAvailableChars > 0)
        {
            Add(
                "restore.absent",
                "problem",
                "content was captured but restoreInstructions is empty, so nothing tells the next session how to begin",
                "restoreInstructions");
        }
        if (restoreText is not null && otherAvailableChars >= RestoreAppliesFrom)
        {
            var floor = Math.Max(
                RestoreMinChars,
                (int)Math.Floor(otherAvailableChars * RestoreFraction));
            if (restoreText.Length < floor)
            {
                Add(
                    "restore.thin",
                    "problem",
                    $"the restore instructions are {restoreText.Length} characters against {otherAvailableChars} of captured content, below the documented floor of {floor}",
                    "restoreInstructions");
            }
        }

        // size.one-liner: in a document whose sections are otherwise
        // substantial, a near-empty available section is a thinness signal,
        // not an error.
        var availableLengths = Sections.SectionKeys
            .Select(key => AvailableSummary(handover, key))
            .Where(text => text is not null)
            .Select(text => text!.Length)
            .ToList();
        if (availableLengths.Count >= OneLinerMinSections
            && LowerMedian(availableLengths) >= OneLinerMinMedian)
        {
            foreach (var key in Sections.SectionKeys)
            {
                var text = AvailableSummary(handover, key);
                if (text is not null && text.Length < OneLinerMaxChars)
                {
                    Add(
                        "size.one-liner",
                        "advice",
                        $"carries {text.Length} characters in a document whose sections are otherwise substantial",
                        key);
                }
            }
        }

        // Deterministic order: document-level findings first, then sections
        // in canonical order, then rule id, then message.
        var keyOrder = Sections.SectionKeys
            .Select((key, index) => (key, index))
            .ToDictionary(pair => pair.key, pair => pair.index);
        int SectionIndex(string? key)
            => key is null ? -1 : keyOrder[key];
        var sorted = findings
            .OrderBy(finding => SectionIndex(finding.Section))
            .ThenBy(finding => finding.Rule, StringComparer.Ordinal)
            .ThenBy(finding => finding.Message, StringComparer.Ordinal)
            .ToList();

        var counts = new CheckCounts(
            sorted.Count(finding => finding.Severity == "problem"),
            sorted.Count(finding => finding.Severity == "caution"),
            sorted.Count(finding => finding.Severity == "advice"));

        return new CheckReport(
            CheckVersion,
            GradeFromCounts(counts),
            counts,
            sorted,
            HandoverStore.CountSections(handover));
    }

    /// <summary>
    /// The upper bound on notes in a quality.capture payload, in Unicode
    /// code points, the unit every length bound in this format is counted
    /// in. See <see cref="Sections.TextLength"/> and spec/value-domain.md.
    ///
    /// Notes are short, non-evaluative context: what the producer wants a
    /// reader to know about how the examination was made. The bound is
    /// deliberately too small for the field to become a container for a
    /// hidden aggregate, and <see cref="CheckObservation"/> refuses anything
    /// longer rather than truncating a claim in the middle.
    /// </summary>
    public const int CheckNotesMaxChars = 280;

    /// <summary>
    /// The note this class writes when the caller supplies none. It states
    /// what kind of examination ran and nothing about how the result
    /// compares to anything, because a comparison is a judgement.
    /// </summary>
    public const string CheckDefaultNotes =
        "Structural examination of the document by the open deterministic baseline. Section statuses and rule outcomes only.";

    /// <summary>
    /// Package a report as a quality.capture observation, ready to attach to
    /// the stored handover.
    ///
    /// <paramref name="producedBy"/> names the tool that ran the check, with
    /// a version, e.g. soil-cli/0.1.0; <paramref name="producedAt"/> is when
    /// the check ran (ISO 8601); <paramref name="notes"/> is short
    /// non-evaluative context, at most <see cref="CheckNotesMaxChars"/> code
    /// points, defaulting to <see cref="CheckDefaultNotes"/>.
    ///
    /// <para>The payload is a closed field set, documented in
    /// spec/observations.md: sectionsWithContent, missingSections,
    /// blockedSections, findings, checkVersion, notes, and nothing else. In
    /// particular no grade, no band, no score, and no counts-by-severity
    /// roll-up. Those exist in the report, where the reader can see who
    /// produced them and when; they do not exist on the document, where a
    /// later reader would meet the verdict without ever meeting the
    /// producer.</para>
    ///
    /// <para>This does not make the band underivable, and pretending
    /// otherwise would be its own dishonesty. Anyone holding this payload
    /// plus the published mapping in docs/checking.md can count the
    /// severities and recompute the band exactly. The difference is who
    /// makes that derivation, and whether the threshold is in front of them
    /// when they do.</para>
    /// </summary>
    public static JsonObject CheckObservation(
        JsonObject handover,
        CheckReport report,
        string producedBy,
        string producedAt,
        string? notes = null)
    {
        var resolved = notes ?? CheckDefaultNotes;
        if (Sections.TextLength(resolved) > CheckNotesMaxChars)
        {
            throw new ArgumentException(
                $"quality.capture notes must be at most {CheckNotesMaxChars} code points, got {Sections.TextLength(resolved)}");
        }
        // Section KEYS, not prose labels: missingSections and
        // blockedSections are addresses a reader can look up, the same
        // identifiers location uses.
        JsonArray Named(string status)
        {
            var list = new JsonArray();
            foreach (var key in Sections.SectionKeys)
            {
                if (SectionStatus(handover, key) == status)
                {
                    list.Add(key);
                }
            }
            return list;
        }
        var findings = new JsonArray();
        foreach (var finding in report.Findings)
        {
            findings.Add(new JsonObject
            {
                ["rule"] = finding.Rule,
                // JSON-Pointer-ish, the same shape a validation issue uses.
                // "/" is the document itself, for a rule that is not about
                // one section.
                ["location"] = finding.Section is null
                    ? "/"
                    : $"/sections/{finding.Section}",
                ["observed"] = finding.Message,
                ["severity"] = finding.Severity,
            });
        }
        return new JsonObject
        {
            ["kind"] = "quality.capture",
            ["producedBy"] = producedBy,
            ["producedAt"] = producedAt,
            ["data"] = new JsonObject
            {
                ["checkVersion"] = report.CheckVersion,
                ["sectionsWithContent"] = report.Sections.WithContent,
                ["missingSections"] = Named("missing"),
                ["blockedSections"] = Named("blocked"),
                ["findings"] = findings,
                ["notes"] = resolved,
            },
        };
    }

    /// <summary>
    /// A report as the ordered JSON value the reference prints for
    /// <c>--json</c>, so a caller that serializes it emits the same bytes
    /// the Node CLI does.
    /// </summary>
    public static JsonObject CheckReportJson(CheckReport report)
    {
        var findings = new JsonArray();
        foreach (var finding in report.Findings)
        {
            var entry = new JsonObject
            {
                ["rule"] = finding.Rule,
                ["severity"] = finding.Severity,
            };
            if (finding.Section is not null)
            {
                entry["section"] = finding.Section;
            }
            entry["message"] = finding.Message;
            findings.Add(entry);
        }
        return new JsonObject
        {
            ["checkVersion"] = report.CheckVersion,
            ["grade"] = report.Grade,
            ["counts"] = new JsonObject
            {
                ["problems"] = report.Counts.Problems,
                ["cautions"] = report.Counts.Cautions,
                ["advice"] = report.Counts.Advice,
            },
            ["findings"] = findings,
            ["sections"] = new JsonObject
            {
                ["withContent"] = report.Sections.WithContent,
                ["missing"] = report.Sections.Missing,
                ["blocked"] = report.Sections.Blocked,
                ["notApplicable"] = report.Sections.NotApplicable,
                ["total"] = report.Sections.Total,
            },
        };
    }
}
