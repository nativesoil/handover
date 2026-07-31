// The rail card: the ASCII shape Soil prints after a save, a load, or a list.
//
// Design contract, do not break:
//
//   - PURE. No I/O, no clock, no randomness. Same input, byte-identical
//     output, which is why the tests can pin whole cards. The cards are also
//     byte-identical to the TypeScript renderer's for the same input.
//   - SAFE BY CALLER. The renderer formats already-safe text. It does not
//     scan, redact or reconstruct anything.
//   - COMPUTED LAYOUT. A fixed 2-space gutter, a continuous left rail, and
//     rules extended to a fixed inner width. Alignment is computed from
//     content, never hardcoded, so the card lands identically in every
//     terminal.
//
// The card reports counts and names: how many sections carry content, which
// ones do not, and what was held back on purpose. It never reports a score.
// A local save has no opinion about how good your handover is.
//
// The save card and the load card carry the same two head blocks, and they do
// so on purpose. A field a writer supplies has not been delivered until a
// reader sees it, and a field shown on the way in and dropped on the way out
// is the same defect as one never stored: "written by" names the tool, the
// model, the provider and the extraction recipe behind the document, and
// "what this document carries" names the withheld sections as withheld rather
// than as empty. Which section carries which provenance label is a
// per-section mapping and lives in the restore prompt; the card names the
// kinds of claim present, which is what fits in a column.

package handover

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

const (
	gutter     = "  "
	innerWidth = 52
	railIndent = "│   "
	wrapWidth  = 46
	// labelWidth is the width of the label column inside the rail.
	labelWidth = 12
)

// Wrap wraps prose to width columns on word boundaries. Never splits a word.
func Wrap(text string, width int) []string {
	out := []string{}
	for _, paragraph := range strings.Split(text, "\n") {
		line := ""
		for _, word := range strings.FieldsFunc(paragraph, unicode.IsSpace) {
			if line == "" {
				line = word
			} else if u16len(line)+1+u16len(word) <= width {
				line = line + " " + word
			} else {
				out = append(out, line)
				line = word
			}
		}
		out = append(out, line)
	}
	return out
}

func masthead(state string, code string) string {
	head := "┌─ SOIL · " + state + " "
	tail := ""
	if code != "" {
		tail = " " + code + " ─"
	}
	fill := innerWidth - u16len(head) - u16len(tail)
	if fill < 1 {
		fill = 1
	}
	return gutter + head + strings.Repeat("─", fill) + tail
}

func sectionRule(label string) string {
	head := "├─ " + label + " "
	fill := innerWidth - u16len(head)
	if fill < 1 {
		fill = 1
	}
	return gutter + head + strings.Repeat("─", fill)
}

func footer(text string) string {
	return gutter + "└─ " + text
}

func blank() string {
	return gutter + "│"
}

func line(text string) string {
	return gutter + railIndent + text
}

func prose(text string) []string {
	out := []string{}
	for _, l := range Wrap(text, wrapWidth) {
		out = append(out, line(l))
	}
	return out
}

func sectionNames(keys []string) string {
	names := make([]string, len(keys))
	for i, key := range keys {
		names[i] = SectionLabels[key]
	}
	return strings.Join(names, ", ")
}

func keysWithStatus(doc *Obj, status string) []string {
	keys := []string{}
	for _, key := range SectionKeys {
		if s, _ := sectionAt(doc, key); s == status {
			keys = append(keys, key)
		}
	}
	return keys
}

// contentCountLine is the one count line. Structural presence, stated as such.
func contentCountLine(counts SectionCounts) string {
	return fmt.Sprintf("%d / %d sections carrying content", counts.WithContent, counts.Total)
}

// labelled renders a labelled row whose value wraps under itself, keeping
// the label column clear: the eye should be able to run down the labels
// without meeting text.
func labelled(label string, value string) []string {
	width := labelWidth
	if len(label)+2 > width {
		width = len(label) + 2
	}
	out := []string{}
	for i, text := range Wrap(value, wrapWidth-width) {
		rowLabel := ""
		if i == 0 {
			rowLabel = label
		}
		out = append(out, line(padEnd(rowLabel, width)+text))
	}
	return out
}

// sourceRows renders the source fields as the rows that show them.
//
// Labelled rather than joined with separators, because a reader met with
// "chatgpt · gpt-5 · openai" has to guess which token is the tool, which is
// the model and which is the provider. The label column says which is which,
// and it is the same block on the save card and the load card, so a field a
// writer supplied is a field the next reader meets. A row is omitted when the
// field is absent; a document with no source gets no block at all.
func sourceRows(doc *Obj) []string {
	sourceValue, ok := doc.Get("source")
	if !ok {
		return nil
	}
	source, ok := asObj(sourceValue)
	if !ok {
		return nil
	}
	rows := [][2]string{
		{"client", stringAt(source, "client")},
		{"model", stringAt(source, "model")},
		{"provider", stringAt(source, "provider")},
		{"recipe", stringAt(source, "recipeVersion")},
	}
	out := []string{}
	for _, row := range rows {
		if row[1] == "" {
			continue
		}
		out = append(out, labelled(row[0], row[1])...)
	}
	return out
}

// writtenByBlock renders the "written by" block, or nothing when the document
// names no source.
func writtenByBlock(doc *Obj) []string {
	rows := sourceRows(doc)
	if len(rows) == 0 {
		return nil
	}
	out := []string{sectionRule("written by"), blank()}
	out = append(out, rows...)
	return append(out, blank())
}

// provenanceLabelsPresent returns every provenance label the sections carry,
// in the frozen order of the label set, each label once.
//
// The card shows which KINDS of claim a document holds. Which section carries
// which label is a mapping, and a mapping belongs where a reader can act on it
// per section, which is the restore prompt.
func provenanceLabelsPresent(doc *Obj) []string {
	seen := map[string]bool{}
	for _, key := range SectionKeys {
		for _, label := range sectionProvenance(doc, key) {
			seen[label] = true
		}
	}
	out := []string{}
	for _, label := range ProvenanceLabels {
		if seen[label] {
			out = append(out, label)
		}
	}
	return out
}

// provenanceRow renders the one row saying which kinds of claim this document
// holds.
func provenanceRow(doc *Obj) []string {
	labels := provenanceLabelsPresent(doc)
	if len(labels) == 0 {
		return nil
	}
	return labelled("provenance", strings.Join(labels, ", "))
}

// evidenceRows renders the attached observations as the rows that name them.
//
// Kinds and producers, never payloads. The data payload is free-form and
// opaque to the specification, so a renderer cannot know how to lay out a
// payload it has never seen, and a renderer that guessed would be inventing a
// shape the producer did not agree to. What a reader needs from a card is that
// the evidence is there, what kind it is and who is answerable for it; the
// payload is one `soil load --json` away, and spec/observations.md says how to
// read it.
//
// Both lists are deduplicated and joined into one wrapping row each, so a
// hundred entries of one kind cost one row rather than a hundred.
func evidenceRows(doc *Obj) []string {
	observationsValue, ok := doc.Get("observations")
	if !ok {
		return nil
	}
	list, ok := observationsValue.([]any)
	if !ok || len(list) == 0 {
		return nil
	}
	kinds := []string{}
	producers := []string{}
	for _, entry := range list {
		observation, ok := asObj(entry)
		if !ok {
			continue
		}
		if kind := stringAt(observation, "kind"); kind != "" && !contains(kinds, kind) {
			kinds = append(kinds, kind)
		}
		producer := stringAt(observation, "producedBy")
		if producer != "" && !contains(producers, producer) {
			producers = append(producers, producer)
		}
	}
	out := []string{}
	if len(kinds) > 0 {
		out = append(out, labelled("evidence", strings.Join(kinds, ", "))...)
	}
	if len(producers) > 0 {
		out = append(out, labelled("recorded", strings.Join(producers, ", "))...)
	}
	return out
}

func bulleted(out []string, notes []string) []string {
	for _, note := range notes {
		for i, text := range Wrap(note, wrapWidth-2) {
			if i == 0 {
				out = append(out, line("▸ "+text))
			} else {
				out = append(out, line("  "+text))
			}
		}
	}
	return out
}

// RenderSaved renders the card printed after soil save.
func RenderSaved(doc *Obj, code string) string {
	counts := CountSections(doc)
	missing := keysWithStatus(doc, "missing")
	blocked := keysWithStatus(doc, "blocked")
	notApplicable := keysWithStatus(doc, "not_applicable")

	out := []string{}
	out = append(out, masthead("handover saved", code))
	out = append(out, blank())
	out = append(out, prose(stringAt(doc, "title"))...)
	out = append(out, line(stringAt(doc, "projectId")))
	out = append(out, blank())
	out = append(out, writtenByBlock(doc)...)
	out = append(out, sectionRule("what this document carries"))
	out = append(out, blank())
	out = append(out, line(contentCountLine(counts)))
	if len(missing) > 0 {
		out = append(out, labelled("no content", sectionNames(missing))...)
	}
	if len(blocked) > 0 {
		out = append(out, labelled("held back", sectionNames(blocked))...)
	}
	if len(notApplicable) > 0 {
		out = append(out, labelled("no subject", sectionNames(notApplicable))...)
	}
	out = append(out, provenanceRow(doc)...)
	out = append(out, evidenceRows(doc)...)
	out = append(out, blank())

	gaps := noteList(doc, "quality", "missingInputs")
	if len(gaps) > 0 {
		out = append(out, sectionRule("stated gaps"))
		out = append(out, blank())
		out = bulleted(out, gaps)
		out = append(out, blank())
	}

	// The gaps' sibling in quality. It reached the restore prompt and not this
	// card, which left the writer no way to see that what it recorded landed.
	contradictions := noteList(doc, "quality", "contradictions")
	if len(contradictions) > 0 {
		out = append(out, sectionRule("unresolved contradictions"))
		out = append(out, blank())
		out = bulleted(out, contradictions)
		out = append(out, blank())
	}

	omissions := noteList(doc, "safety", "unsafeOmissions")
	if len(omissions) > 0 {
		out = append(out, sectionRule("held back · by design"))
		out = append(out, blank())
		out = bulleted(out, omissions)
		out = append(out, blank())
	}

	out = append(out, sectionRule("local"))
	out = append(out, blank())
	out = append(out, prose("stored on this machine · no account · no network")...)
	out = append(out, blank())
	out = append(out, footer("load it in another thread, model, or tool"))
	out = append(out, "")
	out = append(out, "          ❯ soil load "+code)
	return strings.Join(out, "\n")
}

// RenderLoaded renders the card printed above the restore prompt on
// soil load.
func RenderLoaded(doc *Obj) string {
	counts := CountSections(doc)
	missing := keysWithStatus(doc, "missing")
	// A withheld section is not an empty one. The save card said so and this
	// one did not, so a reader of the load door could not tell a section
	// nobody could see from one somebody decided not to move, which is the one
	// distinction that says whether to go looking elsewhere.
	blocked := keysWithStatus(doc, "blocked")
	notApplicable := keysWithStatus(doc, "not_applicable")
	code := stringAt(doc, "code")

	out := []string{}
	out = append(out, masthead("handover loaded", code))
	out = append(out, blank())
	out = append(out, prose(stringAt(doc, "title"))...)
	out = append(out, line(stringAt(doc, "projectId")+" · saved "+stringAt(doc, "createdAt")))
	out = append(out, blank())
	out = append(out, writtenByBlock(doc)...)
	out = append(out, sectionRule("what this document carries"))
	out = append(out, blank())
	out = append(out, line(contentCountLine(counts)))
	if len(missing) > 0 {
		out = append(out, labelled("no content", sectionNames(missing))...)
	}
	if len(blocked) > 0 {
		out = append(out, labelled("held back", sectionNames(blocked))...)
	}
	if len(notApplicable) > 0 {
		out = append(out, labelled("no subject", sectionNames(notApplicable))...)
	}
	out = append(out, provenanceRow(doc)...)
	out = append(out, evidenceRows(doc)...)
	out = append(out, blank())
	out = append(out, sectionRule("read it this way"))
	out = append(out, blank())
	out = append(out, prose(
		"durable sections still hold · frontier sections describe the moment of capture, not now · check fast-moving state before trusting it",
	)...)
	out = append(out, blank())
	out = append(out, footer("the restore prompt follows · paste it into the new session"))
	return strings.Join(out, "\n")
}

// RenderList renders the card printed by soil list.
func RenderList(entries []StoreEntry) string {
	out := []string{}
	out = append(out, masthead("handovers", ""))
	out = append(out, blank())
	if len(entries) == 0 {
		out = append(out, prose("nothing saved yet · run `soil save` to start")...)
		out = append(out, blank())
		out = append(out, footer("local store · ~/.soil"))
		return strings.Join(out, "\n")
	}
	for _, entry := range entries {
		title := entry.Title
		if u16len(title) > 28 {
			title = u16Slice(title, 27) + "…"
		}
		out = append(out, line(fmt.Sprintf(
			"▸ %s  %s %s/17",
			entry.Code,
			padEnd(title, 28),
			padStart(strconv.Itoa(entry.SectionsWithContent), 2),
		)))
	}
	out = append(out, blank())
	// The ratio is the one number here, so the one number says what it is.
	out = append(out, prose("the ratio counts sections carrying content")...)
	out = append(out, blank())
	out = append(out, footer(fmt.Sprintf("%d stored · load one with `soil load #NNN`", len(entries))))
	return strings.Join(out, "\n")
}

func pluralize(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}

// RenderCheck renders the card printed by soil check: the grade band, the
// findings grouped by section, and the boundary the checker lives behind.
// Deterministic like every renderer here; the report is already sorted, and
// this only lays it out.
func RenderCheck(doc *Obj, report CheckReport) string {
	out := []string{}
	out = append(out, masthead("handover checked", stringAt(doc, "code")))
	out = append(out, blank())
	out = append(out, prose(stringAt(doc, "title"))...)
	out = append(out, line(stringAt(doc, "projectId")))
	out = append(out, blank())
	out = append(out, sectionRule("grade"))
	out = append(out, blank())
	out = append(out, line(report.Grade))
	out = append(out, line(fmt.Sprintf(
		"%s · %s · %d advice",
		pluralize(report.Counts.Problems, "problem"),
		pluralize(report.Counts.Cautions, "caution"),
		report.Counts.Advice,
	)))
	out = append(out, blank())
	out = append(out, sectionRule("findings"))
	out = append(out, blank())
	if len(report.Findings) == 0 {
		out = append(out, prose("none · every rule passed on this document")...)
		out = append(out, blank())
	} else {
		labels := []string{}
		groups := map[string][]CheckFinding{}
		for _, finding := range report.Findings {
			label := "the document"
			if finding.Section != "" {
				label = SectionLabels[finding.Section]
			}
			if _, seen := groups[label]; !seen {
				labels = append(labels, label)
			}
			groups[label] = append(groups[label], finding)
		}
		for _, label := range labels {
			out = append(out, line(label))
			for _, finding := range groups[label] {
				out = append(out, line("▸ "+finding.Rule+" · "+finding.Severity))
				for _, text := range Wrap(finding.Message, wrapWidth-2) {
					out = append(out, line("  "+text))
				}
			}
			out = append(out, blank())
		}
	}
	out = append(out, footer("checked from the document alone · only a real load proves restore"))
	return strings.Join(out, "\n")
}

// RenderValidation renders the card printed by soil validate.
func RenderValidation(result ValidationResult, label string) string {
	unsafe := []ValidationIssue{}
	structural := []ValidationIssue{}
	for _, issue := range result.Issues {
		if issue.Kind == IssueSafety {
			unsafe = append(unsafe, issue)
		} else {
			structural = append(structural, issue)
		}
	}

	state := "valid handover"
	if !result.Valid {
		if len(unsafe) > 0 {
			state = "refused · secret material"
		} else {
			state = "not a handover"
		}
	}

	out := []string{}
	out = append(out, masthead(state, ""))
	out = append(out, blank())
	out = append(out, line(label))
	out = append(out, blank())
	if result.Valid {
		out = append(out, sectionRule("shape"))
		out = append(out, blank())
		out = append(out, prose("every required field is present and well formed")...)
		out = append(out, blank())
		out = append(out, footer("structure only · this says nothing about how good the content is"))
		return strings.Join(out, "\n")
	}
	if len(unsafe) > 0 {
		out = append(out, sectionRule("nothing was stored"))
		out = append(out, blank())
		out = issueLines(out, unsafe)
		out = append(out, blank())
	}
	if len(structural) > 0 {
		out = append(out, sectionRule(fmt.Sprintf("%d problem(s)", len(structural))))
		out = append(out, blank())
		out = issueLines(out, structural)
		out = append(out, blank())
	}

	if len(unsafe) > 0 {
		out = append(out, footer("remove the value, keep the meaning, then save again"))
	} else {
		out = append(out, footer("fix these and validate again"))
	}
	return strings.Join(out, "\n")
}

func issueLines(out []string, issues []ValidationIssue) []string {
	for _, issue := range issues {
		path := issue.Path
		if path == "" {
			path = "/"
		}
		for i, text := range Wrap(path+" "+issue.Message, wrapWidth-2) {
			if i == 0 {
				out = append(out, line("✗ "+text))
			} else {
				out = append(out, line("  "+text))
			}
		}
	}
	return out
}
