/**
 * The secret scan: a handover that carries credentials is not portable.
 *
 * A handover is written to be moved. It goes into a second model, often at a
 * second vendor, sometimes into a teammate's session. Anything inside it has
 * left the machine it was written on. So a document carrying an API key, a
 * bearer token, a private key or a private absolute path is not a handover with
 * a small problem, it is a credential in transit, and this implementation
 * refuses to store one.
 *
 * The rule is fail-closed and it is normative: see `spec/README.md`. The
 * detection classes, their required safe near-neighbours and their residual
 * limitations are stated in `spec/safety-patterns.md`. It is a spec rule rather
 * than a schema rule because JSON Schema cannot express "this string looks like
 * a token", which is exactly why the conformance suite checks it separately.
 *
 * What this scan is and is not:
 *  - It refuses transferable authentication material, not the subject of a
 *    sentence. Naming a credential type, a header or an environment variable
 *    without binding a value to it is safe and stays valid, because two of the
 *    format's own section requirements ask for exactly that.
 *  - It refuses that material wherever it appears: in an assignment, in a URL,
 *    in a header, in a code block or in unstructured prose.
 *  - It is not a guarantee. A secret with no recognisable shape passes, and no
 *    scanner catches those. RULE 2 in the extraction recipe is the real
 *    defense: carry the meaning, never the value. This is the net underneath.
 *  - It never echoes what it matched. A finding names the pattern class and
 *    the section, never the value, because an error message is another place a
 *    secret can end up.
 *
 * Two mechanisms, and the difference matters. Private-key armour, JWT shape and
 * the vendor key prefixes are MENTION matches: there the mention is the leak.
 * Authorization headers, client secrets, application-credentials and URL
 * userinfo are VALUE-SHAPE matches: they fire only when a value is bound to the
 * name. Private paths are a value-shape match with a closed exemption list of
 * reserved principal names that documentation may use.
 *
 * Parity with the TypeScript SDK is a parity of OUTCOMES: the same inputs are
 * refused with the same class reported. The expressions are not normative.
 */
@file:JvmName("Safety")

package dev.nativesoil.handover

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Characters that can appear inside transferable authentication material.
 * Deliberately excludes the punctuation placeholder syntax is made of (`<`,
 * `>`, `$`, `{`, `}`), so `Bearer <token>` and `client_secret=${VALUE}` never
 * look like values in the first place.
 */
private const val VALUE_CLASS = "[A-Za-z0-9._~+/=-]"

/** The same, widened for a filesystem path or URI bound to a variable. */
private const val PATH_VALUE_CLASS = "[A-Za-z0-9._~+/=:\\\\-]"

/**
 * NO REPETITION HERE MAY BE RESCANNED. `java.util.regex` backtracks, and on a
 * backtracking engine a repetition the engine can be made to walk twice costs
 * quadratic time: measured on 16000 characters of whitespace after
 * `Authorization:`, this engine took 1986 ms where Go's non-backtracking RE2
 * took 4 ms. Bounding turns the walk into a constant per starting position.
 * The ceilings match the TypeScript SDK exactly and what each gives up is
 * documented there.
 *
 * The most whitespace allowed where a header permits optional whitespace.
 * HTTP writes one space or none and forbids any before the colon.
 */
private const val OWS = "[ \\t]{0,32}"

/**
 * The most characters allowed between `BEGIN ` and `PRIVATE KEY` in PEM
 * armour. The longest label in use is `ENCRYPTED ` at ten.
 */
private const val PEM_LABEL_MAX = 32

/**
 * The ceiling on a JWT's header segment, in base64url characters. Only this
 * segment needs one: it bounds the scan looking for the FIRST dot, which is
 * the scan a run of `eyJ` can restart every three characters. The payload and
 * signature stay open, which keeps the class exact and is also the only form
 * Go's RE2 can compile, since it refuses a repeat count over 1000.
 */
private const val JWT_HEADER_MAX = 256

/**
 * Words a published placeholder is made of. A candidate value built only from
 * these, joined by `-`, `_` or `.`, is documentation rather than a credential.
 */
private const val PLACEHOLDER_WORD =
    "(?:redacted|withheld|omitted|masked|removed|placeholder|changeme|none" +
        "|null|nil|na|todo|tbd|your|my|the|example|sample|dummy|test|fake|token" +
        "|tokens|secret|secrets|api|apikey|key|keys|client|id|value|password" +
        "|passwd|pass|user|username|here|goes|xxx)"

/**
 * A candidate value that is a published placeholder or an explicit statement
 * that the value was left out. Applied to the captured value alone, never to
 * the surrounding string: a redaction claim elsewhere in the same text must
 * never suppress a genuine detection. See the precedence rule in
 * `spec/safety-patterns.md`.
 */
private val PLACEHOLDER_VALUE = Regex(
    "^(?:x{3,}|\\*{3,}|\\.{3,}|-{3,}|_{3,}|" + PLACEHOLDER_WORD +
        "(?:[-_.]" + PLACEHOLDER_WORD + ")*)[.,;:!?]?$",
    RegexOption.IGNORE_CASE,
)

/**
 * The reserved principal names, published so documentation has home paths it
 * can write down. It is structurally impossible to tell an invented username
 * from a real one, so the format reserves a closed list instead of guessing,
 * in the spirit of the reserved example domains.
 *
 * `example` is NOT on this list yet: conformance fixture
 * `invalid/secret-private-path.json` currently requires `/Users/example/...`
 * to be refused. The addition is proposed in `spec/safety-patterns.md` and
 * waits on sign-off.
 */
@JvmField
val RESERVED_PRINCIPAL_NAMES: List<String> = listOf(
    "agent",
    "ada",
    "user",
    "username",
    "you",
    "me",
)

private val RESERVED_PRINCIPAL = Regex(
    "^(?:" + RESERVED_PRINCIPAL_NAMES.joinToString("|") + ")$",
    RegexOption.IGNORE_CASE,
)

/** A named pattern. The label is stable and safe to show a user or a model. */
class SecretPattern(
    /** Stable class name, e.g. `provider_api_key`. Never the matched text. */
    @JvmField val label: String,
    /** What the class means, for an error message a person has to act on. */
    @JvmField val description: String,
    @JvmField val pattern: Regex,
    /**
     * Applied to one capture group of a match, never to the whole string. When
     * it matches, that match is documentation rather than a credential and is
     * skipped; other matches in the same string are still judged on their own.
     */
    @JvmField val exempt: Regex? = null,
    /** Which capture group [exempt] judges. */
    @JvmField val exemptGroup: Int = 1,
)

/** The patterns applied to every string in a handover. */
@JvmField
val SECRET_PATTERNS: List<SecretPattern> = listOf(
    SecretPattern(
        "private_key_pem",
        "a PEM-encoded private key",
        // ANCHOR MULTIPLICITY: `BEGIN ` is made of characters the label
        // repetition accepts. Given up: armour with a label over 32
        // characters, which no PEM variant in use has.
        Regex("BEGIN [A-Z ]{0,$PEM_LABEL_MAX}PRIVATE KEY", RegexOption.IGNORE_CASE),
    ),
    SecretPattern(
        "authorization_header",
        "an authorization header carrying a credential",
        // SPLIT ENUMERATION: the two runs of optional whitespace straddling
        // the optional scheme keyword can both consume the same space. Given
        // up: more than 32 spaces or tabs at one of those points; the
        // `Bearer` form is still caught by `bearer_token`.
        Regex(
            "Authorization" + OWS + ":" + OWS +
                "(?:Bearer|Basic|Token|Digest|ApiKey|Api-Key)?" + OWS +
                "(" + VALUE_CLASS + "{16,})",
            RegexOption.IGNORE_CASE,
        ),
        exempt = PLACEHOLDER_VALUE,
    ),
    SecretPattern(
        "bearer_token",
        "a bearer token",
        Regex("Bearer[ \\t]+(" + VALUE_CLASS + "{20,})", RegexOption.IGNORE_CASE),
        exempt = PLACEHOLDER_VALUE,
    ),
    SecretPattern(
        "jwt",
        "a JSON web token",
        // ANCHOR MULTIPLICITY: `eyJ` is made of characters the segment
        // repetition accepts, so `eyJ` repeated puts an anchor every three
        // characters. Given up: a header segment past 256 base64url
        // characters, meaning one embedding a chain (`x5c`) or key (`jwk`).
        Regex(
            "eyJ[A-Za-z0-9_-]{1,$JWT_HEADER_MAX}" +
                "\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"
        ),
    ),
    SecretPattern(
        "provider_api_key",
        "a provider API key or access-key id in a vendor format",
        Regex(
            "(?:\\bsk-[A-Za-z0-9]" +
                "|\\bgh[pousr]_[A-Za-z0-9]{36,}" +
                "|\\bgithub_pat_[A-Za-z0-9_]{22,}" +
                "|\\b(?:AKIA|ASIA)[0-9A-Z]{16}" +
                "|\\bxox[baprs]-[A-Za-z0-9-]{10,}" +
                "|\\bAIza[0-9A-Za-z_-]{35})"
        ),
    ),
    SecretPattern(
        "client_secret",
        "a client secret bound to a value",
        // Measured linear before the change; bounded anyway so a later edit
        // cannot recreate split enumeration here.
        Regex(
            "client[_-]?secret[\"']?" + OWS + "[:=]" + OWS + "[\"']?(" +
                VALUE_CLASS + "{8,})",
            RegexOption.IGNORE_CASE,
        ),
        exempt = PLACEHOLDER_VALUE,
    ),
    SecretPattern(
        "google_application_credentials",
        "application-credentials material bound to a value",
        // Bounded on the same ceiling and for the same reason as
        // `client_secret`; both forms measured linear before the change.
        Regex(
            "(?:GOOGLE_APPLICATION_CREDENTIALS[\"']?" + OWS + "[:=]" + OWS +
                "[\"']?(" + PATH_VALUE_CLASS + "{4,})" +
                "|\"type\"" + OWS + ":" + OWS + "\"service_account\")"
        ),
        exempt = PLACEHOLDER_VALUE,
    ),
    SecretPattern(
        "private_path",
        "an absolute path inside a home directory or a Windows drive root",
        Regex("(?:/Users/|/home/|[A-Za-z]:\\\\Users\\\\)([A-Za-z0-9._-]+)"),
        exempt = RESERVED_PRINCIPAL,
    ),
    SecretPattern(
        "url_credentials",
        "credentials embedded in a URL",
        // The scheme name is bounded rather than open-ended. An unbounded
        // leading repetition has to be retried from every character of the
        // subject, and on a long run of scheme-legal characters that costs
        // O(n^2) on a backtracking engine: a one-megabyte document takes tens
        // of minutes. The ceiling is 32, well above every registered URI
        // scheme, so no reachable input changes verdict.
        Regex(
            "[a-zA-Z][a-zA-Z0-9+.-]{0,31}://[A-Za-z0-9._~%+-]+" +
                ":([A-Za-z0-9._~%+-]+)@[A-Za-z0-9.-]"
        ),
        exempt = PLACEHOLDER_VALUE,
    ),
)

/** One thing the scan found. Carries a class and a location, never a value. */
data class SecretFinding(
    /** JSON Pointer-ish path, e.g. `/sections/architecture/summary`. */
    @JvmField val path: String,
    /** The pattern class, e.g. `provider_api_key`. */
    @JvmField val label: String,
    /** What that class means. */
    @JvmField val description: String,
)

/**
 * True when the text carries at least one match of this class that is not
 * exempt. Every match is judged on its own captured value, so a placeholder in
 * one sentence never excuses a real credential in the next.
 */
private fun matchesClass(text: String, secret: SecretPattern): Boolean {
    val exempt = secret.exempt ?: return secret.pattern.containsMatchIn(text)
    for (match in secret.pattern.findAll(text)) {
        val value = match.groups[secret.exemptGroup]?.value
        if (value.isNullOrEmpty() || !exempt.matches(value)) return true
    }
    return false
}

private fun scanString(text: String, path: String, findings: MutableList<SecretFinding>) {
    for (secret in SECRET_PATTERNS) {
        if (matchesClass(text, secret)) {
            findings.add(SecretFinding(path, secret.label, secret.description))
        }
    }
}

private fun scan(value: JsonElement?, path: String, findings: MutableList<SecretFinding>) {
    when (value) {
        null, is JsonNull -> return
        is JsonPrimitive -> {
            if (value.isString) {
                scanString(value.content, path.ifEmpty { "/" }, findings)
            }
        }
        is JsonArray ->
            value.forEachIndexed { index, item -> scan(item, "$path/$index", findings) }
        is JsonObject ->
            for ((key, nested) in value) scan(nested, "$path/$key", findings)
    }
}

/**
 * Find secret-shaped material anywhere in a value. Returns every finding
 * rather than the first, so a model fixing its output sees the whole list.
 * Pure: it never mutates, logs or echoes anything it matched.
 */
fun findSecretMaterial(value: JsonElement?): List<SecretFinding> {
    val findings = mutableListOf<SecretFinding>()
    scan(value, "", findings)
    return findings
}

/** Scan one plain string, reported at the root path. */
fun findSecretMaterial(text: String): List<SecretFinding> {
    val findings = mutableListOf<SecretFinding>()
    scanString(text, "/", findings)
    return findings
}

/** True when nothing secret-shaped is present. */
fun isFreeOfSecretMaterial(value: JsonElement?): Boolean =
    findSecretMaterial(value).isEmpty()

/**
 * A safe, actionable sentence about one finding. Names the class and the
 * location, and says what to do instead. Never includes the matched value.
 */
fun describeSecretFinding(finding: SecretFinding): String =
    "looks like it contains ${finding.description} (${finding.label}). " +
        "Remove the value: say that the thing exists and where it is configured, never what it is."

/** Thrown by [assertNoSecretMaterial]. Carries findings, never values. */
class SecretMaterialException(
    @JvmField val findings: List<SecretFinding>,
) : RuntimeException(
    "this handover carries secret material and was not stored: " +
        findings.joinToString("; ") { "${it.path} ${it.label}" }
)

/** Fail closed: throw when anything secret-shaped is present. */
fun assertNoSecretMaterial(value: JsonElement?) {
    val findings = findSecretMaterial(value)
    if (findings.isNotEmpty()) {
        throw SecretMaterialException(findings)
    }
}
