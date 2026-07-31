// The pre-schema ingestion boundary.
//
// Parity with the other four surfaces is asserted by the shared fixture corpus
// in conformance/fixtures/boundary; these are the cases that corpus does not
// carry, plus the store path that has to go through the same door.

package handover

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// verdict is the code and location of a refusal, or "accepted".
func verdict(data []byte) string {
	_, issue := IngestBytes(data)
	if issue == nil {
		return "accepted"
	}
	return issue.Code + " " + issue.Path
}

func nested(levels int) []byte {
	return []byte(strings.Repeat(`{"n":`, levels-1) + "{}" + strings.Repeat("}", levels-1))
}

func padded(total int) []byte {
	return []byte(`{"pad":"` + strings.Repeat("x", total-10) + `"}`)
}

func TestIngestRefusesAByteOrderMarkAndNamesTheEncoding(t *testing.T) {
	_, issue := IngestBytes(append([]byte{0xEF, 0xBB, 0xBF}, []byte("{}")...))
	if issue == nil || issue.Code != CodeEncodingByteOrderMark {
		t.Fatalf("expected a byte order mark refusal, got %v", issue)
	}
	if !strings.Contains(issue.Message, "UTF-8") {
		t.Fatalf("the message should name the encoding, got %q", issue.Message)
	}
}

func TestIngestNamesUTF32LERatherThanTheUTF16LEMarkItStartsWith(t *testing.T) {
	_, issue := IngestBytes([]byte{0xFF, 0xFE, 0x00, 0x00})
	if issue == nil || !strings.Contains(issue.Message, "UTF-32LE") {
		t.Fatalf("expected UTF-32LE to be named, got %v", issue)
	}
}

func TestIngestRefusesMalformedUTF8RatherThanRepairingIt(t *testing.T) {
	// Converting these bytes to a Go string succeeds and ranging over it
	// yields U+FFFD, which is a repair nobody asked for.
	got := verdict([]byte("{\"t\":\"caf\xe9\"}"))
	if got != "encoding.invalid_utf8 " {
		t.Fatalf("got %q", got)
	}
}

func TestIngestAcceptsValidMultibyteUTF8(t *testing.T) {
	if got := verdict([]byte(`{"t":"café · 引き継ぎ"}`)); got != "accepted" {
		t.Fatalf("the rule is about encodings, not about non-ASCII text: got %q", got)
	}
}

func TestIngestRefusesADuplicateMemberAndPointsAtIt(t *testing.T) {
	cases := map[string]string{
		`{"a":1,"a":2}`:               "structure.duplicate_member /a",
		`{"o":[{"d":{"n":1,"n":2}}]}`: "structure.duplicate_member /o/0/d/n",
		`{"a/b~c":1,"a/b~c":2}`:       "structure.duplicate_member /a~1b~0c",
	}
	for input, want := range cases {
		if got := verdict([]byte(input)); got != want {
			t.Errorf("%s: got %q, want %q", input, got, want)
		}
	}
}

func TestIngestAcceptsTheSameNameInTwoDifferentObjects(t *testing.T) {
	if got := verdict([]byte(`{"x":{"status":1},"y":{"status":2}}`)); got != "accepted" {
		t.Fatalf("got %q", got)
	}
}

func TestIngestNeverEchoesTheRepeatedName(t *testing.T) {
	_, issue := IngestBytes([]byte(`{"secretish":1,"secretish":2}`))
	if issue == nil || strings.Contains(issue.Message, "secretish") {
		t.Fatalf("a refusal must not echo document content, got %v", issue)
	}
}

func TestIngestReportsSyntaxBeforeDuplicatesOnMalformedInput(t *testing.T) {
	if got := verdict([]byte(`{"a":1,"a":2`)); got != "syntax.invalid_json " {
		t.Fatalf("got %q", got)
	}
}

func TestIngestDepthCeiling(t *testing.T) {
	if got := verdict(nested(MaxIngestDepth)); got != "accepted" {
		t.Fatalf("exactly at the ceiling must be accepted, got %q", got)
	}
	_, issue := IngestBytes(nested(MaxIngestDepth + 1))
	if issue == nil || issue.Code != CodeStructureDepthExceeded {
		t.Fatalf("one level over must be refused, got %v", issue)
	}
	if !strings.Contains(issue.Message, "33") {
		t.Fatalf("the message should state what it found, got %q", issue.Message)
	}
}

func TestIngestRefusesADocumentDeepEnoughToBreakARecursiveWalker(t *testing.T) {
	// 20000 levels. The decoder and the safety scan both recurse; the
	// boundary must answer with an issue rather than let the stack grow.
	_, issue := IngestBytes(nested(20000))
	if issue == nil || issue.Code != CodeStructureDepthExceeded {
		t.Fatalf("expected a depth refusal, got %v", issue)
	}
}

func TestIngestDoesNotCountBracesInsideStrings(t *testing.T) {
	if got := verdict([]byte(`{"a":"` + strings.Repeat("{", 200) + `"}`)); got != "accepted" {
		t.Fatalf("got %q", got)
	}
}

func TestIngestSizeCeiling(t *testing.T) {
	if got := verdict(padded(MaxIngestBytes)); got != "accepted" {
		t.Fatalf("exactly at the ceiling must be accepted, got %q", got)
	}
	if got := verdict(padded(MaxIngestBytes + 1)); got != "document.too_large " {
		t.Fatalf("got %q", got)
	}
}

func TestStoreReadsThroughTheBoundary(t *testing.T) {
	home := t.TempDir()
	store := NewStore(home)
	if err := store.Init(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(store.HandoversDir, "001.json")
	if err := os.WriteFile(path, append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"soilHandover":"1.0"}`)...), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Read("#001"); err == nil || !strings.Contains(err.Error(), "byte order mark") {
		t.Fatalf("the store must read through the boundary, got %v", err)
	}
}
