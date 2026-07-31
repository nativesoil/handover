package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

const examplePath = "../../../../examples/orchard-checkout.json"

type recorder struct {
	out   bytes.Buffer
	err   bytes.Buffer
	stdin string
	home  string
}

func newRecorder(t *testing.T) *recorder {
	t.Helper()
	return &recorder{home: t.TempDir()}
}

func (r *recorder) env() Environment {
	return Environment{
		Stdout:   &r.out,
		Stderr:   &r.err,
		Stdin:    strings.NewReader(r.stdin),
		ReadFile: os.ReadFile,
		Getenv: func(name string) string {
			if name == "SOIL_HOME" {
				return r.home
			}
			return ""
		},
		Now: func() time.Time { return time.Date(2026, 7, 22, 10, 0, 0, 0, time.UTC) },
	}
}

func TestHelpWithNoArguments(t *testing.T) {
	io := newRecorder(t)
	if code := Run(nil, io.env()); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(io.out.String(), "save the project state") ||
		!strings.Contains(io.out.String(), "soil load") {
		t.Fatalf("unexpected help:\n%s", io.out.String())
	}
}

func TestWherePrintsTheStoreLocation(t *testing.T) {
	io := newRecorder(t)
	Run([]string{"where"}, io.env())
	if strings.TrimSpace(io.out.String()) != io.home {
		t.Fatalf("expected %s, got %s", io.home, io.out.String())
	}
}

func TestUnknownCommand(t *testing.T) {
	io := newRecorder(t)
	if code := Run([]string{"frobnicate"}, io.env()); code != 2 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(io.err.String(), `unknown command "frobnicate"`) {
		t.Fatalf("unexpected stderr:\n%s", io.err.String())
	}
}

func TestVersion(t *testing.T) {
	io := newRecorder(t)
	if code := Run([]string{"-v"}, io.env()); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if strings.TrimSpace(io.out.String()) != "0.1.0 (spec 1.0)" {
		t.Fatalf("unexpected version: %s", io.out.String())
	}
}

func TestSavePrintsTheRecipe(t *testing.T) {
	io := newRecorder(t)
	if code := Run([]string{"save"}, io.env()); code != 0 {
		t.Fatalf("exit %d", code)
	}
	for _, wanted := range []string{"SOIL HANDOVER EXTRACTION", "RULE 1", "restoreInstructions:", "soil save -"} {
		if !strings.Contains(io.out.String(), wanted) {
			t.Fatalf("expected %q in the recipe output", wanted)
		}
	}
}

func TestSaveFromFilePrintsTheCard(t *testing.T) {
	io := newRecorder(t)
	if code := Run([]string{"save", examplePath}, io.env()); code != 0 {
		t.Fatalf("exit %d: %s", code, io.err.String())
	}
	for _, wanted := range []string{"handover saved", "#001", "17 / 17 sections carrying content", "❯ soil load #001"} {
		if !strings.Contains(io.out.String(), wanted) {
			t.Fatalf("expected %q in:\n%s", wanted, io.out.String())
		}
	}
}

func TestSaveQuietPrintsOnlyTheCode(t *testing.T) {
	io := newRecorder(t)
	Run([]string{"save", examplePath, "--quiet"}, io.env())
	if strings.TrimSpace(io.out.String()) != "#001" {
		t.Fatalf("unexpected output: %s", io.out.String())
	}
}

func TestSaveReadsAModelReplyOnStdin(t *testing.T) {
	io := newRecorder(t)
	io.stdin = strings.Join([]string{
		"Here you go:",
		"```json",
		`{"projectId":"pasted","title":"Pasted from a thread","createdAt":"2026-07-22T10:00:00Z","extractionSections":{"decisions":"We chose plain files."}}`,
		"```",
	}, "\n")
	if code := Run([]string{"save", "-"}, io.env()); code != 0 {
		t.Fatalf("exit %d: %s", code, io.err.String())
	}
	if !strings.Contains(io.out.String(), "1 / 17 sections carrying content") {
		t.Fatalf("unexpected output:\n%s", io.out.String())
	}
}

func TestSaveFailsClosedOnASecret(t *testing.T) {
	io := newRecorder(t)
	io.stdin = `{"projectId":"leaky","title":"Leaky","createdAt":"2026-07-22T10:00:00Z","extractionSections":{"architecture":"The key is sk-abc123def456."}}`
	if code := Run([]string{"save", "-"}, io.env()); code != 1 {
		t.Fatalf("exit %d", code)
	}
	stderr := io.err.String()
	for _, wanted := range []string{
		"refused · secret material",
		"nothing was stored",
		"/sections/architecture/summary",
		"provider_api_key",
	} {
		if !strings.Contains(stderr, wanted) {
			t.Fatalf("expected %q in stderr:\n%s", wanted, stderr)
		}
	}
	if strings.Contains(stderr, "sk-abc123def456") {
		t.Fatal("the refusal must never echo the value")
	}
	if entries, err := os.ReadDir(filepath.Join(io.home, "handovers")); err == nil && len(entries) > 0 {
		t.Fatal("nothing may be stored on a refusal")
	}
}

func TestSaveSaysSoWhenThereIsNoJSON(t *testing.T) {
	io := newRecorder(t)
	io.stdin = "I would rather not"
	if code := Run([]string{"save", "-"}, io.env()); code != 1 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(io.err.String(), "no JSON found") {
		t.Fatalf("unexpected stderr: %s", io.err.String())
	}
}

func TestLoadPrintsCardThenRestorePrompt(t *testing.T) {
	io := newRecorder(t)
	Run([]string{"save", examplePath, "--quiet"}, io.env())
	io.out.Reset()
	if code := Run([]string{"load", "#001"}, io.env()); code != 0 {
		t.Fatalf("exit %d: %s", code, io.err.String())
	}
	// The boundary is generated per render, so the assertion is on the shape
	// of the marked banner rather than on a fixed delimiter.
	for _, pattern := range []string{
		`(?m)^=== soil:[0-9a-f]{32} BOOT PROMPT ===$`,
		`(?m)^=== soil:[0-9a-f]{32} KNOWN GAPS ===$`,
	} {
		if !regexp.MustCompile(pattern).MatchString(io.out.String()) {
			t.Fatalf("expected a line matching %s in the load output", pattern)
		}
	}
	for _, wanted := range []string{"handover loaded"} {
		if !strings.Contains(io.out.String(), wanted) {
			t.Fatalf("expected %q in:\n%s", wanted, io.out.String())
		}
	}
}

func TestLoadShowsTheRecordedWorkingStyleInstances(t *testing.T) {
	// The same store read by the Node CLI shows this block, so a binary that
	// left it out handed a loading model a different document from the same
	// bytes.
	const fixture = "../../../../conformance/fixtures/valid/observation-working-style.json"
	io := newRecorder(t)
	Run([]string{"save", fixture, "--quiet"}, io.env())
	io.out.Reset()
	if code := Run([]string{"load", "#001"}, io.env()); code != 0 {
		t.Fatalf("exit %d: %s", code, io.err.String())
	}
	pattern := `(?m)^=== soil:[0-9a-f]{32} WORKING STYLE, RECORDED INSTANCES ===$`
	if !regexp.MustCompile(pattern).MatchString(io.out.String()) {
		t.Fatalf("expected a line matching %s in the load output", pattern)
	}
	for _, wanted := range []string{
		"Evidence from example-recorder 2.0, recorded 2026-07-20T09:00:00Z:",
		"- Situation: A change would remove part of an existing UI",
	} {
		if !strings.Contains(io.out.String(), wanted) {
			t.Fatalf("expected %q in:\n%s", wanted, io.out.String())
		}
	}
}

func TestLoadDefaultsToTheMostRecent(t *testing.T) {
	io := newRecorder(t)
	Run([]string{"save", examplePath, "--quiet"}, io.env())
	io.out.Reset()
	Run([]string{"load"}, io.env())
	if !strings.Contains(io.out.String(), "#001") {
		t.Fatalf("expected the latest handover:\n%s", io.out.String())
	}
}

func TestLoadJSONPrintsTheRawDocument(t *testing.T) {
	io := newRecorder(t)
	Run([]string{"save", examplePath, "--quiet"}, io.env())
	io.out.Reset()
	Run([]string{"load", "#001", "--json"}, io.env())
	var doc map[string]any
	if err := json.Unmarshal(io.out.Bytes(), &doc); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	if doc["code"] != "#001" {
		t.Fatalf("expected the code, got %v", doc["code"])
	}
}

func TestLoadPointsAtListWhenTheCodeDoesNotExist(t *testing.T) {
	io := newRecorder(t)
	if code := Run([]string{"load", "#404"}, io.env()); code != 1 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(io.err.String(), "soil list") {
		t.Fatalf("unexpected stderr: %s", io.err.String())
	}
}

func TestListSaysEmpty(t *testing.T) {
	io := newRecorder(t)
	Run([]string{"list"}, io.env())
	if !strings.Contains(io.out.String(), "nothing saved yet") {
		t.Fatalf("unexpected output:\n%s", io.out.String())
	}
}

func TestListNewestFirst(t *testing.T) {
	io := newRecorder(t)
	Run([]string{"save", examplePath, "--quiet"}, io.env())
	Run([]string{"save", examplePath, "--quiet"}, io.env())
	io.out.Reset()
	Run([]string{"list"}, io.env())
	out := io.out.String()
	if !(strings.Index(out, "#002") < strings.Index(out, "#001")) {
		t.Fatalf("expected newest first:\n%s", out)
	}
}

func TestValidatePassesTheWorkedExample(t *testing.T) {
	io := newRecorder(t)
	if code := Run([]string{"validate", examplePath}, io.env()); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(io.out.String(), "valid handover") {
		t.Fatalf("unexpected output:\n%s", io.out.String())
	}
}

func TestValidateFailsAndListsProblems(t *testing.T) {
	io := newRecorder(t)
	io.stdin = `{"soilHandover":"1.0"}`
	if code := Run([]string{"validate", "-"}, io.env()); code != 1 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(io.out.String(), "/projectId") {
		t.Fatalf("unexpected output:\n%s", io.out.String())
	}
}

func TestValidateNeedsAnArgument(t *testing.T) {
	io := newRecorder(t)
	if code := Run([]string{"validate"}, io.env()); code != 2 {
		t.Fatalf("exit %d", code)
	}
}

func TestRenderAStoredHandover(t *testing.T) {
	io := newRecorder(t)
	Run([]string{"save", examplePath, "--quiet"}, io.env())
	io.out.Reset()
	if code := Run([]string{"render", "#001"}, io.env()); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(io.out.String(), "handover loaded") {
		t.Fatalf("unexpected output:\n%s", io.out.String())
	}
}

func TestRenderFromAFile(t *testing.T) {
	io := newRecorder(t)
	if code := Run([]string{"render", examplePath}, io.env()); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(io.out.String(), "17 / 17 sections carrying content") {
		t.Fatalf("unexpected output:\n%s", io.out.String())
	}
}

func TestRescuePrintsThePrompt(t *testing.T) {
	io := newRecorder(t)
	if code := Run([]string{"rescue"}, io.env()); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(io.out.String(), "Output ONE fenced") ||
		!strings.Contains(io.out.String(), "extractionSections") {
		t.Fatalf("unexpected output:\n%s", io.out.String())
	}
}
