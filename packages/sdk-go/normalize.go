// Normalization: turn what a model actually emitted into a spec-shaped
// document.
//
// Models write JSON by hand under pressure. They use the loose
// extractionSections key, they write a section as a bare string, they skip
// sections they had nothing for, they forget soilHandover. None of that is
// interesting, and none of it should cost a user their capture.
//
// One rule governs the whole file, and it is the rule that makes a save and a
// validation of the same bytes agree:
//
//	Every member present in the input is present in the output. A member is
//	rewritten only in the ways spec/normalization-profile.md enumerates, a
//	value that cannot be rewritten is carried through verbatim, and nothing
//	is invented.
//
// So an unknown top-level field, an unknown field on a section, an unknown
// section key and an unrecognised provenance label all survive this function
// and are refused by Validate, at the path they actually occupy. Version one
// is a closed world (spec/versioning.md): none of those is an extension point,
// and deleting them here would mean the same bytes were rejected by Validate
// and accepted by Save.
//
// Three things this deliberately does NOT do, each of which it used to:
//
//   - It does not stamp a createdAt. A document that does not say when it was
//     captured is refused by Validate, not completed here.
//   - It does not stamp source.recipeVersion. This function is handed a
//     document somebody else wrote, so attributing its own recipe to that
//     document destroys the field's only use.
//   - It does not drop a handoverId it cannot use. A malformed id reaches
//     Validate and is refused there, rather than being dropped here and
//     replaced, over the top, with a freshly minted one by the writer.

package handover

import (
	"regexp"
	"strings"
)

// The members each object may carry. Everything else is carried through.
var (
	sectionFields = []string{"status", "summary", "provenance"}
	sourceFields  = []string{"client", "model", "provider", "recipeVersion"}
	qualityFields = []string{"missingInputs", "contradictions"}
	safetyFields  = []string{"unsafeOmissions"}
	rootFields    = []string{
		"soilHandover",
		"handoverId",
		"projectId",
		"title",
		"createdAt",
		"source",
		"sections",
		"quality",
		"safety",
		"observations",
		"code",
	}
)

func asTrimmedString(value any) (string, bool) {
	s, ok := value.(string)
	if !ok {
		return "", false
	}
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

func missingSection() *Obj {
	section := NewObj()
	section.Set("status", "missing")
	section.Set("summary", nil)
	return section
}

// carryUnknown copies the members of record that are neither known nor
// consumed, in input order. This is the carry-through that keeps Validate able
// to see what the model actually wrote. It never inspects the values.
func carryUnknown(out *Obj, record *Obj, known []string, consumed ...string) {
	for _, key := range record.Keys() {
		if contains(known, key) || contains(consumed, key) {
			continue
		}
		value, _ := record.Get(key)
		out.Set(key, value)
	}
}

// normalizeSection normalizes one section value. A bare non-empty string
// becomes an available section. A string with nothing in it, a null and an
// absent key all become a declared gap, because "nothing here" is exactly what
// missing states. An object is kept, with its status inferred when absent and
// its unknown members carried through. Anything else — a number, an array, a
// boolean — is carried through untouched, so Validate reports it at
// /sections/<key> instead of this function quietly recording a gap where the
// model wrote something.
func normalizeSection(value any) any {
	if text, ok := asTrimmedString(value); ok {
		section := NewObj()
		section.Set("status", "available")
		section.Set("summary", text)
		return section
	}
	if value == nil {
		return missingSection()
	}
	if _, isString := value.(string); isString {
		return missingSection()
	}
	record, ok := asObj(value)
	if !ok {
		return value
	}

	summaryValue, _ := record.Get("summary")
	summary, hasSummary := asTrimmedString(summaryValue)
	statusValue, hasStatusKey := record.Get("status")
	rawStatus, hasStatus := asTrimmedString(statusValue)
	// A status the model actually wrote is kept exactly as written, even when
	// it is not one of the three. Validate then refuses it at
	// /sections/<key>/status. Rewriting "Available" to "available" would be
	// normalization inventing a claim: the section would count as carrying
	// content and would vanish from the list of what is not captured, and the
	// author would never learn the word was wrong.
	var status any
	switch {
	case hasStatus:
		status = rawStatus
	case hasStatusKey:
		status = statusValue
	case hasSummary:
		status = "available"
	default:
		status = "missing"
	}

	section := NewObj()
	section.Set("status", status)
	switch {
	case hasSummary:
		section.Set("summary", summary)
	case summaryValue == nil:
		section.Set("summary", nil)
	default:
		if _, isString := summaryValue.(string); isString {
			section.Set("summary", nil)
		} else {
			section.Set("summary", summaryValue)
		}
	}

	// Provenance is carried verbatim whenever it is there at all. Filtering
	// out a label this implementation does not know would delete the one thing
	// that lets a cold reader tell a check from a guess, and the label set is
	// closed for the whole of version one: an unrecognised label is an error,
	// not noise.
	if provenance, ok := record.Get("provenance"); ok {
		section.Set("provenance", provenance)
	}
	carryUnknown(section, record, sectionFields)
	return section
}

// normalizeStringList trims a list of prose, reporting false when any entry is
// not usable prose. The caller then leaves the list exactly as written, and
// Validate reports the entry that is wrong rather than this function deleting
// it.
func normalizeStringList(value any) ([]any, bool) {
	list, ok := value.([]any)
	if !ok {
		return nil, false
	}
	kept := []any{}
	for _, entry := range list {
		text, ok := asTrimmedString(entry)
		if !ok {
			return nil, false
		}
		kept = append(kept, text)
	}
	return kept, true
}

// normalizeNamedObject trims the string members this object is known to carry
// and leaves everything else — unknown members, and known members holding
// something other than usable text — exactly where it was.
func normalizeNamedObject(value any, known []string) any {
	record, ok := asObj(value)
	if !ok {
		return value
	}
	out := NewObj()
	for _, key := range record.Keys() {
		entry, _ := record.Get(key)
		if text, ok := asTrimmedString(entry); ok && contains(known, key) {
			out.Set(key, text)
			continue
		}
		out.Set(key, entry)
	}
	return out
}

// normalizeListObject is the same, for the two objects whose members are lists
// of prose.
func normalizeListObject(value any, known []string) any {
	record, ok := asObj(value)
	if !ok {
		return value
	}
	out := NewObj()
	for _, key := range record.Keys() {
		entry, _ := record.Get(key)
		if entries, ok := normalizeStringList(entry); ok && contains(known, key) {
			out.Set(key, entries)
			continue
		}
		out.Set(key, entry)
	}
	return out
}

// normalizeSections declares all 17 keys, then carries whatever else was
// written.
func normalizeSections(raw *Obj) *Obj {
	sections := NewObj()
	for _, key := range SectionKeys {
		value, _ := raw.Get(key)
		sections.Set(key, normalizeSection(value))
	}
	carryUnknown(sections, raw, SectionKeys)
	return sections
}

// Normalize turns a parsed JSON value into a spec-shaped document in the
// ordered JSON model.
//
// The result is not guaranteed valid: run Validate on it. What is guaranteed
// is that nothing the input carried was thrown away, and that when the input's
// sections is an object or absent, all 17 section keys are declared. A value
// whose root is not an object is returned as it arrived, because building a
// document around it would replace the value rather than report it.
//
// Observations pass through untouched. An entry whose kind this
// implementation has never heard of is the exact case the extension point
// exists for, so dropping or rewriting it would make the format lossy in the
// one place it promises not to be. And unlike the 17 sections, observations
// are produced by tools rather than by a model writing JSON by hand under
// pressure: a tool that emits a malformed envelope should be told so by
// Validate, not quietly patched here.
func Normalize(input any) any {
	root, ok := asObj(input)
	if !ok {
		return input
	}

	out := NewObj()
	consumed := []string{}

	// The declared version of this document. An input that states one keeps
	// it, whatever it says: normalization never upgrades a document and never
	// downgrades one. An input that states none is declared 1.0, which is a
	// claim about the shape this function just produced, not a claim about
	// where the content came from.
	if version, ok := root.Get("soilHandover"); ok {
		if trimmed, ok := asTrimmedString(version); ok {
			out.Set("soilHandover", trimmed)
		} else {
			out.Set("soilHandover", version)
		}
	} else {
		out.Set("soilHandover", SpecVersion)
	}

	// An id that is already there is kept, whatever shape it is in: a copy
	// keeps its identity, and an id that is present but malformed is a
	// validation error rather than something to drop. Dropping it would hand
	// the writer a document with no id, and the writer would mint a fresh one
	// over the top of the malformed one nobody was ever told about. A missing
	// id stays missing, because assigning it is the writer's job and
	// normalization is not a writer.
	if id, ok := root.Get("handoverId"); ok {
		if trimmed, ok := asTrimmedString(id); ok {
			out.Set("handoverId", trimmed)
		} else {
			out.Set("handoverId", id)
		}
	}

	for _, key := range []string{"projectId", "title"} {
		value, present := root.Get(key)
		switch {
		case !present:
			out.Set(key, "")
		default:
			if trimmed, ok := asTrimmedString(value); ok {
				out.Set(key, trimmed)
			} else {
				out.Set(key, value)
			}
		}
	}

	// No wall clock. A document that does not carry a capture time is refused
	// by Validate, not completed here.
	if createdAt, ok := root.Get("createdAt"); ok {
		if trimmed, ok := asTrimmedString(createdAt); ok {
			out.Set("createdAt", trimmed)
		} else {
			out.Set("createdAt", createdAt)
		}
	}

	// No recipe version is stamped: this function did not write the content,
	// so it is in no position to say which recipe did. source appears in the
	// output only when the input carried one.
	if source, ok := root.Get("source"); ok {
		out.Set("source", normalizeNamedObject(source, sourceFields))
	}

	rawSections, hasSections := root.Get("sections")
	sectionsObj, sectionsAreObject := asObj(rawSections)
	loose, hasLoose := root.Get("extractionSections")
	looseObj, looseIsObject := asObj(loose)
	switch {
	case sectionsAreObject:
		out.Set("sections", normalizeSections(sectionsObj))
	case hasSections:
		out.Set("sections", rawSections)
	case hasLoose && looseIsObject:
		// The loose key the rescue prompt asks for. It is consumed only when
		// it is actually the source of sections; a document carrying both is
		// carrying content under a key nothing read, which is Validate's to
		// report.
		out.Set("sections", normalizeSections(looseObj))
		consumed = append(consumed, "extractionSections")
	default:
		out.Set("sections", normalizeSections(NewObj()))
	}

	if quality, ok := root.Get("quality"); ok {
		out.Set("quality", normalizeListObject(quality, qualityFields))
	}
	if safety, ok := root.Get("safety"); ok {
		out.Set("safety", normalizeListObject(safety, safetyFields))
	}
	if observations, ok := root.Get("observations"); ok {
		out.Set("observations", observations)
	}
	if code, ok := root.Get("code"); ok {
		if trimmed, ok := asTrimmedString(code); ok {
			out.Set("code", trimmed)
		} else {
			out.Set("code", code)
		}
	}

	carryUnknown(out, root, rootFields, consumed...)
	return out
}

var fencedBlockPattern = regexp.MustCompile("(?is)```(?:json)?\\s*\n(.*?)```")

// ExtractJSONBlock pulls the first fenced JSON block out of a model's reply,
// or falls back to the first {...} span. Returns the raw text, not a parsed
// value; the second result is false when no JSON was found.
//
// Models wrap JSON in prose no matter how firmly the prompt says not to, and
// a user pasting a reply should not have to clean it up by hand.
func ExtractJSONBlock(text string) (string, bool) {
	if match := fencedBlockPattern.FindStringSubmatch(text); match != nil {
		return strings.TrimSpace(match[1]), true
	}
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start >= 0 && end > start {
		return strings.TrimSpace(text[start : end+1]), true
	}
	return "", false
}
