// The JVM SDK for the Soil Handover format. Kotlin targeting JVM 17, with
// kotlinx-serialization-json as the only runtime dependency: its JsonObject
// preserves key insertion order and its parsed number primitives keep their
// source text, both of which the byte-level store parity depends on.
plugins {
    kotlin("jvm") version "2.2.20"
    `java-library`
}

group = "dev.nativesoil"
version = "0.2.0"

repositories {
    mavenCentral()
}

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")

    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin {
    jvmToolchain(17)
}

// The repo root, resolved from packages/sdk-jvm.
val repoRoot: File = layout.projectDirectory.dir("../..").asFile.canonicalFile

// The canonical recipe texts live in recipes/ at the repo root and are the
// single source of truth. They are packaged into the jar as resources at
// build time, generated from those files rather than embedded by hand, and a
// test holds the resource bytes to byte identity with the repo files.
tasks.processResources {
    from(repoRoot.resolve("recipes")) {
        include("handover-recipe-v1.txt", "rescue-recipe-v1.txt")
        into("dev/nativesoil/handover/recipes")
    }
}

tasks.test {
    useJUnitPlatform()
    systemProperty("soil.repo.root", repoRoot.path)
    // The concurrency test spawns its worker as its own JVM, because the
    // defect it reproduces only happens between processes. It needs the
    // classpath it is itself running on, and `java.class.path` is not
    // dependable when Gradle shortens a long classpath into a manifest jar.
    systemProperty("soil.test.classpath", sourceSets.test.get().runtimeClasspath.asPath)
}

// The same classpath, for measuring the concurrency behaviour by hand rather
// than through the test. `./gradlew -q printTestClasspath` prints one line.
tasks.register("printTestClasspath") {
    val classpath = sourceSets.test.get().runtimeClasspath
    dependsOn(classpath)
    doLast { println(classpath.asPath) }
}
