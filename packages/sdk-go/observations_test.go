// The extension point, tested from the angle that matters: a reader meeting a
// producer it has never heard of.
package handover

import (
	"testing"
)

func withObservations(t *testing.T, observationsJSON string) *Obj {
	t.Helper()
	return norm(parseObj(t, `{
	  "handoverId": "`+aValidID+`",
	  "projectId": "extension-test",
	  "title": "Extension point",
	  "createdAt": "2026-07-22T10:00:00Z",
	  "sections": {"executiveSummary": "A project."},
	  "observations": `+observationsJSON+`
	}`))
}

func TestObservationsAreOptional(t *testing.T) {
	doc := norm(parseObj(t, `{
	  "handoverId": "`+aValidID+`",
	  "projectId": "none", "title": "None", "createdAt": "2026-07-22T10:00:00Z",
	  "sections": {"decisions": "one"}
	}`))
	if doc.Has("observations") {
		t.Fatal("no observations in, no observations out")
	}
	if !Validate(doc).Valid {
		t.Fatal("a handover without observations is complete")
	}
}

func TestObservationsAcceptUnknownKinds(t *testing.T) {
	doc := withObservations(t, `[{"kind":"com.example.kind.from.the.future","data":{"anything":[1,2]}}]`)
	if !Validate(doc).Valid {
		t.Fatal("an unknown kind must be accepted, never treated as an error")
	}
}

func TestObservationsPassThroughNormalizationUnchanged(t *testing.T) {
	entriesJSON := `[
	  {"kind":"com.example.measurement","producedBy":"example-service 3.2",
	   "producedAt":"2026-07-20T09:00:00Z","data":{"nested":{"deeply":{"value":4}}}},
	  {"kind":"dev.example.annotation","data":{}}
	]`
	doc := withObservations(t, entriesJSON)
	observations, _ := doc.Get("observations")
	if MarshalJSONCompact(observations) != MarshalJSONCompact(parse(t, entriesJSON)) {
		t.Fatal("normalization must not interpret, filter or reorder observations")
	}
}

func TestObservationsDoNotChangeHowSectionsAreRead(t *testing.T) {
	base := norm(parseObj(t, `{
	  "projectId": "extension-test", "title": "Extension point",
	  "createdAt": "2026-07-22T10:00:00Z",
	  "sections": {"executiveSummary": "A project.", "decisions": "One decision."}
	}`))
	observed := base.Clone()
	observed.Set("observations", parse(t, `[{"kind":"com.example.anything","data":{"score":11}}]`))
	// A fixed boundary token, because production takes a fresh one from the
	// platform's cryptographic source on every render and the point here is
	// the sections, not the boundary.
	if BuildRestorePromptWithToken(observed, testBoundaryToken) !=
		BuildRestorePromptWithToken(base, testBoundaryToken) {
		t.Fatal("observations must not change how the 17 sections are read")
	}
}

func TestObservationsRejectExtraEnvelopeKey(t *testing.T) {
	result := Validate(withObservations(t, `[{"kind":"a.kind","data":{},"extra":"no"}]`))
	if result.Valid || result.Issues[0].Path != "/observations/0/extra" {
		t.Fatalf("expected an issue at /observations/0/extra, got %v", result.Issues)
	}
}

func TestObservationsRejectMissingKindOrData(t *testing.T) {
	result := Validate(withObservations(t, `[{"data":{}}]`))
	if result.Valid || result.Issues[0].Path != "/observations/0/kind" {
		t.Fatalf("expected an issue at /observations/0/kind, got %v", result.Issues)
	}
	result = Validate(withObservations(t, `[{"kind":"a.kind"}]`))
	if result.Valid || result.Issues[0].Path != "/observations/0/data" {
		t.Fatalf("expected an issue at /observations/0/data, got %v", result.Issues)
	}
}

func TestObservationsRejectBadProducedAt(t *testing.T) {
	result := Validate(withObservations(t, `[{"kind":"a.kind","producedAt":"recently","data":{}}]`))
	if result.Valid || result.Issues[0].Path != "/observations/0/producedAt" {
		t.Fatalf("expected an issue at /observations/0/producedAt, got %v", result.Issues)
	}
}

func TestObservationsRejectNonArray(t *testing.T) {
	if Validate(withObservations(t, `{"kind":"a.kind","data":{}}`)).Valid {
		t.Fatal("observations must be an array")
	}
}

func TestObservationsAreCoveredByTheSecretScan(t *testing.T) {
	doc := withObservations(t, `[{"kind":"com.example.measurement",
	  "data":{"call":{"header":"Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e"}}}]`)
	findings := FindSecretMaterial(doc)
	if len(findings) == 0 || findings[0].Path != "/observations/0/data/call/header" {
		t.Fatalf("expected a finding inside data, got %v", findings)
	}
	result := Validate(doc)
	if result.Valid || result.Issues[0].Kind != IssueSafety {
		t.Fatalf("expected a safety refusal, got %v", result.Issues)
	}
}
