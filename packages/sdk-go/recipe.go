// The extraction recipe: the words that make a model produce a good handover.
//
// The canonical text lives in recipes/handover-recipe-v1.txt at the repo
// root and is BYTE-NORMATIVE: a paraphrase is a bug. This SDK embeds a copy
// of that file (embedded/handover-recipe-v1.txt) at build time and serves it
// verbatim; a test and the conformance suite hold the embedded copy to byte
// identity with the repo file, so the two cannot drift apart.
//
// The rules, the anti-drift lens, the self-sufficiency framing and the 17
// per-section guidance strings are exposed as data too, parsed from the same
// embedded bytes, so any consumer sees exactly the strings a model sees.

package handover

import (
	_ "embed"
	"fmt"
	"strings"
)

// RecipeVersion is the version of the recipe text, independent of the format
// version.
//
// Nobody in this repository stamps it into a document. A writer is handed a
// finished document and is in no position to attest which recipe produced it,
// so source.recipeVersion is reported by the only party that observed the
// recipe: the model. Both recipe texts print this version on their first line
// and ask the model to copy it back. Improving the recipe bumps this version
// and never moves the format version.
const RecipeVersion = "1.4.0"

//go:embed embedded/handover-recipe-v1.txt
var recipeText string

// SharedRules holds the non-negotiable contract every Soil handover obeys:
// the opening rule and RULES 1 to 5, verbatim.
var SharedRules []string

// AntiDriftLens is the single question the model holds over every section,
// verbatim.
var AntiDriftLens string

// SelfSufficientFraming holds the self-sufficient framing every Soil
// handover obeys, verbatim. There is one save mode, and the reader is always
// assumed to have only the handover itself.
var SelfSufficientFraming []string

// ClosingInstruction is the closing instruction, verbatim: one JSON block
// against the published schema, and no claim of grading.
var ClosingInstruction string

// SectionGuidance holds one verbatim guidance string per section key.
var SectionGuidance map[string]string

// Recipe is the assembled recipe, as data.
type Recipe struct {
	SpecVersion     string
	Instructions    []string
	SectionGuidance map[string]string
	SectionKeys     []string
}

// BuildRecipe builds the recipe. The instruction order is fixed: the shared
// rules, the lens, the framing, the close. Pure and deterministic.
func BuildRecipe() Recipe {
	instructions := []string{}
	instructions = append(instructions, SharedRules...)
	instructions = append(instructions, AntiDriftLens)
	instructions = append(instructions, SelfSufficientFraming...)
	instructions = append(instructions, ClosingInstruction)
	return Recipe{
		SpecVersion:     SpecVersion,
		Instructions:    instructions,
		SectionGuidance: SectionGuidance,
		SectionKeys:     append([]string(nil), SectionKeys...),
	}
}

// RenderRecipe renders the recipe as the text a user pastes into a model:
// the embedded canonical bytes, verbatim.
func RenderRecipe() string {
	return recipeText
}

// The embedded recipe is a fixed layout of single-line blocks separated by
// blank lines: a header, eleven instructions, a SECTIONS marker, and one
// "key: guidance" line per section. init parses that layout back into the
// exported data and refuses to start on any mismatch, so the data and the
// rendered bytes cannot disagree.
func init() {
	content := strings.TrimSuffix(recipeText, "\n")
	blocks := strings.Split(content, "\n\n")
	if len(blocks) != 2+11+len(SectionKeys) {
		panic(fmt.Sprintf("embedded recipe has %d blocks, expected %d", len(blocks), 2+11+len(SectionKeys)))
	}
	if !strings.HasPrefix(blocks[0], "SOIL HANDOVER EXTRACTION") {
		panic("embedded recipe does not start with the extraction header")
	}
	SharedRules = blocks[1:7]
	AntiDriftLens = blocks[7]
	SelfSufficientFraming = blocks[8:11]
	ClosingInstruction = blocks[11]

	SectionGuidance = make(map[string]string, len(SectionKeys))
	for i, key := range SectionKeys {
		block := blocks[13+i]
		prefix := key + ": "
		if !strings.HasPrefix(block, prefix) {
			panic("embedded recipe guidance out of order at " + key)
		}
		SectionGuidance[key] = strings.TrimPrefix(block, prefix)
	}
}
