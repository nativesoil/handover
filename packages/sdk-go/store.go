// The local store: plain JSON files under ~/.soil.
//
// One handover is one file. The index is one more file. There is no database,
// no account, no network call, and no format you cannot read with cat. If
// this repo disappeared tomorrow your handovers would still be readable,
// which is the whole point of writing them down.
//
// Layout (documented in docs/architecture.md):
//
//	~/.soil/
//	  index.json                 the code counter and one row per handover
//	  handovers/001.json         the handover documents
//	  .locks/                    runtime only: the single-writer lock
//
// SOIL_HOME overrides the root, which is how the tests and the conformance
// suite run without touching a real home directory. The layout, the code
// allocation and the file bytes match packages/sdk-ts/src/store.ts, so the
// SDKs read and write the same store.
//
// # Why the writes are locked
//
// Save, Update and Reindex are each a read-modify-write: read the index, write a
// document, write the index back. Two processes doing that at the same time
// against one root both read the same NextCode, both write a document at that
// code, and the second index write erases the first one's row. One document
// survives and both callers were told it was saved.
//
// That is not a server-only story. It is two `soil save` invocations against
// one ~/.soil: an agent running the CLI while a person runs it too, or a shell
// loop. Measured on this store through the CLI before the lock, four processes
// saving fifteen times each acknowledged 60 saves and left 27, 16 and 15
// documents on disk across three runs.
//
// So every write path runs inside the advisory lock in lock.go, keyed on this
// store's own root, with the same on-disk shape every other SDK uses. A write
// that cannot take the lock returns a *LockBusyError and writes nothing,
// because a refusal the caller can retry is honest and an acknowledgement for
// a lost write is not. Reads are not locked and do not need to be: every write
// lands through an atomic rename, so a reader sees the whole old file or the
// whole new one.

package handover

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// codeDigits is the number of digits in a load code, e.g. "#004".
const codeDigits = 3

// ResolveStoreHome resolves the store root: SOIL_HOME, else ~/.soil. A nil
// getenv reads the process environment.
func ResolveStoreHome(getenv func(string) string) string {
	if getenv == nil {
		getenv = os.Getenv
	}
	if override := strings.TrimSpace(getenv("SOIL_HOME")); override != "" {
		return override
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".soil")
}

// FormatCode formats a numeric code as a load code, e.g. 4 becomes "#004".
func FormatCode(n int) string {
	return "#" + padCodeNumber(n)
}

// padCodeNumber zero-pads a code number to at least three digits.
func padCodeNumber(n int) string {
	text := strconv.Itoa(n)
	for len(text) < codeDigits {
		text = "0" + text
	}
	return text
}

var codeInputPattern = regexp.MustCompile(`^#?(\d+)$`)

// ParseCode parses a load code into its number. Accepts "#004", "004" and
// "4"; the second result is false when the code does not parse or is not
// positive.
func ParseCode(code string) (int, bool) {
	match := codeInputPattern.FindStringSubmatch(strings.TrimSpace(code))
	if match == nil {
		return 0, false
	}
	n, err := strconv.Atoi(match[1])
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

// CountSections counts sections by status. Structural content presence,
// never a grade: a section holding two characters counts exactly like one
// holding two pages.
func CountSections(doc *Obj) SectionCounts {
	counts := SectionCounts{Total: len(SectionKeys)}
	sectionsValue, _ := doc.Get("sections")
	sections, _ := asObj(sectionsValue)
	for _, key := range SectionKeys {
		status := ""
		if sections != nil {
			if sectionValue, ok := sections.Get(key); ok {
				if section, ok := asObj(sectionValue); ok {
					if s, ok := section.Get("status"); ok {
						status, _ = s.(string)
					}
				}
			}
		}
		switch status {
		case "available":
			counts.WithContent++
		case "blocked":
			counts.Blocked++
		case "not_applicable":
			counts.NotApplicable++
		default:
			counts.Missing++
		}
	}
	return counts
}

// NotFoundError is returned when a load code does not resolve to a stored
// handover.
type NotFoundError struct {
	Code string
}

func (e *NotFoundError) Error() string {
	return "no handover stored as " + e.Code
}

// Store is a local handover store rooted at one directory.
type Store struct {
	Root         string
	HandoversDir string
	IndexPath    string
	// LocksDir is where the single-writer lock lives. Runtime state, never
	// content.
	LocksDir string
	// LockOptions tunes the wait and staleness thresholds. The zero value is
	// the default, which is what every caller outside the tests uses.
	LockOptions LockOptions
}

// NewStore returns a store rooted at the given directory. An empty root
// resolves the default store home.
func NewStore(root string) *Store {
	if root == "" {
		root = ResolveStoreHome(nil)
	}
	return &Store{
		Root:         root,
		HandoversDir: filepath.Join(root, "handovers"),
		IndexPath:    filepath.Join(root, "index.json"),
		LocksDir:     filepath.Join(root, ".locks"),
	}
}

// locked runs one read-modify-write as this store's only writer, across
// processes.
//
// The lock is keyed on the store root, so two stores under one home never wait
// on each other, and two processes on one root always do. A *LockBusyError
// means body never ran and nothing was written.
func (s *Store) locked(body func() error) error {
	return WithLock(s.LocksDir, "store", body, s.LockOptions)
}

// Init creates the directories if they are not there yet.
func (s *Store) Init() error {
	return os.MkdirAll(s.HandoversDir, 0o755)
}

// ReadIndex reads the index, returning an empty one when the store is new.
func (s *Store) ReadIndex() (StoreIndex, error) {
	data, err := os.ReadFile(s.IndexPath)
	if os.IsNotExist(err) {
		return StoreIndex{IndexVersion: 1, NextCode: 1, Entries: []StoreEntry{}}, nil
	}
	if err != nil {
		return StoreIndex{}, err
	}
	parsed, parseErr := IngestBytesOrError(data)
	root, isObj := parsed.(*Obj)
	var entriesValue any
	if isObj {
		entriesValue, _ = root.Get("entries")
	}
	entries, entriesAreArray := entriesValue.([]any)
	if parseErr != nil || !isObj || !entriesAreArray {
		return StoreIndex{}, fmt.Errorf("the index at %s is not readable", s.IndexPath)
	}

	index := StoreIndex{IndexVersion: 1, NextCode: 1, Entries: []StoreEntry{}}
	if nextCodeValue, ok := root.Get("nextCode"); ok {
		if number, ok := nextCodeValue.(json.Number); ok {
			if n, err := number.Int64(); err == nil {
				index.NextCode = int(n)
			}
		}
	}
	for _, entryValue := range entries {
		entry, ok := asObj(entryValue)
		if !ok {
			continue
		}
		index.Entries = append(index.Entries, StoreEntry{
			Code:                stringAt(entry, "code"),
			ProjectID:           stringAt(entry, "projectId"),
			Title:               stringAt(entry, "title"),
			CreatedAt:           stringAt(entry, "createdAt"),
			SectionsWithContent: sectionsWithContentAt(entry),
			File:                stringAt(entry, "file"),
		})
	}
	return index, nil
}

// sectionsWithContentAt reads one index row's count, accepting an index
// written before the rename.
//
// Pre-existing indexes are not migrated on read and not rewritten: a row
// carrying only the old sectionsCaptured key is understood, and the honest
// name is what gets written the next time that row is touched. Reindex
// rewrites the whole file from the handover documents, which is the one-step
// way to convert an old index deliberately.
func sectionsWithContentAt(entry *Obj) int {
	if value, ok := entry.Get("sectionsWithContent"); ok {
		if _, isNumber := value.(json.Number); isNumber {
			return intAt(entry, "sectionsWithContent")
		}
	}
	return intAt(entry, "sectionsCaptured")
}

func stringAt(obj *Obj, key string) string {
	value, _ := obj.Get(key)
	s, _ := value.(string)
	return s
}

func intAt(obj *Obj, key string) int {
	value, _ := obj.Get(key)
	if number, ok := value.(json.Number); ok {
		if n, err := number.Int64(); err == nil {
			return int(n)
		}
	}
	return 0
}

// List returns every stored handover, newest code first.
func (s *Store) List() ([]StoreEntry, error) {
	index, err := s.ReadIndex()
	if err != nil {
		return nil, err
	}
	entries := append([]StoreEntry(nil), index.Entries...)
	sort.SliceStable(entries, func(i, j int) bool {
		a, _ := ParseCode(entries[i].Code)
		b, _ := ParseCode(entries[j].Code)
		return a > b
	})
	return entries, nil
}

// PathFor returns the path a handover with this code lives at.
func (s *Store) PathFor(code string) (string, error) {
	n, ok := ParseCode(code)
	if !ok {
		return "", &NotFoundError{Code: code}
	}
	return filepath.Join(s.HandoversDir, padCodeNumber(n)+".json"), nil
}

// Read reads one handover. code accepts "#004", "004", "4", or "last" for
// the most recently saved one.
func (s *Store) Read(code string) (*Obj, error) {
	wanted := strings.ToLower(strings.TrimSpace(code))
	if wanted == "last" || wanted == "latest" {
		entries, err := s.List()
		if err != nil {
			return nil, err
		}
		if len(entries) == 0 {
			return nil, &NotFoundError{Code: "last"}
		}
		return s.Read(entries[0].Code)
	}
	path, err := s.PathFor(code)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		n, _ := ParseCode(code)
		return nil, &NotFoundError{Code: FormatCode(n)}
	}
	if err != nil {
		return nil, err
	}
	// Through the ingestion boundary, not ParseJSON: a file on disk is bytes,
	// and the encoding, duplicate-member and depth rules can only be enforced
	// before a value exists. See ingest.go.
	parsed, err := IngestBytesOrError(data)
	if err != nil {
		return nil, err
	}
	if err := AssertHandover(parsed); err != nil {
		return nil, err
	}
	return parsed.(*Obj), nil
}

// Save stores a handover and hands back its index row. The document is
// validated first: an invalid document is never written, because a store
// that accepts anything is a store you cannot trust to load.
//
// The store is a writer, so it assigns identity: a document that arrives
// without a handoverId gets a fresh UUIDv7 here, and a document that already
// carries one keeps it, because a copy keeps its identity. An id that is
// present but malformed is a validation error, never silently replaced.
//
// Reading the index, claiming the code and writing both files is one section
// under this store's lock. Validation and identity assignment stay outside it:
// they touch no disk, and a document that is going to be refused should never
// make another writer wait. A *LockBusyError means nothing was written, and
// the caller has not been told otherwise.
func (s *Store) Save(doc any) (StoreEntry, error) {
	identified := doc
	if obj, ok := asObj(doc); ok && !obj.Has("handoverId") {
		clone := obj.Clone()
		clone.Set("handoverId", UUIDv7())
		identified = clone
	}
	if err := AssertHandover(identified); err != nil {
		return StoreEntry{}, err
	}
	if err := s.Init(); err != nil {
		return StoreEntry{}, err
	}

	var entry StoreEntry
	err := s.locked(func() error {
		index, err := s.ReadIndex()
		if err != nil {
			return err
		}
		code := FormatCode(index.NextCode)
		stored := identified.(*Obj).Clone()
		stored.Set("code", code)
		file := padCodeNumber(index.NextCode) + ".json"

		if err := s.writeJSONAtomic(filepath.Join(s.HandoversDir, file), stored); err != nil {
			return err
		}

		entry = StoreEntry{
			Code:                code,
			ProjectID:           stringAt(stored, "projectId"),
			Title:               stringAt(stored, "title"),
			CreatedAt:           stringAt(stored, "createdAt"),
			SectionsWithContent: CountSections(stored).WithContent,
			File:                file,
		}
		next := StoreIndex{
			IndexVersion: 1,
			NextCode:     index.NextCode + 1,
			Entries:      append(append([]StoreEntry{}, index.Entries...), entry),
		}
		return s.writeJSONAtomic(s.IndexPath, indexToValue(next))
	})
	if err != nil {
		return StoreEntry{}, err
	}
	return entry, nil
}

// Update updates a stored handover in place, e.g. to attach an observation.
// This is the one write path that touches an existing file, and it holds two
// rules absolutely: the handoverId never changes, because identity survives
// every edit, and the load code never changes, because a code in an old note
// must keep pointing at the thing it pointed at. The updated document is
// validated before anything is written, and the index row is refreshed to
// match.
//
// The whole section is locked, the read of the current document included: an
// update that decided what to write from a document another process replaced
// in the meantime would write back a merge nobody made. A *LockBusyError
// means nothing was written.
func (s *Store) Update(code string, next *Obj) (StoreEntry, error) {
	var entry StoreEntry
	err := s.locked(func() error {
		current, err := s.Read(code)
		if err != nil {
			return err
		}
		storedCode := stringAt(current, "code")
		if storedCode == "" {
			n, _ := ParseCode(code)
			storedCode = FormatCode(n)
		}
		if stringAt(next, "handoverId") != stringAt(current, "handoverId") {
			return fmt.Errorf(
				"the handoverId never changes: an update to %s must keep its identity",
				storedCode,
			)
		}
		stored := next.Clone()
		stored.Set("code", storedCode)
		if err := AssertHandover(stored); err != nil {
			return err
		}

		n, ok := ParseCode(storedCode)
		if !ok {
			return &NotFoundError{Code: code}
		}
		file := padCodeNumber(n) + ".json"
		if err := s.writeJSONAtomic(filepath.Join(s.HandoversDir, file), stored); err != nil {
			return err
		}

		entry = StoreEntry{
			Code:                storedCode,
			ProjectID:           stringAt(stored, "projectId"),
			Title:               stringAt(stored, "title"),
			CreatedAt:           stringAt(stored, "createdAt"),
			SectionsWithContent: CountSections(stored).WithContent,
			File:                file,
		}
		index, err := s.ReadIndex()
		if err != nil {
			return err
		}
		entries := make([]StoreEntry, len(index.Entries))
		for i, row := range index.Entries {
			if row.Code == storedCode {
				entries[i] = entry
			} else {
				entries[i] = row
			}
		}
		return s.writeJSONAtomic(s.IndexPath, indexToValue(StoreIndex{
			IndexVersion: 1,
			NextCode:     index.NextCode,
			Entries:      entries,
		}))
	})
	if err != nil {
		return StoreEntry{}, err
	}
	return entry, nil
}

// Reindex rebuilds the index from the handover files on disk. The files are
// the truth; the index is a convenience, so losing it should never lose a
// handover.
//
// Locked like Save: a rebuild that scanned the directory while a save was
// landing would write an index missing the document that save just wrote, and
// hand the next save a code that is already taken. A *LockBusyError means the
// existing index is left exactly as it was.
func (s *Store) Reindex() (StoreIndex, error) {
	if err := s.Init(); err != nil {
		return StoreIndex{}, err
	}
	var index StoreIndex
	if err := s.locked(func() error {
		rebuilt, err := s.reindexLocked()
		index = rebuilt
		return err
	}); err != nil {
		return StoreIndex{}, err
	}
	return index, nil
}

func (s *Store) reindexLocked() (StoreIndex, error) {
	files, err := os.ReadDir(s.HandoversDir)
	if err != nil {
		return StoreIndex{}, err
	}
	entries := []StoreEntry{}
	highest := 0
	for _, file := range files {
		name := file.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.HandoversDir, name))
		if err != nil {
			return StoreIndex{}, err
		}
		// A rebuilt index never silently promotes a document nothing has
		// checked, so a file the boundary refuses is skipped exactly as a
		// structurally invalid one is.
		parsed, issue := IngestBytes(data)
		if issue != nil {
			continue
		}
		if AssertHandover(parsed) != nil {
			continue
		}
		doc := parsed.(*Obj)
		codeSource := stringAt(doc, "code")
		if codeSource == "" {
			codeSource = strings.TrimSuffix(name, ".json")
		}
		n, ok := ParseCode(codeSource)
		if !ok {
			continue
		}
		if n > highest {
			highest = n
		}
		entries = append(entries, StoreEntry{
			Code:                FormatCode(n),
			ProjectID:           stringAt(doc, "projectId"),
			Title:               stringAt(doc, "title"),
			CreatedAt:           stringAt(doc, "createdAt"),
			SectionsWithContent: CountSections(doc).WithContent,
			File:                name,
		})
	}
	index := StoreIndex{IndexVersion: 1, NextCode: highest + 1, Entries: entries}
	if err := s.writeJSONAtomic(s.IndexPath, indexToValue(index)); err != nil {
		return StoreIndex{}, err
	}
	return index, nil
}

// writeJSONAtomic writes through a temporary file and renames, so a reader
// never sees half a document.
//
// The temporary name carries a random id, never os.Getpid(). Two containers on
// one volume both run as pid 1, so a pid makes two different writers look like
// one writer resuming, and the second would silently rename the first's
// half-written bytes into place.
func (s *Store) writeJSONAtomic(path string, value any) error {
	tmp := fmt.Sprintf("%s.tmp-%s", path, randomID())
	if err := os.WriteFile(tmp, []byte(MarshalJSONIndent(value)+"\n"), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func entryToValue(entry StoreEntry) *Obj {
	obj := NewObj()
	obj.Set("code", entry.Code)
	obj.Set("projectId", entry.ProjectID)
	obj.Set("title", entry.Title)
	obj.Set("createdAt", entry.CreatedAt)
	obj.Set("sectionsWithContent", entry.SectionsWithContent)
	obj.Set("file", entry.File)
	return obj
}

func indexToValue(index StoreIndex) *Obj {
	entries := make([]any, len(index.Entries))
	for i, entry := range index.Entries {
		entries[i] = entryToValue(entry)
	}
	obj := NewObj()
	obj.Set("indexVersion", index.IndexVersion)
	obj.Set("nextCode", index.NextCode)
	obj.Set("entries", entries)
	return obj
}
