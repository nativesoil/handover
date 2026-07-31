// The pre-schema ingestion boundary.
//
// Everything else in this package receives a value. This file is the one place
// that receives BYTES, and it is the only place where the rules that cannot
// be seen from a constructed value are enforced:
//
//  1. size        the byte count is bounded before anything decodes, and it
//     is unrecoverable once a value exists
//  2. encoding    the bytes must be UTF-8, with no byte order mark, and
//     nothing is ever repaired or transcoded
//  3. duplicates  a member name repeated inside one object refuses the
//     document, before any object is built from it
//  4. depth       nesting is bounded before anything walks the value, so a
//     deep document is refused rather than crashing the walker
//  5. numbers     a number is judged from its token text, because a parser
//     rounds an oversized integer in silence
//
// Why a boundary rather than the same checks scattered about. A JSON parser is
// lossy on exactly these points: by the time you hold an *Obj, the second "a"
// has overwritten the first, the byte order mark has been stripped or turned
// into a stray rune, the recursion that would have blown the stack has already
// run, and the length of what arrived is gone — whitespace, escapes and member
// order are not recoverable from a value. The safety scan and the validator
// both walk a constructed value, so neither can see any of it.
//
// The security argument for the duplicate rule is the decisive one. With
// last-wins, the fail-closed secret scan sees one value for /sections/x and a
// consumer parsing the same bytes with a different parser sees another. The
// document that gets scanned is then not the document that gets read.
//
// The depth ceiling is derived, not observed. The deepest structure a handover
// needs without custom observation data is 4 levels; the deepest fixture in
// this repository is 6; the lowest hard parser ceiling among the five official
// implementations is 64. 32 sits at half of that.
//
// Mechanism note for this surface: duplicate detection uses encoding/json's
// own streaming decoder, which this package already decodes with. Decoder.Token
// hands over member names one at a time, before any map exists, so the
// repetition an Obj is about to lose is visible where it happens and the
// decode path already carries the pointer to report it. No dependency is
// added; this package has none and gains none.
//
// Depth is checked in a separate, non-recursive scan over the text, run BEFORE
// the decoder. It has to be: decodeValue recurses, the safety scan recurses and
// the validator recurses, so a ceiling enforced anywhere inside them is a
// ceiling enforced too late.
//
// The order of the checks is normative and identical on every surface: size,
// encoding, depth, syntax, duplicate member names, numeric domain. The first
// five are spec/ingestion.md; the sixth is spec/value-domain.md, and it is
// here rather than in the validator because a reader with 64-bit floats has
// destroyed the evidence by the time a value exists.

package handover

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// The bounds this boundary enforces.
const (
	// MaxIngestDepth is the max nesting of containers. The root container
	// counts as level 1.
	MaxIngestDepth = 32
	// MaxIngestBytes is the max size of one serialized handover.
	MaxIngestBytes = 1048576
	// MaxIngestInteger and MinIngestInteger are the ends of the integer
	// domain: the safe-integer range, 2^53 - 1. Beyond them a double can no
	// longer tell two neighbouring integers apart, so a document carrying such
	// a value means one thing to a reader with 64-bit floats and another to a
	// reader with arbitrary-precision integers. See spec/value-domain.md.
	MaxIngestInteger = 9007199254740991
	MinIngestInteger = -9007199254740991
)

// maxIntegerDigits is the decimal spelling of MaxIngestInteger.
//
// The range check compares digit strings rather than converting, because on
// the surfaces where this rule matters most the conversion is what loses the
// answer: a JavaScript parser folds 9007199254740993 into 9007199254740992
// and a forty-digit token into a double with nothing left of its tail. Equal
// length decimal strings compare correctly under ordinary byte order, so digit
// count plus one comparison decides the question exactly, with no big-integer
// type anywhere.
const maxIntegerDigits = "9007199254740991"

// The stable error codes. Identical strings on every surface.
const (
	CodeDocumentTooLarge         = "document.too_large"
	CodeEncodingByteOrderMark    = "encoding.byte_order_mark"
	CodeEncodingUnsupported      = "encoding.unsupported_encoding"
	CodeEncodingInvalidUTF8      = "encoding.invalid_utf8"
	CodeStructureDepthExceeded   = "structure.depth_exceeded"
	CodeSyntaxInvalidJSON        = "syntax.invalid_json"
	CodeStructureDuplicateMember = "structure.duplicate_member"
	CodeNumberNotAnInteger       = "number.not_an_integer"
	CodeNumberOutOfRange         = "number.out_of_range"
)

// IngestErrorCodes lists every code this boundary can report.
var IngestErrorCodes = []string{
	CodeDocumentTooLarge,
	CodeEncodingByteOrderMark,
	CodeEncodingUnsupported,
	CodeEncodingInvalidUTF8,
	CodeStructureDepthExceeded,
	CodeSyntaxInvalidJSON,
	CodeStructureDuplicateMember,
	CodeNumberNotAnInteger,
	CodeNumberOutOfRange,
}

// IngestIssue is one refusal. It carries a class and a location, never
// document content.
type IngestIssue struct {
	// Code is the stable code, e.g. structure.duplicate_member.
	Code string
	// Path is a JSON Pointer to the offending place, or "" for the document.
	Path string
	// Message is a sentence a person can act on. It never echoes a value.
	Message string
}

// Error makes an issue usable as an error without losing its code.
func (i *IngestIssue) Error() string { return i.Message }

// byteOrderMark is a mark this boundary recognises, so it can name what it
// found rather than merely refusing.
type byteOrderMark struct {
	encoding string
	bytes    []byte
}

// The four-byte marks come first: a UTF-32LE mark begins with the two bytes of
// a UTF-16LE mark, so testing the short one first would misname it.
var byteOrderMarks = []byteOrderMark{
	{"UTF-32LE", []byte{0xff, 0xfe, 0x00, 0x00}},
	{"UTF-32BE", []byte{0x00, 0x00, 0xfe, 0xff}},
	{"UTF-8", []byte{0xef, 0xbb, 0xbf}},
	{"UTF-16LE", []byte{0xff, 0xfe}},
	{"UTF-16BE", []byte{0xfe, 0xff}},
}

// sniffUnitWidth names the encoding the first four bytes imply, following the
// detection rule in RFC 4627 section 3: the first token of a JSON text is
// always ASCII, so the position of the NUL padding names the encoding without
// decoding anything. An empty string means the bytes are consistent with UTF-8.
func sniffUnitWidth(data []byte) string {
	if len(data) < 4 {
		return ""
	}
	a, b, c, d := data[0], data[1], data[2], data[3]
	switch {
	case a == 0 && b == 0 && c == 0 && d != 0:
		return "UTF-32BE"
	case a != 0 && b == 0 && c == 0 && d == 0:
		return "UTF-32LE"
	case a == 0 && b != 0 && c == 0 && d != 0:
		return "UTF-16BE"
	case a != 0 && b == 0 && c != 0 && d == 0:
		return "UTF-16LE"
	}
	return ""
}

// scanDepth bounds the nesting without recursing and without building a value.
// String-aware, because a brace inside a string is content. It reports nothing
// but depth: the text may still be malformed here, and the decoder is the
// authority on syntax.
//
// The numeric domain is NOT checked here. This walk runs before the decoder,
// on text that may be malformed, so a run of characters is not yet a number.
// It is judged in decodeIngestValue instead, where UseNumber hands over the
// literal token text and the pointer to report it is already threaded through.
func scanDepth(text string) *IngestIssue {
	depth := 0
	for i := 0; i < len(text); i++ {
		switch text[i] {
		case '"':
			i++
			for i < len(text) {
				if text[i] == '\\' {
					i += 2
					continue
				}
				if text[i] == '"' {
					break
				}
				i++
			}
		case '{', '[':
			depth++
			if depth > MaxIngestDepth {
				return &IngestIssue{
					Code: CodeStructureDepthExceeded,
					Path: "",
					Message: fmt.Sprintf(
						"a serialized handover must nest at most %d levels, found %d",
						MaxIngestDepth, depth),
				}
			}
		case '}', ']':
			depth--
		}
	}
	return nil
}

// judgeNumberToken judges one JSON number token against the integer domain,
// from its TEXT. An empty string means the token is inside the domain.
//
// The two refusals are separate codes because they are separate mistakes: a
// fraction or an exponent is a producer writing a value the format does not
// carry, while a twenty-digit integer is a producer writing a value no reader
// can carry back. 1e2 is 100 and is refused all the same, because deciding
// integrality of an arbitrary decimal needs exact decimal arithmetic the five
// runtimes do not share, and a rule the five cannot execute identically is not
// a rule.
func judgeNumberToken(token string) string {
	if !integerToken.MatchString(token) {
		return CodeNumberNotAnInteger
	}
	digits := strings.TrimPrefix(token, "-")
	if len(digits) > len(maxIntegerDigits) {
		return CodeNumberOutOfRange
	}
	if len(digits) == len(maxIntegerDigits) && digits > maxIntegerDigits {
		return CodeNumberOutOfRange
	}
	return ""
}

// integerToken matches a JSON number written in the integer form: no fraction
// part, no exponent.
var integerToken = regexp.MustCompile(`^-?(?:0|[1-9][0-9]*)$`)

// numberMessage is the message for one numeric refusal. It names a class,
// never a value.
func numberMessage(code string) string {
	if code == CodeNumberNotAnInteger {
		return "a number in a handover must be written as an integer, with no " +
			"fraction part and no exponent"
	}
	return fmt.Sprintf("a number in a handover must lie between %d and %d",
		MinIngestInteger, MaxIngestInteger)
}

// escapePointerSegment applies RFC 6901: ~ becomes ~0 and / becomes ~1.
func escapePointerSegment(segment string) string {
	return strings.ReplaceAll(strings.ReplaceAll(segment, "~", "~0"), "/", "~1")
}

// IngestBytes reads one serialized handover from bytes. This is the boundary:
// the value it returns has been checked for encoding, size, depth and
// duplicate member names, in that order, and nothing was repaired on the way.
func IngestBytes(data []byte) (any, *IngestIssue) {
	if len(data) > MaxIngestBytes {
		return nil, &IngestIssue{
			Code: CodeDocumentTooLarge,
			Message: fmt.Sprintf(
				"a serialized handover must be at most %d bytes, got %d",
				MaxIngestBytes, len(data)),
		}
	}

	for _, mark := range byteOrderMarks {
		if bytes.HasPrefix(data, mark.bytes) {
			return nil, &IngestIssue{
				Code: CodeEncodingByteOrderMark,
				Message: fmt.Sprintf(
					"a serialized handover must not begin with a byte order mark; "+
						"these bytes open with a %s mark. A producer must not write one, "+
						"and a reader must not strip one.", mark.encoding),
			}
		}
	}

	if sniffed := sniffUnitWidth(data); sniffed != "" {
		return nil, &IngestIssue{
			Code: CodeEncodingUnsupported,
			Message: fmt.Sprintf(
				"a serialized handover must be UTF-8; these bytes are %s. "+
					"Other encodings are invalid and are never converted.", sniffed),
		}
	}

	// Go strings hold bytes, so converting is not decoding: the validity check
	// is explicit and refuses rather than substituting U+FFFD, which is what
	// ranging over a string would silently do.
	if !utf8.Valid(data) {
		return nil, &IngestIssue{
			Code: CodeEncodingInvalidUTF8,
			Message: "a serialized handover must be valid UTF-8; these bytes are not, " +
				"and malformed UTF-8 is refused rather than repaired",
		}
	}

	return IngestText(string(data))
}

// IngestText reads a serialized handover that has already been decoded to
// text, e.g. a JSON block lifted out of a model's reply. The encoding rules
// that survive decoding still apply: a leading U+FEFF is a byte order mark
// whether it arrived as three bytes or as one rune.
func IngestText(text string) (any, *IngestIssue) {
	if len(text) > MaxIngestBytes {
		return nil, &IngestIssue{
			Code: CodeDocumentTooLarge,
			Message: fmt.Sprintf(
				"a serialized handover must be at most %d bytes, got %d",
				MaxIngestBytes, len(text)),
		}
	}
	if strings.HasPrefix(text, "\ufeff") {
		return nil, &IngestIssue{
			Code: CodeEncodingByteOrderMark,
			Message: "a serialized handover must not begin with a byte order mark; " +
				"this text opens with a UTF-8 mark. A producer must not write one, " +
				"and a reader must not strip one.",
		}
	}

	// Depth first, and before anything recurses.
	if issue := scanDepth(text); issue != nil {
		return nil, issue
	}

	// One refusal from the decode pass: a duplicate member name, or a number
	// outside the domain. Syntax outranks both, and duplicates outrank the
	// numeric domain.
	value, issue, err := decodeChecked(text)
	if err != nil {
		return nil, &IngestIssue{
			Code:    CodeSyntaxInvalidJSON,
			Message: "the input is not a single well-formed JSON document",
		}
	}
	if issue != nil {
		return nil, issue
	}
	return value, nil
}

// IngestBytesOrError is IngestBytes with the issue returned as an error, for
// call sites that only propagate.
func IngestBytesOrError(data []byte) (any, error) {
	value, issue := IngestBytes(data)
	if issue != nil {
		return nil, issue
	}
	return value, nil
}

// decodeChecked builds the ordered model with encoding/json's streaming
// decoder, recording the first duplicate member name it meets. The duplicate
// is reported only after the whole document has decoded, so a malformed
// document is a syntax refusal on every surface rather than a race between
// two rules.
func decodeChecked(text string) (any, *IngestIssue, error) {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	state := &ingestState{}
	value, err := decodeIngestValue(dec, state, "")
	if err != nil {
		return nil, nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, nil, fmt.Errorf("unexpected content after the JSON document")
	}
	// Duplicates outrank the numeric domain: a document that breaks both is a
	// structural refusal on every surface rather than a race between two rules.
	if state.duplicate != nil {
		return value, state.duplicate, nil
	}
	return value, state.number, nil
}

type ingestState struct {
	duplicate *IngestIssue
	number    *IngestIssue
}

func (s *ingestState) noteDuplicate(pointer string) {
	if s.duplicate != nil {
		return
	}
	s.duplicate = &IngestIssue{
		Code: CodeStructureDuplicateMember,
		Path: pointer,
		Message: "a serialized handover must not repeat a member name inside one object: " +
			"with a repeated name, two readers of the same bytes can hold different documents",
	}
}

func (s *ingestState) noteNumber(code, pointer string) {
	if s.number != nil {
		return
	}
	s.number = &IngestIssue{Code: code, Path: pointer, Message: numberMessage(code)}
}

// decodeIngestValue mirrors decodeValue in jsonvalue.go, with the pointer
// threaded through so a duplicate can say where it sat. Recursion is safe
// here: scanDepth has already refused anything deeper than the ceiling.
func decodeIngestValue(dec *json.Decoder, state *ingestState, pointer string) (any, error) {
	token, err := dec.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		// UseNumber is set on the decoder, so a number arrives as its literal
		// TEXT rather than as a float64. That text is the only representation
		// the five surfaces read the same way, and it is gone the moment
		// anything converts it.
		if number, isNumber := token.(json.Number); isNumber {
			if code := judgeNumberToken(number.String()); code != "" {
				state.noteNumber(code, pointer)
			}
		}
		return token, nil
	}
	switch delim {
	case '{':
		obj := NewObj()
		for dec.More() {
			keyToken, err := dec.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, fmt.Errorf("object key is not a string")
			}
			child := pointer + "/" + escapePointerSegment(key)
			if obj.Has(key) {
				state.noteDuplicate(child)
			}
			value, err := decodeIngestValue(dec, state, child)
			if err != nil {
				return nil, err
			}
			obj.Set(key, value)
		}
		if _, err := dec.Token(); err != nil {
			return nil, err
		}
		return obj, nil
	case '[':
		arr := []any{}
		for dec.More() {
			value, err := decodeIngestValue(dec, state, pointer+"/"+strconv.Itoa(len(arr)))
			if err != nil {
				return nil, err
			}
			arr = append(arr, value)
		}
		if _, err := dec.Token(); err != nil {
			return nil, err
		}
		return arr, nil
	}
	return nil, fmt.Errorf("unexpected delimiter %q", delim.String())
}
