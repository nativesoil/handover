namespace Soil.Handover;

/// <summary>
/// The extraction recipe: the words that make a model produce a good
/// handover.
///
/// The canonical text lives in <c>recipes/handover-recipe-v1.txt</c> at the
/// repo root and is BYTE-NORMATIVE: the conformance suite holds every
/// embedded copy to byte identity with it. This SDK embeds that file at
/// build time and parses its structure, so the rules, the anti-drift lens,
/// the self-sufficiency framing and the 17 per-section guidance strings are
/// exactly the bytes of the canonical file, never a paraphrase.
/// </summary>
public static class Recipe
{
    /// <summary>
    /// The version of the recipe text, independent of the format version.
    ///
    /// Nobody in this repository stamps it into a document. A writer is
    /// handed a finished document and is in no position to attest which
    /// recipe produced it, so <c>source.recipeVersion</c> is reported by the
    /// only party that observed the recipe: the model. Both recipe texts
    /// print this version on their first line and ask the model to copy it
    /// back. Improving the recipe bumps this version and never moves the
    /// format version.
    /// </summary>
    public const string RecipeVersion = "1.4.0";

    private static readonly Lazy<ParsedRecipe> Parsed = new(Parse);

    private sealed record ParsedRecipe(
        string Text,
        IReadOnlyList<string> Instructions,
        IReadOnlyDictionary<string, string> SectionGuidance);

    /// <summary>
    /// The SHARED RULES: the non-negotiable contract every Soil handover
    /// obeys. The opening rule plus RULES 1 to 5, exactly as the canonical
    /// recipe file states them.
    /// </summary>
    public static IReadOnlyList<string> SharedRules
        => Parsed.Value.Instructions.Take(6).ToList();

    /// <summary>
    /// The ANTI-DRIFT LENS: the single question the model holds over every
    /// section.
    /// </summary>
    public static string AntiDriftLens => Parsed.Value.Instructions[6];

    /// <summary>
    /// The SELF-SUFFICIENT FRAMING every Soil handover obeys. There is one
    /// save mode. The reader is ALWAYS assumed to have ONLY this handover:
    /// no repo, no docs, no links, no prior thread, no shared memory.
    /// </summary>
    public static IReadOnlyList<string> SelfSufficientFraming
        => Parsed.Value.Instructions.Skip(7).Take(3).ToList();

    /// <summary>
    /// The CLOSING INSTRUCTION: emit one JSON block against the published
    /// schema, and no claim of grading.
    /// </summary>
    public static string ClosingInstruction => Parsed.Value.Instructions[10];

    /// <summary>One guidance string per section key, from the canonical file.</summary>
    public static IReadOnlyDictionary<string, string> SectionGuidance
        => Parsed.Value.SectionGuidance;

    /// <summary>
    /// Build the recipe as data. The instruction order is fixed: the shared
    /// rules, the lens, the framing, and the close. Pure and deterministic.
    /// </summary>
    public static HandoverRecipe BuildRecipe()
        => new(
            Spec.Version,
            Parsed.Value.Instructions,
            Parsed.Value.SectionGuidance,
            Sections.SectionKeys);

    /// <summary>
    /// The text a user pastes into a model: the canonical recipe file,
    /// byte for byte.
    /// </summary>
    public static string RenderRecipe() => Parsed.Value.Text;

    private static ParsedRecipe Parse()
    {
        var text = Embedded.Read("Soil.Handover.recipes.handover-recipe-v1.txt");
        var lines = text.Split('\n');
        if (lines.Length == 0 || !lines[0].StartsWith("SOIL HANDOVER EXTRACTION", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("the embedded recipe text does not open with the expected header");
        }

        var instructions = new List<string>();
        var guidance = new Dictionary<string, string>();
        var inSections = false;
        for (var i = 1; i < lines.Length; i += 1)
        {
            var line = lines[i];
            if (line.Length == 0)
            {
                continue;
            }
            if (!inSections && line.StartsWith("SECTIONS", StringComparison.Ordinal))
            {
                inSections = true;
                continue;
            }
            if (!inSections)
            {
                instructions.Add(line);
                continue;
            }
            var separator = line.IndexOf(": ", StringComparison.Ordinal);
            if (separator < 0)
            {
                throw new InvalidOperationException("the embedded recipe text has a section line without a key");
            }
            guidance[line[..separator]] = line[(separator + 2)..];
        }

        if (instructions.Count != 11)
        {
            throw new InvalidOperationException(
                "the embedded recipe text does not carry the expected instruction blocks");
        }
        foreach (var key in Sections.SectionKeys)
        {
            if (!guidance.ContainsKey(key))
            {
                throw new InvalidOperationException(
                    $"the embedded recipe text is missing guidance for {key}");
            }
        }

        return new ParsedRecipe(text, instructions, guidance);
    }
}
