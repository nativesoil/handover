// The conformance runner for the JVM SDK, mirroring conformance/run.ts and
// conformance/run_py.py. It is a subproject of the packages/sdk-jvm build:
// run it from packages/sdk-jvm with `./gradlew :conformance:run --quiet`.
plugins {
    kotlin("jvm")
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation(rootProject)
}

kotlin {
    jvmToolchain(17)
}

application {
    mainClass = "dev.nativesoil.handover.conformance.RunnerKt"
}

// The repo root, resolved from conformance/jvm.
val repoRoot: File = layout.projectDirectory.dir("../..").asFile.canonicalFile

tasks.named<JavaExec>("run") {
    systemProperty("soil.repo.root", repoRoot.path)
}
