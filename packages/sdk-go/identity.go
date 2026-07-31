// Handover identity: the handoverId.
//
// Every stored handover carries one globally unique id, a UUIDv7 (RFC 9562).
// It is assigned by the writer at store time when the document does not
// already carry one; the extraction recipe never asks a model to invent an
// id, because an id a model makes up is an id two documents can share.
//
// The id is opaque. It is never derived from the document's content, never
// reused, and carries no meaning beyond identity: the timestamp embedded in a
// UUIDv7 is an implementation detail of how uniqueness is generated, not a
// fact a reader may lean on. A byte-for-byte copy of a handover keeps its
// handoverId; a new capture, even of the same project a minute later, gets a
// new one; migration never changes it.
//
// The local #NNN code is a different thing entirely: a short human handle
// assigned by one store, for typing. Two stores can both hold a #001 without
// any identity collision, because identity lives here.

package handover

import (
	"crypto/rand"
	"encoding/hex"
	"regexp"
	"time"
)

// HandoverIDPattern is the shape of a handoverId: canonical lowercase UUID
// text, 8-4-4-4-12 hex.
//
// The pattern accepts any UUID version on purpose. The official writers emit
// UUIDv7, but a reader treats the id as opaque, so it does not police which
// version another writer chose.
var HandoverIDPattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
)

// IsHandoverID reports whether the value has the shape of a handoverId.
func IsHandoverID(value any) bool {
	s, ok := value.(string)
	return ok && HandoverIDPattern.MatchString(s)
}

// UUIDv7 generates a UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then
// the version and variant bits, then 74 random bits.
//
// The randomness comes from the platform CSPRNG, and nothing about the
// result is derived from any document.
func UUIDv7() string {
	return uuidv7At(time.Now())
}

func uuidv7At(now time.Time) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	ms := now.UnixMilli()
	for i := 5; i >= 0; i-- {
		b[i] = byte(ms % 256)
		ms /= 256
	}
	b[6] = (b[6] & 0x0f) | 0x70
	b[8] = (b[8] & 0x3f) | 0x80

	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
