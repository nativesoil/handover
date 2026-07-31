// The open save-time baseline, held to the reference byte for byte.
//
// The corpus under testdata/check/ is shared across the ports and was
// designed to attack this one: every rule firing and none, counts on each
// grade-band edge, thresholds met and missed by one unit, content outside
// the Basic Multilingual Plane, and a decisions section whose entry order
// punishes a wrong sort. The expected files beside each document were
// produced by the built TypeScript reference through
// scripts/generate-check-parity.mjs, never by hand.

package handover

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const checkProducedBy = "soil-cli/0.1.0"
const checkProducedAt = "2026-07-22T10:00:00Z"

func checkCorpusNames(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join("testdata", "check"))
	if err != nil {
		t.Fatalf("reading the check corpus: %v", err)
	}
	names := []string{}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".card.golden") {
			names = append(names, strings.TrimSuffix(entry.Name(), ".card.golden"))
		}
	}
	return names
}

func checkCorpusDocument(t *testing.T, name string) *Obj {
	t.Helper()
	return parseObj(t, readTestdata(t, filepath.Join("check", name+".json")))
}

func TestCheckCorpusIsPresentAndWhole(t *testing.T) {
	// A deleted corpus directory must fail loudly rather than pass an
	// empty loop.
	if got := len(checkCorpusNames(t)); got != 18 {
		t.Fatalf("expected 18 corpus documents, found %d", got)
	}
}

func TestCheckCardIsByteIdenticalToTheReference(t *testing.T) {
	for _, name := range checkCorpusNames(t) {
		t.Run(name, func(t *testing.T) {
			doc := checkCorpusDocument(t, name)
			report := CheckHandover(doc)
			want := readTestdata(t, filepath.Join("check", name+".card.golden"))
			if got := RenderCheck(doc, report); got != want {
				t.Fatalf("the check card must be byte-identical to the TypeScript SDK's card:\n%s", got)
			}
		})
	}
}

func TestCheckReportJSONIsByteIdenticalToTheReference(t *testing.T) {
	for _, name := range checkCorpusNames(t) {
		t.Run(name, func(t *testing.T) {
			doc := checkCorpusDocument(t, name)
			report := CheckHandover(doc)
			want := readTestdata(t, filepath.Join("check", name+".report.json"))
			if got := MarshalJSONIndent(CheckReportValue(report)) + "\n"; got != want {
				t.Fatalf("the report JSON must be byte-identical to the TypeScript SDK's:\n%s", got)
			}
		})
	}
}

func TestCheckObservationIsByteIdenticalToTheReference(t *testing.T) {
	for _, name := range checkCorpusNames(t) {
		t.Run(name, func(t *testing.T) {
			doc := checkCorpusDocument(t, name)
			report := CheckHandover(doc)
			observation, err := CheckObservation(doc, report, CheckObservationOptions{
				ProducedBy: checkProducedBy,
				ProducedAt: checkProducedAt,
			})
			if err != nil {
				t.Fatalf("CheckObservation: %v", err)
			}
			want := readTestdata(t, filepath.Join("check", name+".observation.json"))
			if got := MarshalJSONIndent(observation) + "\n"; got != want {
				t.Fatalf("the observation must be byte-identical to the TypeScript SDK's:\n%s", got)
			}
		})
	}
}

func TestCheckIsDeterministicAndDoesNotTouchTheDocument(t *testing.T) {
	doc := orchardExample(t)
	before := MarshalJSONIndent(doc)
	first := CheckHandover(doc)
	second := CheckHandover(doc)
	if MarshalJSONIndent(CheckReportValue(first)) != MarshalJSONIndent(CheckReportValue(second)) {
		t.Fatal("identical input must produce identical reports")
	}
	if MarshalJSONIndent(doc) != before {
		t.Fatal("checking must not touch the document")
	}
}

func TestGradeMappingMatchesTheDocumentedTable(t *testing.T) {
	cases := []struct {
		counts CheckCounts
		want   string
	}{
		{CheckCounts{0, 0, 0}, "strong"},
		{CheckCounts{0, 0, 9}, "strong"},
		{CheckCounts{0, 1, 0}, "adequate"},
		{CheckCounts{0, 5, 0}, "adequate"},
		{CheckCounts{0, 6, 0}, "thin"},
		{CheckCounts{1, 0, 0}, "thin"},
		{CheckCounts{2, 9, 0}, "thin"},
		{CheckCounts{3, 0, 0}, "failing"},
	}
	for _, c := range cases {
		if got := GradeFromCounts(c.counts); got != c.want {
			t.Fatalf("%+v graded %s, want %s", c.counts, got, c.want)
		}
	}
}

func TestSplitEntriesSplitsNumberedItemsBulletsAndParagraphs(t *testing.T) {
	got := SplitEntries("Intro line:\n\n1. First.\n2. Second\ncontinued.\n- Third.")
	want := []string{"Intro line:", "1. First.", "2. Second continued.", "- Third."}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEveryFindingCarriesADocumentedRuleID(t *testing.T) {
	doc := testHandover(t)
	report := CheckHandover(doc)
	if len(report.Findings) == 0 {
		t.Fatal("an all-missing document must produce findings")
	}
	for _, finding := range report.Findings {
		if _, ok := CheckRules[finding.Rule]; !ok {
			t.Fatalf("undocumented rule id %q", finding.Rule)
		}
		if finding.Message == "" {
			t.Fatalf("empty message for %q", finding.Rule)
		}
	}
}

func TestCheckObservationCarriesTheClosedFieldSet(t *testing.T) {
	doc := orchardExample(t)
	report := CheckHandover(doc)
	observation, err := CheckObservation(doc, report, CheckObservationOptions{
		ProducedBy: checkProducedBy,
		ProducedAt: checkProducedAt,
	})
	if err != nil {
		t.Fatalf("CheckObservation: %v", err)
	}
	dataValue, _ := observation.Get("data")
	data, ok := asObj(dataValue)
	if !ok {
		t.Fatal("the observation must carry a data object")
	}
	keys := data.Keys()
	want := []string{"checkVersion", "sectionsWithContent", "missingSections", "blockedSections", "findings", "notes"}
	if strings.Join(keys, ",") != strings.Join(want, ",") {
		t.Fatalf("payload keys %v, want %v", keys, want)
	}
	// No band, no score and no aggregate, under any key.
	serialized := MarshalJSONIndent(observation)
	for _, band := range CheckGrades {
		if strings.Contains(serialized, `"`+band+`"`) {
			t.Fatalf("the payload must not carry the band %q", band)
		}
	}
	// The attached document stays valid.
	attached := doc.Clone()
	attached.Set("observations", []any{observation})
	if err := AssertHandover(attached); err != nil {
		t.Fatalf("an attached observation must keep the document valid: %v", err)
	}
}

func TestCheckNotesAreBoundedInCodePoints(t *testing.T) {
	doc := orchardExample(t)
	report := CheckHandover(doc)
	if TextLength(CheckDefaultNotes) > CheckNotesMaxChars {
		t.Fatal("the default notes must fit their own bound")
	}
	custom := "Ran offline."
	observation, err := CheckObservation(doc, report, CheckObservationOptions{
		ProducedBy: checkProducedBy,
		ProducedAt: checkProducedAt,
		Notes:      &custom,
	})
	if err != nil {
		t.Fatalf("CheckObservation: %v", err)
	}
	dataValue, _ := observation.Get("data")
	data, _ := asObj(dataValue)
	if got := stringAt(data, "notes"); got != custom {
		t.Fatalf("notes %q, want %q", got, custom)
	}

	tooLong := strings.Repeat("x", CheckNotesMaxChars+1)
	if _, err := CheckObservation(doc, report, CheckObservationOptions{
		ProducedBy: checkProducedBy,
		ProducedAt: checkProducedAt,
		Notes:      &tooLong,
	}); err == nil || !strings.Contains(err.Error(), "at most 280 code points") {
		t.Fatalf("an over-long note must be refused, got %v", err)
	}
	// The bound is code points, so a note of astral characters is refused at
	// the same count and not at half of it.
	astralFit := strings.Repeat("😀", CheckNotesMaxChars)
	if _, err := CheckObservation(doc, report, CheckObservationOptions{
		ProducedBy: checkProducedBy,
		ProducedAt: checkProducedAt,
		Notes:      &astralFit,
	}); err != nil {
		t.Fatalf("a 280-code-point astral note must be accepted: %v", err)
	}
	astralOver := strings.Repeat("😀", CheckNotesMaxChars+1)
	if _, err := CheckObservation(doc, report, CheckObservationOptions{
		ProducedBy: checkProducedBy,
		ProducedAt: checkProducedAt,
		Notes:      &astralOver,
	}); err == nil {
		t.Fatal("a 281-code-point astral note must be refused")
	}
}

func TestStoreUpdateAttachesAnObservationAndKeepsIdAndCode(t *testing.T) {
	store := NewStore(t.TempDir())
	entry, err := store.Save(orchardExample(t))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	stored, err := store.Read(entry.Code)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	report := CheckHandover(stored)
	observation, err := CheckObservation(stored, report, CheckObservationOptions{
		ProducedBy: checkProducedBy,
		ProducedAt: checkProducedAt,
	})
	if err != nil {
		t.Fatalf("CheckObservation: %v", err)
	}
	updated := stored.Clone()
	updated.Set("observations", []any{observation})

	row, err := store.Update(entry.Code, updated)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if row.Code != entry.Code {
		t.Fatalf("the code must not change: %s", row.Code)
	}
	readBack, err := store.Read(entry.Code)
	if err != nil {
		t.Fatalf("Read after update: %v", err)
	}
	if stringAt(readBack, "handoverId") != stringAt(stored, "handoverId") {
		t.Fatal("the handoverId must survive an update")
	}
	if stringAt(readBack, "code") != entry.Code {
		t.Fatal("the load code must survive an update")
	}
	observations, _ := readBack.Get("observations")
	if list, ok := observations.([]any); !ok || len(list) != 1 {
		t.Fatal("the observation must be stored")
	}
	// Checking again after an attach produces the same grade: observations
	// never change how the document is read.
	if CheckHandover(readBack).Grade != report.Grade {
		t.Fatal("an attach must not change the grade")
	}
}

func TestStoreUpdateRefusesAChangedHandoverID(t *testing.T) {
	store := NewStore(t.TempDir())
	entry, err := store.Save(orchardExample(t))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	stored, err := store.Read(entry.Code)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	impostor := stored.Clone()
	impostor.Set("handoverId", "019f7e89-fc00-7000-8000-999999999999")
	if _, err := store.Update(entry.Code, impostor); err == nil ||
		!strings.Contains(err.Error(), "the handoverId never changes") {
		t.Fatalf("a changed id must be refused, got %v", err)
	}
}

func TestStoreUpdateNeverChangesTheLoadCode(t *testing.T) {
	store := NewStore(t.TempDir())
	entry, err := store.Save(orchardExample(t))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	stored, err := store.Read(entry.Code)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	relabelled := stored.Clone()
	relabelled.Set("code", "#999")
	if _, err := store.Update(entry.Code, relabelled); err != nil {
		t.Fatalf("Update: %v", err)
	}
	readBack, err := store.Read(entry.Code)
	if err != nil {
		t.Fatalf("Read after update: %v", err)
	}
	if stringAt(readBack, "code") != entry.Code {
		t.Fatalf("the stored code moved to %q", stringAt(readBack, "code"))
	}
}

func TestStoreUpdateValidatesBeforeWriting(t *testing.T) {
	store := NewStore(t.TempDir())
	entry, err := store.Save(orchardExample(t))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	stored, err := store.Read(entry.Code)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	broken := stored.Clone()
	broken.Set("title", "")
	if _, err := store.Update(entry.Code, broken); err == nil {
		t.Fatal("an invalid update must be refused")
	}
	readBack, err := store.Read(entry.Code)
	if err != nil {
		t.Fatalf("Read after refused update: %v", err)
	}
	if stringAt(readBack, "title") != stringAt(stored, "title") {
		t.Fatal("a refused update must leave the stored document untouched")
	}
}
