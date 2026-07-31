package handover

import (
	"testing"
)

// norm normalizes and asserts the object shape, which is what every test in
// this package feeds it. Normalize itself returns any, because a root that is
// not an object is carried through as it arrived rather than replaced with a
// document built around it.
func norm(input any) *Obj {
	obj, _ := asObj(Normalize(input))
	return obj
}

func sectionOf(t *testing.T, doc *Obj, key string) *Obj {
	t.Helper()
	sectionsValue, _ := doc.Get("sections")
	sectionValue, _ := sectionsValue.(*Obj).Get(key)
	return sectionValue.(*Obj)
}

func TestNormalizeDeclaresAll17Sections(t *testing.T) {
	doc := norm(NewObj())
	sectionsValue, _ := doc.Get("sections")
	keys := sectionsValue.(*Obj).Keys()
	if len(keys) != 17 {
		t.Fatalf("expected 17 sections, got %d", len(keys))
	}
	for i, key := range SectionKeys {
		if keys[i] != key {
			t.Fatalf("expected canonical order, got %v", keys)
		}
	}
	decisions := sectionOf(t, doc, "decisions")
	if stringAt(decisions, "status") != "missing" {
		t.Fatal("an unwritten section must be missing")
	}
	if summary, _ := decisions.Get("summary"); summary != nil {
		t.Fatal("a missing section carries a null summary")
	}
}

func TestNormalizeAcceptsExtractionSections(t *testing.T) {
	doc := norm(parseObj(t,
		`{"projectId":"loose","title":"Loose","extractionSections":{"decisions":"We picked Postgres."}}`))
	decisions := sectionOf(t, doc, "decisions")
	if stringAt(decisions, "status") != "available" || stringAt(decisions, "summary") != "We picked Postgres." {
		t.Fatalf("unexpected section: %s", MarshalJSONCompact(decisions))
	}
}

func TestNormalizeBareString(t *testing.T) {
	doc := norm(parseObj(t, `{"sections":{"workflow":"  Review before merge.  "}}`))
	workflow := sectionOf(t, doc, "workflow")
	if stringAt(workflow, "status") != "available" || stringAt(workflow, "summary") != "Review before merge." {
		t.Fatalf("unexpected section: %s", MarshalJSONCompact(workflow))
	}
}

func TestNormalizeEmptyStringIsAGap(t *testing.T) {
	doc := norm(parseObj(t, `{"sections":{"workflow":"   "}}`))
	if stringAt(sectionOf(t, doc, "workflow"), "status") != "missing" {
		t.Fatal("an empty string is a gap, not content")
	}
}

func TestNormalizeInfersAvailableFromSummary(t *testing.T) {
	doc := norm(parseObj(t, `{"sections":{"blockers":{"summary":"The sandbox is down."}}}`))
	if stringAt(sectionOf(t, doc, "blockers"), "status") != "available" {
		t.Fatal("a summary with no status infers available")
	}
}

func TestNormalizeKeepsBlocked(t *testing.T) {
	doc := norm(parseObj(t,
		`{"sections":{"architecture":{"status":"blocked","summary":"Host names withheld."}}}`))
	architecture := sectionOf(t, doc, "architecture")
	if stringAt(architecture, "status") != "blocked" || stringAt(architecture, "summary") != "Host names withheld." {
		t.Fatalf("unexpected section: %s", MarshalJSONCompact(architecture))
	}
}

func TestNormalizeDoesNotInventProjectID(t *testing.T) {
	doc := norm(parseObj(t, `{"title":"No slug"}`))
	if stringAt(doc, "projectId") != "" {
		t.Fatal("normalization must not invent a project id")
	}
	if Validate(doc).Valid {
		t.Fatal("validation must report the missing project id")
	}
}

func TestNormalizeLeavesACompleteReplyOneIDFromValid(t *testing.T) {
	doc := norm(parseObj(t, `{
	  "projectId": "rescue-test",
	  "title": "Rescued from a full thread",
	  "createdAt": "2026-07-22T10:00:00Z",
	  "extractionSections": {
	    "projectIdentity": "A test project.",
	    "decisions": {"status": "available", "summary": "One decision."},
	    "blockers": {"status": "missing", "summary": null}
	  }
	}`))
	result := Validate(doc)
	if result.Valid || len(result.Issues) != 1 || result.Issues[0].Path != "/handoverId" {
		t.Fatalf("expected only /handoverId, got %v", result.Issues)
	}
	identified := doc.Clone()
	identified.Set("handoverId", aValidID)
	if !Validate(identified).Valid {
		t.Fatal("expected valid once identified")
	}
}

func TestNormalizeKeepsExistingIDAndNeverMints(t *testing.T) {
	kept := norm(parseObj(t,
		`{"handoverId":"`+aValidID+`","projectId":"identified","title":"Identified"}`))
	if stringAt(kept, "handoverId") != aValidID {
		t.Fatal("an existing id must be kept")
	}
	fresh := norm(parseObj(t, `{"projectId":"unidentified","title":"Unidentified"}`))
	if fresh.Has("handoverId") {
		t.Fatal("normalization is not a writer and must not mint an id")
	}
}

func TestExtractJSONBlockFenced(t *testing.T) {
	text := "Sure!\n\n```json\n{\"a\":1}\n```\n\nAnything else?"
	block, ok := ExtractJSONBlock(text)
	if !ok || block != `{"a":1}` {
		t.Fatalf("unexpected block: %q", block)
	}
}

func TestExtractJSONBlockNoLanguageTag(t *testing.T) {
	block, ok := ExtractJSONBlock("```\n{\"a\":1}\n```")
	if !ok || block != `{"a":1}` {
		t.Fatalf("unexpected block: %q", block)
	}
}

func TestExtractJSONBlockOutermostBraces(t *testing.T) {
	block, ok := ExtractJSONBlock(`here you go: {"a":{"b":2}} done`)
	if !ok || block != `{"a":{"b":2}}` {
		t.Fatalf("unexpected block: %q", block)
	}
}

func TestExtractJSONBlockNothing(t *testing.T) {
	if _, ok := ExtractJSONBlock("I could not do that"); ok {
		t.Fatal("expected no JSON")
	}
}

// Wrong capitalisation is the common case. Rewriting it to "available" would
// let a typo become content that counts as captured, and the author would
// never be told.
func TestNormalizeKeepsAnUnrecognisedStatusSoValidateRefusesIt(t *testing.T) {
	for _, wrong := range []string{"Available", "AVAILABLE", "partial", "done"} {
		input := parseObj(t, `{"handoverId":"`+aValidID+`","projectId":"status-test","title":"Status",`+
			`"sections":{"decisions":{"status":"`+wrong+`","summary":"One decision."}}}`)
		doc := norm(input)
		if stringAt(sectionOf(t, doc, "decisions"), "status") != wrong {
			t.Fatalf("normalization must keep %q, got %q",
				wrong, stringAt(sectionOf(t, doc, "decisions"), "status"))
		}
		result := Validate(doc)
		refused := false
		for _, issue := range result.Issues {
			if issue.Path == "/sections/decisions/status" && issue.Kind == IssueStructure {
				refused = true
			}
		}
		if result.Valid || !refused {
			t.Fatalf("an unrecognised status %q must be refused at /sections/decisions/status", wrong)
		}
	}
}

// The closed-world contract, on the normalization path.
//
// Version one has no room for an unknown field, and normalization is not
// allowed to make room by deleting one. Each of these used to be dropped
// silently, which meant `soil validate` rejected a document and `soil save`
// stored it, from the same bytes.
func closedWorldBase(t *testing.T, extra string) *Obj {
	t.Helper()
	body := `{"soilHandover":"1.0","handoverId":"` + aValidID + `",` +
		`"projectId":"closed-world","title":"Closed world",` +
		`"createdAt":"2026-07-22T10:00:00Z"` + extra + `}`
	return parseObj(t, body)
}

func hasIssueAt(result ValidationResult, path string) bool {
	for _, issue := range result.Issues {
		if issue.Path == path {
			return true
		}
	}
	return false
}

func TestNormalizeCarriesUnknownContentToValidation(t *testing.T) {
	cases := []struct {
		what  string
		extra string
		path  string
	}{
		{"an unknown top-level field", `,"grade":0.92`, "/grade"},
		{
			"an unknown field on a section",
			`,"sections":{"decisions":{"status":"available","summary":"One.","confidence":0.4}}`,
			"/sections/decisions/confidence",
		},
		{
			"an unknown section key",
			`,"sections":{"vibes":{"status":"available","summary":"Good."}}`,
			"/sections/vibes",
		},
		{
			"a provenance label outside the eleven",
			`,"sections":{"decisions":{"status":"available","summary":"one",` +
				`"provenance":["repo_verified","vibe_checked"]}}`,
			"/sections/decisions/provenance/1",
		},
		{
			"an unknown member of source",
			`,"source":{"client":"a-tool","temperature":0.7}`,
			"/source/temperature",
		},
		{
			"a section value it cannot reshape",
			`,"sections":{"decisions":42}`,
			"/sections/decisions",
		},
	}
	for _, c := range cases {
		input := closedWorldBase(t, c.extra)
		if !hasIssueAt(Validate(input), c.path) {
			t.Fatalf("%s must be refused at %s", c.what, c.path)
		}
		if !hasIssueAt(Validate(norm(input)), c.path) {
			t.Fatalf("%s must survive normalization and still be refused at %s", c.what, c.path)
		}
	}
}

func TestNormalizeDoesNotMoveADeclaredVersion(t *testing.T) {
	for _, declared := range []string{"1.7", "2.0", "0.9"} {
		doc := norm(parseObj(t, `{"soilHandover":"`+declared+`","projectId":"v","title":"V"}`))
		if stringAt(doc, "soilHandover") != declared {
			t.Fatalf("expected %q kept, got %q", declared, stringAt(doc, "soilHandover"))
		}
	}
}

// The anchor every frontier section is read against. A wall clock read at save
// time is indistinguishable, to a consumer, from a time the session actually
// reported.
func TestNormalizeDoesNotStampCreatedAt(t *testing.T) {
	doc := norm(parseObj(t, `{"projectId":"no-time","title":"No time"}`))
	if doc.Has("createdAt") {
		t.Fatal("normalization must not supply a createdAt the document does not carry")
	}
	identified := doc.Clone()
	identified.Set("handoverId", aValidID)
	if !hasIssueAt(Validate(identified), "/createdAt") {
		t.Fatal("a document with no createdAt must be refused, not completed")
	}
}

func TestNormalizeDoesNotStampRecipeVersion(t *testing.T) {
	doc := norm(parseObj(t, `{"projectId":"recipe","title":"Recipe"}`))
	if doc.Has("source") {
		t.Fatal("normalization must not attribute its own recipe to another writer's document")
	}
	kept := norm(parseObj(t,
		`{"projectId":"recipe","title":"Kept","source":{"recipeVersion":"0.9.9"}}`))
	sourceValue, _ := kept.Get("source")
	if stringAt(sourceValue.(*Obj), "recipeVersion") != "0.9.9" {
		t.Fatal("a stated recipeVersion must be kept untouched")
	}
}

// Dropping it is what makes the replacement possible: the writer then sees a
// document with no id and mints one, and nobody is ever told the id the
// document arrived with was wrong.
func TestNormalizeKeepsAMalformedHandoverID(t *testing.T) {
	for _, malformed := range []string{`42`, `"handover-42"`, `""`, `null`} {
		doc := norm(parseObj(t, `{"soilHandover":"1.0","handoverId":`+malformed+
			`,"projectId":"identity","title":"Identity","createdAt":"2026-07-22T10:00:00Z"}`))
		if !doc.Has("handoverId") {
			t.Fatalf("a malformed id (%s) must reach validation, never be dropped", malformed)
		}
		if !hasIssueAt(Validate(doc), "/handoverId") {
			t.Fatalf("a malformed id (%s) must be refused at /handoverId", malformed)
		}
	}
}

func TestNormalizeKeepsAQualityEntryItCannotUse(t *testing.T) {
	doc := norm(parseObj(t, `{
	  "projectId": "notes", "title": "Notes", "createdAt": "2026-07-22T10:00:00Z",
	  "quality": {"missingInputs": ["the logs", "  ", 7]},
	  "safety": {"unsafeOmissions": ["  a key exists in the platform config  "]}
	}`))
	qualityValue, _ := doc.Get("quality")
	missingValue, _ := qualityValue.(*Obj).Get("missingInputs")
	if len(missingValue.([]any)) != 3 {
		t.Fatalf("an entry that cannot be used must be kept, got %v", missingValue)
	}
	safetyValue, _ := doc.Get("safety")
	omissionsValue, _ := safetyValue.(*Obj).Get("unsafeOmissions")
	if omissionsValue.([]any)[0] != "a key exists in the platform config" {
		t.Fatalf("a usable list must be trimmed, got %v", omissionsValue)
	}
	identified := doc.Clone()
	identified.Set("handoverId", aValidID)
	result := Validate(identified)
	if !hasIssueAt(result, "/quality/missingInputs/1") || !hasIssueAt(result, "/quality/missingInputs/2") {
		t.Fatalf("expected the unusable entries reported, got %v", result.Issues)
	}
}
