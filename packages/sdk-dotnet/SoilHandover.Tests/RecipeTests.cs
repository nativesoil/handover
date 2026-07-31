using System.Text.RegularExpressions;
using Xunit;

namespace Soil.Handover.Tests;

public class RecipeTests
{
    [Fact]
    public void TheEmbeddedRecipeIsByteIdenticalToTheCanonicalFile()
    {
        var file = File.ReadAllText(TestData.RepoFile("recipes", "handover-recipe-v1.txt"));
        Assert.Equal(file, Recipe.RenderRecipe());
    }

    [Fact]
    public void TheEmbeddedRescuePromptIsByteIdenticalToTheCanonicalFile()
    {
        var file = File.ReadAllText(TestData.RepoFile("recipes", "rescue-recipe-v1.txt"));
        Assert.Equal(file, Rescue.RescuePrompt + "\n");
    }

    [Fact]
    public void TheRecipeVersionIsASemverString()
    {
        Assert.Matches(new Regex(@"^\d+\.\d+\.\d+$"), Recipe.RecipeVersion);
    }

    [Fact]
    public void TheRecipeCarriesTheOpeningRuleAndRules1To5()
    {
        Assert.Equal(6, Recipe.SharedRules.Count);
        foreach (var rule in new[] { "RULE 1", "RULE 2", "RULE 3", "RULE 4", "RULE 5" })
        {
            Assert.Contains(Recipe.SharedRules, text => text.StartsWith(rule, StringComparison.Ordinal));
        }
    }

    [Fact]
    public void TheInstructionBlockIsTheRulesTheLensTheFramingAndTheClose()
    {
        var recipe = Recipe.BuildRecipe();
        Assert.Equal(Recipe.SharedRules.Count + 5, recipe.Instructions.Count);
        Assert.Equal(Recipe.SharedRules, recipe.Instructions.Take(6).ToList());
        Assert.Equal(Recipe.AntiDriftLens, recipe.Instructions[6]);
        Assert.Equal(Recipe.SelfSufficientFraming, recipe.Instructions.Skip(7).Take(3).ToList());
        Assert.Equal(Recipe.ClosingInstruction, recipe.Instructions[10]);
    }

    [Fact]
    public void EveryOneOfThe17SectionsHasRealGuidanceNotALabel()
    {
        foreach (var key in Sections.SectionKeys)
        {
            Assert.True(
                Recipe.SectionGuidance.TryGetValue(key, out var guidance) && guidance.Length > 200,
                $"guidance for {key} is missing or too short");
        }
    }

    [Fact]
    public void TheRescuePromptAsksForTheShapeNormalizationAccepts()
    {
        Assert.Contains("extractionSections", Rescue.RescuePrompt);
    }
}
