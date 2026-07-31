# Conformance runner (JVM)

The conformance suite run against `packages/sdk-jvm`, mirroring `run.ts` and
`run_py.py` at the directory above. It executes every golden fixture and the
behaviour checks (identity, observations, the fail-closed secret scan,
normalization, store round trips, restore framing, determinism, recipe byte
identity), and reports the two conformance classes separately.

This directory is a subproject of the `packages/sdk-jvm` Gradle build, so one
wrapper drives both. Run it from `packages/sdk-jvm`:

```bash
./gradlew :conformance:run --quiet
```

```
soil conformance (jvm, spec 1.0)
Soil Document Conformant       <count> checks
Soil Secure Writer Conformant  <count> checks
```

The counts are not reproduced here, for the reason
[the conformance page](../README.md) gives: nothing in the specification
defines what one check is, the corpus grows, and a number in prose that
nothing derives goes stale without anybody noticing. Run it and read your own.

It exits non-zero on failure and prints what failed rather than a count. The
`schema` category runs in the TypeScript runner only, which pins the published
JSON Schema to these same fixtures once; byte parity of the user-facing
surfaces against the TypeScript SDK is asserted by `packages/sdk-jvm`'s own
test suite.
