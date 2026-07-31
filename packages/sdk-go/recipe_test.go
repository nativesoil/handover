package handover

import (
	"regexp"
	"strings"
	"testing"
)

// The recipes are BYTE-NORMATIVE. The embedded copies must match the
// canonical files at the repo root byte for byte, and the rendered text must
// be the same bytes again.

func TestEmbeddedRecipeMatchesTheRepoFileByteForByte(t *testing.T) {
	if recipeText != readRepoFile(t, "recipes/handover-recipe-v1.txt") {
		t.Fatal("embedded/handover-recipe-v1.txt has drifted from recipes/handover-recipe-v1.txt; copy the canonical file over the embedded one")
	}
}

func TestEmbeddedRescueMatchesTheRepoFileByteForByte(t *testing.T) {
	if rescueText != readRepoFile(t, "recipes/rescue-recipe-v1.txt") {
		t.Fatal("embedded/rescue-recipe-v1.txt has drifted from recipes/rescue-recipe-v1.txt; copy the canonical file over the embedded one")
	}
}

func TestRenderRecipeIsTheCanonicalBytes(t *testing.T) {
	if RenderRecipe() != readRepoFile(t, "recipes/handover-recipe-v1.txt") {
		t.Fatal("RenderRecipe must return the canonical recipe bytes")
	}
}

func TestRescuePromptIsTheCanonicalBytes(t *testing.T) {
	if RescuePrompt+"\n" != readRepoFile(t, "recipes/rescue-recipe-v1.txt") {
		t.Fatal("RescuePrompt plus a newline must be the canonical rescue bytes")
	}
	if !strings.Contains(RescuePrompt, "extractionSections") {
		t.Fatal("the rescue prompt asks for the shape normalization accepts")
	}
}

func TestRecipeVersionIsSemver(t *testing.T) {
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(RecipeVersion) {
		t.Fatalf("RecipeVersion %q is not a semver string", RecipeVersion)
	}
}

func TestRecipeCarriesTheRules(t *testing.T) {
	if len(SharedRules) != 6 {
		t.Fatalf("expected the opening rule and RULES 1 to 5, got %d", len(SharedRules))
	}
	for _, rule := range []string{"RULE 1", "RULE 2", "RULE 3", "RULE 4", "RULE 5"} {
		found := false
		for _, text := range SharedRules {
			if strings.HasPrefix(text, rule) {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("%s should be present verbatim", rule)
		}
	}
}

func TestRecipeInstructionsAreComplete(t *testing.T) {
	recipe := BuildRecipe()
	if len(recipe.Instructions) != len(SharedRules)+5 {
		t.Fatalf("the instruction block should be the rules, the lens, the framing and the close, got %d", len(recipe.Instructions))
	}
	for _, key := range SectionKeys {
		if len(SectionGuidance[key]) <= 200 {
			t.Fatalf("%s needs real guidance, not a label", key)
		}
	}
}
