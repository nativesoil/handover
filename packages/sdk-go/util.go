// String-length helpers.
//
// Two units live here and they answer two different questions.
//
// TextLength is the FORMAT's unit: the number of Unicode code points in a
// string, which is what every length bound in the specification is counted in
// and what the published JSON Schema's maxLength has always meant. See
// spec/value-domain.md.
//
// u16len and its neighbours are the RENDERER's unit: a rail card is laid out
// in columns, the reference renderer is the TypeScript one, and byte-identical
// card output across five languages means copying how that runtime measures a
// string for padding. That is a display concern and it is deliberately not the
// format's. The two were the same helper until the unit was decided, which is
// how the validator came to bound a title in UTF-16 units.

package handover

import (
	"strings"
	"unicode/utf8"
)

// TextLength returns the string's length in Unicode code points, the unit
// every length bound in this format is counted in.
//
// On this runtime a string is bytes, so neither len nor a UTF-16 count is the
// answer: len("😀") is 4 and its UTF-16 length is 2, while its length in this
// format is 1. Code points cost no Unicode table — the count is a property of
// the encoding, not of the character database — and it does not change when a
// new Unicode version ships.
func TextLength(s string) int {
	return utf8.RuneCountInString(s)
}

// u16len returns the string's length in UTF-16 code units.
func u16len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// u16Slice returns the prefix of s that fits in at most units UTF-16 code
// units, never splitting a surrogate pair.
func u16Slice(s string, units int) string {
	n := 0
	for i, r := range s {
		width := 1
		if r > 0xFFFF {
			width = 2
		}
		if n+width > units {
			return s[:i]
		}
		n += width
	}
	return s
}

// padEnd pads s with spaces on the right to the given width, in UTF-16
// units, like String.prototype.padEnd.
func padEnd(s string, width int) string {
	if n := u16len(s); n < width {
		return s + strings.Repeat(" ", width-n)
	}
	return s
}

// padStart pads s with spaces on the left to the given width, in UTF-16
// units, like String.prototype.padStart.
func padStart(s string, width int) string {
	if n := u16len(s); n < width {
		return strings.Repeat(" ", width-n) + s
	}
	return s
}
