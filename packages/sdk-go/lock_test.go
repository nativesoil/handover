package handover

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// holdFromElsewhere leaves behind exactly what another process holding the
// lock leaves.
func holdFromElsewhere(t *testing.T, locks string, name string, holder map[string]any) string {
	t.Helper()
	dir := filepath.Join(locks, name+".lock")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	encoded, err := json.Marshal(holder)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "holder.json"), encoded, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	return dir
}

func nowMs() int64 { return time.Now().UnixMilli() }

func TestWithLockRunsTheBodyAndLeavesNothingBehind(t *testing.T) {
	locks := filepath.Join(t.TempDir(), ".locks")
	ran := false
	if err := WithLock(locks, "store", func() error {
		ran = true
		return nil
	}, LockOptions{}); err != nil {
		t.Fatalf("WithLock: %v", err)
	}
	if !ran {
		t.Fatal("the body did not run")
	}
	if _, err := os.Stat(filepath.Join(locks, "store.lock")); !os.IsNotExist(err) {
		t.Fatal("the lock directory outlived the call")
	}
}

func TestWithLockReleasesWhenTheBodyFails(t *testing.T) {
	locks := filepath.Join(t.TempDir(), ".locks")
	boom := errors.New("boom")
	if err := WithLock(locks, "store", func() error { return boom }, LockOptions{}); !errors.Is(err, boom) {
		t.Fatalf("expected the body's error, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(locks, "store.lock")); !os.IsNotExist(err) {
		t.Fatal("the lock directory outlived the call")
	}
}

func TestWithLockRefusesRatherThanRunningTheBody(t *testing.T) {
	locks := filepath.Join(t.TempDir(), ".locks")
	holdFromElsewhere(t, locks, "store", map[string]any{
		"holder":     "11111111-1111-4111-8111-111111111111",
		"acquiredAt": nowMs(),
		"host":       "elsewhere",
		"pid":        1,
	})
	ran := false
	err := WithLock(locks, "store", func() error {
		ran = true
		return nil
	}, LockOptions{Timeout: 60 * time.Millisecond})

	var busy *LockBusyError
	if !errors.As(err, &busy) {
		t.Fatalf("expected a LockBusyError, got %v", err)
	}
	// The point of the refusal: nothing was written, not even partly.
	if ran {
		t.Fatal("the body ran even though the lock was held")
	}
}

func TestWithLockDoesNotDecideAnythingFromAProcessID(t *testing.T) {
	// Two containers on one volume both run as pid 1. A lock whose holder
	// carries *this* process's own pid must still be treated as somebody
	// else's, or a fix that leans on pids being distinct silently opens the
	// race it was meant to close.
	locks := filepath.Join(t.TempDir(), ".locks")
	holdFromElsewhere(t, locks, "store", map[string]any{
		"holder":     "22222222-2222-4222-8222-222222222222",
		"acquiredAt": nowMs(),
		"host":       "elsewhere",
		"pid":        os.Getpid(),
	})
	var busy *LockBusyError
	err := WithLock(locks, "store", func() error { return nil },
		LockOptions{Timeout: 60 * time.Millisecond})
	if !errors.As(err, &busy) {
		t.Fatalf("expected a LockBusyError, got %v", err)
	}
}

func TestWithLockTakesOverALockWhoseHolderDied(t *testing.T) {
	locks := filepath.Join(t.TempDir(), ".locks")
	holdFromElsewhere(t, locks, "store", map[string]any{
		"holder":     "33333333-3333-4333-8333-333333333333",
		"acquiredAt": nowMs() - 120_000,
		"host":       "elsewhere",
		"pid":        1,
	})
	taken := false
	if err := WithLock(locks, "store", func() error {
		taken = true
		return nil
	}, LockOptions{Timeout: 500 * time.Millisecond, Stale: time.Second}); err != nil {
		t.Fatalf("WithLock: %v", err)
	}
	if !taken {
		t.Fatal("an abandoned lock was never broken")
	}
}

func TestWithLockTakesOverADirectoryWithNoHolder(t *testing.T) {
	// The window between the Mkdir and the holder write. Without a fallback
	// this would be a lock nothing could ever break.
	locks := filepath.Join(t.TempDir(), ".locks")
	if err := os.MkdirAll(filepath.Join(locks, "store.lock"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	taken := false
	// A negative Stale means everything already there counts as abandoned.
	if err := WithLock(locks, "store", func() error {
		taken = true
		return nil
	}, LockOptions{Timeout: 500 * time.Millisecond, Stale: -1}); err != nil {
		t.Fatalf("WithLock: %v", err)
	}
	if !taken {
		t.Fatal("a holderless lock directory was never broken")
	}
}

func TestWithLockKeepsDifferentNamesApart(t *testing.T) {
	locks := filepath.Join(t.TempDir(), ".locks")
	holdFromElsewhere(t, locks, "personal-a", map[string]any{
		"holder":     "44444444-4444-4444-8444-444444444444",
		"acquiredAt": nowMs(),
		"host":       "elsewhere",
		"pid":        1,
	})
	// A held personal store must not block a different store's writer.
	if err := WithLock(locks, "personal-b", func() error { return nil },
		LockOptions{Timeout: 60 * time.Millisecond}); err != nil {
		t.Fatalf("a different lock name was blocked: %v", err)
	}
}

func TestWithLockWritesARandomHolderID(t *testing.T) {
	locks := filepath.Join(t.TempDir(), ".locks")
	seen := map[string]bool{}
	for i := 0; i < 3; i++ {
		if err := WithLock(locks, "store", func() error {
			data, err := os.ReadFile(filepath.Join(locks, "store.lock", "holder.json"))
			if err != nil {
				return err
			}
			var holder lockHolder
			if err := json.Unmarshal(data, &holder); err != nil {
				return err
			}
			seen[holder.Holder] = true
			return nil
		}, LockOptions{}); err != nil {
			t.Fatalf("WithLock: %v", err)
		}
	}
	if len(seen) != 3 {
		t.Fatalf("expected three distinct holder ids, got %d", len(seen))
	}
}

func TestStoreLocksWhereEveryOtherSDKPutsIt(t *testing.T) {
	// The on-disk contract: one store, five SDKs, one lock directory.
	root := t.TempDir()
	store := NewStore(root)
	if store.LocksDir != filepath.Join(root, ".locks") {
		t.Fatalf("locks live at %s", store.LocksDir)
	}
}

func TestACreateThatCanNeverWorkFailsAtOnceSayingWhy(t *testing.T) {
	// A create refused for something other than EEXIST is treated as
	// contention, because on Windows that is how a name on its way out is
	// reported. That must not swallow a create that will never work: a lock
	// inside a directory that is not there is not a busy lock, and the caller
	// has to be told the difference, immediately and in the platform's own
	// words.
	locks := filepath.Join(t.TempDir(), ".locks")
	started := time.Now()
	err := WithLock(locks, "missing/child", func() error { return nil }, LockOptions{})
	if err == nil {
		t.Fatal("a lock inside a directory that is not there was taken")
	}
	var busy *LockBusyError
	if errors.As(err, &busy) {
		t.Fatalf("reported as a busy lock rather than as itself: %v", err)
	}
	// Fast, not after the retry budget and not after the acquire timeout.
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("took %v to say a create could not work", elapsed)
	}
}
