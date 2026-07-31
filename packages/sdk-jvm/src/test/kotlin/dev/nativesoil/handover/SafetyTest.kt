package dev.nativesoil.handover

import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource

private fun withSection(text: String): JsonObject = normalized(
    jsonObject(
        """
        {"handoverId":"$A_VALID_ID","projectId":"secret-test","title":"Secrets",
         "createdAt":"$A_CAPTURE_TIME",
         "sections":{"architecture":${kotlinx.serialization.json.JsonPrimitive(text)}}}
        """.trimIndent()
    ),
)

class SafetyTest {

    @Test
    fun `catches a provider api key`() {
        val findings =
            findSecretMaterial(withSection("The key is sk-abc123def456 and it is in the env."))
        assertTrue(findings.any { it.label == "provider_api_key" })
        assertEquals("/sections/architecture/summary", findings[0].path)
    }

    @Test
    fun `catches a jwt`() {
        val findings = findSecretMaterial(
            withSection("Session token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def")
        )
        assertTrue(findings.any { it.label == "jwt" })
    }

    @Test
    fun `catches a bearer token and an authorization header`() {
        val labels = findSecretMaterial(
            withSection("Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e")
        ).map { it.label }
        assertTrue("authorization_header" in labels)
        assertTrue("bearer_token" in labels)
    }

    @ParameterizedTest
    @ValueSource(
        strings = [
            "clone https://ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/o/r.git",
            "the runner env holds AKIAIOSFODNN7EXAMPLE",
            "the bot posts with xoxb-2314789012-4567890123456-AbCdEfGhIjKlMnOpQrStUvWx",
            "maps is keyed with AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
            "the token is github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789",
        ]
    )
    fun `catches the vendor token formats that leak`(text: String) {
        assertTrue(
            findSecretMaterial(withSection(text)).any { it.label == "provider_api_key" }
        )
    }

    @Test
    fun `catches credentials embedded in a url`() {
        assertTrue(
            findSecretMaterial(
                withSection("postgres://orchard:9f8a7b6c5d4e3f@db.internal:5432/orchard")
            ).any { it.label == "url_credentials" }
        )
    }

    // The precedence rule: a redaction claim never suppresses a detection in
    // the same string. The conjunction is refused under the detected class.
    @Test
    fun `refuses a real value even when the same string claims redaction`() {
        assertTrue(
            findSecretMaterial(
                withSection(
                    "The token was redacted: " +
                        "ghp_16C7e42F292c6912E7710c838347Ae178B4a is gone."
                )
            ).any { it.label == "provider_api_key" }
        )
    }

    @Test
    fun `catches a pem private key`() {
        val labels =
            findSecretMaterial(withSection("-----BEGIN RSA PRIVATE KEY-----")).map { it.label }
        assertTrue("private_key_pem" in labels)
    }

    @ParameterizedTest
    @ValueSource(
        strings = [
            "/Users/casey/Developer/thing",
            "/home/deploy/app/config",
            "C:\\Users\\casey\\project",
        ]
    )
    fun `catches private absolute paths on all platforms`(path: String) {
        val labels = findSecretMaterial(withSection("It lives at $path.")).map { it.label }
        assertTrue("private_path" in labels)
    }

    @Test
    fun `catches client secret and application credentials bound to a value`() {
        assertTrue(
            findSecretMaterial(
                withSection("""the app reads client_secret="9f8a7b6c5d4e3f2a1b0c"""")
            ).any { it.label == "client_secret" }
        )
        assertTrue(
            findSecretMaterial(
                withSection("GOOGLE_APPLICATION_CREDENTIALS=/opt/keys/orchard-sa.json")
            ).any { it.label == "google_application_credentials" }
        )
        assertTrue(
            findSecretMaterial(
                withSection("""the runner loads {"type": "service_account"}""")
            ).any { it.label == "google_application_credentials" }
        )
    }

    // The safe near-neighbour of every class. Refusing any of these would make
    // the format contradict its own section requirements: architecture asks
    // for flag and command names quoted exactly, and safetySummary asks for
    // what was withheld and where it is configured.
    @ParameterizedTest
    @ValueSource(
        strings = [
            "The service uses an Authorization header.",
            "GOOGLE_APPLICATION_CREDENTIALS is set outside the handover.",
            "The client_secret value was intentionally omitted.",
            "A provider API key exists and is set in the deployment platform.",
            "The endpoint expects bearer credentials; the token is not carried here.",
            "Login returns a JWT; the value is not carried here.",
            "The signing key is a PEM private key held in the platform's secret manager.",
            "The CI job reads a GitHub token from the repository secrets.",
            "Run `soil save --project orchard`; SOIL_HOME selects the store and PORT is 3000.",
            "Send it as `Authorization: Bearer <token>`.",
            "The config template ships client_secret=YOUR_CLIENT_SECRET.",
            "GOOGLE_APPLICATION_CREDENTIALS=REDACTED",
            "The URL is documented as postgres://app:password@db.internal:5432/app.",
            "Initialised /home/ada/.soil-server.",
            "The container mounts /home/agent/.soil.",
            "On Windows it is C:\\Users\\user\\.soil.",
        ]
    )
    fun `accepts the safe near-neighbours`(text: String) {
        assertTrue(
            isFreeOfSecretMaterial(withSection(text)),
            "must stay valid: $text -> " +
                findSecretMaterial(withSection(text)).joinToString(", ") { it.label },
        )
    }

    @Test
    fun `finds material anywhere not only in sections`() {
        val doc = normalized(
            jsonObject(
                """
                {"projectId":"secret-test","title":"Secrets",
                 "createdAt":"$A_CAPTURE_TIME",
                 "safety":{"unsafeOmissions":["the key sk-abc123 was withheld"]}}
                """.trimIndent()
            ),
        )
        assertEquals("/safety/unsafeOmissions/0", findSecretMaterial(doc)[0].path)
    }

    @Test
    fun `leaves an ordinary handover alone`() {
        assertTrue(
            isFreeOfSecretMaterial(
                withSection(
                    "A provider API key exists and is set in the deployment platform. " +
                        "Its value is not carried here. The app listens on port 3000."
                )
            )
        )
    }

    @Test
    fun `does not flag a relative path or a public url`() {
        assertTrue(
            isFreeOfSecretMaterial(
                withSection("See src/checkout/window.ts and https://example.com/docs")
            )
        )
    }

    @Test
    fun `scans a plain string at the root path`() {
        val findings = findSecretMaterial("the key is sk-abc123def456")
        assertTrue(findings.any { it.label == "provider_api_key" })
        assertEquals("/", findings[0].path)
    }

    @Test
    fun `describes a finding without echoing the value`() {
        val findings = findSecretMaterial(withSection("key sk-supersecret999"))
        assertTrue(findings.isNotEmpty())
        val message = describeSecretFinding(findings[0])
        assertTrue(message.contains("provider_api_key"))
        assertTrue(message.contains("where it is configured"))
        assertFalse(message.contains("supersecret"))
    }

    @Test
    fun `assertNoSecretMaterial passes a clean document`() {
        assertDoesNotThrow { assertNoSecretMaterial(withSection("nothing secret")) }
    }

    @Test
    fun `fails closed and the error never carries the value`() {
        val error = assertThrows<SecretMaterialException> {
            assertNoSecretMaterial(withSection("token eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.zzz"))
        }
        assertFalse(error.message!!.contains("eyJhbGciOiJIUzI1NiJ9"))
        assertTrue(error.message!!.contains("jwt"))
    }

    @Test
    fun `validate refuses a structurally perfect handover carrying a key`() {
        val result = validateHandover(withSection("key: sk-abc123def"))
        assertFalse(result.valid)
        assertEquals(ValidationIssueKind.SAFETY, result.issues[0].kind)
        assertEquals("/sections/architecture/summary", result.issues[0].path)
    }

    @Test
    fun `validate reports safety and structure problems together`() {
        val doc = withKey(
            withSection("key: sk-abc123def"),
            "projectId",
            kotlinx.serialization.json.JsonPrimitive(""),
        )
        val kinds = validateHandover(doc).issues.map { it.kind }
        assertTrue(ValidationIssueKind.STRUCTURE in kinds)
        assertTrue(ValidationIssueKind.SAFETY in kinds)
    }
}
