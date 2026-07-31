// The secret scan: a handover that carries credentials is not portable.
//
// A handover is written to be moved. It goes into a second model, often at a
// second vendor, sometimes into a teammate's session. Anything inside it has
// left the machine it was written on. So a document carrying an API key, a
// bearer token, a private key or a private absolute path is not a handover
// with a small problem, it is a credential in transit, and this
// implementation refuses to store one.
//
// The rule is fail-closed and it is normative: see spec/README.md. The
// detection classes, their required safe near-neighbours and their residual
// limitations are stated in spec/safety-patterns.md. It is a spec rule rather
// than a schema rule because JSON Schema cannot express "this string looks
// like a token", which is exactly why the conformance suite checks it
// separately.
//
// What this scan is and is not:
//
//   - It refuses transferable authentication material, not the subject of a
//     sentence. Naming a credential type, a header or an environment variable
//     without binding a value to it is safe and stays valid, because two of
//     the format's own section requirements ask for exactly that.
//   - It refuses that material wherever it appears: in an assignment, in a
//     URL, in a header, in a code block or in unstructured prose.
//   - It is not a guarantee. A secret with no recognisable shape passes, and
//     no scanner catches those. RULE 2 in the extraction recipe is the real
//     defense: carry the meaning, never the value. This is the net
//     underneath.
//   - It never echoes what it matched. A finding names the pattern class and
//     the section, never the value, because an error message is another place
//     a secret can end up.
//
// Two mechanisms, and the difference matters. Private-key armour, JWT shape
// and the vendor key prefixes are MENTION matches: there the mention is the
// leak. Authorization headers, client secrets, application-credentials and
// URL userinfo are VALUE-SHAPE matches: they fire only when a value is bound
// to the name. Private paths are a value-shape match with a closed exemption
// list of reserved principal names that documentation may use.
//
// Parity with the TypeScript SDK is a parity of OUTCOMES: the same inputs are
// refused with the same class reported. The expressions are not normative,
// and they are kept free of lookahead so this engine can run them unchanged.

package handover

import (
	"fmt"
	"regexp"
	"strings"
)

// valueClass holds the characters that can appear inside transferable
// authentication material. It deliberately excludes the punctuation that
// placeholder syntax is made of (`<`, `>`, `$`, `{`, `}`), so `Bearer
// <token>` and `client_secret=${VALUE}` never look like values at all.
const valueClass = `[A-Za-z0-9._~+/=-]`

// pathValueClass is the same, widened for a filesystem path or URI bound to a
// variable.
const pathValueClass = `[A-Za-z0-9._~+/=:\\-]`

// The bounded repetitions below cost THIS engine nothing. RE2 does not
// backtrack, so a repetition here is walked once whatever the subject: on
// 16000 characters of whitespace after `Authorization:`, measured, this
// package took 4 ms where Node took 633 ms, Python 2067 ms and the JVM
// 1986 ms. The bounds are here because the class is one taxonomy across five
// languages and the expressions stay in step, and because a port that reads
// this file as its reference must not copy an unbounded form onto a
// backtracking engine. The ceilings and what each gives up are documented in
// packages/sdk-ts/src/safety.ts.
const (
	// ows is the most whitespace allowed where a header permits optional
	// whitespace. HTTP writes one space or none.
	ows = `[ \t]{0,32}`
	// pemLabelMax bounds the label between `BEGIN ` and `PRIVATE KEY`. The
	// longest in use is `ENCRYPTED ` at ten.
	pemLabelMax = 32
	// jwtHeaderMax bounds a JWT's header segment, in base64url characters.
	// Only this segment needs a ceiling: it bounds the scan looking for the
	// FIRST dot, which is the scan a run of `eyJ` restarts every three
	// characters on a backtracking engine. The payload and the signature stay
	// open, which keeps the class exact. It is also the only form THIS engine
	// can compile: RE2 refuses a repeat count over 1000, so a ceiling wide
	// enough for a real payload could not be written here at all.
	jwtHeaderMax = 256
)

// placeholderWord lists the words a published placeholder is made of. A
// candidate value built only from these, joined by `-`, `_` or `.`, is
// documentation rather than a credential.
const placeholderWord = `(?:redacted|withheld|omitted|masked|removed|placeholder|changeme|none` +
	`|null|nil|na|todo|tbd|your|my|the|example|sample|dummy|test|fake|token` +
	`|tokens|secret|secrets|api|apikey|key|keys|client|id|value|password` +
	`|passwd|pass|user|username|here|goes|xxx)`

// placeholderValue matches a candidate value that is a published placeholder
// or an explicit statement that the value was left out. It is applied to the
// captured value alone, never to the surrounding string: a redaction claim
// elsewhere in the same text must never suppress a genuine detection. See the
// precedence rule in spec/safety-patterns.md.
var placeholderValue = regexp.MustCompile(
	`(?i)^(?:x{3,}|\*{3,}|\.{3,}|-{3,}|_{3,}|` + placeholderWord +
		`(?:[-_.]` + placeholderWord + `)*)[.,;:!?]?$`,
)

// ReservedPrincipalNames is the closed list of principal names documentation
// may use in a home path. It is structurally impossible to tell an invented
// username from a real one, so the format reserves a list instead of
// guessing, in the spirit of the reserved example domains.
//
// "example" is NOT on this list yet: conformance fixture
// invalid/secret-private-path.json currently requires /Users/example/... to
// be refused. The addition is proposed in spec/safety-patterns.md and waits
// on sign-off.
var ReservedPrincipalNames = []string{
	"agent",
	"ada",
	"user",
	"username",
	"you",
	"me",
}

var reservedPrincipal = regexp.MustCompile(
	`(?i)^(?:` + strings.Join(ReservedPrincipalNames, "|") + `)$`,
)

// SecretPattern is a named pattern. The label is stable and safe to show a
// user or a model.
type SecretPattern struct {
	// Label is the stable class name, e.g. "provider_api_key". Never the
	// matched text.
	Label string
	// Description says what the class means, for an error message a person
	// has to act on.
	Description string
	Pattern     *regexp.Regexp
	// Exempt is applied to one capture group of a match, never to the whole
	// string. When it matches, that match is documentation rather than a
	// credential and is skipped; other matches in the same string are still
	// judged on their own. Nil means the class has no exemption.
	Exempt *regexp.Regexp
	// ExemptGroup is which capture group Exempt judges.
	ExemptGroup int
}

// SecretPatterns holds the patterns applied to every string in a handover.
var SecretPatterns = []SecretPattern{
	{
		Label:       "private_key_pem",
		Description: "a PEM-encoded private key",
		Pattern: regexp.MustCompile(
			fmt.Sprintf(`(?i)BEGIN [A-Z ]{0,%d}PRIVATE KEY`, pemLabelMax),
		),
	},
	{
		Label:       "authorization_header",
		Description: "an authorization header carrying a credential",
		Pattern: regexp.MustCompile(
			`(?i)Authorization` + ows + `:` + ows +
				`(?:Bearer|Basic|Token|Digest|ApiKey|Api-Key)?` + ows + `(` +
				valueClass + `{16,})`,
		),
		Exempt:      placeholderValue,
		ExemptGroup: 1,
	},
	{
		Label:       "bearer_token",
		Description: "a bearer token",
		Pattern: regexp.MustCompile(
			`(?i)Bearer[ \t]+(` + valueClass + `{20,})`,
		),
		Exempt:      placeholderValue,
		ExemptGroup: 1,
	},
	{
		Label:       "jwt",
		Description: "a JSON web token",
		Pattern: regexp.MustCompile(fmt.Sprintf(
			`eyJ[A-Za-z0-9_-]{1,%d}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`,
			jwtHeaderMax,
		)),
	},
	{
		Label:       "provider_api_key",
		Description: "a provider API key or access-key id in a vendor format",
		Pattern: regexp.MustCompile(
			`(?:\bsk-[A-Za-z0-9]` +
				`|\bgh[pousr]_[A-Za-z0-9]{36,}` +
				`|\bgithub_pat_[A-Za-z0-9_]{22,}` +
				`|\b(?:AKIA|ASIA)[0-9A-Z]{16}` +
				`|\bxox[baprs]-[A-Za-z0-9-]{10,}` +
				`|\bAIza[0-9A-Za-z_-]{35})`,
		),
	},
	{
		Label:       "client_secret",
		Description: "a client secret bound to a value",
		Pattern: regexp.MustCompile(
			`(?i)client[_-]?secret["']?` + ows + `[:=]` + ows + `["']?(` +
				valueClass + `{8,})`,
		),
		Exempt:      placeholderValue,
		ExemptGroup: 1,
	},
	{
		Label:       "google_application_credentials",
		Description: "application-credentials material bound to a value",
		Pattern: regexp.MustCompile(
			`(?:GOOGLE_APPLICATION_CREDENTIALS["']?` + ows + `[:=]` + ows +
				`["']?(` + pathValueClass + `{4,})` +
				`|"type"` + ows + `:` + ows + `"service_account")`,
		),
		Exempt:      placeholderValue,
		ExemptGroup: 1,
	},
	{
		Label:       "private_path",
		Description: "an absolute path inside a home directory or a Windows drive root",
		Pattern: regexp.MustCompile(
			`(?:/Users/|/home/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)`,
		),
		Exempt:      reservedPrincipal,
		ExemptGroup: 1,
	},
	{
		Label:       "url_credentials",
		Description: "credentials embedded in a URL",
		// The scheme name is bounded rather than open-ended. RE2 does not
		// backtrack, so this costs Go nothing, but the class is one taxonomy
		// across five languages and the expressions stay in step. The ceiling
		// is 32, well above every registered URI scheme.
		Pattern: regexp.MustCompile(
			`[a-zA-Z][a-zA-Z0-9+.-]{0,31}://[A-Za-z0-9._~%+-]+:([A-Za-z0-9._~%+-]+)@[A-Za-z0-9.-]`,
		),
		Exempt:      placeholderValue,
		ExemptGroup: 1,
	},
}

// SecretFinding is one thing the scan found. Carries a class and a location,
// never a value.
type SecretFinding struct {
	// Path is a JSON Pointer-ish path, e.g. "/sections/architecture/summary".
	Path string
	// Label is the pattern class, e.g. "provider_api_key".
	Label string
	// Description says what that class means.
	Description string
}

// matchesClass reports whether the text carries at least one match of this
// class that is not exempt. Every match is judged on its own captured value,
// so a placeholder in one sentence never excuses a real credential in the
// next.
func matchesClass(text string, p SecretPattern) bool {
	if p.Exempt == nil {
		return p.Pattern.MatchString(text)
	}
	for _, groups := range p.Pattern.FindAllStringSubmatch(text, -1) {
		if p.ExemptGroup >= len(groups) {
			return true
		}
		value := groups[p.ExemptGroup]
		if value == "" || !p.Exempt.MatchString(value) {
			return true
		}
	}
	return false
}

func scanString(text string, path string, findings *[]SecretFinding) {
	for _, p := range SecretPatterns {
		if matchesClass(text, p) {
			*findings = append(*findings, SecretFinding{
				Path:        path,
				Label:       p.Label,
				Description: p.Description,
			})
		}
	}
}

func scanValue(value any, path string, findings *[]SecretFinding) {
	switch v := value.(type) {
	case string:
		if path == "" {
			path = "/"
		}
		scanString(v, path, findings)
	case []any:
		for i, item := range v {
			scanValue(item, fmt.Sprintf("%s/%d", path, i), findings)
		}
	case *Obj:
		for _, key := range v.keys {
			scanValue(v.values[key], path+"/"+key, findings)
		}
	}
}

// FindSecretMaterial finds secret-shaped material anywhere in a value.
// Returns every finding rather than the first, so a model fixing its output
// sees the whole list. Pure: it never mutates, logs or echoes anything it
// matched.
func FindSecretMaterial(value any) []SecretFinding {
	findings := []SecretFinding{}
	scanValue(value, "", &findings)
	return findings
}

// IsFreeOfSecretMaterial reports whether nothing secret-shaped is present.
func IsFreeOfSecretMaterial(value any) bool {
	return len(FindSecretMaterial(value)) == 0
}

// DescribeSecretFinding renders a safe, actionable sentence about one
// finding. Names the class and the location, and says what to do instead.
// Never includes the matched value.
func DescribeSecretFinding(finding SecretFinding) string {
	return fmt.Sprintf(
		"looks like it contains %s (%s). Remove the value: say that the thing exists and where it is configured, never what it is.",
		finding.Description, finding.Label,
	)
}

// SecretMaterialError is returned when a value carries secret-shaped
// material. Carries findings, never values.
type SecretMaterialError struct {
	Findings []SecretFinding
}

func (e *SecretMaterialError) Error() string {
	parts := make([]string, len(e.Findings))
	for i, finding := range e.Findings {
		parts[i] = finding.Path + " " + finding.Label
	}
	return "this handover carries secret material and was not stored: " +
		strings.Join(parts, "; ")
}

// CheckNoSecretMaterial fails closed: it returns a *SecretMaterialError when
// anything secret-shaped is present, and nil otherwise.
func CheckNoSecretMaterial(value any) error {
	findings := FindSecretMaterial(value)
	if len(findings) > 0 {
		return &SecretMaterialError{Findings: findings}
	}
	return nil
}
