package handover

import (
	"testing"
	"time"
)

func TestUUIDv7HasTheOfficialShape(t *testing.T) {
	for i := 0; i < 32; i++ {
		id := UUIDv7()
		if !uuidV7Test.MatchString(id) {
			t.Fatalf("not a UUIDv7: %s", id)
		}
	}
}

func TestUUIDv7IsUniquePerCall(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 256; i++ {
		id := UUIDv7()
		if seen[id] {
			t.Fatalf("duplicate id: %s", id)
		}
		seen[id] = true
	}
}

func TestUUIDv7EncodesTheMoment(t *testing.T) {
	// The first 48 bits carry Unix milliseconds, so ids from later moments
	// sort after ids from earlier ones. This is a property of how uniqueness
	// is generated, never a fact a reader may lean on.
	earlier := uuidv7At(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	later := uuidv7At(time.Date(2026, 7, 22, 10, 0, 0, 0, time.UTC))
	if !(earlier < later) {
		t.Fatalf("expected %s < %s", earlier, later)
	}
}

func TestIsHandoverID(t *testing.T) {
	if !IsHandoverID(aValidID) {
		t.Fatal("a canonical UUID must be recognised")
	}
	for _, bad := range []any{"handover-42", "019F7E89-FC00-7000-8000-000000000000", 7, nil} {
		if IsHandoverID(bad) {
			t.Fatalf("should not be recognised: %v", bad)
		}
	}
}
