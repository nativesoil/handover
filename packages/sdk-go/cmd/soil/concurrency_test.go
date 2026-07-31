// Four `soil save` processes, one store.
//
// Store.Save was an unlocked read-modify-write, so two CLI processes against
// one ~/.soil both read the same nextCode, both wrote a document at that code,
// and the second index write erased the first one's row. Both callers were
// told "saved", and both were given the same load code.
//
// Measured through this CLI on the unlocked store, four processes saving
// fifteen times each: 60 acknowledged and 27, 16 and 15 documents on disk over
// three runs, so 33, 44 and 45 acknowledgements for documents that no longer
// existed. The store now takes the lock in lock.go, and this file is what says
// so.
//
// The checks are the ones the TypeScript CLI's concurrency test makes, because
// it is the same defect:
//
//  1. every save the CLI acknowledged is on disk afterwards
//  2. no two acknowledgements carry the same load code
//  3. every acknowledged code still holds the document that receipt named
//  4. no half-written temporary file survived the race
//
// Nothing here identifies a writer by its process id. Markers are random ids
// (see packages/sdk-go/test-workers/concurrentsave): two containers on one
// volume both run as pid 1, and a test that told writers apart by pid would
// agree with itself for the wrong reason.
//
// Slow by the standards of the rest of this package, and the only test here
// that can fail for a reason a reader would call "a race", so it gets its own
// file. It builds two binaries first, because a race between goroutines is not
// the failure being reproduced.

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	handover "github.com/nativesoil/handover/packages/sdk-go"
)

const (
	concurrentProcesses = 4
	savesPerProcess     = 15
)

type recordedAck struct {
	OK     bool   `json:"ok"`
	Code   string `json:"code"`
	Marker string `json:"marker"`
	Error  string `json:"error"`
}

// executableSuffix is what this toolchain adds to the name of a binary it
// builds: ".exe" on Windows and nothing anywhere else.
//
// Asked of the toolchain rather than decided from the operating system,
// because the toolchain is both what writes the file and what has to find it
// again. A binary built without the suffix does get written on Windows, and
// then os/exec cannot start it: an extensionless path is not looked up as
// itself, only with each suffix in PATHEXT appended, so the file that is
// sitting right there is reported as not found.
func executableSuffix(t *testing.T) string {
	t.Helper()
	out, err := exec.Command("go", "env", "GOEXE").Output()
	if err != nil {
		t.Fatalf("go env GOEXE: %v", err)
	}
	return strings.TrimSpace(string(out))
}

// buildBinary compiles one package into the test's temporary directory.
func buildBinary(t *testing.T, pkg string, name string, into string) string {
	t.Helper()
	out := filepath.Join(into, name+executableSuffix(t))
	command := exec.Command("go", "build", "-o", out, pkg)
	command.Dir = "."
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("go build %s: %v\n%s", pkg, err, output)
	}
	return out
}

func TestFourSaveProcessesLoseNothing(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns processes and builds binaries")
	}
	work := t.TempDir()
	soil := buildBinary(t, ".", "soil", work)
	worker := buildBinary(t, "../../test-workers/concurrentsave", "concurrentsave", work)

	store := filepath.Join(work, "store")
	docs := filepath.Join(work, "docs")
	acks := filepath.Join(work, "acks.jsonl")
	for _, dir := range []string{store, docs} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("MkdirAll: %v", err)
		}
	}

	startAt := strconv.FormatInt(time.Now().Add(1500*time.Millisecond).UnixMilli(), 10)
	var wait sync.WaitGroup
	failures := make(chan string, concurrentProcesses)
	for i := 0; i < concurrentProcesses; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			command := exec.Command(worker, soil, store, startAt,
				strconv.Itoa(savesPerProcess), acks, docs)
			// Both halves, because a process that never started writes
			// nothing at all and only the error says why.
			if output, err := command.CombinedOutput(); err != nil {
				failures <- fmt.Sprintf("%v\n%s", err, output)
			}
		}()
	}
	wait.Wait()
	close(failures)
	for failure := range failures {
		t.Fatalf("a worker process failed: %s", failure)
	}

	file, err := os.Open(acks)
	if err != nil {
		t.Fatalf("no acknowledgements were written: %v", err)
	}
	defer file.Close()
	var lines []recordedAck
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		text := strings.TrimSpace(scanner.Text())
		if text == "" {
			continue
		}
		var line recordedAck
		if err := json.Unmarshal([]byte(text), &line); err != nil {
			t.Fatalf("unreadable acknowledgement %q: %v", text, err)
		}
		lines = append(lines, line)
	}
	if len(lines) != concurrentProcesses*savesPerProcess {
		t.Fatalf("expected %d attempts, got %d", concurrentProcesses*savesPerProcess, len(lines))
	}

	var acknowledged []recordedAck
	for _, line := range lines {
		if line.OK {
			acknowledged = append(acknowledged, line)
			continue
		}
		// A save that was refused under contention is honest, and this store
		// is uncontended enough that none should be. Either way the invariants
		// below are about what was acknowledged, never about what was tried.
		t.Fatalf("a save was refused: %s", line.Error)
	}

	s := handover.NewStore(store)

	// 1. Nothing the CLI printed a code for may be missing afterwards.
	entries, err := os.ReadDir(s.HandoversDir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	onDisk := []string{}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			onDisk = append(onDisk, entry.Name())
		}
		// 4. No half-written temporary file survived the race.
		if strings.Contains(entry.Name(), ".tmp-") {
			t.Fatalf("a temporary file survived: %s", entry.Name())
		}
	}
	if len(onDisk) != len(acknowledged) {
		t.Fatalf("%d acknowledged, %d documents on disk", len(acknowledged), len(onDisk))
	}
	listed, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listed) != len(acknowledged) {
		t.Fatalf("%d acknowledged, %d rows in the index", len(acknowledged), len(listed))
	}

	// 2. No two receipts may carry the same load code.
	codes := map[string]bool{}
	for _, ack := range acknowledged {
		if codes[ack.Code] {
			t.Fatalf("two receipts carry the load code %s", ack.Code)
		}
		codes[ack.Code] = true
	}

	// 3. Every receipt's code must still hold the document it named.
	for _, ack := range acknowledged {
		doc, err := s.Read(ack.Code)
		if err != nil {
			t.Fatalf("acknowledged %s is not readable: %v", ack.Code, err)
		}
		title, _ := doc.Get("title")
		if title != ack.Marker {
			t.Fatalf("%s holds %v, not the document acknowledged as %s",
				ack.Code, title, ack.Marker)
		}
	}
}
