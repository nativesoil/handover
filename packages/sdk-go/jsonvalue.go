// The ordered JSON model the SDK operates on.
//
// A handover travels as a JSON document, and the official TypeScript implementation
// preserves the document's own key order everywhere: in validation paths, in
// the secret scan's finding order, and in the bytes the store writes back.
// Go's built-in maps do not remember insertion order, so the SDK carries
// objects as Obj, a map that does. Every function in this package that takes
// a parsed document expects the shapes ParseJSON produces: nil, bool,
// json.Number, string, []any, and *Obj.
//
// MarshalJSONIndent mirrors what the TypeScript SDK's JSON.stringify with a
// two-space indent emits, so a store written by one SDK reads byte-for-byte
// like a store written by the other.

package handover

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// Obj is a JSON object that remembers the order its keys arrived in.
type Obj struct {
	keys   []string
	values map[string]any
}

// NewObj returns an empty ordered object.
func NewObj() *Obj {
	return &Obj{values: map[string]any{}}
}

// Get returns the value for key and whether the key is present.
func (o *Obj) Get(key string) (any, bool) {
	value, ok := o.values[key]
	return value, ok
}

// Has reports whether the key is present.
func (o *Obj) Has(key string) bool {
	_, ok := o.values[key]
	return ok
}

// Set stores a value. An existing key keeps its position; a new key is
// appended, which is the same rule JavaScript objects follow.
func (o *Obj) Set(key string, value any) {
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

// Delete removes a key, if present.
func (o *Obj) Delete(key string) {
	if _, ok := o.values[key]; !ok {
		return
	}
	delete(o.values, key)
	for i, k := range o.keys {
		if k == key {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

// Keys returns the keys in insertion order. The slice is a copy.
func (o *Obj) Keys() []string {
	return append([]string(nil), o.keys...)
}

// Len returns the number of keys.
func (o *Obj) Len() int {
	return len(o.keys)
}

// Clone returns a shallow copy, like a JavaScript object spread.
func (o *Obj) Clone() *Obj {
	clone := &Obj{
		keys:   append([]string(nil), o.keys...),
		values: make(map[string]any, len(o.values)),
	}
	for key, value := range o.values {
		clone.values[key] = value
	}
	return clone
}

// ParseJSON parses one JSON document into the ordered model. Numbers arrive
// as json.Number so their literal text survives a round trip.
func ParseJSON(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	value, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected content after the JSON document")
	}
	return value, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	token, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := token.(type) {
	case json.Delim:
		switch t {
		case '{':
			obj := NewObj()
			for dec.More() {
				keyToken, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, errors.New("object key is not a string")
				}
				value, err := decodeValue(dec)
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
				value, err := decodeValue(dec)
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
		return nil, fmt.Errorf("unexpected delimiter %q", t.String())
	default:
		return token, nil
	}
}

// MarshalJSONIndent renders a value with a two-space indent, matching the
// bytes the TypeScript SDK writes for the same value.
func MarshalJSONIndent(value any) string {
	var b strings.Builder
	writeValue(&b, value, 0, true)
	return b.String()
}

// MarshalJSONCompact renders a value with no whitespace.
func MarshalJSONCompact(value any) string {
	var b strings.Builder
	writeValue(&b, value, 0, false)
	return b.String()
}

func writeValue(b *strings.Builder, value any, depth int, indent bool) {
	switch v := value.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if v {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		writeString(b, v)
	case json.Number:
		b.WriteString(v.String())
	case int:
		b.WriteString(strconv.Itoa(v))
	case float64:
		b.WriteString(strconv.FormatFloat(v, 'g', -1, 64))
	case []any:
		writeArray(b, v, depth, indent)
	case *Obj:
		writeObject(b, v, depth, indent)
	default:
		panic(fmt.Sprintf("cannot marshal a %T", value))
	}
}

func writeArray(b *strings.Builder, arr []any, depth int, indent bool) {
	if len(arr) == 0 {
		b.WriteString("[]")
		return
	}
	b.WriteByte('[')
	for i, item := range arr {
		if i > 0 {
			b.WriteByte(',')
		}
		if indent {
			b.WriteByte('\n')
			writeIndent(b, depth+1)
		}
		writeValue(b, item, depth+1, indent)
	}
	if indent {
		b.WriteByte('\n')
		writeIndent(b, depth)
	}
	b.WriteByte(']')
}

func writeObject(b *strings.Builder, obj *Obj, depth int, indent bool) {
	if obj.Len() == 0 {
		b.WriteString("{}")
		return
	}
	b.WriteByte('{')
	for i, key := range obj.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		if indent {
			b.WriteByte('\n')
			writeIndent(b, depth+1)
		}
		writeString(b, key)
		b.WriteByte(':')
		if indent {
			b.WriteByte(' ')
		}
		writeValue(b, obj.values[key], depth+1, indent)
	}
	if indent {
		b.WriteByte('\n')
		writeIndent(b, depth)
	}
	b.WriteByte('}')
}

func writeIndent(b *strings.Builder, depth int) {
	for i := 0; i < depth; i++ {
		b.WriteString("  ")
	}
}

func writeString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}
