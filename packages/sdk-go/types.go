// The document types of the Soil Handover Specification v1.
//
// The schema at spec/handover.schema.json is normative. Documents in this SDK
// stay in the ordered JSON model (see jsonvalue.go), the same way the Python
// SDK keeps them as plain dicts; the structs here are the typed rows and
// results that surround a document, not the document itself.

package handover

// SpecVersion is the format version this SDK writes.
const SpecVersion = "1.0"

// SupportedSpecVersions is the set of format versions this SDK reads, exactly.
//
// Support is a set of versions, not a pattern. A reader that accepts "1.4"
// because the string starts with "1." is claiming to implement a version
// nobody has written yet, and version one is a closed world: whatever a later
// minor allowed, this reader would meet it having never been told what it
// means. Refusing is the honest answer. See spec/versioning.md.
var SupportedSpecVersions = []string{"1.0"}

// StoreEntry is a row in the local index.
type StoreEntry struct {
	// Code is the load code, e.g. "#004".
	Code string
	// ProjectID is the handover's project slug.
	ProjectID string
	// Title is the handover's human title.
	Title string
	// CreatedAt is the handover's timestamp.
	CreatedAt string
	// SectionsWithContent is how many of the 17 sections have status
	// available. Structural content presence, never a claim that the capture
	// succeeded.
	SectionsWithContent int
	// File is the file name inside the store's handovers directory.
	File string
}

// StoreIndex is the on-disk index document.
type StoreIndex struct {
	IndexVersion int
	// NextCode is the next numeric code the store will hand out.
	NextCode int
	Entries  []StoreEntry
}

// ValidationIssueKind says what kind of rule an issue broke. IssueStructure
// is the shape of the document. IssueSafety is the fail-closed secret scan,
// which is a spec rule rather than a schema rule because JSON Schema cannot
// express "this string looks like a token".
type ValidationIssueKind string

const (
	IssueStructure ValidationIssueKind = "structure"
	IssueSafety    ValidationIssueKind = "safety"
)

// ValidationIssue is one problem found by Validate.
type ValidationIssue struct {
	// Path is a JSON Pointer-ish path to the offending value, e.g.
	// "/sections/decisions".
	Path string
	// Message says what is wrong, in plain language. Never quotes the
	// offending value.
	Message string
	// Kind says which rule was broken.
	Kind ValidationIssueKind
}

// ValidationResult is the result of validating a candidate handover.
type ValidationResult struct {
	Valid  bool
	Issues []ValidationIssue
}

// SectionCounts holds section counts for a handover. Structural content
// presence, never a grade.
//
// The field is WithContent, not Captured: a section holding two characters
// has content present and nothing more. "Captured" asserts that the thing was
// successfully taken, which a count of non-empty summaries cannot know.
type SectionCounts struct {
	// WithContent is the number of sections with status available.
	WithContent int
	// Missing is the number of sections with status missing.
	Missing int
	// Blocked is the number of sections with status blocked.
	Blocked int
	// NotApplicable is the number of sections with status not_applicable.
	NotApplicable int
	// Total is always 17.
	Total int
}
