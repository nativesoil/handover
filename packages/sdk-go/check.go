// Save-time checking and grading: the open baseline.
//
// CheckHandover is deterministic, lint-style analysis of the handover
// document itself. Every rule has an id, a severity and a plain-language
// explanation, all documented openly in docs/checking.md. Same input, same
// report, byte for byte, and byte-identical to the TypeScript reference in
// packages/sdk-ts/src/check.ts for the same document. Nothing here calls a
// model, reaches the network, or measures anything outside the document.
//
// The boundary, stated plainly: the baseline checker is deterministic
// analysis of the document itself. Whether a handover actually restores a
// session is a different question, answered only by a real load.
//
// The grade band belongs to the report and stops there. It is printed on
// the card, present in --json, and it decides the exit code. It is NOT
// written into the document: the quality.capture observation this module
// builds carries counts, names and findings, and no band, no score and no
// aggregate of any kind. A judgement made by a producer the reader never
// met has no business travelling inside the thing it judges.
//
// Two string units live in this module and they answer two different
// questions. The notes bound is counted in Unicode code points with
// TextLength, the format's unit. The rule thresholds and the numbers quoted
// inside finding messages are counted in UTF-16 code units with u16len,
// because the reference implementation measures them with JavaScript's
// String.prototype.length and a port that counted differently would produce
// a different report for the same bytes.

package handover

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
)

// CheckVersion is the version of this rule set. It moves when a rule is
// added or tuned, so a report always says which rules produced it.
const CheckVersion = "1.0.0"

// CheckGrades holds the grade bands, best first.
var CheckGrades = []string{"strong", "adequate", "thin", "failing"}

// CheckSeverities holds the three severities. A problem undermines the
// document's ability to restore anything. A caution is a concrete weakness
// worth fixing. Advice is a soft signal that never lowers the grade.
//
// Severity classifies the individual rule outcome. It is never a judgement
// of the handover, and summing severities into one word is the report's
// business, not the document's.
var CheckSeverities = []string{"problem", "caution", "advice"}

// CheckRuleIDs holds every rule id in the baseline, in the order the
// reference declares them.
var CheckRuleIDs = []string{
	"completeness.missing-without-reason",
	"completeness.no-durable-truth",
	"self-containment.fetch-pointer",
	"time.unanchored",
	"decisions.entry-without-reason",
	"anchors.no-exact-values",
	"gaps.blocked-without-omission-note",
	"restore.absent",
	"restore.thin",
	"size.one-liner",
}

// CheckRules maps every rule id to its one-line explanation. The full
// rationale for each lives in docs/checking.md.
var CheckRules = map[string]string{
	"completeness.missing-without-reason": "a section is declared missing with no reason stated anywhere",
	"completeness.no-durable-truth":       "no durable-tier section carries content, so nothing outlives the session",
	"self-containment.fetch-pointer":      "the text sends the reader somewhere else instead of carrying the content",
	"time.unanchored":                     "a frontier section uses time words with no capture-time anchor",
	"decisions.entry-without-reason":      "a decision is stated with no recorded reason, which invites relitigation",
	"anchors.no-exact-values":             "the section talks about configuration but carries no exact values",
	"gaps.blocked-without-omission-note":  "a section was withheld but the safety record does not say what or where",
	"restore.absent":                      "content was captured but there are no restore instructions to boot it",
	"restore.thin":                        "the restore instructions are far shorter than the content they must boot",
	"size.one-liner":                      "a one-line section in an otherwise rich document reads as thinness",
}

// CheckFinding is one finding from one rule. Section is the section key it
// points at, or empty for a document-level finding.
type CheckFinding struct {
	Rule     string
	Severity string
	Section  string
	Message  string
}

// CheckCounts holds findings counted by severity.
type CheckCounts struct {
	Problems int
	Cautions int
	Advice   int
}

// CheckReport is the whole report. Ephemeral output: nothing in it is part
// of the document. Grade is the band, report only: it is never written onto
// a handover.
type CheckReport struct {
	CheckVersion string
	Grade        string
	Counts       CheckCounts
	Findings     []CheckFinding
	Sections     SectionCounts
}

// GradeFromCounts is the grade mapping, documented in docs/checking.md and
// applied nowhere else. Counts in, band out, no judgement calls:
//
//	failing   3 or more problems
//	thin      1 or 2 problems, or 6 or more cautions
//	adequate  no problems, 1 to 5 cautions
//	strong    no problems, no cautions; advice never lowers the grade
func GradeFromCounts(counts CheckCounts) string {
	if counts.Problems >= 3 {
		return "failing"
	}
	if counts.Problems >= 1 || counts.Cautions >= 6 {
		return "thin"
	}
	if counts.Cautions >= 1 {
		return "adequate"
	}
	return "strong"
}

// The reference implementation runs on JavaScript strings, so its trim and
// its regex \s are ECMAScript's. Go's strings.TrimSpace and RE2's \s cover
// a different set at the edges (a no-break space, a byte order mark), and a
// checker that trims or matches differently produces a different report for
// the same document. So the ECMAScript whitespace set is spelled out once
// here and used everywhere in this file. RE2's \b and \d are already the
// ASCII sets ECMAScript uses.
const jsWhitespaceCutset = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

const wsClass = `\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

func jsTrim(s string) string {
	return strings.Trim(s, jsWhitespaceCutset)
}

// fetchPointers holds phrases that point away from the document. A handover
// assumes its reader has nothing else, so "see the repo" is content that
// failed to travel. Each pattern is a heuristic: deterministic, documented,
// and tuned to phrases that present somewhere else as where the content
// lives.
var fetchPointers = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bsee (?:the )?(?:repo|repository|docs|documentation|readme|wiki|codebase|source|thread|conversation|chat)\b`),
	regexp.MustCompile(`(?i)\bin the (?:docs|documentation|readme|wiki)\b`),
	regexp.MustCompile(`(?i)\bconsult\b`),
	regexp.MustCompile(`(?i)\brefer to\b`),
	regexp.MustCompile(`(?i)\b(?:see|check|visit|read|browse)[` + wsClass + `]+https?://`),
	regexp.MustCompile(`(?i)\b(?:described|documented|explained|detailed|available|found)[` + wsClass + `]+(?:at|in)[` + wsClass + `]+https?://`),
}

// volatileTerms holds words that are true only at one moment.
var volatileTerms = regexp.MustCompile(`(?i)\b(?:currently|right now|now|today|tonight|yesterday|tomorrow|this week|last week|this morning|this afternoon|at the moment|just now|recently)\b`)

// captureAnchors holds phrases that pin volatile words to the capture.
var captureAnchors = regexp.MustCompile(`(?i)\b(?:at capture|at the capture|as of (?:this|the) capture|at the time of capture|when this was (?:captured|written)|at save time|as of \d{4}-\d{2}-\d{2})\b`)

// decisionVerbs holds verbs that state a decision. Scoped to the decisions
// section only.
var decisionVerbs = regexp.MustCompile(`(?i)\b(?:decided|decision|locked|chose|chosen|agreed|settled|adopted|picked|selected|went with|opted|will use|use[sd]?|switched to|migrated to|standardi[sz]ed)\b`)

// reasonMarkers holds markers that a reason was recorded. "cannot" and
// "could not" count because a stated inability is a stated reason.
var reasonMarkers = regexp.MustCompile(`(?i)\b(?:because|since|due to|so that|reason|why|after|caused|led to|avoid|avoids|avoided|prevent|prevents|prevented|otherwise|rather than|instead of|cannot|could not)\b`)

// configTerms holds terms that say the section is talking about
// configuration.
var configTerms = regexp.MustCompile(`(?i)\b(?:config|configuration|configured|environment variable|env var|port|version|pinned|flag|timeout|limit|ceiling|budget|quota|threshold)\b`)

var asciiDigit = regexp.MustCompile(`\d`)

var wsRun = regexp.MustCompile(`[` + wsClass + `]+`)

var entryMarker = regexp.MustCompile(`^(?:\d+[.)][` + wsClass + `]+|[-*•▸][` + wsClass + `]+)`)

// The floor parameters for the restore-instructions length rule.
const (
	restoreMinChars    = 300
	restoreFraction    = 0.05
	restoreAppliesFrom = 1000
)

// The parameters for the one-liner rule.
const (
	oneLinerMaxChars    = 40
	oneLinerMinSections = 5
	oneLinerMinMedian   = 200
)

// availableSummary returns a section's summary when the section carries
// content: status available and a non-blank summary. The second result is
// false otherwise.
func availableSummary(doc *Obj, key string) (string, bool) {
	sectionsValue, _ := doc.Get("sections")
	sections, ok := asObj(sectionsValue)
	if !ok {
		return "", false
	}
	sectionValue, _ := sections.Get(key)
	section, ok := asObj(sectionValue)
	if !ok {
		return "", false
	}
	statusValue, _ := section.Get("status")
	if status, _ := statusValue.(string); status != "available" {
		return "", false
	}
	summaryValue, _ := section.Get("summary")
	summary, isString := summaryValue.(string)
	if !isString || jsTrim(summary) == "" {
		return "", false
	}
	return summary, true
}

func firstMatch(text string, patterns []*regexp.Regexp) (string, bool) {
	for _, pattern := range patterns {
		if match := pattern.FindString(text); match != "" {
			return match, true
		}
	}
	return "", false
}

// SplitEntries splits a section's prose into entries: numbered items,
// bulleted items, and blank-line-separated paragraphs. Deterministic, no
// interpretation.
func SplitEntries(text string) []string {
	entries := []string{}
	current := []string{}
	flush := func() {
		if len(current) > 0 {
			entries = append(entries, strings.Join(current, " "))
		}
		current = nil
	}
	for _, raw := range strings.Split(text, "\n") {
		line := jsTrim(raw)
		if line == "" {
			flush()
			continue
		}
		if entryMarker.MatchString(line) {
			flush()
		}
		current = append(current, line)
	}
	flush()
	return entries
}

// lowerMedian returns the lower median of a list of numbers.
func lowerMedian(values []int) int {
	if len(values) == 0 {
		return 0
	}
	ordered := append([]int(nil), values...)
	sort.Ints(ordered)
	return ordered[(len(ordered)-1)/2]
}

func checkPreview(text string, max int) string {
	flat := jsTrim(wsRun.ReplaceAllString(text, " "))
	if u16len(flat) <= max {
		return flat
	}
	return u16Slice(flat, max-1) + "…"
}

// sectionStatusAt returns one section's status, or an empty string.
func sectionStatusAt(doc *Obj, key string) string {
	status, _ := sectionAt(doc, key)
	return status
}

// sectionSummaryIsBlank reports whether one section's summary is null,
// absent or blank, which is what the missing-without-reason rule reads as
// "no note here".
func sectionSummaryIsBlank(doc *Obj, key string) bool {
	sectionsValue, _ := doc.Get("sections")
	sections, ok := asObj(sectionsValue)
	if !ok {
		return true
	}
	sectionValue, _ := sections.Get(key)
	section, ok := asObj(sectionValue)
	if !ok {
		return true
	}
	summaryValue, _ := section.Get("summary")
	summary, isString := summaryValue.(string)
	if !isString {
		return true
	}
	return jsTrim(summary) == ""
}

// CheckHandover checks a handover: it runs every rule, counts the findings,
// and maps the counts to a grade band. The input is assumed structurally
// valid; run Validate first, the way the CLI does.
//
// Pure and deterministic on purpose. No I/O, no clock, no randomness, no
// model. The report is honest exactly because every finding can be traced
// to a documented rule and re-produced by anyone from the same bytes.
func CheckHandover(doc *Obj) CheckReport {
	findings := []CheckFinding{}
	add := func(rule string, severity string, message string, section string) {
		findings = append(findings, CheckFinding{
			Rule:     rule,
			Severity: severity,
			Section:  section,
			Message:  message,
		})
	}

	missingInputs := noteList(doc, "quality", "missingInputs")
	unsafeOmissions := noteList(doc, "safety", "unsafeOmissions")

	// completeness.missing-without-reason: a gap is fine, an unexplained gap
	// is not. A reason can live in the section's own note or in the
	// document-level quality.missingInputs list.
	if len(missingInputs) == 0 {
		for _, key := range SectionKeys {
			if sectionStatusAt(doc, key) == "missing" && sectionSummaryIsBlank(doc, key) {
				add(
					"completeness.missing-without-reason",
					"caution",
					"declared missing, with no note here and nothing in quality.missingInputs saying why",
					key,
				)
			}
		}
	}

	// gaps.blocked-without-omission-note: blocked means withheld for safety,
	// and the safety record is where the withheld fact is supposed to be.
	for _, key := range SectionKeys {
		if sectionStatusAt(doc, key) == "blocked" && len(unsafeOmissions) == 0 {
			add(
				"gaps.blocked-without-omission-note",
				"caution",
				"withheld for safety, but safety.unsafeOmissions does not name what exists or where it is configured",
				key,
			)
		}
	}

	// completeness.no-durable-truth: with zero durable sections, nothing in
	// the document outlives the session it came from.
	durableAvailable := 0
	for _, key := range SectionKeys {
		if SectionTiers[key] != TierDurable {
			continue
		}
		if _, ok := availableSummary(doc, key); ok {
			durableAvailable++
		}
	}
	if durableAvailable == 0 {
		add(
			"completeness.no-durable-truth",
			"problem",
			"none of the six durable-tier sections carries content, so the project's lasting truth did not travel",
			"",
		)
	}

	// self-containment.fetch-pointer: per section. A pointer inside the
	// restore instructions is a problem, because the boot prompt must stand
	// alone; in any other section it is a caution.
	for _, key := range SectionKeys {
		text, ok := availableSummary(doc, key)
		if !ok {
			continue
		}
		if match, found := firstMatch(text, fetchPointers); found {
			severity := "caution"
			if key == "restoreInstructions" {
				severity = "problem"
			}
			add(
				"self-containment.fetch-pointer",
				severity,
				"sends the reader elsewhere (\""+checkPreview(match, 40)+"\"), but a handover reader has no repo, no docs and no earlier thread",
				key,
			)
		}
	}

	// time.unanchored: frontier sections describe a moment. Time words with
	// no capture anchor in the same section will read as the present to a
	// reader arriving later.
	for _, key := range SectionKeys {
		if SectionTiers[key] != TierFrontier {
			continue
		}
		text, ok := availableSummary(doc, key)
		if !ok {
			continue
		}
		volatile := volatileTerms.FindString(text)
		if volatile != "" && !captureAnchors.MatchString(text) {
			add(
				"time.unanchored",
				"caution",
				"uses \""+volatile+"\" with no capture-time anchor, so a later reader cannot tell when it was true",
				key,
			)
		}
	}

	// decisions.entry-without-reason: a decision with no recorded reason is
	// the exact thing a later session relitigates.
	if decisionsText, ok := availableSummary(doc, "decisions"); ok {
		for i, entry := range SplitEntries(decisionsText) {
			if decisionVerbs.MatchString(entry) && !reasonMarkers.MatchString(entry) {
				add(
					"decisions.entry-without-reason",
					"caution",
					fmt.Sprintf(
						"entry %d states a decision with no recorded reason (\"%s\")",
						i+1,
						checkPreview(entry, 60),
					),
					"decisions",
				)
			}
		}
	}

	// anchors.no-exact-values: architecture and constraints that mention
	// configuration but carry no digits have probably lost their pins.
	for _, key := range []string{"architecture", "constraints"} {
		text, ok := availableSummary(doc, key)
		if ok && configTerms.MatchString(text) && !asciiDigit.MatchString(text) {
			add(
				"anchors.no-exact-values",
				"advice",
				"mentions configuration but holds no numbers, versions or pins; exact values are what survive a move",
				key,
			)
		}
	}

	// restore.absent and restore.thin: the restore instructions are the boot
	// prompt. Captured content with no boot prompt, or a boot prompt far
	// smaller than the content, will not bring a cold session back.
	restoreText, restoreOk := availableSummary(doc, "restoreInstructions")
	otherAvailableChars := 0
	for _, key := range SectionKeys {
		if key == "restoreInstructions" {
			continue
		}
		if text, ok := availableSummary(doc, key); ok {
			otherAvailableChars += u16len(text)
		}
	}
	if !restoreOk && otherAvailableChars > 0 {
		add(
			"restore.absent",
			"problem",
			"content was captured but restoreInstructions is empty, so nothing tells the next session how to begin",
			"restoreInstructions",
		)
	}
	if restoreOk && otherAvailableChars >= restoreAppliesFrom {
		floor := restoreMinChars
		if scaled := int(math.Floor(float64(otherAvailableChars) * restoreFraction)); scaled > floor {
			floor = scaled
		}
		if u16len(restoreText) < floor {
			add(
				"restore.thin",
				"problem",
				fmt.Sprintf(
					"the restore instructions are %d characters against %d of captured content, below the documented floor of %d",
					u16len(restoreText),
					otherAvailableChars,
					floor,
				),
				"restoreInstructions",
			)
		}
	}

	// size.one-liner: in a document whose sections are otherwise
	// substantial, a near-empty available section is a thinness signal, not
	// an error.
	availableLengths := []int{}
	for _, key := range SectionKeys {
		if text, ok := availableSummary(doc, key); ok {
			availableLengths = append(availableLengths, u16len(text))
		}
	}
	if len(availableLengths) >= oneLinerMinSections && lowerMedian(availableLengths) >= oneLinerMinMedian {
		for _, key := range SectionKeys {
			text, ok := availableSummary(doc, key)
			if ok && u16len(text) < oneLinerMaxChars {
				add(
					"size.one-liner",
					"advice",
					fmt.Sprintf(
						"carries %d characters in a document whose sections are otherwise substantial",
						u16len(text),
					),
					key,
				)
			}
		}
	}

	// Deterministic order: document-level findings first, then sections in
	// canonical order, then rule id, then message.
	sectionIndex := func(key string) int {
		if key == "" {
			return -1
		}
		for i, candidate := range SectionKeys {
			if candidate == key {
				return i
			}
		}
		return -1
	}
	sort.SliceStable(findings, func(a, b int) bool {
		left, right := findings[a], findings[b]
		if d := sectionIndex(left.Section) - sectionIndex(right.Section); d != 0 {
			return d < 0
		}
		if c := strings.Compare(left.Rule, right.Rule); c != 0 {
			return c < 0
		}
		return strings.Compare(left.Message, right.Message) < 0
	})

	counts := CheckCounts{}
	for _, finding := range findings {
		switch finding.Severity {
		case "problem":
			counts.Problems++
		case "caution":
			counts.Cautions++
		case "advice":
			counts.Advice++
		}
	}

	return CheckReport{
		CheckVersion: CheckVersion,
		Grade:        GradeFromCounts(counts),
		Counts:       counts,
		Findings:     findings,
		Sections:     CountSections(doc),
	}
}

// CheckNotesMaxChars is the upper bound on notes in a quality.capture
// payload, in Unicode code points, the unit every length bound in this
// format is counted in. See TextLength and spec/value-domain.md.
//
// Notes are short, non-evaluative context: what the producer wants a reader
// to know about how the examination was made. The bound is deliberately too
// small for the field to become a container for a hidden aggregate, and
// CheckObservation refuses anything longer rather than truncating a claim
// in the middle.
const CheckNotesMaxChars = 280

// CheckDefaultNotes is the note this module writes when the caller supplies
// none. It states what kind of examination ran and nothing about how the
// result compares to anything, because a comparison is a judgement.
const CheckDefaultNotes = "Structural examination of the document by the open deterministic baseline. Section statuses and rule outcomes only."

// CheckObservationOptions is what CheckObservation needs beyond the report
// itself. ProducedBy names the tool that ran the check, with a version,
// e.g. soil-cli/0.1.0. ProducedAt is when the check ran (ISO 8601). Notes
// is short non-evaluative context, at most CheckNotesMaxChars code points;
// nil means CheckDefaultNotes.
type CheckObservationOptions struct {
	ProducedBy string
	ProducedAt string
	Notes      *string
}

// CheckObservation packages a report as a quality.capture observation,
// ready to attach to the stored handover.
//
// The payload is a closed field set, documented in spec/observations.md:
//
//	sectionsWithContent · missingSections · blockedSections ·
//	findings · checkVersion · notes
//
// and nothing else. In particular no grade, no band, no score, and no
// counts-by-severity roll-up. Those exist in the report, where the reader
// can see who produced them and when; they do not exist on the document,
// where a later reader would meet the verdict without ever meeting the
// producer.
//
// This does not make the band underivable, and pretending otherwise would
// be its own dishonesty. Anyone holding this payload plus the published
// mapping in docs/checking.md can count the severities and recompute the
// band exactly. The difference is who makes that derivation, and whether
// the threshold is in front of them when they do.
func CheckObservation(doc *Obj, report CheckReport, options CheckObservationOptions) (*Obj, error) {
	notes := CheckDefaultNotes
	if options.Notes != nil {
		notes = *options.Notes
	}
	if TextLength(notes) > CheckNotesMaxChars {
		return nil, fmt.Errorf(
			"quality.capture notes must be at most %d code points, got %d",
			CheckNotesMaxChars,
			TextLength(notes),
		)
	}
	// Section KEYS, not prose labels: missingSections and blockedSections
	// are addresses a reader can look up, the same identifiers location
	// uses.
	named := func(status string) []any {
		keys := []any{}
		for _, key := range SectionKeys {
			if sectionStatusAt(doc, key) == status {
				keys = append(keys, key)
			}
		}
		return keys
	}
	findings := make([]any, len(report.Findings))
	for i, finding := range report.Findings {
		entry := NewObj()
		entry.Set("rule", finding.Rule)
		// JSON-Pointer-ish, the same shape a validation issue uses. "/" is
		// the document itself, for a rule that is not about one section.
		location := "/"
		if finding.Section != "" {
			location = "/sections/" + finding.Section
		}
		entry.Set("location", location)
		entry.Set("observed", finding.Message)
		entry.Set("severity", finding.Severity)
		findings[i] = entry
	}
	data := NewObj()
	data.Set("checkVersion", report.CheckVersion)
	data.Set("sectionsWithContent", report.Sections.WithContent)
	data.Set("missingSections", named("missing"))
	data.Set("blockedSections", named("blocked"))
	data.Set("findings", findings)
	data.Set("notes", notes)
	observation := NewObj()
	observation.Set("kind", "quality.capture")
	observation.Set("producedBy", options.ProducedBy)
	observation.Set("producedAt", options.ProducedAt)
	observation.Set("data", data)
	return observation, nil
}

// CheckReportValue renders a report as the ordered JSON value the reference
// prints for --json, so the two CLIs emit the same bytes for the same
// document.
func CheckReportValue(report CheckReport) *Obj {
	counts := NewObj()
	counts.Set("problems", report.Counts.Problems)
	counts.Set("cautions", report.Counts.Cautions)
	counts.Set("advice", report.Counts.Advice)
	findings := make([]any, len(report.Findings))
	for i, finding := range report.Findings {
		entry := NewObj()
		entry.Set("rule", finding.Rule)
		entry.Set("severity", finding.Severity)
		if finding.Section != "" {
			entry.Set("section", finding.Section)
		}
		entry.Set("message", finding.Message)
		findings[i] = entry
	}
	sections := NewObj()
	sections.Set("withContent", report.Sections.WithContent)
	sections.Set("missing", report.Sections.Missing)
	sections.Set("blocked", report.Sections.Blocked)
	sections.Set("notApplicable", report.Sections.NotApplicable)
	sections.Set("total", report.Sections.Total)
	value := NewObj()
	value.Set("checkVersion", report.CheckVersion)
	value.Set("grade", report.Grade)
	value.Set("counts", counts)
	value.Set("findings", findings)
	value.Set("sections", sections)
	return value
}
