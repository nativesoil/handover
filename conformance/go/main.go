// The conformance suite, run against the Go SDK.
//
// This is what "Soil Compatible" means, executed. It runs the golden fixtures
// against packages/sdk-go and checks the behaviours that make handovers
// portable rather than merely well-formed:
//
//  1. fixtures      the valid ones validate, the invalid ones fail where the
//     manifest says they fail, compared as an abstract semantic location
//     rather than as pointer text
//     1b. boundary     the pre-schema ingestion boundary: encoding, duplicate
//     member names, nesting depth and the numeric domain, judged on the
//     BYTES, because none of them can be seen from a value
//     1c. text-unit    every length bound in the format counted in Unicode
//     code points, on strings where the candidate units disagree
//  2. identity      the handoverId rules: writer-assigned UUIDv7, copies keep
//     it, new captures get a new one, codes are not identity
//  3. observations  the extension point stays forward compatible: unknown kinds
//     survive a round trip and change nothing about the sections
//  4. safety        a handover carrying credentials or private absolute paths
//     is refused, and the refusal never echoes the value
//  5. normalization the loose shapes a model actually emits become documents
//     5b. closed-world exact version support, and the invariant that a save and a
//     validation of the same bytes give the same verdict
//  6. store         save, list and read round trip through plain files
//  7. restore       a loaded handover carries its gaps and its framing, every
//     field a writer supplied reaches the reader, and content in it cannot be
//     mistaken for the rendered prompt's own structure
//  8. determinism   the renderer returns identical bytes for identical input
//  9. recipe        all 17 sections have guidance, and the rules are intact
//
// The schema-agreement category runs in the TypeScript runner (run.ts), which
// pins the published JSON Schema to these same fixtures; every SDK is pinned
// to the fixtures here and there, so the schema and the validators cannot
// drift apart. Prompt and card byte parity with the TypeScript SDK is
// asserted by the golden files in packages/sdk-go/testdata.
//
// Run it from the repo root with: go run -C conformance/go .
// It exits non-zero on failure, and it prints what failed rather than a count.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	handover "github.com/nativesoil/handover/packages/sdk-go"
)

// The two conformance classes, reported separately and never as one green
// blob. "Soil Document Conformant" is a claim about DOCUMENTS: the schema,
// the section semantics, round trips, identity. "Soil Secure Writer
// Conformant" is a claim about BEHAVIOUR: the safety fixtures that must be
// refused, with the right category, storing nothing.
const (
	classDocument     = "document"
	classSecureWriter = "secure-writer"
)

// classOf says which class a category's checks belong to unless a check says
// otherwise.
func classOf(category string) string {
	if category == "safety" {
		return classSecureWriter
	}
	return classDocument
}

type failure struct {
	class    string
	category string
	detail   string
}

type suite struct {
	checks        int
	checksByClass map[string]int
	failures      []failure
}

func newSuite() *suite {
	return &suite{checksByClass: map[string]int{classDocument: 0, classSecureWriter: 0}}
}

func (s *suite) check(category string, condition bool, detail string) {
	s.checkAs(classOf(category), category, condition, detail)
}

func (s *suite) checkAs(class, category string, condition bool, detail string) {
	s.checks++
	s.checksByClass[class]++
	if !condition {
		s.failures = append(s.failures, failure{class: class, category: category, detail: detail})
	}
}

var now = time.Date(2026, 7, 22, 10, 0, 0, 0, time.UTC)

// A syntactically valid UUID used where a check needs a document that is
// complete but is not exercising the writer's assignment path.
const aValidID = "019f7e89-fc00-7000-8000-000000000000"

// A capture time, stated by the document. Nothing here reads a clock.
const aCaptureTime = "2026-07-22T10:00:00Z"

// normalize normalizes and asserts the object shape, which is what every call
// in this runner feeds it. handover.Normalize itself returns any, because a
// root that is not an object is carried through as it arrived rather than
// replaced with a document built around it.
func normalize(input any) *handover.Obj {
	return obj(handover.Normalize(input))
}

// The exact shape the official writers emit: UUIDv7, RFC 9562 variant.
var uuidV7Pattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
)

var root = findRoot()

func findRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "conformance", "fixtures", "manifest.json")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			panic("cannot find the repo root; run from inside the repository")
		}
		dir = parent
	}
}

func readJSON(path string) any {
	data, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	value, err := handover.ParseJSON(data)
	if err != nil {
		panic(fmt.Sprintf("%s: %v", path, err))
	}
	return value
}

func fixturePath(file string) string {
	return filepath.Join(root, "conformance", "fixtures", file)
}

// restoreToken is the fixed boundary token every restore-prompt check
// injects. Production takes 128 bits from the platform's cryptographic source
// instead, which is what makes the boundary unforgeable; a fixed token here is
// what makes a check on the rendered bytes possible at all.
var restoreToken = func() string {
	manifest := readJSON(fixturePath("manifest.json")).(*handover.Obj)
	value, _ := manifest.Get("restoreBoundaryToken")
	token, _ := value.(string)
	return token
}()

var restoreMark = "soil:" + restoreToken

var structureShapedLine = regexp.MustCompile(`^\s*(?:===|##)`)

func obj(value any) *handover.Obj {
	return value.(*handover.Obj)
}

func str(o *handover.Obj, key string) string {
	value, _ := o.Get(key)
	s, _ := value.(string)
	return s
}

// An abstract semantic location: an ordered sequence of object member names
// and array indices, from the root of the document to the offending value. The
// empty sequence means the document itself.
//
// This is what the harness compares, and it is deliberately not a string. The
// manifest used to bind exact JSON Pointer text, which made a formatting
// choice into a conformance requirement the specification never states: an
// implementation that reports the same place in a different notation was
// failed by the official suite for being spelled differently. A pointer is
// still a fine representation; each runner parses its own representation into
// segments before comparing, and locationOf is this runner's adapter.
//
// Segments are compared as text. An index and a member name never collide in
// practice, because the two only ever appear at positions the document's own
// shape decides.
func locationOf(pointer string) []string {
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

// manifestLocation reads one manifest `location` array as segments.
func manifestLocation(value any) []string {
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

func sameLocation(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// showLocation renders a semantic location for a failure message. Never
// compared.
func showLocation(location []string) string {
	if len(location) == 0 {
		return "the document"
	}
	return strings.Join(location, " > ")
}

func issueLocations(result handover.ValidationResult) string {
	shown := []string{}
	for _, issue := range result.Issues {
		shown = append(shown, showLocation(locationOf(issue.Path)))
	}
	if len(shown) == 0 {
		return "nothing"
	}
	return strings.Join(shown, ", ")
}

func hasIssueAt(result handover.ValidationResult, location []string) bool {
	for _, issue := range result.Issues {
		if sameLocation(locationOf(issue.Path), location) {
			return true
		}
	}
	return false
}

// boundaryBytes materialises one boundary fixture: bytes on disk, or a padded
// document, because the size fixtures are a megabyte each and do not belong in
// a repository.
func boundaryBytes(entry *handover.Obj) []byte {
	if file := str(entry, "file"); file != "" {
		data, err := os.ReadFile(fixturePath(file))
		if err != nil {
			panic(err)
		}
		return data
	}
	value, _ := entry.Get("generateBytes")
	total, err := strconv.Atoi(fmt.Sprintf("%v", value))
	if err != nil {
		panic(err)
	}
	return []byte(`{"pad":"` + strings.Repeat("x", total-10) + `"}`)
}

// checkIngestionBoundary runs the pre-schema ingestion boundary: encoding,
// duplicate member names and nesting depth, all judged on the bytes before a
// value exists.
//
// The category is its own because none of it can be seen from a constructed
// value, which is exactly why the three defects survived this long. The
// published JSON Schema and the reference validator are both handed an
// already-parsed value, so both are structurally blind here; that is a fact
// about layers, not a gap in the schema.
func checkIngestionBoundary(s *suite) {
	manifest := obj(readJSON(fixturePath("manifest.json")))
	boundaryValue, _ := manifest.Get("boundary")
	for _, entryValue := range boundaryValue.([]any) {
		entry := obj(entryValue)
		name := str(entry, "name")
		expected := str(entry, "ingest")
		value, issue := handover.IngestBytes(boundaryBytes(entry))

		if expected == "accepted" {
			got := "acceptance"
			if issue != nil {
				got = issue.Code
			}
			s.check("boundary", issue == nil, fmt.Sprintf(
				"%s: must be accepted, was refused with %s", name, got))
			if issue != nil {
				continue
			}

			// An accepted document is never merely accepted. The validator
			// runs on it and must return a result, because the one outcome
			// worse than a rejection is a document that is accepted and never
			// scanned.
			result := handover.Validate(value)
			switch str(entry, "afterIngest") {
			case "valid":
				problems := []string{}
				for _, i := range result.Issues {
					problems = append(problems, i.Path+" "+i.Message)
				}
				s.check("boundary", result.Valid, fmt.Sprintf(
					"%s: accepted at the boundary, then rejected by the validator: %s",
					name, strings.Join(problems, "; ")))
			case "refused-by-safety":
				refused := false
				for _, i := range result.Issues {
					if i.Kind == "safety" {
						refused = true
					}
				}
				s.checkAs(classSecureWriter, "boundary", refused, fmt.Sprintf(
					"%s: accepted at the boundary, so the fail-closed secret scan must reach it and refuse it",
					name))
			default:
				s.check("boundary", !result.Valid, fmt.Sprintf(
					"%s: is not a handover, so the validator must say so rather than accept it",
					name))
			}
			continue
		}

		got := "acceptance"
		if issue != nil {
			got = issue.Code
		}
		s.check("boundary", issue != nil && issue.Code == expected, fmt.Sprintf(
			"%s: must be refused with %s, got %s", name, expected, got))
		if issue != nil && entry.Has("location") {
			value, _ := entry.Get("location")
			wanted := manifestLocation(value)
			s.check("boundary", sameLocation(locationOf(issue.Path), wanted), fmt.Sprintf(
				"%s: must report the issue at %q, reported %q",
				name, showLocation(wanted), showLocation(locationOf(issue.Path))))
		}
	}

	s.check("boundary",
		handover.MaxIngestDepth == 32 && handover.MaxIngestBytes == 1048576,
		fmt.Sprintf("the boundary limits must be 32 levels and 1048576 bytes, found %d and %d",
			handover.MaxIngestDepth, handover.MaxIngestBytes))
	s.check("boundary",
		handover.MaxIngestInteger == 9007199254740991 &&
			handover.MinIngestInteger == -9007199254740991,
		fmt.Sprintf("the integer domain must run from -9007199254740991 to 9007199254740991, "+
			"found %d to %d", handover.MinIngestInteger, handover.MaxIngestInteger))
}

// One code point, two UTF-16 code units, four UTF-8 bytes.
const astral = "\U0001F600"

// Two code points, two UTF-16 code units, three UTF-8 bytes, one cluster.
const combined = "e\u0301"

// textUnitBase is a complete, valid handover with nothing near a limit.
func textUnitBase() *handover.Obj {
	input := handover.NewObj()
	input.Set("projectId", "text-unit")
	input.Set("title", "The text unit")
	input.Set("createdAt", aCaptureTime)
	sections := handover.NewObj()
	sections.Set("executiveSummary", "The text unit, exercised.")
	input.Set("sections", sections)
	doc := normalize(input)
	doc.Set("handoverId", aValidID)
	return doc
}

// textUnitField returns the base document with one top-level field replaced.
func textUnitField(name string, value any) *handover.Obj {
	doc := textUnitBase()
	doc.Set(name, value)
	return doc
}

// textUnitSummary returns the base document with one section carrying text.
func textUnitSummary(text string) *handover.Obj {
	doc := textUnitBase()
	sectionsValue, _ := doc.Get("sections")
	sections := obj(sectionsValue)
	section := handover.NewObj()
	section.Set("status", "available")
	section.Set("summary", text)
	sections.Set("architecture", section)
	return doc
}

func textUnitList(entry string) *handover.Obj {
	quality := handover.NewObj()
	quality.Set("missingInputs", []any{entry})
	return textUnitField("quality", quality)
}

func textUnitObservation(kind string) *handover.Obj {
	entry := handover.NewObj()
	entry.Set("kind", kind)
	entry.Set("data", handover.NewObj())
	return textUnitField("observations", []any{entry})
}

// checkTextUnit exercises the text unit at every individually bounded string.
//
// The fixtures pin three of these sites and this pins all five, including the
// 20000-code-point section summary, which is deliberately not a fixture: at
// four bytes per astral character it would be an eighty-kilobyte file in a
// repository whose largest real document is eighteen kilobytes, and a string
// built here costs nothing and proves the same thing.
//
// Everything here is deliberately NOT ASCII. On ASCII the three candidate
// units, code points and UTF-16 code units and UTF-8 bytes, all give the same
// answer, so an ASCII test cannot tell a conformant implementation from one
// counting the wrong thing.
func checkTextUnit(s *suite) {
	cases := []struct {
		what string
		path string
		at   *handover.Obj
		over *handover.Obj
	}{
		{
			fmt.Sprintf("title at %d code points", handover.LimitTitle),
			"/title",
			textUnitField("title", strings.Repeat(astral, handover.LimitTitle)),
			textUnitField("title", strings.Repeat(astral, handover.LimitTitle+1)),
		},
		{
			fmt.Sprintf("title at %d code points of combining sequences", handover.LimitTitle),
			"/title",
			textUnitField("title", strings.Repeat(combined, handover.LimitTitle/2)),
			textUnitField("title", strings.Repeat(combined, handover.LimitTitle/2)+"x"),
		},
		{
			fmt.Sprintf("section summary at %d code points", handover.LimitSectionSummary),
			"/sections/architecture/summary",
			textUnitSummary(strings.Repeat(astral, handover.LimitSectionSummary)),
			textUnitSummary(strings.Repeat(astral, handover.LimitSectionSummary+1)),
		},
		{
			fmt.Sprintf("a stated gap at %d code points", handover.LimitListEntry),
			"/quality/missingInputs/0",
			textUnitList(strings.Repeat(combined, handover.LimitListEntry/2)),
			textUnitList(strings.Repeat(combined, handover.LimitListEntry/2) + "x"),
		},
		{
			fmt.Sprintf("an observation kind at %d code points", handover.LimitObservationKind),
			"/observations/0/kind",
			textUnitObservation(strings.Repeat(astral, handover.LimitObservationKind)),
			textUnitObservation(strings.Repeat(astral, handover.LimitObservationKind+1)),
		},
		{
			// projectId is pattern-restricted to ASCII, so all three candidate
			// units agree on it. It is here for the bound, not for the unit.
			fmt.Sprintf("projectId at %d code points", handover.LimitProjectID),
			"/projectId",
			textUnitField("projectId", strings.Repeat("p", handover.LimitProjectID)),
			textUnitField("projectId", strings.Repeat("p", handover.LimitProjectID+1)),
		},
	}

	for _, entry := range cases {
		result := handover.Validate(entry.at)
		problems := make([]string, len(result.Issues))
		for i, issue := range result.Issues {
			problems[i] = issue.Path + " " + issue.Message
		}
		s.check("text-unit", result.Valid, fmt.Sprintf(
			"%s must be accepted, refused: %s", entry.what, strings.Join(problems, "; ")))

		refused := handover.Validate(entry.over)
		located := false
		for _, issue := range refused.Issues {
			if issue.Path == entry.path {
				located = true
			}
		}
		s.check("text-unit", !refused.Valid && located, fmt.Sprintf(
			"one code point over %s must be refused at %s", entry.what, entry.path))
	}

	// The unit itself, on the three cases that separate the candidates.
	s.check("text-unit", handover.TextLength(astral) == 1 && len(astral) == 4,
		"a character outside the basic plane is one code point and four UTF-8 bytes")
	s.check("text-unit", handover.TextLength(combined) == 2,
		"one perceived character written as a base plus a combining mark is two code points, not one")
	s.check("text-unit", handover.TextLength("caf\u00e9") == 4 && len("caf\u00e9") == 5,
		"a precomposed accented character is one code point and two UTF-8 bytes")
}

func checkFixtures(s *suite) {
	manifest := obj(readJSON(fixturePath("manifest.json")))

	validValue, _ := manifest.Get("valid")
	for _, entryValue := range validValue.([]any) {
		entry := obj(entryValue)
		file := str(entry, "file")
		doc := readJSON(fixturePath(file))
		result := handover.Validate(doc)
		problems := []string{}
		for _, issue := range result.Issues {
			problems = append(problems, issue.Path+" "+issue.Message)
		}
		s.check("fixtures", result.Valid, fmt.Sprintf(
			"%s should be valid but the validator reported: %s", file, strings.Join(problems, "; ")))
	}

	invalidValue, _ := manifest.Get("invalid")
	for _, entryValue := range invalidValue.([]any) {
		entry := obj(entryValue)
		file := str(entry, "file")
		locationValue, _ := entry.Get("location")
		location := manifestLocation(locationValue)
		reason := str(entry, "reason")
		doc := readJSON(fixturePath(file))
		result := handover.Validate(doc)
		// Refusing a safety fixture is writer behaviour, so those two checks
		// count toward the Secure Writer class; structural rejections are
		// document checks.
		entryClass := classDocument
		if str(entry, "kind") == "safety" {
			entryClass = classSecureWriter
		}
		s.checkAs(entryClass, "fixtures", !result.Valid, fmt.Sprintf(
			"%s should be rejected (%s) but validated", file, reason))
		s.checkAs(entryClass, "fixtures", hasIssueAt(result, location), fmt.Sprintf(
			"%s should report a problem at %s, reported: %s",
			file, showLocation(location), issueLocations(result)))
		if str(entry, "kind") == "safety" {
			refusedBySafety := false
			for _, issue := range result.Issues {
				if issue.Kind == handover.IssueSafety {
					refusedBySafety = true
				}
			}
			s.check("safety", refusedBySafety, fmt.Sprintf(
				"%s should be refused by the secret scan, not merely by shape", file))
		}
	}
}

func freshIdentityDoc() *handover.Obj {
	input, err := handover.ParseJSON([]byte(
		`{"projectId":"identity","title":"Identity","createdAt":"2026-07-22T10:00:00Z","sections":{"executiveSummary":"The identity rules, exercised."}}`,
	))
	if err != nil {
		panic(err)
	}
	return normalize(input)
}

// checkIdentity exercises the handoverId rules one by one. The letters match
// the fixture list in the specification work: (a) a new handover gets a new
// UUIDv7, (b) a byte-for-byte copy keeps its id, (c) a new capture of the
// same project gets a new one, (d) local codes may collide across stores
// without identity collision, (e) the id survives the store's own update
// path, (f) an invalid or missing id is handled deterministically, and (g)
// is these same checks run by run.ts and run_py.py over the same fixtures.
func checkIdentity(s *suite) {
	homeA, _ := os.MkdirTemp("", "soil-identity-a-")
	homeB, _ := os.MkdirTemp("", "soil-identity-b-")
	defer os.RemoveAll(homeA)
	defer os.RemoveAll(homeB)
	storeA := handover.NewStore(homeA)
	storeB := handover.NewStore(homeB)

	// (a) a new handover gets a new UUIDv7, assigned by the writer.
	first, err := storeA.Save(freshIdentityDoc())
	if err != nil {
		panic(err)
	}
	firstDoc, _ := storeA.Read(first.Code)
	s.check("identity", uuidV7Pattern.MatchString(str(firstDoc, "handoverId")),
		"(a) a handover stored without an id must be assigned a UUIDv7 by the writer")

	// (c) a new capture, even of the same project, gets a new handoverId.
	second, _ := storeA.Save(freshIdentityDoc())
	secondDoc, _ := storeA.Read(second.Code)
	s.check("identity",
		str(secondDoc, "handoverId") != "" && str(secondDoc, "handoverId") != str(firstDoc, "handoverId"),
		"(c) a new capture of the same project must get a new handoverId")

	// (d) local codes may collide across two stores; identity does not.
	other, _ := storeB.Save(freshIdentityDoc())
	otherDoc, _ := storeB.Read(other.Code)
	s.check("identity",
		other.Code == first.Code && str(otherDoc, "handoverId") != str(firstDoc, "handoverId"),
		"(d) two stores may both hold a #001, and the two documents must still have different handoverIds")

	// (b) a byte-for-byte copy keeps its handoverId, in any store.
	copyValue, err := handover.ParseJSON([]byte(handover.MarshalJSONIndent(firstDoc)))
	if err != nil {
		panic(err)
	}
	copyEntry, _ := storeB.Save(copyValue)
	copyDoc, _ := storeB.Read(copyEntry.Code)
	s.check("identity", str(copyDoc, "handoverId") == str(firstDoc, "handoverId"),
		"(b) a byte-for-byte copy must keep its handoverId when stored again")

	// (e) the store's own update path never changes an id. There is no
	// migration tooling yet, so the rule is pinned on reindex: the files are
	// rewritten around, and identity must come out untouched.
	if _, err := storeA.Reindex(); err != nil {
		panic(err)
	}
	reread, _ := storeA.Read(first.Code)
	s.check("identity", str(reread, "handoverId") == str(firstDoc, "handoverId"),
		"(e) rebuilding the store's index must leave every handoverId unchanged")

	// (f) an invalid or missing id is handled deterministically on validate:
	// a structure issue at /handoverId, and never a silent replacement.
	withoutID := firstDoc.Clone()
	withoutID.Delete("handoverId")
	missing := handover.Validate(withoutID)
	missingAtPath := false
	for _, issue := range missing.Issues {
		if issue.Path == "/handoverId" && issue.Kind == handover.IssueStructure {
			missingAtPath = true
		}
	}
	s.check("identity", !missing.Valid && missingAtPath,
		"(f) a document claiming validity without an id must fail with a structure issue at /handoverId")
	malformedDoc := firstDoc.Clone()
	malformedDoc.Set("handoverId", "handover-42")
	malformed := handover.Validate(malformedDoc)
	s.check("identity", !malformed.Valid && hasIssueAt(malformed, []string{"handoverId"}),
		"(f) a malformed id must fail at /handoverId rather than be replaced")
}

func checkObservations(s *suite) {
	// The extension point: unknown kinds survive a full round trip, and the
	// sections are read the same with them as without them.
	home, _ := os.MkdirTemp("", "soil-observations-")
	defer os.RemoveAll(home)
	store := handover.NewStore(home)
	doc := obj(readJSON(fixturePath(filepath.Join("valid", "observations-unknown-kinds.json"))))

	entry, err := store.Save(doc)
	if err != nil {
		panic(err)
	}
	read, _ := store.Read(entry.Code)
	readObservations, _ := read.Get("observations")
	docObservations, _ := doc.Get("observations")
	s.check("observations",
		len(readObservations.([]any)) == 3,
		"an unrecognised observation must survive a save and a read, not be dropped")
	s.check("observations",
		handover.MarshalJSONCompact(readObservations) == handover.MarshalJSONCompact(docObservations),
		"an unrecognised observation must round trip unchanged")

	normalized := normalize(doc)
	normalizedObservations, _ := normalized.Get("observations")
	s.check("observations",
		handover.MarshalJSONCompact(normalizedObservations) == handover.MarshalJSONCompact(docObservations),
		"normalization must not interpret, filter or reorder observations")

	without := read.Clone()
	without.Delete("observations")
	s.check("observations",
		handover.BuildRestorePromptWithToken(read, restoreToken) ==
			handover.BuildRestorePromptWithToken(without, restoreToken),
		"observations must not change how the 17 sections are read")

	unknownOnly := doc.Clone()
	futureKind, err := handover.ParseJSON([]byte(`[{"kind":"kind.from.the.future","data":{"x":1}}]`))
	if err != nil {
		panic(err)
	}
	unknownOnly.Set("observations", futureKind)
	s.check("observations", handover.Validate(unknownOnly).Valid,
		"a kind this implementation has never heard of must be accepted, not treated as an error")
}

func scanDoc(text string) *handover.Obj {
	input, err := handover.ParseJSON([]byte(handover.MarshalJSONCompact(scanInput(text))))
	if err != nil {
		panic(err)
	}
	return normalize(input)
}

func scanInput(text string) *handover.Obj {
	input := handover.NewObj()
	input.Set("handoverId", aValidID)
	input.Set("projectId", "scan")
	input.Set("title", "Scan")
	input.Set("createdAt", aCaptureTime)
	sections := handover.NewObj()
	sections.Set("architecture", text)
	input.Set("sections", sections)
	return input
}

func checkSecretScan(s *suite) {
	clean := readJSON(filepath.Join(root, "examples", "orchard-checkout.json"))
	s.check("safety", len(handover.FindSecretMaterial(clean)) == 0,
		"the worked example must be free of secret material")

	// One unsafe positive per mandatory class, plus the vendor formats and
	// the precedence case. spec/safety-patterns.md is the normative
	// statement; this table is the minimum an implementation must refuse.
	cases := []struct {
		text  string
		label string
	}{
		{"the key is sk-abc123def456", "provider_api_key"},
		{"clone https://ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/o/r.git", "provider_api_key"},
		{"the runner env holds AKIAIOSFODNN7EXAMPLE", "provider_api_key"},
		{"the bot posts with xoxb-2314789012-4567890123456-AbCdEfGhIjKlMnOpQrStUvWx", "provider_api_key"},
		{"maps is keyed with AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY", "provider_api_key"},
		{"Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e", "bearer_token"},
		{"Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1lMTIzNDU2", "authorization_header"},
		{"token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", "jwt"},
		{"-----BEGIN PRIVATE KEY-----", "private_key_pem"},
		{`the app reads client_secret="9f8a7b6c5d4e3f2a1b0c"`, "client_secret"},
		{`the runner loads {"type": "service_account", "project_id": "x"}`, "google_application_credentials"},
		{"GOOGLE_APPLICATION_CREDENTIALS=/opt/keys/orchard-sa.json", "google_application_credentials"},
		{"it lives at /Users/example/code/app", "private_path"},
		{"it lives at /home/deploy/app", "private_path"},
		{`it lives at C:\Users\example\app`, "private_path"},
		{"postgres://orchard:9f8a7b6c5d4e3f@db.internal:5432/orchard", "url_credentials"},
		{"The token was redacted: ghp_16C7e42F292c6912E7710c838347Ae178B4a is gone.", "provider_api_key"},
	}

	for _, c := range cases {
		doc := scanDoc(c.text)
		findings := handover.FindSecretMaterial(doc)
		found := false
		for _, finding := range findings {
			if finding.Label == c.label {
				found = true
			}
		}
		s.check("safety", found, fmt.Sprintf("a section carrying %s must be detected", c.label))
		result := handover.Validate(doc)
		s.check("safety", !result.Valid, fmt.Sprintf(
			"a handover carrying %s must be rejected, not merely flagged", c.label))
		for _, issue := range result.Issues {
			s.check("safety", !strings.Contains(issue.Message, c.text), fmt.Sprintf(
				"a %s finding must not echo the matched value back", c.label))
		}
	}

	// The safe near-neighbour of every class. Refusing any of these would
	// make the format contradict its own section requirements: architecture
	// asks for flag and command names quoted exactly, and safetySummary asks
	// for what was withheld and where it is configured.
	safeCases := []string{
		"A provider API key exists and is set in the deployment platform. Its value is not carried here.",
		"The service uses an Authorization header.",
		"GOOGLE_APPLICATION_CREDENTIALS is set outside the handover.",
		"The client_secret value was intentionally omitted.",
		"The endpoint expects bearer credentials; the token is not carried here.",
		"Login returns a JWT; the value is not carried here.",
		"The signing key is a PEM private key held in the platform's secret manager.",
		"Run `soil save --project orchard`; SOIL_HOME selects the store and PORT defaults to 3000.",
		"Send it as `Authorization: Bearer <token>`, or as `Authorization: Bearer $TOKEN`.",
		"The config template ships client_secret=YOUR_CLIENT_SECRET.",
		"Initialised /home/ada/.soil-server, and the container mounts /home/agent/.soil.",
		"The URL is documented as postgres://app:password@db.internal:5432/app.",
		"See src/checkout/window.ts and https://example.com/docs",
	}
	for _, text := range safeCases {
		result := handover.Validate(scanDoc(text))
		refused := []string{}
		for _, issue := range result.Issues {
			refused = append(refused, issue.Path+" "+string(issue.Kind))
		}
		s.check("safety", result.Valid, fmt.Sprintf(
			"naming a credential type, header, environment variable, flag or documented placeholder must stay valid, refused: %s",
			strings.Join(refused, ", ")))
	}
}

func checkNormalization(s *suite) {
	modelReply := strings.Join([]string{
		"Sure, here is the save:",
		"",
		"```json",
		`{"projectId": "loose-shape", "title": "A reply in the rescue shape", "createdAt": "2026-07-22T10:00:00Z", "extractionSections": {"projectIdentity": "A project that exists only to test the loose shape.", "decisions": {"status": "available", "summary": "One decision was made."}, "blockers": {"status": "missing", "summary": null}}}`,
		"```",
		"",
		"Let me know if you want anything changed.",
	}, "\n")

	block, ok := handover.ExtractJSONBlock(modelReply)
	s.check("normalization", ok, "a fenced JSON block inside prose should be extracted")

	parsed, err := handover.ParseJSON([]byte(block))
	if err != nil {
		panic(err)
	}
	doc := normalize(parsed)

	// Normalization is not a writer, so the id is still absent here. The
	// only thing standing between this reply and validity must be the id the
	// writer assigns at store time.
	beforeID := handover.Validate(doc)
	beforeProblems := []string{}
	for _, issue := range beforeID.Issues {
		beforeProblems = append(beforeProblems, issue.Path+" "+issue.Message)
	}
	s.check("normalization",
		!beforeID.Valid && len(beforeID.Issues) == 1 && beforeID.Issues[0].Path == "/handoverId",
		fmt.Sprintf("a normalized reply should be one writer-assigned id away from valid, got: %s",
			strings.Join(beforeProblems, "; ")))

	identified := doc.Clone()
	identified.Set("handoverId", aValidID)
	result := handover.Validate(identified)
	problems := []string{}
	for _, issue := range result.Issues {
		problems = append(problems, issue.Path+" "+issue.Message)
	}
	s.check("normalization", result.Valid, fmt.Sprintf(
		"a normalized rescue-shaped reply should be valid once identified, got: %s",
		strings.Join(problems, "; ")))

	sectionsValue, _ := doc.Get("sections")
	sections := obj(sectionsValue)
	s.check("normalization", sections.Len() == 17,
		"normalization should declare all 17 sections")
	projectIdentityValue, _ := sections.Get("projectIdentity")
	s.check("normalization", str(obj(projectIdentityValue), "status") == "available",
		"a bare string section should become an available section")
	workflowValue, _ := sections.Get("workflow")
	s.check("normalization", str(obj(workflowValue), "status") == "missing",
		"a section the model never wrote should be recorded as missing, not invented")
	s.check("normalization", strings.Contains(handover.RescuePrompt, "extractionSections"),
		"the rescue prompt should ask for the shape normalization accepts")

	// An unrecognised status, wrong capitalisation included, must reach
	// Validate and be refused there. Silently rewriting it to "available"
	// would turn a typo into content that counts as captured.
	for _, wrong := range []string{"Available", "AVAILABLE", "partial", "notApplicable", "not applicable", "NOT_APPLICABLE"} {
		input := handover.NewObj()
		input.Set("handoverId", aValidID)
		input.Set("projectId", "status")
		input.Set("title", "Status")
		input.Set("createdAt", aCaptureTime)
		section := handover.NewObj()
		section.Set("status", wrong)
		section.Set("summary", "One decision.")
		sections := handover.NewObj()
		sections.Set("decisions", section)
		input.Set("sections", sections)
		parsedStatus, err := handover.ParseJSON([]byte(handover.MarshalJSONCompact(input)))
		if err != nil {
			panic(err)
		}
		written := normalize(parsedStatus)
		writtenSectionsValue, _ := written.Get("sections")
		decisionsValue, _ := obj(writtenSectionsValue).Get("decisions")
		s.check("normalization", str(obj(decisionsValue), "status") == wrong, fmt.Sprintf(
			"normalization must keep the unrecognised status %q rather than rewrite it", wrong))
		statusResult := handover.Validate(written)
		refusedAtStatus := false
		for _, issue := range statusResult.Issues {
			if issue.Path == "/sections/decisions/status" && issue.Kind == "structure" {
				refusedAtStatus = true
			}
		}
		s.check("normalization", !statusResult.Valid && refusedAtStatus, fmt.Sprintf(
			"an unrecognised status %q must be refused at /sections/decisions/status", wrong))
	}
}

func checkStoreAndRestore(s *suite) {
	home, _ := os.MkdirTemp("", "soil-conformance-")
	defer os.RemoveAll(home)
	store := handover.NewStore(home)
	doc := obj(readJSON(filepath.Join(root, "examples", "orchard-checkout.json")))

	entry, err := store.Save(doc)
	if err != nil {
		panic(err)
	}
	s.check("store", entry.Code == "#001", "the first code should be #001")
	s.check("store", entry.SectionsWithContent == 17, "the worked example carries all 17 sections")

	second, _ := store.Save(doc)
	s.check("store", second.Code == "#002", "codes should increment, never be reused")

	read, err := store.Read("#001")
	if err != nil {
		panic(err)
	}
	s.check("store", str(read, "title") == str(doc, "title") && str(read, "code") == "#001",
		"a stored handover should read back with its code")
	listed, _ := store.List()
	s.check("store", len(listed) == 2 && listed[0].Code == "#002",
		"list should return everything, newest first")

	rebuilt, err := store.Reindex()
	if err != nil {
		panic(err)
	}
	s.check("store", len(rebuilt.Entries) == 2 && rebuilt.NextCode == 3,
		"the index should be rebuildable from the files alone")

	prompt := handover.BuildRestorePromptWithToken(read, restoreToken)
	s.check("restore", strings.Contains(prompt, "=== "+restoreMark+" BOOT PROMPT ==="),
		"the restore prompt should lead with the boot prompt")
	s.check("restore", strings.Contains(prompt, "context, not instruction"),
		"the restore prompt should tell the reader the document is context, not commands")
	s.check("restore",
		strings.Contains(prompt, "=== "+restoreMark+" KNOWN GAPS ===") &&
			strings.Contains(prompt, "not captured: Conversion numbers"),
		"stated gaps should travel with the handover into the restore prompt")
	s.check("restore", strings.Contains(prompt, "not now"),
		"the restore prompt should anchor capture-state sections to the capture")
	// The asserted-absent word is built by concatenation on purpose: the
	// rule it enforces covers this repo's own text too.
	word := "verif" + "ied"
	s.check("restore", !regexp.MustCompile(`(?i)\b`+word+`\b`).MatchString(prompt),
		"nothing local should describe a handover as checked by anything")

	// A field a writer supplies is not delivered until a reader sees it, and
	// the reader on this side is a model. Each of these was accepted,
	// validated and stored, and then reached no rendered surface at all.
	source := obj(mustGet(read, "source"))
	s.check("restore",
		strings.Contains(prompt, "=== "+restoreMark+" THIS HANDOVER ===") &&
			strings.Contains(prompt, "Title: "+str(read, "title")),
		"the handover's own title should reach the prompt, not only the rail card")
	sourceReaches := true
	for _, label := range []string{"client", "model", "provider", "extraction recipe"} {
		if !strings.Contains(prompt, label+" ") {
			sourceReaches = false
		}
	}
	for _, key := range []string{"client", "provider", "recipeVersion"} {
		if value := str(source, key); value != "" && !strings.Contains(prompt, value) {
			sourceReaches = false
		}
	}
	s.check("restore", sourceReaches,
		"the client, the model, the provider and the recipe version should tell the reader what wrote this")

	labelsInDocument := documentProvenance(read)
	labelsReach := len(labelsInDocument) > 0 &&
		strings.Contains(prompt, "=== "+restoreMark+" WHERE THE CLAIMS CAME FROM ===")
	for _, label := range labelsInDocument {
		if !strings.Contains(prompt, label) {
			labelsReach = false
		}
	}
	s.check("restore", labelsReach,
		"every provenance label the document carries should reach the reader, because provenance is the format's only trust mechanism")

	// A withheld section and an empty one are two different instructions to
	// the reader, and the prompt reported both as the second.
	withheldDoc := obj(readJSON(fixturePath("valid/blocked-and-safe.json")))
	withheldPrompt := handover.BuildRestorePromptWithToken(withheldDoc, restoreToken)
	emptyLine := ""
	for _, line := range strings.Split(withheldPrompt, "\n") {
		if strings.HasPrefix(line, "Sections with nothing in them") {
			emptyLine = line
			break
		}
	}
	withheldKeys := []string{}
	for _, key := range handover.SectionKeys {
		if status, _ := sectionOf(withheldDoc, key); status == "blocked" {
			withheldKeys = append(withheldKeys, key)
		}
	}
	withheldNamed := len(withheldKeys) > 0
	notesTravel := true
	for _, key := range withheldKeys {
		label := handover.SectionLabels[key]
		if strings.Contains(emptyLine, label) ||
			!strings.Contains(withheldPrompt, "withheld from "+label) {
			withheldNamed = false
		}
		_, summary := sectionOf(withheldDoc, key)
		if summary != "" && !strings.Contains(withheldPrompt, summary[:40]) {
			notesTravel = false
		}
	}
	s.check("restore", withheldNamed,
		"a withheld section should be named as withheld rather than counted among the empty ones")
	s.check("restore", notesTravel,
		"the note a writer left on a withheld section should travel to the reader")
}

// mustGet reads a member that the fixture is required to carry.
func mustGet(o *handover.Obj, key string) any {
	value, ok := o.Get(key)
	if !ok {
		panic("the fixture must carry " + key)
	}
	return value
}

// sectionOf reads one section's status and summary.
func sectionOf(doc *handover.Obj, key string) (string, string) {
	sectionsValue, _ := doc.Get("sections")
	sections, ok := sectionsValue.(*handover.Obj)
	if !ok {
		return "", ""
	}
	sectionValue, _ := sections.Get(key)
	section, ok := sectionValue.(*handover.Obj)
	if !ok {
		return "", ""
	}
	return str(section, "status"), str(section, "summary")
}

// documentProvenance collects every provenance label the document's sections
// carry, without duplicates.
func documentProvenance(doc *handover.Obj) []string {
	sectionsValue, _ := doc.Get("sections")
	sections, ok := sectionsValue.(*handover.Obj)
	if !ok {
		return nil
	}
	seen := map[string]bool{}
	out := []string{}
	for _, key := range handover.SectionKeys {
		sectionValue, _ := sections.Get(key)
		section, ok := sectionValue.(*handover.Obj)
		if !ok {
			continue
		}
		listValue, _ := section.Get("provenance")
		list, ok := listValue.([]any)
		if !ok {
			continue
		}
		for _, entry := range list {
			label, ok := entry.(string)
			if !ok || seen[label] {
				continue
			}
			seen[label] = true
			out = append(out, label)
		}
	}
	return out
}

// unescapeRestoreLine recovers the original content line: exactly one
// backslash comes off.
func unescapeRestoreLine(line string) string {
	return strings.TrimPrefix(line, "\\")
}

// checkRestoreBoundary holds the restore prompt to spec/restore-prompt.md on
// adversarial documents.
//
// Every fixture in the manifest's restore list is a VALID handover whose
// content is written to be mistaken for the rendered prompt's own structure.
// The rule is that content cannot be mistaken for structure, and it is checked
// here as three outcomes rather than as a mechanism: every line a reader could
// take for structure carries this render's marker; after the first structural
// line, a line carrying the marker is either structure or is visibly escaped;
// and removing one leading backslash from each line of a section's rendered
// block returns that section's summary byte for byte.
//
// What is NOT checked, because it is not what the boundary claims: that
// instruction-shaped text is absent. It travels on purpose.
func checkRestoreBoundary(s *suite) {
	manifest := obj(readJSON(fixturePath("manifest.json")))
	bannerLine := regexp.MustCompile(`^=== ` + regexp.QuoteMeta(restoreMark) + ` .+ ===$`)
	headingLine := regexp.MustCompile(`^## ` + regexp.QuoteMeta(restoreMark) + ` .+$`)

	restoreValue, _ := manifest.Get("restore")
	for _, entryValue := range restoreValue.([]any) {
		entry := obj(entryValue)
		name := str(entry, "name")
		doc := obj(readJSON(fixturePath(str(entry, "file"))))

		s.check("restore", handover.Validate(doc).Valid, fmt.Sprintf(
			"%s: an adversarial fixture must be a valid handover, or it is testing the validator instead", name))

		prompt := handover.BuildRestorePromptWithToken(doc, restoreToken)
		lines := strings.Split(prompt, "\n")

		unmarked := []string{}
		for _, line := range lines {
			if structureShapedLine.MatchString(line) && !strings.Contains(line, restoreMark) {
				unmarked = append(unmarked, line)
			}
		}
		s.check("restore", len(unmarked) == 0, fmt.Sprintf(
			"%s: %d line(s) read as structure without this render's marker, the first being %q",
			name, len(unmarked), first(unmarked)))

		firstStructural := -1
		for i, line := range lines {
			if bannerLine.MatchString(line) {
				firstStructural = i
				break
			}
		}
		borrowed := []string{}
		for _, line := range lines[firstStructural+1:] {
			if strings.Contains(line, restoreMark) &&
				!bannerLine.MatchString(line) &&
				!headingLine.MatchString(line) &&
				!strings.HasPrefix(line, "\\") {
				borrowed = append(borrowed, line)
			}
		}
		s.check("restore", len(borrowed) == 0, fmt.Sprintf(
			"%s: %d content line(s) carry the marker unescaped, the first being %q",
			name, len(borrowed), first(borrowed)))

		sectionsValue, _ := doc.Get("sections")
		sections := obj(sectionsValue)
		for _, key := range handover.SectionKeys {
			sectionValue, _ := sections.Get(key)
			section, ok := sectionValue.(*handover.Obj)
			if !ok || str(section, "status") != "available" || str(section, "summary") == "" {
				continue
			}
			summary := str(section, "summary")
			heading := "## " + restoreMark + " " + handover.SectionLabels[key]
			offset := 1
			if key == "restoreInstructions" {
				heading = "=== " + restoreMark + " BOOT PROMPT ==="
				offset = 2
			}
			anchor := -1
			for i, line := range lines {
				if line == heading {
					anchor = i + offset
					break
				}
			}
			s.check("restore", anchor > 0, fmt.Sprintf(
				"%s: the rendering has no marked heading for %s", name, key))
			if anchor < 0 {
				continue
			}
			summaryLines := strings.Split(summary, "\n")
			block := lines[anchor : anchor+len(summaryLines)]
			decoded := make([]string, len(block))
			for i, line := range block {
				decoded[i] = unescapeRestoreLine(line)
			}
			s.check("restore", strings.Join(decoded, "\n") == summary, fmt.Sprintf(
				"%s: the rendered block for %s does not decode back to the section's summary", name, key))
		}
	}
}

func first(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	return lines[0]
}

func checkDeterminism(s *suite) {
	doc := obj(readJSON(filepath.Join(root, "examples", "orchard-checkout.json")))
	once := handover.RenderSaved(doc, "#001")
	twice := handover.RenderSaved(doc, "#001")
	s.check("determinism", once == twice,
		"the renderer should return identical bytes for identical input")
	s.check("determinism",
		!regexp.MustCompile(`\d+\s*%`).MatchString(once) &&
			!regexp.MustCompile(`(?i)score`).MatchString(once),
		"a local save card should report counts, never a score")
}

func checkRecipe(s *suite) {
	// The recipe is complete, its text is byte-identical to the canonical
	// files in recipes/, and the recipe version travels with every document
	// the official writers produce.
	recipeFile, err := os.ReadFile(filepath.Join(root, "recipes", "handover-recipe-v1.txt"))
	if err != nil {
		panic(err)
	}
	s.check("recipe", handover.RenderRecipe() == string(recipeFile),
		"the SDK's rendered recipe must be byte-identical to recipes/handover-recipe-v1.txt, the single source of truth")
	rescueFile, err := os.ReadFile(filepath.Join(root, "recipes", "rescue-recipe-v1.txt"))
	if err != nil {
		panic(err)
	}
	s.check("recipe", handover.RescuePrompt+"\n" == string(rescueFile),
		"the SDK's rescue prompt must be byte-identical to recipes/rescue-recipe-v1.txt, the single source of truth")
	s.check("recipe", regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(handover.RecipeVersion),
		"the recipe version must be a semver string")

	// The recipe version travels, and it is never invented: an ingestion path
	// is handed a document somebody else wrote, so it may not attribute its
	// own recipe to that document. An input that already states one keeps it,
	// a stored document round-trips it untouched, and a document without one
	// is still valid.
	unstampedInput, _ := handover.ParseJSON([]byte(
		`{"projectId":"recipe-version","title":"Not stamped","createdAt":"` + aCaptureTime + `"}`))
	unstamped := normalize(unstampedInput)
	s.check("recipe", !unstamped.Has("source"),
		"normalization must not write its own recipeVersion onto a document it did not produce")
	keptInput, _ := handover.ParseJSON([]byte(
		`{"projectId":"recipe-version","title":"Kept","createdAt":"` + aCaptureTime + `",` +
			`"source":{"recipeVersion":"0.9.9"}}`))
	kept := normalize(keptInput)
	keptSource, _ := kept.Get("source")
	s.check("recipe", str(obj(keptSource), "recipeVersion") == "0.9.9",
		"an input that already states a recipeVersion must keep it untouched")

	home, _ := os.MkdirTemp("", "soil-recipe-version-")
	defer os.RemoveAll(home)
	store := handover.NewStore(home)
	example := obj(readJSON(filepath.Join(root, "examples", "orchard-checkout.json")))
	entry, err := store.Save(example)
	if err != nil {
		panic(err)
	}
	read, _ := store.Read(entry.Code)
	readSource, _ := read.Get("source")
	exampleSource, _ := example.Get("source")
	s.check("recipe",
		str(obj(readSource), "recipeVersion") == str(obj(exampleSource), "recipeVersion"),
		"a document's recipeVersion must round-trip through the store untouched")

	withoutOne := obj(readJSON(fixturePath(filepath.Join("valid", "thin-but-honest.json"))))
	s.check("recipe", !withoutOne.Has("source") && handover.Validate(withoutOne).Valid,
		"a document without a recipeVersion is still valid: other writers may lack one")

	recipe := handover.BuildRecipe()
	allGuided := true
	for _, key := range handover.SectionKeys {
		if len(handover.SectionGuidance[key]) <= 200 {
			allGuided = false
		}
	}
	s.check("recipe", allGuided, "every one of the 17 sections needs real guidance, not a label")
	s.check("recipe", len(handover.SharedRules) == 6,
		"the recipe should carry the opening rule and RULES 1 to 5")
	s.check("recipe", len(recipe.Instructions) == len(handover.SharedRules)+5,
		"the instruction block should be the rules, the lens, the framing and the close")
	for _, rule := range []string{"RULE 1", "RULE 2", "RULE 3", "RULE 4", "RULE 5"} {
		found := false
		for _, text := range handover.SharedRules {
			if strings.HasPrefix(text, rule) {
				found = true
			}
		}
		s.check("recipe", found, fmt.Sprintf("%s should be present verbatim", rule))
	}
}

// checkClosedWorld exercises the closed-world contract, and the one invariant
// that follows from it: a save path and a validation of the same bytes give
// the same verdict.
//
// Version one is closed. The top-level field set, the section field set and
// the eleven provenance labels are fixed, and a reader refuses anything
// outside them. A normalizing implementation therefore may not delete unknown
// content to make a document acceptable, because then the same bytes are
// rejected by Validate and accepted by Save. It may not invent the facts a
// reader depends on either: the capture time, the recipe attribution and the
// declared version are all claims only their real author is in a position to
// make.
func checkClosedWorld(s *suite) {
	canonical := obj(readJSON(fixturePath("valid/version-exactly-supported.json")))

	// Support is a set of exact versions, not a pattern over the 1.x line.
	s.check("closed-world", handover.Validate(canonical).Valid,
		"a document at exactly the supported version must validate")
	for _, unsupported := range []string{"0.9", "1.1", "1.10", "2.0", "1", "1.0.0", ""} {
		candidate := canonical.Clone()
		candidate.Set("soilHandover", unsupported)
		s.check("closed-world", hasIssueAt(handover.Validate(candidate), locationOf("/soilHandover")),
			fmt.Sprintf("an unsupported format version %q must be refused at /soilHandover,"+
				" never inferred from the shape of the string", unsupported))
	}

	baseSections, _ := canonical.Get("sections")
	sectionsOf := func(extra string) *handover.Obj {
		merged := obj(baseSections).Clone()
		overlay := obj(parseOrPanic(extra))
		for _, key := range overlay.Keys() {
			value, _ := overlay.Get(key)
			merged.Set(key, value)
		}
		return merged
	}

	unknownContent := []struct {
		what  string
		build func() *handover.Obj
		path  string
	}{
		{"an unknown top-level field", func() *handover.Obj {
			d := canonical.Clone()
			d.Set("grade", 0.92)
			return d
		}, "/grade"},
		{"an unknown field on a section", func() *handover.Obj {
			d := canonical.Clone()
			d.Set("sections", sectionsOf(
				`{"decisions":{"status":"missing","summary":null,"confidence":0.4}}`))
			return d
		}, "/sections/decisions/confidence"},
		{"an unknown section key", func() *handover.Obj {
			d := canonical.Clone()
			d.Set("sections", sectionsOf(`{"vibes":{"status":"available","summary":"Good."}}`))
			return d
		}, "/sections/vibes"},
		{"a provenance label outside the eleven", func() *handover.Obj {
			d := canonical.Clone()
			d.Set("sections", sectionsOf(`{"decisions":{"status":"available","summary":"One.",`+
				`"provenance":["repo_verified","vibe_checked"]}}`))
			return d
		}, "/sections/decisions/provenance/1"},
		{"an unknown member of source", func() *handover.Obj {
			d := canonical.Clone()
			d.Set("source", parseOrPanic(`{"client":"a-tool","temperature":0.7}`))
			return d
		}, "/source/temperature"},
	}

	for _, c := range unknownContent {
		document := c.build()
		s.check("closed-world", hasIssueAt(handover.Validate(document), locationOf(c.path)),
			fmt.Sprintf("%s must be refused at %s", c.what, c.path))
		s.check("closed-world", hasIssueAt(handover.Validate(normalize(document)), locationOf(c.path)),
			fmt.Sprintf("%s must survive normalization and still be refused at %s:"+
				" a save that strips it and a validation that refuses it are two"+
				" answers about the same bytes", c.what, c.path))
	}

	// Nothing is invented. Each of these was measured being stamped in.
	bare := normalize(parseOrPanic(`{"projectId":"invents-nothing","title":"Invents nothing"}`))
	s.check("closed-world", !bare.Has("createdAt"),
		"normalization must not supply a createdAt the document does not carry:"+
			" it is the anchor every frontier section is read against")
	identified := bare.Clone()
	identified.Set("handoverId", aValidID)
	s.check("closed-world", hasIssueAt(handover.Validate(identified), locationOf("/createdAt")),
		"a document with no createdAt must be refused, not completed")
	s.check("closed-world", !bare.Has("source"),
		"normalization must not attribute its own recipe to a document it did not produce")

	for _, declared := range []string{"1.7", "2.0", "0.9"} {
		candidate := canonical.Clone()
		candidate.Set("soilHandover", declared)
		s.check("closed-world", str(normalize(candidate), "soilHandover") == declared,
			fmt.Sprintf("normalization must leave a declared version %q exactly as written,"+
				" neither upgrading nor downgrading it", declared))
	}

	// A malformed identifier is refused rather than replaced. Dropping it here
	// is what let a writer mint a fresh one over the top of it.
	for _, malformed := range []any{parseOrPanic("42"), "handover-42", ""} {
		candidate := canonical.Clone()
		candidate.Set("handoverId", malformed)
		carried := normalize(candidate)
		s.check("closed-world",
			carried.Has("handoverId") && hasIssueAt(handover.Validate(carried), locationOf("/handoverId")),
			"a malformed handoverId must reach validation and be refused there,"+
				" never be dropped and replaced")
	}
}

func parseOrPanic(text string) any {
	value, err := handover.ParseJSON([]byte(text))
	if err != nil {
		panic(err)
	}
	return value
}

func main() {
	s := newSuite()
	checkFixtures(s)
	checkIngestionBoundary(s)
	checkTextUnit(s)
	checkIdentity(s)
	checkObservations(s)
	checkSecretScan(s)
	checkNormalization(s)
	checkClosedWorld(s)
	checkStoreAndRestore(s)
	checkRestoreBoundary(s)
	checkDeterminism(s)
	checkRecipe(s)

	// The two classes are reported separately, always. A single green blob
	// would let a writer claim the safety behaviour it never proved.
	fmt.Println("soil conformance (go, spec 1.0)")
	fmt.Printf("Soil Document Conformant       %d checks\n", s.checksByClass[classDocument])
	fmt.Printf("Soil Secure Writer Conformant  %d checks\n", s.checksByClass[classSecureWriter])
	if len(s.failures) > 0 {
		fmt.Printf("\n%d of %d checks failed\n\n", len(s.failures), s.checks)
		for _, f := range s.failures {
			fmt.Printf("  [%s/%s] %s\n", f.class, f.category, f.detail)
		}
		fmt.Println()
		os.Exit(1)
	}
}
