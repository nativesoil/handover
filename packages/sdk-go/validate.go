// Validation: does this document obey the Soil Handover Specification v1?
//
// Two normative rules are checked, and only two. First the shape: the 17
// sections, the statuses, the labels, the bounds. Then the fail-closed secret
// scan: a handover that carries credentials or private absolute paths is
// rejected, because a handover is written to be moved and anything inside it
// has already left the machine.
//
// Neither rule is a judgement about content. This answers "is this a handover
// and is it safe to move", never "is this a good handover". A thin but honest
// handover is valid, and so is one whose every section is missing.
//
// spec/handover.schema.json is the normative statement of these same rules,
// and the conformance suite holds this validator to the same fixtures the
// schema is held to, so the two cannot drift apart.
//
// Zero dependencies on purpose: the SDK should be usable anywhere without a
// validator bundle, and the error messages here can say what a JSON Schema
// error cannot.

package handover

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

var (
	projectIDPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	codePattern          = regexp.MustCompile(`^#\d{3,}$`)
	isoDatePattern       = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$`)
	recipeVersionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
)

// notApplicableNeedsReason explains why not_applicable is the one gap status
// that must say something. It is a positive assertion about the project rather
// than a report about the extractor, and it is the only status that tells the
// next model to stop looking. A writer that cannot say why a section does not
// apply has not established that it does not apply; it has established that it
// could not see it, and missing says exactly that and carries no such
// requirement.
const notApplicableNeedsReason = "must say why the section does not apply when status is 'not_applicable': " +
	"a gap that tells the next model to stop looking has to carry its reason, and a gap with no reason is 'missing'"

var sourceTextKeys = []string{"client", "model", "provider"}
var sourceKeys = []string{"client", "model", "provider", "recipeVersion"}
var observationKeys = []string{"kind", "producedBy", "producedAt", "data"}
var qualityKeys = []string{"missingInputs", "contradictions"}
var safetyKeys = []string{"unsafeOmissions"}
var rootKeys = []string{
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
}

func isParsableTimestamp(value string) bool {
	if !isoDatePattern.MatchString(value) {
		return false
	}
	// The regex pins the shape; parsing catches out-of-range components the
	// way Date.parse does in the official TypeScript implementation.
	_, err := time.Parse(time.RFC3339, value)
	return err == nil
}

type issueBag struct {
	issues []ValidationIssue
}

func (b *issueBag) add(path, message string) {
	b.addKind(path, message, IssueStructure)
}

func (b *issueBag) addKind(path, message string, kind ValidationIssueKind) {
	b.issues = append(b.issues, ValidationIssue{Path: path, Message: message, Kind: kind})
}

func asObj(value any) (*Obj, bool) {
	obj, ok := value.(*Obj)
	return obj, ok
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func checkStringList(bag *issueBag, value any, path string) {
	list, ok := value.([]any)
	if !ok {
		bag.add(path, "must be an array of strings")
		return
	}
	if len(list) > LimitListEntries {
		bag.add(path, fmt.Sprintf("must hold at most %d entries", LimitListEntries))
	}
	for i, entry := range list {
		text, ok := entry.(string)
		if !ok {
			bag.add(fmt.Sprintf("%s/%d", path, i), "must be a string")
			continue
		}
		if strings.TrimSpace(text) == "" {
			bag.add(fmt.Sprintf("%s/%d", path, i), "must not be empty")
		}
		if TextLength(text) > LimitListEntry {
			bag.add(fmt.Sprintf("%s/%d", path, i), fmt.Sprintf("must be at most %d code points", LimitListEntry))
		}
	}
}

func checkExtraKeys(bag *issueBag, record *Obj, allowed []string, path string) {
	for _, key := range record.keys {
		if !contains(allowed, key) {
			bag.add(path+"/"+key, "is not a field of this object")
		}
	}
}

func checkSections(bag *issueBag, value any) {
	record, ok := asObj(value)
	if !ok {
		bag.add("/sections", "must be an object holding all 17 sections")
		return
	}
	checkExtraKeys(bag, record, SectionKeys, "/sections")

	for _, key := range SectionKeys {
		path := "/sections/" + key
		raw, present := record.Get(key)
		if !present {
			bag.add(path, "is required: every section is declared, and a gap is stated with status 'missing'")
			continue
		}
		section, ok := asObj(raw)
		if !ok {
			bag.add(path, "must be an object with 'status' and 'summary'")
			continue
		}
		checkExtraKeys(bag, section, []string{"status", "summary", "provenance"}, path)

		statusValue, _ := section.Get("status")
		status, statusIsString := statusValue.(string)
		if !statusIsString || !isSectionStatus(status) {
			bag.add(path+"/status", "must be one of "+strings.Join(SectionStatuses, ", "))
		}

		summaryValue, _ := section.Get("summary")
		switch summary := summaryValue.(type) {
		case nil:
			if status == "available" {
				bag.add(path+"/summary", "must hold content when status is 'available'")
			}
			if status == "not_applicable" {
				bag.add(path+"/summary", notApplicableNeedsReason)
			}
		case string:
			if TextLength(summary) > LimitSectionSummary {
				bag.add(path+"/summary", fmt.Sprintf("must be at most %d code points", LimitSectionSummary))
			}
			if status == "available" && strings.TrimSpace(summary) == "" {
				bag.add(path+"/summary", "must hold content when status is 'available'")
			}
			if status == "not_applicable" && strings.TrimSpace(summary) == "" {
				bag.add(path+"/summary", notApplicableNeedsReason)
			}
		default:
			bag.add(path+"/summary", "must be a string or null")
		}

		if provenanceValue, ok := section.Get("provenance"); ok {
			provenance, isArray := provenanceValue.([]any)
			if !isArray {
				bag.add(path+"/provenance", "must be an array of provenance labels")
				continue
			}
			if len(provenance) > LimitProvenanceLabels {
				bag.add(path+"/provenance", fmt.Sprintf("must hold at most %d labels", LimitProvenanceLabels))
			}
			seen := map[string]bool{}
			for i, labelValue := range provenance {
				label, isString := labelValue.(string)
				if !isString || !isProvenanceLabel(label) {
					bag.add(
						fmt.Sprintf("%s/provenance/%d", path, i),
						"must be one of "+strings.Join(ProvenanceLabels, ", "),
					)
					continue
				}
				if seen[label] {
					bag.add(fmt.Sprintf("%s/provenance/%d", path, i), "is a duplicate label")
				}
				seen[label] = true
			}
		}
	}
}

// Validate validates a candidate handover against the spec. The input is a
// value in the ordered JSON model, as produced by ParseJSON or Normalize.
//
// Every problem is reported, not just the first, so a model fixing its output
// needs one round trip rather than five.
func Validate(input any) ValidationResult {
	bag := &issueBag{issues: []ValidationIssue{}}

	root, ok := asObj(input)
	if !ok {
		bag.add("", "a handover must be a JSON object")
		// Fail closed even here. A document with the wrong root shape is still
		// a document, and a credential inside one has still left the machine.
		// The scan runs before this early return so that no document the
		// ingestion boundary accepted is refused without also being scanned.
		for _, finding := range FindSecretMaterial(input) {
			bag.addKind(finding.Path, DescribeSecretFinding(finding), "safety")
		}
		return ValidationResult{Valid: false, Issues: bag.issues}
	}

	checkExtraKeys(bag, root, rootKeys, "")

	versionValue, _ := root.Get("soilHandover")
	if version, ok := versionValue.(string); !ok {
		bag.add("/soilHandover", `is required and must be a string, e.g. "1.0"`)
	} else if !contains(SupportedSpecVersions, version) {
		// Exact versions, never a pattern. A reader that accepts a minor it
		// does not implement is claiming to implement a version nobody has
		// written; version one is a closed world, so whatever that minor
		// allowed would arrive unrecognised. See spec/versioning.md.
		bag.add("/soilHandover", fmt.Sprintf(
			"must be a format version this reader supports (%s), got %q",
			strings.Join(SupportedSpecVersions, ", "), version))
	}

	handoverID, hasID := root.Get("handoverId")
	if !hasID {
		bag.add("/handoverId", "is required: the globally unique id a writer assigns when the handover is stored")
	} else if !IsHandoverID(handoverID) {
		bag.add("/handoverId", "must be a UUID in canonical form: lowercase hex as 8-4-4-4-12")
	}

	projectIDValue, _ := root.Get("projectId")
	if projectID, ok := projectIDValue.(string); !ok || projectID == "" {
		bag.add("/projectId", "is required and must be a non-empty string")
	} else {
		if TextLength(projectID) > LimitProjectID {
			bag.add("/projectId", fmt.Sprintf("must be at most %d code points", LimitProjectID))
		}
		if !projectIDPattern.MatchString(projectID) {
			bag.add("/projectId", "must be a slug: letters, digits, dot, dash or underscore, no spaces")
		}
	}

	titleValue, _ := root.Get("title")
	if title, ok := titleValue.(string); !ok || strings.TrimSpace(title) == "" {
		bag.add("/title", "is required and must be a non-empty string")
	} else if TextLength(title) > LimitTitle {
		bag.add("/title", fmt.Sprintf("must be at most %d code points", LimitTitle))
	}

	createdAtValue, _ := root.Get("createdAt")
	if createdAt, ok := createdAtValue.(string); !ok {
		bag.add("/createdAt", "is required and must be an ISO 8601 timestamp")
	} else if !isParsableTimestamp(createdAt) {
		bag.add("/createdAt", `must be an ISO 8601 timestamp, e.g. "2026-07-23T09:41:00Z"`)
	}

	if sourceValue, ok := root.Get("source"); ok {
		if source, isObj := asObj(sourceValue); !isObj {
			bag.add("/source", "must be an object")
		} else {
			checkExtraKeys(bag, source, sourceKeys, "/source")
			for _, key := range sourceTextKeys {
				if entry, present := source.Get(key); present {
					if _, isString := entry.(string); !isString {
						bag.add("/source/"+key, "must be a string")
					}
				}
			}
			if recipeVersionValue, present := source.Get("recipeVersion"); present {
				recipeVersion, isString := recipeVersionValue.(string)
				if !isString || !recipeVersionPattern.MatchString(recipeVersion) {
					bag.add("/source/recipeVersion", `must be a semver string such as "1.0.0"`)
				}
			}
		}
	}

	sectionsValue, _ := root.Get("sections")
	checkSections(bag, sectionsValue)

	if qualityValue, ok := root.Get("quality"); ok {
		if quality, isObj := asObj(qualityValue); !isObj {
			bag.add("/quality", "must be an object")
		} else {
			checkExtraKeys(bag, quality, qualityKeys, "/quality")
			for _, key := range qualityKeys {
				if entry, present := quality.Get(key); present {
					checkStringList(bag, entry, "/quality/"+key)
				}
			}
		}
	}

	if safetyValue, ok := root.Get("safety"); ok {
		if safety, isObj := asObj(safetyValue); !isObj {
			bag.add("/safety", "must be an object")
		} else {
			checkExtraKeys(bag, safety, safetyKeys, "/safety")
			for _, key := range safetyKeys {
				if entry, present := safety.Get(key); present {
					checkStringList(bag, entry, "/safety/"+key)
				}
			}
		}
	}

	// The extension point. Shape is checked; meaning is not. An entry whose
	// kind this implementation has never heard of is valid on purpose.
	if observationsValue, ok := root.Get("observations"); ok {
		observations, isArray := observationsValue.([]any)
		if !isArray {
			bag.add("/observations", "must be an array of observations")
		} else {
			if len(observations) > LimitObservations {
				bag.add("/observations", fmt.Sprintf("must hold at most %d entries", LimitObservations))
			}
			for i, observationValue := range observations {
				path := fmt.Sprintf("/observations/%d", i)
				observation, isObj := asObj(observationValue)
				if !isObj {
					bag.add(path, "must be an object with 'kind' and 'data'")
					continue
				}
				checkExtraKeys(bag, observation, observationKeys, path)

				kindValue, _ := observation.Get("kind")
				if kind, ok := kindValue.(string); !ok || strings.TrimSpace(kind) == "" {
					bag.add(path+"/kind", "is required and must be a non-empty string")
				} else if TextLength(kind) > LimitObservationKind {
					bag.add(path+"/kind", fmt.Sprintf("must be at most %d code points", LimitObservationKind))
				}

				dataValue, _ := observation.Get("data")
				if _, isObj := asObj(dataValue); !isObj {
					bag.add(path+"/data", "is required and must be an object")
				}

				for _, key := range []string{"producedBy", "producedAt"} {
					if value, present := observation.Get(key); present {
						if _, isString := value.(string); !isString {
							bag.add(path+"/"+key, "must be a string")
						}
					}
				}
				if producedAtValue, present := observation.Get("producedAt"); present {
					if producedAt, isString := producedAtValue.(string); isString && !isParsableTimestamp(producedAt) {
						bag.add(path+"/producedAt", "must be an ISO 8601 timestamp")
					}
				}
			}
		}
	}

	if codeValue, ok := root.Get("code"); ok {
		if code, isString := codeValue.(string); !isString || !codePattern.MatchString(code) {
			bag.add("/code", `must look like "#004": a hash and at least 3 digits`)
		}
	}

	// Fail closed on credentials. This runs whatever the structural result
	// was: a malformed document carrying a key is still a key.
	for _, finding := range FindSecretMaterial(input) {
		bag.addKind(finding.Path, DescribeSecretFinding(finding), IssueSafety)
	}

	return ValidationResult{Valid: len(bag.issues) == 0, Issues: bag.issues}
}

// ValidationError is returned by AssertHandover. Carries every issue, not
// just the first.
type ValidationError struct {
	Issues []ValidationIssue
}

func (e *ValidationError) Error() string {
	parts := make([]string, len(e.Issues))
	for i, issue := range e.Issues {
		path := issue.Path
		if path == "" {
			path = "/"
		}
		parts[i] = path + " " + issue.Message
	}
	return "not a valid Soil handover: " + strings.Join(parts, "; ")
}

// AssertHandover validates and returns a *ValidationError when the document
// is invalid, nil when it is valid.
func AssertHandover(input any) error {
	result := Validate(input)
	if !result.Valid {
		return &ValidationError{Issues: result.Issues}
	}
	return nil
}
