// The 17 sections of the Soil Handover Specification v1, their tiers, and the
// provenance label set.
//
// The key list and the label list are the format's contract: an implementation
// that renames, reorders, drops or adds a key is not producing a Soil handover.
// Both are locked for the whole v1 line (see spec/versioning.md).

package handover

// SectionKeys holds the 17 section keys, in canonical order.
//
// Tier A (durable project truth) carries what stays true across sessions.
// Tier B (this session's frontier) carries what was true at capture.
// Tier C (handover meta) carries the boot prompt and the honesty record.
var SectionKeys = []string{
	// Tier A, the project (durable).
	"projectIdentity",
	"decisions",
	"workflow",
	"architecture",
	"constraints",
	"rejectedPaths",
	// Tier B, the latest (this session's frontier).
	"executiveSummary",
	"currentTask",
	"latestUserIntent",
	"sessionDelta",
	"blockers",
	"nextSteps",
	"openQuestions",
	// Tier C, handover meta.
	"sessionActivity",
	"restoreInstructions",
	"provenanceMap",
	"safetySummary",
}

// The tier a section belongs to.
const (
	TierDurable  = "durable"
	TierFrontier = "frontier"
	TierMeta     = "meta"
)

// SectionTiers maps each section key to its tier.
var SectionTiers = map[string]string{
	"projectIdentity":     TierDurable,
	"decisions":           TierDurable,
	"workflow":            TierDurable,
	"architecture":        TierDurable,
	"constraints":         TierDurable,
	"rejectedPaths":       TierDurable,
	"executiveSummary":    TierFrontier,
	"currentTask":         TierFrontier,
	"latestUserIntent":    TierFrontier,
	"sessionDelta":        TierFrontier,
	"blockers":            TierFrontier,
	"nextSteps":           TierFrontier,
	"openQuestions":       TierFrontier,
	"sessionActivity":     TierMeta,
	"restoreInstructions": TierMeta,
	"provenanceMap":       TierMeta,
	"safetySummary":       TierMeta,
}

// SectionLabels holds the short human labels used by the renderer and the CLI.
var SectionLabels = map[string]string{
	"projectIdentity":     "project identity",
	"decisions":           "decisions",
	"workflow":            "workflow",
	"architecture":        "architecture",
	"constraints":         "constraints",
	"rejectedPaths":       "rejected paths",
	"executiveSummary":    "executive summary",
	"currentTask":         "current task",
	"latestUserIntent":    "latest user intent",
	"sessionDelta":        "session delta",
	"blockers":            "blockers",
	"nextSteps":           "next steps",
	"openQuestions":       "open questions",
	"sessionActivity":     "session activity",
	"restoreInstructions": "restore instructions",
	"provenanceMap":       "provenance map",
	"safetySummary":       "safety summary",
}

// SectionStatuses holds the four statuses a section may carry.
//
// available carries content. The other three are the kinds of nothing, and
// they are not interchangeable: missing says the extractor could not see it
// and the next session should look, blocked says it exists and was withheld so
// the next session should ask elsewhere, and not_applicable says the project
// has no such thing so the next session should stop looking. not_applicable
// carries a required reason, because it is the one status that tells a reader
// to stop.
var SectionStatuses = []string{"available", "missing", "blocked", "not_applicable"}

// ProvenanceLabels holds the labels a section may carry, so a cold reader can
// tell what was checked from what was merely reported or guessed.
//
// The set is fixed so that a label means the same thing in every
// implementation and a handover written by one tool reads the same in
// another. Labels are additive facts about a claim's origin; they are not a
// grade, and nothing here scores them.
var ProvenanceLabels = []string{
	// Checked against the project's own source of truth by the extractor.
	"repo_verified",
	// Observed by a Soil component rather than reported by the model.
	"soil_observed",
	// Taken from the standing instructions or system prompt in force.
	"prompt_report",
	// The user stated it and locked it explicitly.
	"user_locked_memory",
	// The model is reporting it from the conversation.
	"model_reported",
	// The model concluded it; nobody stated it.
	"inferred",
	// The project owner observed it directly.
	"owner_observed",
	// Confirmed against a running system.
	"live_verified",
	// Confirmed against a local or emulated system.
	"emulator_verified",
	// Intended but not built yet.
	"planned_only",
	// Withheld for safety; the fact exists, the value does not travel.
	"blocked",
}

// Length and count bounds. A handover is a document, never a dump.
//
// Every length here is counted in Unicode code points, by TextLength. The
// comment on LimitTitle used to say "in UTF-16 units like the schema", and
// both halves of that were wrong: the code counted UTF-16 units, the
// published schema's maxLength is defined in code points, and the two
// therefore disagreed on every string carrying a character outside the basic
// plane. spec/value-domain.md is the normative statement.
const (
	// LimitTitle is the max length of title, in code points.
	LimitTitle = 200
	// LimitProjectID is the max length of projectId, in code points.
	LimitProjectID = 120
	// LimitSectionSummary is the max length of a section summary, in code points.
	LimitSectionSummary = 20000
	// LimitProvenanceLabels is the max provenance labels on one section.
	LimitProvenanceLabels = 11
	// LimitListEntries is the max entries in a quality or safety list.
	LimitListEntries = 200
	// LimitListEntry is the max length of one quality or safety list entry,
	// in code points.
	LimitListEntry = 1000
	// LimitObservations is the max attached observations.
	LimitObservations = 100
	// LimitObservationKind is the max length of an observation kind, in code
	// points.
	LimitObservationKind = 200
)

func isSectionKey(key string) bool {
	for _, known := range SectionKeys {
		if known == key {
			return true
		}
	}
	return false
}

func isSectionStatus(status string) bool {
	for _, known := range SectionStatuses {
		if known == status {
			return true
		}
	}
	return false
}

func isProvenanceLabel(label string) bool {
	for _, known := range ProvenanceLabels {
		if known == label {
			return true
		}
	}
	return false
}
