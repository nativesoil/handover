package handover

import (
	"strings"
	"testing"
)

func withSection(t *testing.T, text string) *Obj {
	t.Helper()
	input := NewObj()
	input.Set("handoverId", aValidID)
	input.Set("projectId", "secret-test")
	input.Set("title", "Secrets")
	input.Set("createdAt", "2026-07-22T10:00:00Z")
	sections := NewObj()
	sections.Set("architecture", text)
	input.Set("sections", sections)
	return norm(input)
}

func TestScanCatchesProviderAPIKey(t *testing.T) {
	findings := FindSecretMaterial(withSection(t, "The key is sk-abc123def456 and it is in the env."))
	if !containsString(findingLabels(findings), "provider_api_key") {
		t.Fatalf("expected provider_api_key, got %v", findings)
	}
	if findings[0].Path != "/sections/architecture/summary" {
		t.Fatalf("unexpected path %s", findings[0].Path)
	}
}

func TestScanCatchesJWT(t *testing.T) {
	findings := FindSecretMaterial(withSection(t, "Session token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def"))
	if !containsString(findingLabels(findings), "jwt") {
		t.Fatalf("expected jwt, got %v", findings)
	}
}

func TestScanCatchesBearerAndAuthorizationHeader(t *testing.T) {
	labels := findingLabels(FindSecretMaterial(
		withSection(t, "Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e")))
	if !containsString(labels, "authorization_header") || !containsString(labels, "bearer_token") {
		t.Fatalf("expected both header classes, got %v", labels)
	}
}

func TestScanCatchesVendorTokenFormats(t *testing.T) {
	for _, text := range []string{
		"clone https://ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/o/r.git",
		"the runner env holds AKIAIOSFODNN7EXAMPLE",
		"the bot posts with xoxb-2314789012-4567890123456-AbCdEfGhIjKlMnOpQrStUvWx",
		"maps is keyed with AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
		"the fine-grained token is github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789",
	} {
		labels := findingLabels(FindSecretMaterial(withSection(t, text)))
		if !containsString(labels, "provider_api_key") {
			t.Fatalf("expected provider_api_key for %q, got %v", text, labels)
		}
	}
}

func TestScanCatchesURLCredentials(t *testing.T) {
	labels := findingLabels(FindSecretMaterial(
		withSection(t, "postgres://orchard:9f8a7b6c5d4e3f@db.internal:5432/orchard")))
	if !containsString(labels, "url_credentials") {
		t.Fatalf("expected url_credentials, got %v", labels)
	}
}

// The precedence rule: a redaction claim never suppresses a detection in the
// same string. The conjunction is refused under the detected class.
func TestScanRefusesAValueUnderARedactionClaim(t *testing.T) {
	labels := findingLabels(FindSecretMaterial(withSection(t,
		"The token was redacted: ghp_16C7e42F292c6912E7710c838347Ae178B4a is gone.")))
	if !containsString(labels, "provider_api_key") {
		t.Fatalf("expected provider_api_key, got %v", labels)
	}
}

func TestScanCatchesPEMPrivateKey(t *testing.T) {
	labels := findingLabels(FindSecretMaterial(withSection(t, "-----BEGIN RSA PRIVATE KEY-----")))
	if !containsString(labels, "private_key_pem") {
		t.Fatalf("expected private_key_pem, got %v", labels)
	}
}

func TestScanCatchesPrivatePaths(t *testing.T) {
	for _, path := range []string{
		"/Users/casey/Developer/thing",
		"/home/deploy/app/config",
		`C:\Users\casey\project`,
	} {
		labels := findingLabels(FindSecretMaterial(withSection(t, "It lives at "+path+".")))
		if !containsString(labels, "private_path") {
			t.Fatalf("expected private_path for %s, got %v", path, labels)
		}
	}
}

func TestScanCatchesClientSecretAndCredentialsBoundToAValue(t *testing.T) {
	labels := findingLabels(FindSecretMaterial(
		withSection(t, `the app reads client_secret="9f8a7b6c5d4e3f2a1b0c"`)))
	if !containsString(labels, "client_secret") {
		t.Fatalf("expected client_secret, got %v", labels)
	}
	labels = findingLabels(FindSecretMaterial(
		withSection(t, "GOOGLE_APPLICATION_CREDENTIALS=/opt/keys/orchard-sa.json")))
	if !containsString(labels, "google_application_credentials") {
		t.Fatalf("expected google_application_credentials, got %v", labels)
	}
	labels = findingLabels(FindSecretMaterial(
		withSection(t, `the runner loads {"type": "service_account", "project_id": "x"}`)))
	if !containsString(labels, "google_application_credentials") {
		t.Fatalf("expected google_application_credentials, got %v", labels)
	}
}

// The safe near-neighbour of every class. Refusing any of these would make
// the format contradict its own section requirements: architecture asks for
// flag and command names quoted exactly, and safetySummary asks for what was
// withheld and where it is configured.
func TestScanAcceptsTheSafeNearNeighbours(t *testing.T) {
	for _, text := range []string{
		"The service uses an Authorization header.",
		"GOOGLE_APPLICATION_CREDENTIALS is set outside the handover.",
		"The client_secret value was intentionally omitted.",
		"A provider API key exists and is set in the deployment platform.",
		"The endpoint expects bearer credentials; the token is not carried here.",
		"Login returns a JWT; the value is not carried here.",
		"The signing key is a PEM private key held in the platform's secret manager.",
		"The CI job reads a GitHub token from the repository secrets.",
		"Run `soil save --project orchard`; SOIL_HOME selects the store and PORT defaults to 3000.",
		"Send it as `Authorization: Bearer <token>`.",
		`curl -H "Authorization: Bearer $TOKEN" https://api.example.com`,
		"The config template ships client_secret=YOUR_CLIENT_SECRET.",
		"GOOGLE_APPLICATION_CREDENTIALS=REDACTED",
		"The URL is documented as postgres://app:password@db.internal:5432/app.",
		"Initialised /home/ada/.soil-server.",
		`The container mounts { "SOIL_HOME": "/home/agent/.soil" }.`,
		`On Windows it is C:\Users\user\.soil.`,
	} {
		if !IsFreeOfSecretMaterial(withSection(t, text)) {
			t.Fatalf("must stay valid: %q -> %v",
				text, findingLabels(FindSecretMaterial(withSection(t, text))))
		}
	}
}

func TestScanFindsMaterialAnywhere(t *testing.T) {
	input := NewObj()
	input.Set("projectId", "secret-test")
	input.Set("title", "Secrets")
	input.Set("createdAt", "2026-07-22T10:00:00Z")
	input.Set("safety", parseObj(t, `{"unsafeOmissions":["the key sk-abc123 was withheld"]}`))
	doc := norm(input)
	findings := FindSecretMaterial(doc)
	if len(findings) == 0 || findings[0].Path != "/safety/unsafeOmissions/0" {
		t.Fatalf("expected a finding at /safety/unsafeOmissions/0, got %v", findings)
	}
}

func TestScanLeavesOrdinaryHandoverAlone(t *testing.T) {
	doc := withSection(t,
		"A provider API key exists and is set in the deployment platform. Its value is not carried here. The app listens on port 3000.")
	if !IsFreeOfSecretMaterial(doc) {
		t.Fatal("naming a secret without its value must pass")
	}
}

func TestScanIgnoresRelativePathsAndURLs(t *testing.T) {
	doc := withSection(t, "See src/checkout/window.ts and https://example.com/docs")
	if !IsFreeOfSecretMaterial(doc) {
		t.Fatal("relative paths and public URLs must pass")
	}
}

func TestDescribeSecretFindingNeverEchoes(t *testing.T) {
	findings := FindSecretMaterial(withSection(t, "key sk-supersecret999"))
	if len(findings) == 0 {
		t.Fatal("expected a finding")
	}
	message := DescribeSecretFinding(findings[0])
	if !strings.Contains(message, "provider_api_key") || !strings.Contains(message, "where it is configured") {
		t.Fatalf("unexpected message: %s", message)
	}
	if strings.Contains(message, "supersecret") {
		t.Fatal("the message must not echo the matched value")
	}
}

func TestCheckNoSecretMaterialFailsClosed(t *testing.T) {
	if err := CheckNoSecretMaterial(withSection(t, "nothing secret")); err != nil {
		t.Fatalf("a clean document must pass, got %v", err)
	}
	err := CheckNoSecretMaterial(withSection(t, "token eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.zzz"))
	secretErr, ok := err.(*SecretMaterialError)
	if !ok {
		t.Fatalf("expected a *SecretMaterialError, got %T", err)
	}
	if strings.Contains(secretErr.Error(), "eyJhbGciOiJIUzI1NiJ9") {
		t.Fatal("the error must never carry the value")
	}
	if !strings.Contains(secretErr.Error(), "jwt") {
		t.Fatalf("the error must name the class, got %s", secretErr.Error())
	}
}

func TestValidateRefusesStructurallyPerfectLeak(t *testing.T) {
	result := Validate(withSection(t, "key: sk-abc123def"))
	if result.Valid {
		t.Fatal("a handover carrying a key must be refused")
	}
	if result.Issues[0].Kind != IssueSafety || result.Issues[0].Path != "/sections/architecture/summary" {
		t.Fatalf("expected a safety issue at the section, got %v", result.Issues)
	}
}

func TestValidateReportsSafetyAndStructureTogether(t *testing.T) {
	doc := withSection(t, "key: sk-abc123def")
	doc.Set("projectId", "")
	kinds := map[ValidationIssueKind]bool{}
	for _, issue := range Validate(doc).Issues {
		kinds[issue.Kind] = true
	}
	if !kinds[IssueStructure] || !kinds[IssueSafety] {
		t.Fatalf("expected both kinds, got %v", kinds)
	}
}
