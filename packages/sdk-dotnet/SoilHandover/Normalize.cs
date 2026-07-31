using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Soil.Handover;

/// <summary>
/// Normalization: turn what a model actually emitted into a spec-shaped
/// document.
///
/// Models write JSON by hand under pressure. They use the loose
/// <c>extractionSections</c> key, they write a section as a bare string,
/// they skip sections they had nothing for, they forget
/// <c>soilHandover</c>. None of that is interesting, and none of it should
/// cost a user their capture.
///
/// One rule governs the whole file, and it is the rule that makes a save and
/// a validation of the same bytes agree: every member present in the input is
/// present in the output, a member is rewritten only in the ways
/// <c>spec/normalization-profile.md</c> enumerates, a value that cannot be
/// rewritten is carried through verbatim, and nothing is invented.
///
/// So an unknown top-level field, an unknown field on a section, an unknown
/// section key and an unrecognised provenance label all survive this method
/// and are refused by <see cref="Validate.ValidateHandover"/>, at the path
/// they actually occupy. Version one is a closed world
/// (<c>spec/versioning.md</c>): none of those is an extension point, and
/// deleting them here would mean the same bytes were rejected by validation
/// and accepted by a save.
///
/// Three things this deliberately does NOT do, each of which it used to: it
/// does not stamp a <c>createdAt</c>, it does not stamp
/// <c>source.recipeVersion</c>, and it does not drop a <c>handoverId</c> it
/// cannot use.
/// </summary>
public static partial class Normalize
{
    // The members each object may carry. Everything else is carried through.
    private static readonly string[] SectionFields = ["status", "summary", "provenance"];
    private static readonly string[] SourceFields = ["client", "model", "provider", "recipeVersion"];
    private static readonly string[] QualityFields = ["missingInputs", "contradictions"];
    private static readonly string[] SafetyFields = ["unsafeOmissions"];
    private static readonly string[] RootFields =
    [
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
    ];

    private static string? AsTrimmedString(JsonNode? node)
    {
        if (node is JsonValue value && value.TryGetValue<string>(out var text))
        {
            var trimmed = text.Trim();
            return trimmed.Length > 0 ? trimmed : null;
        }
        return null;
    }

    private static JsonNode? At(JsonObject record, string key)
        => record.TryGetPropertyValue(key, out var node) ? node : null;

    /// <summary>
    /// Copy the members of <paramref name="record"/> that are neither known
    /// nor consumed, in input order. This is the carry-through that keeps
    /// validation able to see what the model actually wrote. It never
    /// inspects the values.
    /// </summary>
    private static void CarryUnknown(
        JsonObject into,
        JsonObject record,
        string[] known,
        string[]? consumed = null)
    {
        foreach (var (key, value) in record)
        {
            if (known.Contains(key) || (consumed is not null && consumed.Contains(key)))
            {
                continue;
            }
            into[key] = value?.DeepClone();
        }
    }

    /// <summary>
    /// Normalize one section value. A bare non-empty string becomes an
    /// available section. A string with nothing in it, a null and an absent
    /// key all become a declared gap, because "nothing here" is exactly what
    /// missing states. An object is kept, with its status inferred when
    /// absent and its unknown members carried through. Anything else — a
    /// number, an array, a boolean — is carried through untouched, so
    /// validation reports it at /sections/&lt;key&gt; instead of this method
    /// quietly recording a gap where the model wrote something.
    /// </summary>
    private static JsonNode? NormalizeSection(JsonNode? value)
    {
        var bare = AsTrimmedString(value);
        if (bare is not null)
        {
            return new JsonObject
            {
                ["status"] = "available",
                ["summary"] = bare,
            };
        }
        if (value is null || (value is JsonValue text && text.TryGetValue<string>(out _)))
        {
            return new JsonObject
            {
                ["status"] = "missing",
                ["summary"] = null,
            };
        }
        if (value is not JsonObject record)
        {
            return value.DeepClone();
        }

        var summary = AsTrimmedString(At(record, "summary"));
        var rawSummary = At(record, "summary");
        var rawStatus = AsTrimmedString(At(record, "status"));
        // A status the model actually wrote is kept exactly as written, even
        // when it is not one of the three. Validation then refuses it at
        // /sections/<key>/status. Rewriting "Available" to "available" would
        // be normalization inventing a claim: the section would count as
        // carrying content and would vanish from the list of what is not
        // captured, and the author would never learn the word was wrong.
        JsonNode? status;
        if (rawStatus is not null)
        {
            status = JsonValue.Create(rawStatus);
        }
        else if (record.ContainsKey("status"))
        {
            status = At(record, "status")?.DeepClone();
        }
        else
        {
            status = JsonValue.Create(summary is not null ? "available" : "missing");
        }

        JsonNode? summaryOut;
        if (summary is not null)
        {
            summaryOut = JsonValue.Create(summary);
        }
        else if (rawSummary is null || (rawSummary is JsonValue s && s.TryGetValue<string>(out _)))
        {
            summaryOut = null;
        }
        else
        {
            summaryOut = rawSummary.DeepClone();
        }

        var normalized = new JsonObject
        {
            ["status"] = status,
            ["summary"] = summaryOut,
        };
        // Provenance is carried verbatim whenever it is there at all.
        // Filtering out a label this implementation does not know would delete
        // the one thing that lets a cold reader tell a check from a guess, and
        // the label set is closed for the whole of version one: an
        // unrecognised label is an error, not noise.
        if (record.ContainsKey("provenance"))
        {
            normalized["provenance"] = At(record, "provenance")?.DeepClone();
        }
        CarryUnknown(normalized, record, SectionFields);
        return normalized;
    }

    /// <summary>
    /// Trim a list of prose, or return null when any entry is not usable
    /// prose, so the caller leaves the list exactly as written and validation
    /// reports the entry that is wrong rather than this method deleting it.
    /// </summary>
    private static JsonArray? NormalizeStringList(JsonNode? value)
    {
        if (value is not JsonArray array)
        {
            return null;
        }
        var list = new JsonArray();
        foreach (var item in array)
        {
            var entry = AsTrimmedString(item);
            if (entry is null)
            {
                return null;
            }
            list.Add(entry);
        }
        return list;
    }

    /// <summary>
    /// Trim the string members this object is known to carry, and leave
    /// everything else — unknown members, and known members holding something
    /// other than usable text — exactly where it was.
    /// </summary>
    private static JsonNode? NormalizeNamedObject(JsonNode? value, string[] known)
    {
        if (value is not JsonObject record)
        {
            return value?.DeepClone();
        }
        var result = new JsonObject();
        foreach (var (key, entry) in record)
        {
            var text = known.Contains(key) ? AsTrimmedString(entry) : null;
            result[key] = text is not null ? JsonValue.Create(text) : entry?.DeepClone();
        }
        return result;
    }

    /// <summary>The same, for the two objects whose members are lists of prose.</summary>
    private static JsonNode? NormalizeListObject(JsonNode? value, string[] known)
    {
        if (value is not JsonObject record)
        {
            return value?.DeepClone();
        }
        var result = new JsonObject();
        foreach (var (key, entry) in record)
        {
            var entries = known.Contains(key) ? NormalizeStringList(entry) : null;
            result[key] = entries is not null ? entries : entry?.DeepClone();
        }
        return result;
    }

    /// <summary>All 17 keys declared, then whatever else was written.</summary>
    private static JsonObject NormalizeSections(JsonObject raw)
    {
        var sections = new JsonObject();
        foreach (var key in Sections.SectionKeys)
        {
            sections[key] = NormalizeSection(At(raw, key));
        }
        CarryUnknown(sections, raw, Sections.SectionKeys.ToArray());
        return sections;
    }

    /// <summary>
    /// Normalize a parsed JSON value into a spec-shaped document.
    ///
    /// The result is not guaranteed valid: run
    /// <see cref="Validate.ValidateHandover"/> on it. What is guaranteed is
    /// that nothing the input carried was thrown away, and that when the
    /// input's <c>sections</c> is an object or absent, all 17 section keys are
    /// declared. A value whose root is not an object is returned as it
    /// arrived, because building a document around it would replace the value
    /// rather than report it.
    ///
    /// Observations pass through unchanged. Nothing here interprets them,
    /// reorders them, filters them by kind, rewrites their data, or repairs
    /// a malformed entry: an entry whose kind this implementation has never
    /// heard of is the exact case the extension point exists for, and a
    /// tool that emits a malformed envelope should be told so by validate,
    /// not quietly patched here.
    /// </summary>
    public static JsonNode? NormalizeHandover(JsonNode? input)
    {
        if (input is null)
        {
            return NormalizeHandover(new JsonObject());
        }
        if (input is not JsonObject root)
        {
            return input.DeepClone();
        }

        var result = new JsonObject();
        string[] consumed = [];

        // The declared version of this document. An input that states one
        // keeps it, whatever it says: normalization never upgrades a document
        // and never downgrades one. An input that states none is declared 1.0,
        // which is a claim about the shape this method just produced, not a
        // claim about where the content came from.
        result["soilHandover"] = root.ContainsKey("soilHandover")
            ? AsTrimmedString(At(root, "soilHandover")) is { } version
                ? JsonValue.Create(version)
                : At(root, "soilHandover")?.DeepClone()
            : Spec.Version;

        // An id that is already there is kept, whatever shape it is in: a copy
        // keeps its identity, and an id that is present but malformed is a
        // validation error rather than something to drop. Dropping it would
        // hand the writer a document with no id, and the writer would mint a
        // fresh one over the top of the malformed one nobody was ever told
        // about. A missing id stays missing, because assigning it is the
        // writer's job and normalization is not a writer.
        if (root.ContainsKey("handoverId"))
        {
            result["handoverId"] = AsTrimmedString(At(root, "handoverId")) is { } id
                ? JsonValue.Create(id)
                : At(root, "handoverId")?.DeepClone();
        }

        foreach (var key in new[] { "projectId", "title" })
        {
            result[key] = root.ContainsKey(key)
                ? AsTrimmedString(At(root, key)) is { } text
                    ? JsonValue.Create(text)
                    : At(root, key)?.DeepClone()
                : JsonValue.Create("");
        }

        // No wall clock. A document that does not carry a capture time is
        // refused by validation, not completed here.
        if (root.ContainsKey("createdAt"))
        {
            result["createdAt"] = AsTrimmedString(At(root, "createdAt")) is { } createdAt
                ? JsonValue.Create(createdAt)
                : At(root, "createdAt")?.DeepClone();
        }

        // No recipe version is stamped: this method did not write the content,
        // so it is in no position to say which recipe did. source appears in
        // the output only when the input carried one.
        if (root.ContainsKey("source"))
        {
            result["source"] = NormalizeNamedObject(At(root, "source"), SourceFields);
        }

        var rawSections = At(root, "sections");
        var loose = At(root, "extractionSections");
        if (rawSections is JsonObject sectionsObject)
        {
            result["sections"] = NormalizeSections(sectionsObject);
        }
        else if (root.ContainsKey("sections"))
        {
            result["sections"] = rawSections?.DeepClone();
        }
        else if (loose is JsonObject looseObject)
        {
            // The loose key the rescue prompt asks for. It is consumed only
            // when it is actually the source of sections; a document carrying
            // both is carrying content under a key nothing read, which is
            // validation's to report.
            result["sections"] = NormalizeSections(looseObject);
            consumed = ["extractionSections"];
        }
        else
        {
            result["sections"] = NormalizeSections(new JsonObject());
        }

        if (root.ContainsKey("quality"))
        {
            result["quality"] = NormalizeListObject(At(root, "quality"), QualityFields);
        }
        if (root.ContainsKey("safety"))
        {
            result["safety"] = NormalizeListObject(At(root, "safety"), SafetyFields);
        }
        if (root.ContainsKey("observations"))
        {
            result["observations"] = At(root, "observations")?.DeepClone();
        }
        if (root.ContainsKey("code"))
        {
            result["code"] = AsTrimmedString(At(root, "code")) is { } code
                ? JsonValue.Create(code)
                : At(root, "code")?.DeepClone();
        }

        CarryUnknown(result, root, RootFields, consumed);
        return result;
    }

    [GeneratedRegex("```(?:json)?\\s*\\n([\\s\\S]*?)```", RegexOptions.IgnoreCase)]
    private static partial Regex FencedBlock();

    /// <summary>
    /// Pull the first fenced JSON block out of a model's reply, or fall back
    /// to the first <c>{...}</c> span. Returns the raw text, not a parsed
    /// value.
    ///
    /// Models wrap JSON in prose no matter how firmly the prompt says not
    /// to, and a user pasting a reply should not have to clean it up by
    /// hand.
    /// </summary>
    public static string? ExtractJsonBlock(string text)
    {
        var fenced = FencedBlock().Match(text);
        if (fenced.Success)
        {
            return fenced.Groups[1].Value.Trim();
        }
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        if (start >= 0 && end > start)
        {
            return text[start..(end + 1)].Trim();
        }
        return null;
    }
}
