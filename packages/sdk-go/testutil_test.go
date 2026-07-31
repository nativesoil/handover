package handover

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

var testNow = time.Date(2026, 7, 22, 10, 0, 0, 0, time.UTC)

const aValidID = "019f7e89-fc00-7000-8000-000000000000"

// parse parses a JSON literal into the ordered model, failing the test on
// any error.
func parse(t *testing.T, text string) any {
	t.Helper()
	value, err := ParseJSON([]byte(text))
	if err != nil {
		t.Fatalf("ParseJSON: %v", err)
	}
	return value
}

func parseObj(t *testing.T, text string) *Obj {
	t.Helper()
	obj, ok := parse(t, text).(*Obj)
	if !ok {
		t.Fatalf("expected an object")
	}
	return obj
}

// testSections returns all 17 sections declared missing.
func testSections(t *testing.T) *Obj {
	t.Helper()
	sections := NewObj()
	for _, key := range SectionKeys {
		sections.Set(key, parseObj(t, `{"status":"missing","summary":null}`))
	}
	return sections
}

// testHandover returns a minimal valid handover.
func testHandover(t *testing.T) *Obj {
	t.Helper()
	doc := NewObj()
	doc.Set("soilHandover", "1.0")
	doc.Set("handoverId", aValidID)
	doc.Set("projectId", "test-project")
	doc.Set("title", "A handover")
	doc.Set("createdAt", "2026-07-20T08:00:00Z")
	doc.Set("sections", testSections(t))
	return doc
}

func issuePaths(result ValidationResult) []string {
	paths := make([]string, len(result.Issues))
	for i, issue := range result.Issues {
		paths[i] = issue.Path
	}
	return paths
}

func containsString(list []string, wanted string) bool {
	for _, item := range list {
		if item == wanted {
			return true
		}
	}
	return false
}

func readRepoFile(t *testing.T, relative string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", relative))
	if err != nil {
		t.Fatalf("reading %s: %v", relative, err)
	}
	return string(data)
}

func readTestdata(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("reading testdata/%s: %v", name, err)
	}
	return string(data)
}

func orchardExample(t *testing.T) *Obj {
	t.Helper()
	return parseObj(t, readRepoFile(t, filepath.Join("examples", "orchard-checkout.json")))
}

func findingLabels(findings []SecretFinding) []string {
	labels := make([]string, len(findings))
	for i, finding := range findings {
		labels[i] = finding.Label
	}
	return labels
}
