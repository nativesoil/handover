// The numeric domain and the text unit.
//
// Both are stated normatively in spec/value-domain.md and both are pinned
// across the five implementations by the conformance corpus. What is here is
// what only this runtime can show: that a Go string is bytes, so neither len
// nor a UTF-16 count is the unit the format counts in, and that the decoder
// hands over a number as its literal text only because UseNumber is set.

package handover

import (
	"strings"
	"testing"
)

// One code point, two UTF-16 code units, four UTF-8 bytes.
const astralChar = "\U0001F600"

// Two code points, two UTF-16 code units, three UTF-8 bytes, one cluster.
const combinedChar = "é"

const aValidHandoverID = "019f7e89-fc00-7000-8000-000000000000"

// textVerdict is the code and location of a refusal, or "accepted".
func textVerdict(text string) string {
	_, issue := IngestText(text)
	if issue == nil {
		return "accepted"
	}
	return issue.Code + " " + issue.Path
}

func TestNumericDomainEnds(t *testing.T) {
	cases := map[string]string{
		`{"n":9007199254740991}`:                "accepted",
		`{"n":-9007199254740991}`:               "accepted",
		`{"a":0,"b":-0,"c":42,"d":-42}`:         "accepted",
		`{"n":9007199254740992}`:                "number.out_of_range /n",
		`{"n":-9007199254740992}`:               "number.out_of_range /n",
		`{"n":` + strings.Repeat("9", 40) + `}`: "number.out_of_range /n",
		`{"n":100.0}`:                           "number.not_an_integer /n",
		`{"n":1e2}`:                             "number.not_an_integer /n",
		`{"n":-0.0}`:                            "number.not_an_integer /n",
		`{"confidence":0.92}`:                   "number.not_an_integer /confidence",
	}
	for text, want := range cases {
		if got := textVerdict(text); got != want {
			t.Errorf("%s: got %q, want %q", text, got, want)
		}
	}
}

func TestNumericDomainLocation(t *testing.T) {
	if got := textVerdict(`{"a":[1,2,1e2]}`); got != "number.not_an_integer /a/2" {
		t.Errorf("array element: got %q", got)
	}
	if got := textVerdict(`{"a":{"b":{"c":0.5}}}`); got != "number.not_an_integer /a/b/c" {
		t.Errorf("nested object: got %q", got)
	}
	if got := textVerdict(`0.5`); got != "number.not_an_integer " {
		t.Errorf("bare root number: got %q", got)
	}
}

func TestNumericDomainLeavesOtherTokensAlone(t *testing.T) {
	if got := textVerdict(`{"a":true,"b":false,"c":null}`); got != "accepted" {
		t.Errorf("the three JSON literals must not be read as numbers: %q", got)
	}
	if got := textVerdict(`{"a":"9007199254740992"}`); got != "accepted" {
		t.Errorf("digits inside a string are not a number: %q", got)
	}
}

func TestNumericDomainIsRankedLast(t *testing.T) {
	// Both rules broken at once: the structural refusal is the one reported,
	// so a document is judged the same way whichever surface reads it.
	if got := textVerdict(`{"a":1e2,"a":1e2}`); got != "structure.duplicate_member /a" {
		t.Errorf("duplicates must outrank the numeric domain: %q", got)
	}
	if got := textVerdict(`{"a":1e2,}`); got != "syntax.invalid_json " {
		t.Errorf("syntax must outrank the numeric domain: %q", got)
	}
}

func TestTextLengthIsNotTheByteCount(t *testing.T) {
	title := strings.Repeat(astralChar, LimitTitle)
	if TextLength(title) != 200 {
		t.Errorf("code points: got %d, want 200", TextLength(title))
	}
	if len(title) != 800 {
		t.Errorf("bytes: got %d, want 800", len(title))
	}
	if u16len(title) != 400 {
		t.Errorf("UTF-16 code units: got %d, want 400", u16len(title))
	}
}

func TestTextLengthCountsCodePointsNotClusters(t *testing.T) {
	if TextLength(combinedChar) != 2 {
		t.Errorf("a base plus a combining mark is two code points, got %d",
			TextLength(combinedChar))
	}
	if TextLength("café") != 4 {
		t.Errorf("a precomposed accented character is one code point, got %d",
			TextLength("café"))
	}
}

func textUnitDoc(t *testing.T, title string) *Obj {
	t.Helper()
	input := NewObj()
	input.Set("projectId", "text-unit")
	input.Set("title", title)
	input.Set("createdAt", "2026-07-26T10:00:00Z")
	sections := NewObj()
	sections.Set("executiveSummary", "The text unit, exercised.")
	input.Set("sections", sections)
	doc, ok := Normalize(input).(*Obj)
	if !ok {
		t.Fatal("normalize should return an object")
	}
	doc.Set("handoverId", aValidHandoverID)
	return doc
}

func TestTitleAtTheLimitInAstralCharacters(t *testing.T) {
	result := Validate(textUnitDoc(t, strings.Repeat(astralChar, LimitTitle)))
	if !result.Valid {
		t.Errorf("a title of exactly %d code points must be accepted: %v",
			LimitTitle, result.Issues)
	}
}

func TestTitleOneCodePointOverNamesTheUnit(t *testing.T) {
	result := Validate(textUnitDoc(t, strings.Repeat(astralChar, LimitTitle+1)))
	if result.Valid {
		t.Fatal("a title one code point over the limit must be refused")
	}
	found := false
	for _, issue := range result.Issues {
		if issue.Path == "/title" {
			found = true
			if issue.Message != "must be at most 200 code points" {
				t.Errorf("the message must name the unit, got %q", issue.Message)
			}
		}
	}
	if !found {
		t.Error("the refusal must be reported at /title")
	}
}
