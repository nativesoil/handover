// The JVM SDK build. The conformance runner lives at conformance/jvm at the
// repo root, mirroring conformance/run.ts and conformance/run_py.py, and is
// wired in here as a subproject so one wrapper drives both.
rootProject.name = "soil-handover-sdk-jvm"

include(":conformance")
project(":conformance").projectDir = file("../../conformance/jvm")
