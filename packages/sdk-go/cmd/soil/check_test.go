// soil check, driven through the real command paths.

package main

import (
	"strings"
	"testing"

	handover "github.com/nativesoil/handover/packages/sdk-go"
)

func saveExample(t *testing.T, io *recorder) string {
	t.Helper()
	if code := Run([]string{"save", examplePath, "--quiet"}, io.env()); code != 0 {
		t.Fatalf("save exited %d: %s", code, io.err.String())
	}
	saved := strings.TrimSpace(io.out.String())
	io.out.Reset()
	return saved
}

func TestCheckGradesAStoredHandover(t *testing.T) {
	io := newRecorder(t)
	code := saveExample(t, io)
	if exit := Run([]string{"check", code}, io.env()); exit != 0 {
		t.Fatalf("exit %d: %s", exit, io.err.String())
	}
	out := io.out.String()
	for _, wanted := range []string{"handover checked", "grade", "only a real load"} {
		if !strings.Contains(out, wanted) {
			t.Fatalf("expected %q:\n%s", wanted, out)
		}
	}
}

func TestCheckCardMatchesTheLibraryRenderer(t *testing.T) {
	io := newRecorder(t)
	code := saveExample(t, io)
	if exit := Run([]string{"check", code}, io.env()); exit != 0 {
		t.Fatalf("exit %d: %s", exit, io.err.String())
	}
	store := handover.NewStore(io.home)
	doc, err := store.Read(code)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	want := handover.RenderCheck(doc, handover.CheckHandover(doc)) + "\n"
	if io.out.String() != want {
		t.Fatalf("the CLI card must be the library card:\n%s", io.out.String())
	}
}

func TestCheckJSONPrintsTheReport(t *testing.T) {
	io := newRecorder(t)
	code := saveExample(t, io)
	if exit := Run([]string{"check", code, "--json"}, io.env()); exit != 0 {
		t.Fatalf("exit %d: %s", exit, io.err.String())
	}
	out := io.out.String()
	for _, wanted := range []string{`"checkVersion"`, `"grade"`, `"findings"`} {
		if !strings.Contains(out, wanted) {
			t.Fatalf("expected %q:\n%s", wanted, out)
		}
	}
}

func TestCheckExitCodeFollowsTheGrade(t *testing.T) {
	io := newRecorder(t)
	// The thin fixture grades thin, so the exit code is 1: CI can gate on it.
	if exit := Run([]string{
		"check", "../../../../conformance/fixtures/valid/thin-but-honest.json",
	}, io.env()); exit != 1 {
		t.Fatalf("a thin document must exit 1, got %d", exit)
	}
	if !strings.Contains(io.out.String(), "thin") {
		t.Fatalf("expected the thin band:\n%s", io.out.String())
	}
}

func TestCheckWithoutATargetIsAUsageError(t *testing.T) {
	io := newRecorder(t)
	if exit := Run([]string{"check"}, io.env()); exit != 2 {
		t.Fatalf("exit %d", exit)
	}
	if !strings.Contains(io.err.String(), "give a load code") {
		t.Fatalf("unexpected stderr:\n%s", io.err.String())
	}
}

func TestCheckAttachWritesAQualityCaptureObservation(t *testing.T) {
	io := newRecorder(t)
	code := saveExample(t, io)
	if exit := Run([]string{"check", code, "--attach"}, io.env()); exit != 0 {
		t.Fatalf("exit %d: %s", exit, io.err.String())
	}
	if !strings.Contains(io.out.String(), "report attached to "+code) {
		t.Fatalf("expected the attach note:\n%s", io.out.String())
	}
	store := handover.NewStore(io.home)
	doc, err := store.Read(code)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	observationsValue, _ := doc.Get("observations")
	observations, ok := observationsValue.([]any)
	if !ok || len(observations) != 1 {
		t.Fatalf("expected one attached observation, got %v", observationsValue)
	}
	// The payload carries the closed field set and never the band; the check
	// itself is byte-pinned in the SDK's corpus tests.
	serialized := handover.MarshalJSONIndent(observations[0])
	if !strings.Contains(serialized, `"quality.capture"`) ||
		!strings.Contains(serialized, `"producedBy": "soil-cli/0.2.0"`) {
		t.Fatalf("unexpected observation:\n%s", serialized)
	}
	for _, band := range handover.CheckGrades {
		if strings.Contains(serialized, `"`+band+`"`) {
			t.Fatalf("the stored payload must not carry the band %q", band)
		}
	}
}

func TestCheckAttachNeedsAStoredHandover(t *testing.T) {
	io := newRecorder(t)
	if exit := Run([]string{"check", examplePath, "--attach"}, io.env()); exit != 2 {
		t.Fatalf("exit %d", exit)
	}
	if !strings.Contains(io.err.String(), "--attach needs a stored handover") {
		t.Fatalf("unexpected stderr:\n%s", io.err.String())
	}
}

func TestCheckRefusesAnInvalidFile(t *testing.T) {
	io := newRecorder(t)
	io.stdin = `{"soilHandover": "1.0"}`
	if exit := Run([]string{"check", "-"}, io.env()); exit != 1 {
		t.Fatalf("exit %d", exit)
	}
	if !strings.Contains(io.err.String(), "not a handover") {
		t.Fatalf("unexpected stderr:\n%s", io.err.String())
	}
}

func TestHelpNamesCheck(t *testing.T) {
	io := newRecorder(t)
	Run([]string{"--help"}, io.env())
	out := io.out.String()
	if !strings.Contains(out, "soil check <#NNN|file|->") ||
		!strings.Contains(out, "--attach") {
		t.Fatalf("the help must name check:\n%s", out)
	}
	if strings.Contains(out, "not in this release") {
		t.Fatalf("the old gap statement survived:\n%s", out)
	}
}
