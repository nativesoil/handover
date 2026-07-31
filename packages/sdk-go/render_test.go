package handover

import (
	"regexp"
	"strings"
	"testing"
)

func renderTestDoc(t *testing.T) *Obj {
	t.Helper()
	return norm(parseObj(t, `{
	  "handoverId": "`+aValidID+`",
	  "projectId": "render-test",
	  "title": "A short title",
	  "createdAt": "2026-07-22T10:00:00Z",
	  "source": {"client": "claude-code", "model": "opus-4.8"},
	  "sections": {
	    "executiveSummary": "What this is.",
	    "decisions": "What was decided.",
	    "architecture": {"status": "blocked", "summary": "Host names withheld."}
	  },
	  "quality": {"missingInputs": ["the deploy logs were not available"]},
	  "safety": {"unsafeOmissions": ["an API key exists in the platform config"]}
	}`))
}

func TestWrapBreaksOnWords(t *testing.T) {
	got := Wrap("one two three four", 9)
	want := []string{"one two", "three", "four"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestWrapKeepsLongWordsWhole(t *testing.T) {
	got := Wrap("supercalifragilistic", 5)
	if len(got) != 1 || got[0] != "supercalifragilistic" {
		t.Fatalf("got %v", got)
	}
}

func TestRenderSavedLeadsWithTheCode(t *testing.T) {
	card := RenderSaved(renderTestDoc(t), "#004")
	if !strings.Contains(strings.Split(card, "\n")[0], "#004") {
		t.Fatalf("the first line must carry the code:\n%s", card)
	}
}

func TestRenderSavedReportsCountsNeverAScore(t *testing.T) {
	card := RenderSaved(renderTestDoc(t), "#004")
	if !strings.Contains(card, "2 / 17 sections carrying content") {
		t.Fatalf("expected the count line:\n%s", card)
	}
	if regexp.MustCompile(`\d+\s*%`).MatchString(card) {
		t.Fatal("a percentage reads as a grade")
	}
	if regexp.MustCompile(`(?i)score|grade|readiness`).MatchString(card) {
		t.Fatal("nothing local grades a handover")
	}
}

func TestRenderSavedNamesWhatDidNotSurvive(t *testing.T) {
	card := RenderSaved(renderTestDoc(t), "#004")
	if !strings.Contains(card, "no content") || !strings.Contains(card, "held back   architecture") {
		t.Fatalf("expected missing and blocked names:\n%s", card)
	}
}

func TestRenderSavedShowsGapsAndOmissions(t *testing.T) {
	card := RenderSaved(renderTestDoc(t), "#004")
	for _, wanted := range []string{"stated gaps", "the deploy logs were not available", "held back · by design"} {
		if !strings.Contains(card, wanted) {
			t.Fatalf("expected %q:\n%s", wanted, card)
		}
	}
}

func TestRenderSavedEndsWithTheLoadCommand(t *testing.T) {
	card := RenderSaved(renderTestDoc(t), "#004")
	if !strings.HasSuffix(strings.TrimRight(card, " \n"), "❯ soil load #004") {
		t.Fatalf("expected the load command at the end:\n%s", card)
	}
}

func TestRenderSavedIsDeterministic(t *testing.T) {
	doc := renderTestDoc(t)
	if RenderSaved(doc, "#004") != RenderSaved(doc, "#004") {
		t.Fatal("identical input must produce identical bytes")
	}
}

func TestRenderSavedKeepsLinesInsideTheCard(t *testing.T) {
	for _, line := range strings.Split(RenderSaved(renderTestDoc(t), "#004"), "\n") {
		if u16len(line) > 70 {
			t.Fatalf("line too long: %q", line)
		}
	}
}

func TestRenderSavedMatchesTheReferenceBytes(t *testing.T) {
	if RenderSaved(renderTestDoc(t), "#004") != readTestdata(t, "saved-normalized.golden") {
		t.Fatal("the saved card must be byte-identical to the TypeScript SDK's card")
	}
}

func TestRenderSavedOrchardMatchesTheReferenceBytes(t *testing.T) {
	if RenderSaved(orchardExample(t), "#001") != readTestdata(t, "saved-orchard.golden") {
		t.Fatal("the saved card for the worked example must be byte-identical to the TypeScript SDK's card")
	}
}

func TestRenderLoaded(t *testing.T) {
	doc := renderTestDoc(t).Clone()
	doc.Set("code", "#004")
	card := RenderLoaded(doc)
	for _, wanted := range []string{"what this document carries", "no content", "moment of capture"} {
		if !strings.Contains(card, wanted) {
			t.Fatalf("expected %q:\n%s", wanted, card)
		}
	}
}

func TestRenderLoadedOrchardMatchesTheReferenceBytes(t *testing.T) {
	doc := orchardExample(t).Clone()
	doc.Set("code", "#001")
	if RenderLoaded(doc) != readTestdata(t, "loaded-orchard.golden") {
		t.Fatal("the loaded card must be byte-identical to the TypeScript SDK's card")
	}
}

func TestRenderListEmpty(t *testing.T) {
	if !strings.Contains(RenderList(nil), "nothing saved yet") {
		t.Fatal("an empty store says so")
	}
}

func TestRenderListRow(t *testing.T) {
	card := RenderList([]StoreEntry{{
		Code:                "#002",
		ProjectID:           "render-test",
		Title:               "A very long title that will not fit in the column at all",
		CreatedAt:           "2026-07-22T10:00:00Z",
		SectionsWithContent: 9,
		File:                "002.json",
	}})
	for _, wanted := range []string{"#002", "…", "9/17"} {
		if !strings.Contains(card, wanted) {
			t.Fatalf("expected %q:\n%s", wanted, card)
		}
	}
}

func TestRenderValidationValid(t *testing.T) {
	card := RenderValidation(Validate(renderTestDoc(t)), "the document")
	if !strings.Contains(card, "valid handover") ||
		!strings.Contains(card, "says nothing about how good the content is") {
		t.Fatalf("unexpected card:\n%s", card)
	}
}

func TestRenderValidationInvalid(t *testing.T) {
	card := RenderValidation(Validate(parseObj(t, `{"soilHandover":"1.0"}`)), "x")
	if !strings.Contains(card, "not a handover") || !strings.Contains(card, "/projectId") {
		t.Fatalf("unexpected card:\n%s", card)
	}
}
