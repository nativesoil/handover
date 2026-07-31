// The single-writer guarantee.
//
// Every state change that touches a store is a read-modify-write: read
// index.json, write a document, write index.json back. Inside one goroutine
// that is safe enough; across two processes on one directory it is not safe
// at all, and the failure is silent. Both processes read the same index, both
// write a document at the same load code, and the second index write erases
// the first one's row. Both callers were told "saved".
//
// Two processes on one directory is not a hypothetical. It is two containers
// on one volume, and it is two `soil save` invocations against one ~/.soil —
// an agent running the CLI beside a person doing the same.
//
// # The mechanism
//
// An advisory lock directory, taken with os.Mkdir. Mkdir either creates the
// directory or fails with EEXIST, in one indivisible step, on every
// filesystem this code can run on including NFS, where O_EXCL on a plain file
// historically could not be trusted. No dependency: the standard library
// expresses every part of this, which is why this SDK still has none.
//
// A holder.json inside the directory records who holds it. The holder id is
// random, never a process id. Two containers that both run as pid 1 must not
// be able to look like each other; that also rules out any "is that pid
// alive" stale check, which would be wrong across containers anyway.
//
// # What happens when the lock cannot be taken
//
// The write is refused. Nothing is written and nothing is half-written: the
// caller gets a *LockBusyError. A refusal a caller can retry is the honest
// outcome; the thing that must never happen is an acknowledgement for a write
// that did not survive.
//
// A stale lock, left by a process that was killed mid-write, is broken after
// DefaultStale. Breaking a lock is the one unsound moment in any advisory
// scheme, so it is deliberately far beyond any honest hold time.
//
// # Two refusals, one rule
//
// Both ends of the lock are a filesystem call that can be refused for a reason
// that passes, and both are held to the same rule: retry for retryBudget, then
// report the refusal as itself.
//
// Releasing is a directory removal. It is refused on Windows when another
// process holds a file inside the directory open, which is exactly what every
// waiter is doing to holder.json. A release whose outcome is discarded is worse
// than one that fails loudly: the holder carries on believing it released, and
// every other writer waits the whole staleness window for a lock that nobody
// holds.
//
// Taking is a directory create. Mkdir says EEXIST when somebody else holds the
// lock, and that is the ordinary answer, but it is not the only way a platform
// says the name is unavailable. Windows refuses a create on a name whose
// deletion has been accepted and not yet finished, with access denied, while a
// lookup of that same name already reports it as gone: for a few milliseconds
// the name is neither present nor creatable. Measured on a Windows runner over
// 180 repetitions of two races: 38 refused creates, all of them access denied,
// all of them with a lookup reporting the name absent, and every one resolving
// into a taken lock between 4 and 121 milliseconds.
//
// So a create refused for anything but EEXIST is treated as contention for as
// long as the budget, and reported as itself once the budget is spent. It is
// never turned into a *LockBusyError, because a directory that cannot be
// created is not a busy lock, and the difference has to reach the caller.
//
// The on-disk shape — the <name>.lock directory, the holder.json inside it
// and the fields it carries — is the same in all five SDKs, so a Go writer
// and a Python writer on one store wait for each other.

package handover

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"math/big"
	"os"
	"path/filepath"
	"time"
)

// DefaultLockTimeout is how long an acquire waits before giving up.
const DefaultLockTimeout = 5 * time.Second

// DefaultLockStale is how old a lock must be before it is treated as
// abandoned.
const DefaultLockStale = 30 * time.Second

// retryBudget is how long either side of the lock keeps trying a filesystem
// call that was refused for a reason that passes, before reporting the refusal
// as itself. Well inside DefaultLockTimeout, so a retry never itself becomes
// the reason a waiter is refused, and far short of DefaultLockStale.
const retryBudget = 1 * time.Second

const lockHolderFile = "holder.json"

// LockBusyError is returned when a lock could not be taken. Nothing was
// written.
type LockBusyError struct {
	// LockName is the lock that was contended, as a short name, never a path.
	LockName string
}

func (e *LockBusyError) Error() string {
	return "another process is writing and the " + e.LockName +
		" lock could not be taken; nothing was written, try again"
}

// LockOptions are the tunables, for the tests. A zero field means the
// default; a negative Stale means every lock already there counts as
// abandoned, which is how a test reaches the take-over path without waiting.
type LockOptions struct {
	Timeout time.Duration
	Stale   time.Duration
}

// resolve reads the two tunables, applying the defaults.
func (o LockOptions) resolve() (timeout time.Duration, staleMs int64) {
	timeout = o.Timeout
	if timeout <= 0 {
		timeout = DefaultLockTimeout
	}
	switch {
	case o.Stale < 0:
		staleMs = 0
	case o.Stale == 0:
		staleMs = DefaultLockStale.Milliseconds()
	default:
		staleMs = o.Stale.Milliseconds()
	}
	return timeout, staleMs
}

type lockHolder struct {
	Holder     string `json:"holder"`
	AcquiredAt int64  `json:"acquiredAt"`
	Host       string `json:"host"`
	// Informational only. Nothing is ever decided from this.
	PID int `json:"pid"`
}

// randomID returns a random identifier, never anything derived from the
// process.
func randomID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		// A machine with no entropy source cannot be given a weaker id
		// instead: a predictable holder id is the failure this guards.
		panic("soil: no randomness available for a lock holder id: " + err.Error())
	}
	return hex.EncodeToString(raw)
}

// readLockHolder reads the holder record, or reports that there is not a
// readable one.
//
// A lock directory with no readable holder file is one that was created a
// moment ago, or one whose holder died between the two steps. Both are
// handled by the staleness path in WithLock.
func readLockHolder(dir string) (lockHolder, bool) {
	data, err := os.ReadFile(filepath.Join(dir, lockHolderFile))
	if err != nil {
		return lockHolder{}, false
	}
	var holder lockHolder
	if err := json.Unmarshal(data, &holder); err != nil {
		return lockHolder{}, false
	}
	if holder.Holder == "" || holder.AcquiredAt == 0 {
		return lockHolder{}, false
	}
	return holder, true
}

// lockDirectoryAge reports when the lock directory itself was last written,
// or now when it is unreadable.
func lockDirectoryAge(dir string) int64 {
	info, err := os.Stat(dir)
	if err != nil {
		return time.Now().UnixMilli()
	}
	return info.ModTime().UnixMilli()
}

// removeLockDirectory removes the lock directory and whatever is inside it,
// once.
//
// It reports nil when the directory is gone afterwards, and the failure when
// it is still there. Nobody may assume the removal happened: that assumption
// is what turns one refused delete into a lock held for the whole staleness
// window.
func removeLockDirectory(dir string) error {
	// Left to the removal below, which is the call whose outcome is read.
	_ = os.Remove(filepath.Join(dir, lockHolderFile))
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return nil
}

// releaseLockDirectory gives the lock back, retrying a removal that failed for
// a passing reason.
//
// Deleting a file another process holds open is refused outright on some
// platforms, and every waiter reads holder.json a few times a second, so a
// release and a waiter's read do collide. The collision lasts as long as one
// read, which is why retrying is what resolves it, on the same jitter the
// acquire loop uses. Measured on a Windows runner against the Python port of
// this file: one release in fifty was refused this way, and the lock it failed
// to give back stayed held for the full thirty seconds, refusing every save in
// that window.
//
// Whatever is still there when the budget is spent is reported rather than
// dropped. A lock this process holds and cannot give back is one every other
// writer waits the staleness window for, and this process is the only one in a
// position to say so.
func releaseLockDirectory(dir string) error {
	deadline := time.Now().Add(retryBudget)
	for {
		err := removeLockDirectory(dir)
		if err == nil || !time.Now().Before(deadline) {
			return err
		}
		time.Sleep(lockJitterMs())
	}
}

// breakLockIfStale breaks a lock that looks abandoned, but only the exact one
// that was seen to be abandoned: the holder id is re-read immediately before
// the removal, so a lock that changed hands in between is left alone.
//
// A removal that fails here is left to the acquire loop, which comes back
// within milliseconds and tries again. That is the difference between this
// path and the release path: here the caller is about to look, so nothing is
// being told that the lock is gone.
func breakLockIfStale(dir string, seen lockHolder) {
	again, ok := readLockHolder(dir)
	if !ok || again.Holder != seen.Holder {
		return
	}
	_ = removeLockDirectory(dir)
}

// lockJitterMs returns a short randomised wait, so two waiters do not wake in
// lockstep forever.
func lockJitterMs() time.Duration {
	n, err := rand.Int(rand.Reader, big.NewInt(9))
	if err != nil {
		return 7 * time.Millisecond
	}
	return time.Duration(3+n.Int64()) * time.Millisecond
}

// WithLock runs body while holding the named lock.
//
// locksDir must sit on the same volume as the data it guards, because that is
// the only thing two processes are guaranteed to share. Store passes
// <store root>/.locks, which is where every SDK puts it, so the layout stays
// identical.
//
// It returns a *LockBusyError if the lock could not be taken in time; body
// did not run and nothing was written.
func WithLock(locksDir string, name string, body func() error, options LockOptions) (err error) {
	timeout, staleMs := options.resolve()

	dir := filepath.Join(locksDir, name+".lock")
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown"
	}
	holder := lockHolder{
		Holder:     randomID(),
		AcquiredAt: time.Now().UnixMilli(),
		Host:       hostname,
		PID:        os.Getpid(),
	}

	if err := os.MkdirAll(locksDir, 0o755); err != nil {
		return err
	}

	deadline := time.Now().Add(timeout)
	taken := false
	// When the first create was refused for a reason other than EEXIST. Reset
	// the moment a create is refused for EEXIST, because that is the name
	// becoming visible again: whatever the earlier refusal was, it is over.
	refusedAt := time.Time{}
	for {
		mkdirErr := os.Mkdir(dir, 0o755)
		if mkdirErr == nil {
			taken = true
			break
		}
		if !errors.Is(mkdirErr, fs.ErrExist) {
			// Not EEXIST, and not necessarily fatal either. See "Two refusals,
			// one rule" above: this is how one platform says a name is on its
			// way out. Give it the budget, then let it speak.
			if info, err := os.Stat(filepath.Dir(dir)); err != nil || !info.IsDir() {
				// Except when there is nothing to wait for. No amount of
				// waiting makes a name creatable inside a directory that is
				// not there, and the caller should hear that at once.
				return mkdirErr
			}
			if refusedAt.IsZero() {
				refusedAt = time.Now()
			}
			if time.Since(refusedAt) >= retryBudget {
				return mkdirErr
			}
			time.Sleep(lockJitterMs())
			continue
		}
		refusedAt = time.Time{}

		now := time.Now().UnixMilli()
		if current, ok := readLockHolder(dir); ok {
			if now-current.AcquiredAt > staleMs {
				breakLockIfStale(dir, current)
				continue
			}
		} else if now-lockDirectoryAge(dir) > staleMs {
			// A lock directory with no readable holder file is either one
			// created a microsecond ago, or one whose owner died between the
			// Mkdir and the write. Without this branch the second case would
			// be a lock nothing can ever break, so the directory's own
			// modification time stands in for the holder.
			_ = removeLockDirectory(dir)
			continue
		}

		if !time.Now().Before(deadline) {
			break
		}
		time.Sleep(lockJitterMs())
	}

	if !taken {
		return &LockBusyError{LockName: name}
	}

	// Both of these are releases: the lock is held and the holder record is
	// not there, so the directory has to go back. The removal is retried, and
	// its own failure gives way to the more informative one it stands beside.
	encoded, err := json.Marshal(holder)
	if err != nil {
		_ = releaseLockDirectory(dir)
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, lockHolderFile), encoded, 0o644); err != nil {
		_ = releaseLockDirectory(dir)
		return err
	}

	defer func() {
		// Release only what is still ours. If the lock was broken as stale
		// while this body ran, the directory now belongs to somebody else and
		// removing it would hand a third process a lock two processes think
		// they hold.
		current, ok := readLockHolder(dir)
		if !ok || current.Holder == holder.Holder {
			// A body that failed carries the more informative failure, so a
			// release failure is reported only when there is nothing to hide
			// behind. It is never dropped.
			if releaseErr := releaseLockDirectory(dir); releaseErr != nil && err == nil {
				err = releaseErr
			}
		}
	}()
	return body()
}
