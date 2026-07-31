/**
 * Cross-SDK parity: the JVM SDK reproduces the TypeScript SDK's observable
 * output byte for byte.
 *
 * The golden files under `src/test/resources/parity/` were produced by the
 * built TypeScript SDK (`packages/sdk-ts`) from the shared worked example.
 * The restore prompt and the rail cards are the format's user-facing surface,
 * so byte identity is asserted. The store is a shared on-disk format, so the
 * stored file and index bytes are asserted too. The secret scan is compared
 * on observable behaviour, never on internals: the same inputs report the
 * same pattern classes.
 */
package dev.nativesoil.handover

import java.nio.file.Files
import kotlin.io.path.readText
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

private fun golden(name: String): String {
    val stream = ParityTest::class.java.getResourceAsStream("/parity/$name")
        ?: error("missing golden resource $name")
    return stream.use { String(it.readAllBytes(), Charsets.UTF_8) }
}

class ParityTest {

    private val example: JsonObject =
        jsonObject(REPO_ROOT.resolve("examples/orchard-checkout.json").readText())

    @Test
    fun `the restore prompt is byte identical for the example`() {
        // A fixed boundary token: production takes 128 bits from the
        // platform's cryptographic source on every render, so a golden of a
        // per-render value would be a golden of nothing.
        assertEquals(
            golden("restore-prompt.txt"),
            buildRestorePrompt(example, "0123456789abcdef0123456789abcdef"),
        )
    }

    @Test
    fun `the working-style block is byte identical for a document carrying the kind`() {
        // The block a caller can ask for, on the conformance fixture that
        // carries a `working.style` observation. A document that renders one way
        // here and another way there is the one thing the cross-language
        // byte-identity claim does not survive.
        val carrying = jsonObject(
            REPO_ROOT
                .resolve("conformance/fixtures/valid/observation-working-style.json")
                .readText()
        )
        assertEquals(
            golden("restore-prompt-working-style.txt"),
            buildRestorePrompt(
                carrying,
                "0123456789abcdef0123456789abcdef",
                workingStyleEvidence = true,
            ),
        )
    }

    @Test
    fun `the saved card is byte identical for the example`() {
        assertEquals(golden("saved-card.txt"), renderSaved(example, "#001"))
    }

    @Test
    fun `the loaded card is byte identical for the example`() {
        val withCode =
            withKey(example, "code", kotlinx.serialization.json.JsonPrimitive("#001"))
        assertEquals(golden("loaded-card.txt"), renderLoaded(withCode))
    }

    @Test
    fun `the stored file bytes are identical to the typescript store`() {
        val home = Files.createTempDirectory("soil-parity-")
        try {
            val store = HandoverStore(home.toString())
            store.save(example)
            assertEquals(
                golden("stored-001.json"),
                home.resolve("handovers/001.json").readText(),
            )
            assertEquals(golden("stored-index.json"), home.resolve("index.json").readText())
        } finally {
            home.toFile().deleteRecursively()
        }
    }

    @Test
    fun `the secret scan reports the same pattern classes for the same inputs`() {
        // The same case list the other SDKs run; the expected labels were
        // produced by the TypeScript scan and are pinned as a golden file.
        val cases = listOf(
            "the key is sk-abc123def456",
            "clone https://ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/o/r.git",
            "the runner env holds AKIAIOSFODNN7EXAMPLE",
            "the bot posts with xoxb-2314789012-4567890123456-AbCdEfGhIjKlMnOpQrStUvWx",
            "maps is keyed with AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
            "Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e",
            "Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1lMTIzNDU2",
            "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln",
            "-----BEGIN PRIVATE KEY-----",
            "the app reads client_secret=\"9f8a7b6c5d4e3f2a1b0c\"",
            "the runner loads {\"type\": \"service_account\", \"project_id\": \"x\"}",
            "GOOGLE_APPLICATION_CREDENTIALS=/opt/keys/orchard-sa.json",
            "it lives at /Users/example/code/app",
            "it lives at /home/deploy/app",
            "it lives at C:\\Users\\example\\app",
            "postgres://orchard:9f8a7b6c5d4e3f@db.internal:5432/orchard",
            "The token was redacted: ghp_16C7e42F292c6912E7710c838347Ae178B4a is gone.",
            "The service uses an Authorization header.",
            "GOOGLE_APPLICATION_CREDENTIALS is set outside the handover.",
            "The client_secret value was intentionally omitted.",
            "A provider API key exists and is set in the deployment platform.",
            "The endpoint expects bearer credentials; the token is not carried here.",
            "Run `soil save --project orchard`; SOIL_HOME selects the store.",
            "Send it as `Authorization: Bearer <token>`.",
            "The config template ships client_secret=YOUR_CLIENT_SECRET.",
            "Initialised /home/ada/.soil-server, and the container mounts /home/agent/.soil.",
            "The URL is documented as postgres://app:password@db.internal:5432/app.",
            "See src/checkout/window.ts and https://example.com/docs",
        )
        val expected = arr(json(golden("scan-labels.json")))!!.map { entry ->
            arr(entry)!!.map { str(it)!! }
        }
        val actual = cases.map { text ->
            findSecretMaterial(text).map { it.label }.sorted()
        }
        assertEquals(expected, actual)
    }
}
