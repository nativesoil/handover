package handover

import (
	"testing"
)

func TestObjPreservesInsertionOrder(t *testing.T) {
	obj := parseObj(t, `{"b":1,"a":2,"c":3}`)
	keys := obj.Keys()
	if keys[0] != "b" || keys[1] != "a" || keys[2] != "c" {
		t.Fatalf("expected document order, got %v", keys)
	}
	obj.Set("a", 9)
	keys = obj.Keys()
	if keys[1] != "a" {
		t.Fatal("overwriting a key must keep its position")
	}
	obj.Set("d", 4)
	if keys := obj.Keys(); keys[3] != "d" {
		t.Fatal("a new key is appended")
	}
}

func TestObjDelete(t *testing.T) {
	obj := parseObj(t, `{"a":1,"b":2}`)
	obj.Delete("a")
	if obj.Has("a") || obj.Len() != 1 {
		t.Fatal("delete removes the key")
	}
}

func TestMarshalIndentMatchesTheReferenceShape(t *testing.T) {
	obj := parseObj(t, `{"a":1,"b":[1,2],"c":{"d":null},"e":[],"f":{}}`)
	want := "{\n  \"a\": 1,\n  \"b\": [\n    1,\n    2\n  ],\n  \"c\": {\n    \"d\": null\n  },\n  \"e\": [],\n  \"f\": {}\n}"
	if got := MarshalJSONIndent(obj); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestMarshalEscapesLikeTheReference(t *testing.T) {
	obj := NewObj()
	obj.Set("text", "a \"quote\", a \\ backslash, a\ttab, a\nnewline and <html> & friends")
	want := `{"text":"a \"quote\", a \\ backslash, a\ttab, a\nnewline and <html> & friends"}`
	if got := MarshalJSONCompact(obj); got != want {
		t.Fatalf("got %s", got)
	}
}

func TestMarshalKeepsNumberLiterals(t *testing.T) {
	value := parse(t, `{"n":1,"big":123456789012345678901234567890}`)
	got := MarshalJSONCompact(value)
	if got != `{"n":1,"big":123456789012345678901234567890}` {
		t.Fatalf("number literals must survive a round trip, got %s", got)
	}
}

func TestParseJSONRejectsTrailingGarbage(t *testing.T) {
	if _, err := ParseJSON([]byte(`{"a":1} extra`)); err == nil {
		t.Fatal("trailing garbage must be rejected")
	}
}
