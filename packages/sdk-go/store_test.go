package handover

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var uuidV7Test = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
)

func storeHandover(t *testing.T, title string, sections map[string]string) *Obj {
	t.Helper()
	input := NewObj()
	input.Set("projectId", "store-test")
	input.Set("title", title)
	input.Set("createdAt", "2026-07-22T10:00:00Z")
	sectionsObj := NewObj()
	for key, text := range sections {
		sectionsObj.Set(key, text)
	}
	input.Set("sections", sectionsObj)
	return norm(input)
}

func tempStore(t *testing.T) *Store {
	t.Helper()
	return NewStore(t.TempDir())
}

func TestFormatCode(t *testing.T) {
	for n, want := range map[int]string{1: "#001", 42: "#042", 1234: "#1234"} {
		if got := FormatCode(n); got != want {
			t.Fatalf("FormatCode(%d) = %s, want %s", n, got, want)
		}
	}
}

func TestParseCode(t *testing.T) {
	for input, want := range map[string]int{"#004": 4, "004": 4, " 4 ": 4} {
		if n, ok := ParseCode(input); !ok || n != want {
			t.Fatalf("ParseCode(%q) = %d, %v", input, n, ok)
		}
	}
	for _, input := range []string{"#abc", "#000"} {
		if _, ok := ParseCode(input); ok {
			t.Fatalf("ParseCode(%q) should fail", input)
		}
	}
}

func TestResolveStoreHome(t *testing.T) {
	got := ResolveStoreHome(func(name string) string {
		if name == "SOIL_HOME" {
			return "/tmp/elsewhere"
		}
		return ""
	})
	if got != "/tmp/elsewhere" {
		t.Fatalf("expected the SOIL_HOME override, got %s", got)
	}
	fallback := ResolveStoreHome(func(string) string { return "" })
	if !strings.HasSuffix(fallback, ".soil") {
		t.Fatalf("expected a .soil fallback, got %s", fallback)
	}
}

func TestCountSections(t *testing.T) {
	doc := norm(parseObj(t, `{"sections":{
	  "decisions": "one",
	  "workflow": "two",
	  "architecture": {"status": "blocked", "summary": "withheld"}
	}}`))
	counts := CountSections(doc)
	want := SectionCounts{WithContent: 2, Missing: 14, Blocked: 1, NotApplicable: 0, Total: 17}
	if counts != want {
		t.Fatalf("got %+v, want %+v", counts, want)
	}
}

func TestCountSectionsCountsNotApplicableOnItsOwn(t *testing.T) {
	doc := norm(parseObj(t, `{"sections":{
	  "decisions": "one",
	  "architecture": {"status": "not_applicable", "summary": "A manuscript has no system to describe."},
	  "safetySummary": {"status": "not_applicable", "summary": "Nothing here holds a value to withhold."}
	}}`))
	counts := CountSections(doc)
	want := SectionCounts{WithContent: 1, Missing: 14, Blocked: 0, NotApplicable: 2, Total: 17}
	if counts != want {
		t.Fatalf("got %+v, want %+v", counts, want)
	}
}

func TestStoreStartsEmpty(t *testing.T) {
	entries, err := tempStore(t).List()
	if err != nil || len(entries) != 0 {
		t.Fatalf("expected an empty store, got %v, %v", entries, err)
	}
}

func TestStoreHandsOutCodesInOrder(t *testing.T) {
	store := tempStore(t)
	for i, want := range []string{"#001", "#002", "#003"} {
		entry, err := store.Save(storeHandover(t, "save", nil))
		if err != nil {
			t.Fatal(err)
		}
		if entry.Code != want {
			t.Fatalf("save %d got code %s, want %s", i+1, entry.Code, want)
		}
	}
}

func TestStoreWritesOneReadableFile(t *testing.T) {
	store := tempStore(t)
	if _, err := store.Save(storeHandover(t, "readable", map[string]string{"decisions": "We chose files."})); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(store.Root, "handovers", "001.json"))
	if err != nil {
		t.Fatal(err)
	}
	doc := parseObj(t, string(raw))
	if stringAt(doc, "code") != "#001" {
		t.Fatal("the stored file carries its code")
	}
	if stringAt(sectionOf(t, doc, "decisions"), "status") != "available" {
		t.Fatal("the stored file carries its sections")
	}
}

func TestStoreReadsByCodeNumberAndLast(t *testing.T) {
	store := tempStore(t)
	mustSave(t, store, storeHandover(t, "first", nil))
	mustSave(t, store, storeHandover(t, "second", nil))
	for code, want := range map[string]string{"#001": "first", "1": "first", "last": "second"} {
		doc, err := store.Read(code)
		if err != nil {
			t.Fatal(err)
		}
		if stringAt(doc, "title") != want {
			t.Fatalf("Read(%q) got %s, want %s", code, stringAt(doc, "title"), want)
		}
	}
}

func mustSave(t *testing.T, store *Store, doc *Obj) StoreEntry {
	t.Helper()
	entry, err := store.Save(doc)
	if err != nil {
		t.Fatal(err)
	}
	return entry
}

func TestStoreListsNewestFirst(t *testing.T) {
	store := tempStore(t)
	mustSave(t, store, storeHandover(t, "first", map[string]string{"decisions": "one"}))
	mustSave(t, store, storeHandover(t, "second", nil))
	entries, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	if entries[0].Code != "#002" || entries[1].Code != "#001" {
		t.Fatalf("expected newest first, got %v", entries)
	}
	if entries[1].SectionsWithContent != 1 {
		t.Fatalf("expected the section count, got %d", entries[1].SectionsWithContent)
	}
}

func TestStoreAssignsUUIDv7AndKeepsExistingID(t *testing.T) {
	store := tempStore(t)
	assigned := mustSave(t, store, storeHandover(t, "fresh", nil))
	stored, err := store.Read(assigned.Code)
	if err != nil {
		t.Fatal(err)
	}
	if !uuidV7Test.MatchString(stringAt(stored, "handoverId")) {
		t.Fatalf("expected a UUIDv7, got %s", stringAt(stored, "handoverId"))
	}
	copied := mustSave(t, store, stored)
	reread, err := store.Read(copied.Code)
	if err != nil {
		t.Fatal(err)
	}
	if stringAt(reread, "handoverId") != stringAt(stored, "handoverId") {
		t.Fatal("a copy must keep its handoverId")
	}
}

func TestStoreRefusesInvalidDocument(t *testing.T) {
	store := tempStore(t)
	_, err := store.Save(parseObj(t, `{"title":"nope"}`))
	if err == nil || !strings.Contains(err.Error(), "not a valid Soil handover") {
		t.Fatalf("expected a validation error, got %v", err)
	}
}

func TestStoreSaysSoWhenACodeDoesNotExist(t *testing.T) {
	store := tempStore(t)
	if _, err := store.Read("#404"); err == nil {
		t.Fatal("expected a not-found error")
	} else if _, ok := err.(*NotFoundError); !ok {
		t.Fatalf("expected *NotFoundError, got %T", err)
	}
	if _, err := store.Read("last"); err == nil {
		t.Fatal("expected a not-found error for last on an empty store")
	}
}

func TestStoreReindexRebuildsFromFiles(t *testing.T) {
	store := tempStore(t)
	mustSave(t, store, storeHandover(t, "first", nil))
	mustSave(t, store, storeHandover(t, "second", nil))
	if err := os.WriteFile(store.IndexPath, []byte(`{"indexVersion":1,"nextCode":1,"entries":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	rebuilt, err := store.Reindex()
	if err != nil {
		t.Fatal(err)
	}
	if len(rebuilt.Entries) != 2 || rebuilt.Entries[0].Code != "#001" || rebuilt.Entries[1].Code != "#002" {
		t.Fatalf("unexpected rebuild: %v", rebuilt.Entries)
	}
	if rebuilt.NextCode != 3 {
		t.Fatalf("expected nextCode 3, got %d", rebuilt.NextCode)
	}
}

func TestStoreReindexSkipsUnreadableFiles(t *testing.T) {
	store := tempStore(t)
	mustSave(t, store, storeHandover(t, "good", nil))
	if err := os.WriteFile(filepath.Join(store.HandoversDir, "099.json"), []byte(`{"not":"a handover"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	rebuilt, err := store.Reindex()
	if err != nil {
		t.Fatal(err)
	}
	if len(rebuilt.Entries) != 1 {
		t.Fatalf("expected the invalid file skipped, got %v", rebuilt.Entries)
	}
}

func TestStoreFileBytesMatchTheReferenceWriter(t *testing.T) {
	// The stored file is the normalized document plus the code, serialized
	// with a two-space indent. The golden file pins the TypeScript SDK's
	// bytes for the same normalized document.
	store := tempStore(t)
	doc := parseObj(t, readTestdata(t, "normalized-json.golden"))
	entry := mustSave(t, store, doc)
	raw, err := os.ReadFile(filepath.Join(store.HandoversDir, entry.File))
	if err != nil {
		t.Fatal(err)
	}
	expected := doc.Clone()
	expected.Set("code", "#001")
	if string(raw) != MarshalJSONIndent(expected)+"\n" {
		t.Fatal("the stored bytes must round trip the document with its code")
	}
}
