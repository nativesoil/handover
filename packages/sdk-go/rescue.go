// The rescue prompt: the exact text a user pastes into a dead or full thread.
//
// When a thread is out of room, or the assistant has no tools wired up, no
// soil save can run inside it. The rescue prompt asks the model for ONE JSON
// block, which soil save - (or a file) ingests as a real handover. It is the
// manual on-ramp, and it is the reason the format has to be writable by a
// model with no tools at all.
//
// The canonical text lives in recipes/rescue-recipe-v1.txt at the repo root
// and is BYTE-NORMATIVE. This SDK embeds a copy (embedded/rescue-recipe-v1.txt)
// and serves it verbatim; a test and the conformance suite hold the embedded
// copy to byte identity with the repo file.
//
// The block it asks for uses the loose shape (extractionSections, plain
// strings). Normalize turns that into a spec-shaped document, which is how
// the manual on-ramp reaches the same store as everything else.

package handover

import (
	_ "embed"
	"strings"
)

//go:embed embedded/rescue-recipe-v1.txt
var rescueText string

// RescuePrompt is the rescue prompt, verbatim. The canonical file carries a
// trailing newline that belongs to the file, not the prompt.
var RescuePrompt = strings.TrimSuffix(rescueText, "\n")
