// One `soil save` writer process for the Go concurrency test.
//
// The failure this file exists to reproduce cannot be written inside one
// process. Documents are only lost when two *processes* share one store, and
// two processes on one ~/.soil is not exotic: it is an agent running
// `soil save` while a person runs it too, or a shell loop.
//
// It runs the real CLI binary, in a real separate process per save, so what
// is measured is the published tool rather than a library call the tool
// happens to make.
//
// Usage:
//
//	concurrentsave <soilBin> <soilHome> <startAtMs> <count> <out> <docDir>
//
// Every acknowledgement the CLI hands back is appended to <out> as one JSON
// line, together with the marker the document carried, so the test can check
// each receipt against the disk. A refused save is recorded as one too: a
// refusal is a legitimate answer under contention, an acknowledgement for a
// write that did not survive is not.
//
// Nothing here identifies a writer by its process id. Markers are random ids:
// two containers on one volume both run as pid 1, so a test that told writers
// apart by pid would agree with itself for the wrong reason.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	handover "github.com/nativesoil/handover/packages/sdk-go"
)

type ack struct {
	OK     bool   `json:"ok"`
	Code   string `json:"code,omitempty"`
	Marker string `json:"marker"`
	Error  string `json:"error,omitempty"`
}

// workerID is random, never os.Getpid().
func workerID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw)
}

func document(marker string) map[string]any {
	sections := map[string]any{}
	for _, key := range handover.SectionKeys {
		sections[key] = map[string]any{"status": "missing", "summary": nil}
	}
	sections["projectIdentity"] = map[string]any{"status": "available", "summary": marker}
	return map[string]any{
		"soilHandover": "1.0",
		"projectId":    "billing-rework",
		"title":        marker,
		"createdAt":    "2026-07-24T10:00:00.000Z",
		"sections":     sections,
	}
}

func record(out string, line ack) {
	encoded, err := json.Marshal(line)
	if err != nil {
		panic(err)
	}
	file, err := os.OpenFile(out, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		panic(err)
	}
	defer file.Close()
	if _, err := file.Write(append(encoded, '\n')); err != nil {
		panic(err)
	}
}

func main() {
	args := os.Args[1:]
	if len(args) != 6 {
		fmt.Fprintln(os.Stderr, "usage: concurrentsave <soilBin> <soilHome> <startAtMs> <count> <out> <docDir>")
		os.Exit(2)
	}
	soilBin, home, startAtRaw, countRaw, out, docDir := args[0], args[1], args[2], args[3], args[4], args[5]
	startAtMs, err := strconv.ParseInt(startAtRaw, 10, 64)
	if err != nil {
		panic(err)
	}
	count, err := strconv.Atoi(countRaw)
	if err != nil {
		panic(err)
	}
	startAt := time.UnixMilli(startAtMs)
	id := workerID()

	// A deliberate busy wait, so the processes collide instead of queueing.
	for time.Now().Before(startAt) {
	}

	for i := 0; i < count; i++ {
		marker := fmt.Sprintf("%s-%d", id, i)
		path := filepath.Join(docDir, marker+".json")
		encoded, err := json.Marshal(document(marker))
		if err != nil {
			panic(err)
		}
		if err := os.WriteFile(path, encoded, 0o644); err != nil {
			panic(err)
		}

		command := exec.Command(soilBin, "save", path, "--quiet")
		command.Env = append(os.Environ(), "SOIL_HOME="+home)
		var stdout, stderr bytes.Buffer
		command.Stdout = &stdout
		command.Stderr = &stderr
		if err := command.Run(); err != nil {
			// Both halves. A CLI that ran and refused explains itself on
			// stderr; a CLI that never started leaves stderr empty, and then
			// the error is the only account of what happened.
			reason := strings.TrimSpace(stderr.String())
			if reason == "" {
				reason = err.Error()
			}
			record(out, ack{OK: false, Marker: marker, Error: reason})
			continue
		}
		record(out, ack{OK: true, Code: strings.TrimSpace(stdout.String()), Marker: marker})
	}
}
