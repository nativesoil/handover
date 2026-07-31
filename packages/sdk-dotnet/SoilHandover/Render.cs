using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Soil.Handover;

/// <summary>
/// The rail card: the ASCII shape Soil prints after a save, a load, or a
/// list.
///
/// Design contract, do not break:
///  - PURE. No I/O, no clock, no randomness. Same input, byte-identical
///    output, which is why the tests can pin whole cards.
///  - SAFE BY CALLER. The renderer formats already-safe text. It does not
///    scan, redact or reconstruct anything.
///  - COMPUTED LAYOUT. A fixed 2-space gutter, a continuous left rail, and
///    rules extended to a fixed inner width. Alignment is computed from
///    content, never hardcoded, so the card lands identically in every
///    terminal.
///
/// The card reports counts and names: how many sections carry content,
/// which ones do not, and what was held back on purpose. It never reports a
/// score. A local save has no opinion about how good your handover is.
///
/// The save card and the load card carry the same two head blocks, and they
/// do so on purpose. A field a writer supplies has not been delivered until a
/// reader sees it, and a field shown on the way in and dropped on the way out
/// is the same defect as one never stored: <c>written by</c> names the tool,
/// the model, the provider and the extraction recipe behind the document, and
/// <c>what this document carries</c> names the withheld sections as withheld
/// rather than as empty. Which section carries which provenance label is a
/// per-section mapping and lives in the restore prompt; the card names the
/// kinds of claim present, which is what fits in a column.
/// </summary>
public static class Render
{
    private const string Gutter = "  ";
    private const int InnerWidth = 52;
    private const string RailIndent = "│   ";
    private const int WrapWidth = 46;

    /// <summary>Width of the label column inside the rail, e.g. <c>sections    </c>.</summary>
    private const int LabelWidth = 12;

    /// <summary>
    /// Wrap prose to <paramref name="width"/> columns on word boundaries.
    /// Never splits a word.
    /// </summary>
    public static IReadOnlyList<string> Wrap(string text, int width = WrapWidth)
    {
        var output = new List<string>();
        foreach (var paragraph in text.Split('\n'))
        {
            var line = "";
            foreach (var word in Regex.Split(paragraph, @"\s+").Where(w => w.Length > 0))
            {
                if (line.Length == 0)
                {
                    line = word;
                }
                else if (line.Length + 1 + word.Length <= width)
                {
                    line = $"{line} {word}";
                }
                else
                {
                    output.Add(line);
                    line = word;
                }
            }
            output.Add(line);
        }
        return output;
    }

    private static string Masthead(string state, string? code = null)
    {
        var head = $"┌─ SOIL · {state} ";
        var tail = code is not null ? $" {code} ─" : "";
        var fill = Math.Max(1, InnerWidth - head.Length - tail.Length);
        return $"{Gutter}{head}{new string('─', fill)}{tail}";
    }

    private static string SectionRule(string label)
    {
        var head = $"├─ {label} ";
        var fill = Math.Max(1, InnerWidth - head.Length);
        return $"{Gutter}{head}{new string('─', fill)}";
    }

    private static string Footer(string text) => $"{Gutter}└─ {text}";

    private static string Blank() => $"{Gutter}│";

    private static string Line(string text) => $"{Gutter}{RailIndent}{text}";

    private static IEnumerable<string> Prose(string text)
        => Wrap(text).Select(Line);

    private static string SectionNames(IEnumerable<string> keys)
        => string.Join(", ", keys.Select(key => Sections.SectionLabels[key]));

    private static List<string> KeysWithStatus(JsonObject handover, string status)
    {
        var sections = handover.TryGetPropertyValue("sections", out var node) && node is JsonObject s
            ? s
            : new JsonObject();
        return Sections.SectionKeys
            .Where(key =>
                sections.TryGetPropertyValue(key, out var sectionNode)
                && sectionNode is JsonObject section
                && section.TryGetPropertyValue("status", out var statusNode)
                && statusNode is JsonValue value
                && value.TryGetValue<string>(out var text)
                && text == status)
            .ToList();
    }

    /// <summary>The one count line. Structural presence, stated as such.</summary>
    private static string ContentCountLine(SectionCounts counts)
        => $"{counts.WithContent} / {counts.Total} sections carrying content";

    /// <summary>
    /// A labelled row whose value wraps under itself, keeping the label
    /// column clear: the eye should be able to run down the labels without
    /// meeting text.
    /// </summary>
    private static IEnumerable<string> Labelled(string label, string value)
    {
        var width = Math.Max(LabelWidth, label.Length + 2);
        return Wrap(value, WrapWidth - width)
            .Select((text, i) => Line($"{(i == 0 ? label : "").PadRight(width)}{text}"));
    }

    private static string GetString(JsonObject record, string key)
        => record.TryGetPropertyValue(key, out var node)
            && node is JsonValue value
            && value.TryGetValue<string>(out var text)
                ? text
                : "";

    private static IReadOnlyList<string> NoteList(JsonObject handover, string group, string key)
    {
        if (handover.TryGetPropertyValue(group, out var groupNode)
            && groupNode is JsonObject record
            && record.TryGetPropertyValue(key, out var listNode)
            && listNode is JsonArray list)
        {
            return list
                .Select(item => item is JsonValue value && value.TryGetValue<string>(out var text) ? text : null)
                .Where(text => text is not null)
                .Cast<string>()
                .ToList();
        }
        return Array.Empty<string>();
    }

    /// <summary>
    /// The <c>source</c> fields, as the rows that show them.
    ///
    /// Labelled rather than joined with separators, because a reader met with
    /// <c>chatgpt · gpt-5 · openai</c> has to guess which token is the tool,
    /// which is the model and which is the provider. The label column says
    /// which is which, and it is the same block on the save card and the load
    /// card, so a field a writer supplied is a field the next reader meets. A
    /// row is omitted when the field is absent; a document with no
    /// <c>source</c> gets no block at all.
    /// </summary>
    private static IReadOnlyList<string> SourceRows(JsonObject handover)
    {
        var source = handover.TryGetPropertyValue("source", out var sourceNode)
            && sourceNode is JsonObject record
                ? record
                : null;
        if (source is null)
        {
            return Array.Empty<string>();
        }
        var rows = new[]
        {
            ("client", GetString(source, "client")),
            ("model", GetString(source, "model")),
            ("provider", GetString(source, "provider")),
            ("recipe", GetString(source, "recipeVersion")),
        };
        var output = new List<string>();
        foreach (var (label, value) in rows)
        {
            if (value.Length == 0)
            {
                continue;
            }
            output.AddRange(Labelled(label, value));
        }
        return output;
    }

    /// <summary>
    /// The <c>written by</c> block, or nothing when the document names no
    /// source.
    /// </summary>
    private static IReadOnlyList<string> WrittenByBlock(JsonObject handover)
    {
        var rows = SourceRows(handover);
        if (rows.Count == 0)
        {
            return Array.Empty<string>();
        }
        var output = new List<string> { SectionRule("written by"), Blank() };
        output.AddRange(rows);
        output.Add(Blank());
        return output;
    }

    /// <summary>
    /// Every provenance label the document's sections carry, in the frozen
    /// order of the label set, each label appearing once.
    ///
    /// The card shows which KINDS of claim a document holds. Which section
    /// carries which label is a mapping, and a mapping belongs where a reader
    /// can act on it per section, which is the restore prompt.
    /// </summary>
    private static IReadOnlyList<string> ProvenanceLabelsPresent(JsonObject handover)
    {
        var seen = new HashSet<string>();
        foreach (var key in Sections.SectionKeys)
        {
            foreach (var label in SectionProvenance(handover, key))
            {
                seen.Add(label);
            }
        }
        return Sections.ProvenanceLabels.Where(seen.Contains).ToList();
    }

    /// <summary>
    /// The provenance labels one section carries, in the document's own order.
    /// </summary>
    internal static IReadOnlyList<string> SectionProvenance(JsonObject handover, string key)
    {
        if (handover.TryGetPropertyValue("sections", out var sectionsNode)
            && sectionsNode is JsonObject sections
            && sections.TryGetPropertyValue(key, out var sectionNode)
            && sectionNode is JsonObject section
            && section.TryGetPropertyValue("provenance", out var listNode)
            && listNode is JsonArray list)
        {
            return list
                .Select(item => item is JsonValue value && value.TryGetValue<string>(out var text) ? text : null)
                .Where(text => text is not null)
                .Cast<string>()
                .ToList();
        }
        return Array.Empty<string>();
    }

    /// <summary>
    /// The one row that says which kinds of claim this document holds.
    /// </summary>
    private static IReadOnlyList<string> ProvenanceRow(JsonObject handover)
    {
        var labels = ProvenanceLabelsPresent(handover);
        return labels.Count == 0
            ? Array.Empty<string>()
            : Labelled("provenance", string.Join(", ", labels)).ToList();
    }

    /// <summary>
    /// The observations attached to the document, as the rows that name them.
    ///
    /// Kinds and producers, never payloads. <c>data</c> is free-form and
    /// opaque to the specification, so a renderer cannot know how to lay out a
    /// payload it has never seen, and a renderer that guessed would be
    /// inventing a shape the producer did not agree to. What a reader needs
    /// from a card is that the evidence is there, what kind it is and who is
    /// answerable for it; the payload is one <c>soil load --json</c> away, and
    /// <c>spec/observations.md</c> says how to read it.
    ///
    /// Both lists are deduplicated and joined into one wrapping row each, so a
    /// hundred entries of one kind cost one row rather than a hundred.
    /// </summary>
    private static IReadOnlyList<string> EvidenceRows(JsonObject handover)
    {
        if (!handover.TryGetPropertyValue("observations", out var node)
            || node is not JsonArray observations
            || observations.Count == 0)
        {
            return Array.Empty<string>();
        }
        var kinds = new List<string>();
        var producers = new List<string>();
        foreach (var entry in observations)
        {
            if (entry is not JsonObject observation)
            {
                continue;
            }
            var kind = GetString(observation, "kind");
            if (kind.Length > 0 && !kinds.Contains(kind))
            {
                kinds.Add(kind);
            }
            var producer = GetString(observation, "producedBy");
            if (producer.Length > 0 && !producers.Contains(producer))
            {
                producers.Add(producer);
            }
        }
        var output = new List<string>();
        if (kinds.Count > 0)
        {
            output.AddRange(Labelled("evidence", string.Join(", ", kinds)));
        }
        if (producers.Count > 0)
        {
            output.AddRange(Labelled("recorded", string.Join(", ", producers)));
        }
        return output;
    }

    private static void PushBulleted(List<string> output, IReadOnlyList<string> notes)
    {
        foreach (var note in notes)
        {
            var wrapped = Wrap(note, WrapWidth - 2);
            for (var i = 0; i < wrapped.Count; i += 1)
            {
                output.Add(Line(i == 0 ? $"▸ {wrapped[i]}" : $"  {wrapped[i]}"));
            }
        }
    }

    /// <summary>The card printed after <c>soil save</c>.</summary>
    public static string RenderSaved(JsonObject handover, string code)
    {
        var counts = HandoverStore.CountSections(handover);
        var missing = KeysWithStatus(handover, "missing");
        var blocked = KeysWithStatus(handover, "blocked");
        var notApplicable = KeysWithStatus(handover, "not_applicable");
        var projectId = GetString(handover, "projectId");

        var output = new List<string>
        {
            Masthead("handover saved", code),
            Blank(),
        };
        output.AddRange(Prose(GetString(handover, "title")));
        output.Add(Line(projectId));
        output.Add(Blank());
        output.AddRange(WrittenByBlock(handover));
        output.Add(SectionRule("what this document carries"));
        output.Add(Blank());
        output.Add(Line(ContentCountLine(counts)));
        if (missing.Count > 0)
        {
            output.AddRange(Labelled("no content", SectionNames(missing)));
        }
        if (blocked.Count > 0)
        {
            output.AddRange(Labelled("held back", SectionNames(blocked)));
        }
        if (notApplicable.Count > 0)
        {
            output.AddRange(Labelled("no subject", SectionNames(notApplicable)));
        }
        output.AddRange(ProvenanceRow(handover));
        output.AddRange(EvidenceRows(handover));
        output.Add(Blank());

        var gaps = NoteList(handover, "quality", "missingInputs");
        if (gaps.Count > 0)
        {
            output.Add(SectionRule("stated gaps"));
            output.Add(Blank());
            PushBulleted(output, gaps);
            output.Add(Blank());
        }

        // The gaps' sibling in quality. It reached the restore prompt and not
        // this card, which left the writer no way to see that what it recorded
        // landed.
        var contradictions = NoteList(handover, "quality", "contradictions");
        if (contradictions.Count > 0)
        {
            output.Add(SectionRule("unresolved contradictions"));
            output.Add(Blank());
            PushBulleted(output, contradictions);
            output.Add(Blank());
        }

        var omissions = NoteList(handover, "safety", "unsafeOmissions");
        if (omissions.Count > 0)
        {
            output.Add(SectionRule("held back · by design"));
            output.Add(Blank());
            PushBulleted(output, omissions);
            output.Add(Blank());
        }

        output.Add(SectionRule("local"));
        output.Add(Blank());
        output.AddRange(Prose("stored on this machine · no account · no network"));
        output.Add(Blank());
        output.Add(Footer("load it in another thread, model, or tool"));
        output.Add("");
        output.Add($"          ❯ soil load {code}");
        return string.Join("\n", output);
    }

    /// <summary>The card printed above the restore prompt on <c>soil load</c>.</summary>
    public static string RenderLoaded(JsonObject handover)
    {
        var counts = HandoverStore.CountSections(handover);
        var missing = KeysWithStatus(handover, "missing");
        // A withheld section is not an empty one. The save card said so and
        // this one did not, so a reader of the load door could not tell a
        // section nobody could see from one somebody decided not to move,
        // which is the one distinction that says whether to go looking
        // elsewhere.
        var blocked = KeysWithStatus(handover, "blocked");
        var notApplicable = KeysWithStatus(handover, "not_applicable");
        var code = GetString(handover, "code");

        var output = new List<string>
        {
            Masthead("handover loaded", code.Length > 0 ? code : null),
            Blank(),
        };
        output.AddRange(Prose(GetString(handover, "title")));
        output.Add(Line($"{GetString(handover, "projectId")} · saved {GetString(handover, "createdAt")}"));
        output.Add(Blank());
        output.AddRange(WrittenByBlock(handover));
        output.Add(SectionRule("what this document carries"));
        output.Add(Blank());
        output.Add(Line(ContentCountLine(counts)));
        if (missing.Count > 0)
        {
            output.AddRange(Labelled("no content", SectionNames(missing)));
        }
        if (blocked.Count > 0)
        {
            output.AddRange(Labelled("held back", SectionNames(blocked)));
        }
        if (notApplicable.Count > 0)
        {
            output.AddRange(Labelled("no subject", SectionNames(notApplicable)));
        }
        output.AddRange(ProvenanceRow(handover));
        output.AddRange(EvidenceRows(handover));
        output.Add(Blank());
        output.Add(SectionRule("read it this way"));
        output.Add(Blank());
        output.AddRange(Prose(
            "durable sections still hold · frontier sections describe the moment of capture, not now · check fast-moving state before trusting it"));
        output.Add(Blank());
        output.Add(Footer("the restore prompt follows · paste it into the new session"));
        return string.Join("\n", output);
    }

    /// <summary>The card printed by <c>soil list</c>.</summary>
    public static string RenderList(IReadOnlyList<StoreEntry> entries)
    {
        var output = new List<string>
        {
            Masthead("handovers"),
            Blank(),
        };
        if (entries.Count == 0)
        {
            output.AddRange(Prose("nothing saved yet · run `soil save` to start"));
            output.Add(Blank());
            output.Add(Footer("local store · ~/.soil"));
            return string.Join("\n", output);
        }
        foreach (var entry in entries)
        {
            var title = entry.Title.Length > 28
                ? entry.Title[..27] + "…"
                : entry.Title;
            output.Add(Line(
                $"▸ {entry.Code}  {title.PadRight(28)} "
                + $"{entry.SectionsWithContent.ToString(System.Globalization.CultureInfo.InvariantCulture).PadLeft(2)}/17"));
        }
        output.Add(Blank());
        // The ratio is the one number here, so the one number says what it is.
        output.AddRange(Prose("the ratio counts sections carrying content"));
        output.Add(Blank());
        output.Add(Footer($"{entries.Count} stored · load one with `soil load #NNN`"));
        return string.Join("\n", output);
    }

    private static string Pluralize(int n, string word)
        => $"{n} {word}{(n == 1 ? "" : "s")}";

    /// <summary>
    /// The card printed by <c>soil check</c>: the grade band, the findings
    /// grouped by section, and the boundary the checker lives behind.
    /// Deterministic like every renderer here; the report is already sorted,
    /// and this only lays it out.
    /// </summary>
    public static string RenderCheck(JsonObject handover, CheckReport report)
    {
        var code = GetString(handover, "code");
        var output = new List<string>
        {
            Masthead("handover checked", code.Length > 0 ? code : null),
            Blank(),
        };
        output.AddRange(Prose(GetString(handover, "title")));
        output.Add(Line(GetString(handover, "projectId")));
        output.Add(Blank());
        output.Add(SectionRule("grade"));
        output.Add(Blank());
        output.Add(Line(report.Grade));
        output.Add(Line(
            $"{Pluralize(report.Counts.Problems, "problem")} · {Pluralize(report.Counts.Cautions, "caution")} · {report.Counts.Advice} advice"));
        output.Add(Blank());
        output.Add(SectionRule("findings"));
        output.Add(Blank());
        if (report.Findings.Count == 0)
        {
            output.AddRange(Prose("none · every rule passed on this document"));
            output.Add(Blank());
        }
        else
        {
            var labels = new List<string>();
            var groups = new Dictionary<string, List<CheckFinding>>();
            foreach (var finding in report.Findings)
            {
                var label = finding.Section is null
                    ? "the document"
                    : Sections.SectionLabels[finding.Section];
                if (!groups.TryGetValue(label, out var group))
                {
                    group = new List<CheckFinding>();
                    groups[label] = group;
                    labels.Add(label);
                }
                group.Add(finding);
            }
            foreach (var label in labels)
            {
                output.Add(Line(label));
                foreach (var finding in groups[label])
                {
                    output.Add(Line($"▸ {finding.Rule} · {finding.Severity}"));
                    foreach (var text in Wrap(finding.Message, WrapWidth - 2))
                    {
                        output.Add(Line($"  {text}"));
                    }
                }
                output.Add(Blank());
            }
        }
        output.Add(Footer("checked from the document alone · only a real load proves restore"));
        return string.Join("\n", output);
    }

    /// <summary>The card printed by <c>soil validate</c>.</summary>
    public static string RenderValidation(ValidationResult result, string label)
    {
        var unsafeIssues = result.Issues
            .Where(issue => issue.Kind == ValidationIssueKind.Safety)
            .ToList();
        var output = new List<string>
        {
            Masthead(result.Valid
                ? "valid handover"
                : unsafeIssues.Count > 0
                    ? "refused · secret material"
                    : "not a handover"),
            Blank(),
            Line(label),
            Blank(),
        };
        if (result.Valid)
        {
            output.Add(SectionRule("shape"));
            output.Add(Blank());
            output.AddRange(Prose("every required field is present and well formed"));
            output.Add(Blank());
            output.Add(Footer("structure only · this says nothing about how good the content is"));
            return string.Join("\n", output);
        }
        if (unsafeIssues.Count > 0)
        {
            output.Add(SectionRule("nothing was stored"));
            output.Add(Blank());
            foreach (var issue in unsafeIssues)
            {
                var wrapped = Wrap($"{issue.Path} {issue.Message}", WrapWidth - 2);
                for (var i = 0; i < wrapped.Count; i += 1)
                {
                    output.Add(Line(i == 0 ? $"✗ {wrapped[i]}" : $"  {wrapped[i]}"));
                }
            }
            output.Add(Blank());
        }

        var structural = result.Issues
            .Where(issue => issue.Kind != ValidationIssueKind.Safety)
            .ToList();
        if (structural.Count > 0)
        {
            output.Add(SectionRule($"{structural.Count} problem(s)"));
            output.Add(Blank());
            foreach (var issue in structural)
            {
                var path = issue.Path.Length > 0 ? issue.Path : "/";
                var wrapped = Wrap($"{path} {issue.Message}", WrapWidth - 2);
                for (var i = 0; i < wrapped.Count; i += 1)
                {
                    output.Add(Line(i == 0 ? $"✗ {wrapped[i]}" : $"  {wrapped[i]}"));
                }
            }
            output.Add(Blank());
        }

        output.Add(Footer(unsafeIssues.Count > 0
            ? "remove the value, keep the meaning, then save again"
            : "fix these and validate again"));
        return string.Join("\n", output);
    }
}
