package handover

import (
	"fmt"
	"sort"
	"strings"
	"testing"
)

func TestValidateAcceptsAllMissing(t *testing.T) {
	if result := Validate(testHandover(t)); !result.Valid {
		t.Fatalf("expected valid, got %v", result.Issues)
	}
}

func TestValidateAcceptsOffsetTimestamp(t *testing.T) {
	doc := testHandover(t)
	doc.Set("createdAt", "2026-07-20T08:00:00+02:00")
	if result := Validate(doc); !result.Valid {
		t.Fatalf("expected valid, got %v", result.Issues)
	}
}

func TestValidateReportsEveryProblemAtOnce(t *testing.T) {
	doc := NewObj()
	doc.Set("soilHandover", "1.0")
	doc.Set("handoverId", aValidID)
	doc.Set("title", "")
	doc.Set("createdAt", "yesterday")
	doc.Set("sections", testSections(t))
	result := Validate(doc)
	if result.Valid {
		t.Fatal("expected invalid")
	}
	paths := issuePaths(result)
	sort.Strings(paths)
	want := []string{"/createdAt", "/projectId", "/title"}
	if len(paths) != len(want) {
		t.Fatalf("expected %v, got %v", want, paths)
	}
	for i := range want {
		if paths[i] != want[i] {
			t.Fatalf("expected %v, got %v", want, paths)
		}
	}
}

func TestValidateRejectsDroppedSection(t *testing.T) {
	doc := testHandover(t)
	sections, _ := doc.Get("sections")
	sections.(*Obj).Delete("decisions")
	result := Validate(doc)
	if result.Valid || result.Issues[0].Path != "/sections/decisions" {
		t.Fatalf("expected an issue at /sections/decisions, got %v", result.Issues)
	}
}

func TestValidateRejectsInventedSection(t *testing.T) {
	doc := testHandover(t)
	sections, _ := doc.Get("sections")
	sections.(*Obj).Set("vibes", parseObj(t, `{"status":"missing","summary":null}`))
	result := Validate(doc)
	if !containsString(issuePaths(result), "/sections/vibes") {
		t.Fatalf("expected an issue at /sections/vibes, got %v", result.Issues)
	}
}

func TestValidateRejectsAvailableWithoutContent(t *testing.T) {
	doc := testHandover(t)
	sections, _ := doc.Get("sections")
	sections.(*Obj).Set("decisions", parseObj(t, `{"status":"available","summary":"  "}`))
	result := Validate(doc)
	if result.Valid || result.Issues[0].Path != "/sections/decisions/summary" {
		t.Fatalf("expected an issue at /sections/decisions/summary, got %v", result.Issues)
	}
}

func TestValidateRejectsStatusOutsideVocabulary(t *testing.T) {
	doc := testHandover(t)
	sections, _ := doc.Get("sections")
	sections.(*Obj).Set("decisions", parseObj(t, `{"status":"partial","summary":"half"}`))
	result := Validate(doc)
	if result.Valid || result.Issues[0].Path != "/sections/decisions/status" {
		t.Fatalf("expected an issue at /sections/decisions/status, got %v", result.Issues)
	}
}

func TestValidateAcceptsNotApplicableWithAReason(t *testing.T) {
	doc := testHandover(t)
	sections, _ := doc.Get("sections")
	sections.(*Obj).Set("architecture", parseObj(t,
		`{"status":"not_applicable","summary":"A one-author manuscript has no system to describe."}`))
	if result := Validate(doc); !result.Valid {
		t.Fatalf("expected a valid document, got %v", result.Issues)
	}
}

func TestValidateRejectsNotApplicableWithoutAReason(t *testing.T) {
	for _, summary := range []string{"null", `""`, `"   "`} {
		doc := testHandover(t)
		sections, _ := doc.Get("sections")
		sections.(*Obj).Set("architecture", parseObj(t,
			`{"status":"not_applicable","summary":`+summary+`}`))
		result := Validate(doc)
		if result.Valid || result.Issues[0].Path != "/sections/architecture/summary" {
			t.Fatalf("expected an issue at /sections/architecture/summary for %s, got %v", summary, result.Issues)
		}
	}
}

func TestValidateRefusesANearNeighbourOfTheFourthStatus(t *testing.T) {
	for _, status := range []string{"notApplicable", "not applicable", "NOT_APPLICABLE"} {
		doc := testHandover(t)
		sections, _ := doc.Get("sections")
		sections.(*Obj).Set("architecture", parseObj(t,
			`{"status":"`+status+`","summary":"There is no system here."}`))
		result := Validate(doc)
		if result.Valid || result.Issues[0].Path != "/sections/architecture/status" {
			t.Fatalf("expected an issue at /sections/architecture/status for %s, got %v", status, result.Issues)
		}
	}
}

func TestValidateRejectsUnknownProvenanceLabel(t *testing.T) {
	doc := testHandover(t)
	sections, _ := doc.Get("sections")
	sections.(*Obj).Set("decisions", parseObj(t,
		`{"status":"available","summary":"one","provenance":["model_reported","vibes_based"]}`))
	result := Validate(doc)
	if result.Valid || result.Issues[0].Path != "/sections/decisions/provenance/1" {
		t.Fatalf("expected an issue at /sections/decisions/provenance/1, got %v", result.Issues)
	}
}

func TestValidateRejectsDuplicateProvenanceLabel(t *testing.T) {
	doc := testHandover(t)
	sections, _ := doc.Get("sections")
	sections.(*Obj).Set("decisions", parseObj(t,
		`{"status":"available","summary":"one","provenance":["inferred","inferred"]}`))
	result := Validate(doc)
	if result.Valid || !strings.Contains(result.Issues[0].Message, "duplicate") {
		t.Fatalf("expected a duplicate-label issue, got %v", result.Issues)
	}
}

func TestValidateRejectsUnknownTopLevelField(t *testing.T) {
	doc := testHandover(t)
	doc.Set("grade", "A")
	result := Validate(doc)
	if !containsString(issuePaths(result), "/grade") {
		t.Fatalf("expected an issue at /grade, got %v", result.Issues)
	}
}

// Support is a set, not a pattern. A reader that accepts 1.4 because the
// string starts with "1." is claiming to implement a version nobody has
// written, and version one is a closed world: whatever that minor allowed
// would arrive here unrecognised.
func TestValidateSupportsExactVersions(t *testing.T) {
	doc := testHandover(t)
	doc.Set("soilHandover", "1.0")
	if !Validate(doc).Valid {
		t.Fatal("a document at exactly the supported version must validate")
	}
	for _, unsupported := range []string{"0.9", "1.1", "1.4", "1.10", "2.0", "1", "1.0.0", ""} {
		doc.Set("soilHandover", unsupported)
		result := Validate(doc)
		if result.Valid || !containsString(issuePaths(result), "/soilHandover") {
			t.Fatalf("%q must be refused at /soilHandover", unsupported)
		}
	}
}

func TestValidateRequiresHandoverID(t *testing.T) {
	doc := testHandover(t)
	doc.Delete("handoverId")
	result := Validate(doc)
	if result.Valid || result.Issues[0].Path != "/handoverId" || result.Issues[0].Kind != IssueStructure {
		t.Fatalf("expected a structure issue at /handoverId, got %v", result.Issues)
	}
}

func TestValidateRejectsMalformedHandoverID(t *testing.T) {
	doc := testHandover(t)
	doc.Set("handoverId", "handover-42")
	result := Validate(doc)
	if result.Valid || result.Issues[0].Path != "/handoverId" {
		t.Fatalf("expected an issue at /handoverId, got %v", result.Issues)
	}
}

func TestValidateRejectsProjectIDWithSpaces(t *testing.T) {
	doc := testHandover(t)
	doc.Set("projectId", "two words")
	result := Validate(doc)
	if result.Valid || result.Issues[0].Path != "/projectId" {
		t.Fatalf("expected an issue at /projectId, got %v", result.Issues)
	}
}

func TestValidateCode(t *testing.T) {
	doc := testHandover(t)
	doc.Set("code", "#004")
	if !Validate(doc).Valid {
		t.Fatal("a store-assigned code must be accepted")
	}
	doc.Set("code", "4")
	if Validate(doc).Valid {
		t.Fatal("a malformed code must be rejected")
	}
}

func TestValidateAcceptsGapsAndOmissions(t *testing.T) {
	doc := testHandover(t)
	doc.Set("quality", parseObj(t, `{"missingInputs":["the deploy logs"],"contradictions":[]}`))
	doc.Set("safety", parseObj(t, `{"unsafeOmissions":["an API key exists in the platform config"]}`))
	if result := Validate(doc); !result.Valid {
		t.Fatalf("expected valid, got %v", result.Issues)
	}
}

func TestValidateRejectsNoteThatIsNotText(t *testing.T) {
	doc := testHandover(t)
	doc.Set("quality", parseObj(t, `{"missingInputs":[7]}`))
	result := Validate(doc)
	if result.Valid || result.Issues[0].Path != "/quality/missingInputs/0" {
		t.Fatalf("expected an issue at /quality/missingInputs/0, got %v", result.Issues)
	}
}

func TestValidateRejectsNonObjects(t *testing.T) {
	if Validate("a handover, honest").Valid {
		t.Fatal("a string is not a handover")
	}
	if Validate(nil).Valid {
		t.Fatal("null is not a handover")
	}
}

func TestAssertHandover(t *testing.T) {
	if err := AssertHandover(testHandover(t)); err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
	err := AssertHandover(parseObj(t, `{"soilHandover":"1.0"}`))
	validationErr, ok := err.(*ValidationError)
	if !ok {
		t.Fatalf("expected a *ValidationError, got %T", err)
	}
	if len(validationErr.Issues) <= 1 {
		t.Fatalf("expected every issue attached, got %v", validationErr.Issues)
	}
	if !strings.Contains(validationErr.Error(), "not a valid Soil handover") {
		t.Fatalf("unexpected message: %s", validationErr.Error())
	}
}

func TestValidateFixtures(t *testing.T) {
	manifest := parseObj(t, readRepoFile(t, "conformance/fixtures/manifest.json"))
	validValue, _ := manifest.Get("valid")
	for _, entryValue := range validValue.([]any) {
		entry := entryValue.(*Obj)
		file := stringAt(entry, "file")
		doc := parse(t, readRepoFile(t, "conformance/fixtures/"+file))
		if result := Validate(doc); !result.Valid {
			t.Errorf("%s should be valid, got %v", file, result.Issues)
		}
	}
	invalidValue, _ := manifest.Get("invalid")
	for _, entryValue := range invalidValue.([]any) {
		entry := entryValue.(*Obj)
		file := stringAt(entry, "file")
		locationValue, _ := entry.Get("location")
		wanted := manifestSegments(locationValue)
		doc := parse(t, readRepoFile(t, "conformance/fixtures/"+file))
		result := Validate(doc)
		if result.Valid {
			t.Errorf("%s should be rejected", file)
			continue
		}
		if !reportsLocation(result, wanted) {
			t.Errorf("%s should report a problem at %v, reported %v", file, wanted, issuePaths(result))
		}
	}
}

// The manifest states an offending place as an abstract semantic location: an
// ordered sequence of member names and array indices, with the empty sequence
// meaning the document itself. It deliberately no longer states JSON Pointer
// text, so this test parses its own pointers into segments before comparing,
// exactly as conformance/go/main.go does.
func manifestSegments(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, fmt.Sprintf("%v", item))
	}
	return out
}

func pointerSegments(pointer string) []string {
	if pointer == "" || pointer == "/" {
		return []string{}
	}
	raw := strings.Split(strings.TrimPrefix(pointer, "/"), "/")
	out := make([]string, 0, len(raw))
	for _, token := range raw {
		token = strings.ReplaceAll(token, "~1", "/")
		token = strings.ReplaceAll(token, "~0", "~")
		out = append(out, token)
	}
	return out
}

func reportsLocation(result ValidationResult, wanted []string) bool {
	for _, path := range issuePaths(result) {
		got := pointerSegments(path)
		if len(got) != len(wanted) {
			continue
		}
		same := true
		for i := range got {
			if got[i] != wanted[i] {
				same = false
				break
			}
		}
		if same {
			return true
		}
	}
	return false
}
