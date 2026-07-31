using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Soil.Handover;

/// <summary>A named pattern. The label is stable and safe to show a user or a model.</summary>
/// <param name="Label">Stable class name, e.g. <c>provider_api_key</c>. Never the matched text.</param>
/// <param name="Description">What the class means, for an error message a person has to act on.</param>
/// <param name="Pattern">The pattern applied to every string in a handover.</param>
/// <param name="Exempt">
/// Applied to one capture group of a match, never to the whole string. When it
/// matches, that match is documentation rather than a credential and is
/// skipped; other matches in the same string are still judged on their own.
/// </param>
/// <param name="ExemptGroup">Which capture group <paramref name="Exempt"/> judges.</param>
public sealed record SecretPattern(
    string Label,
    string Description,
    Regex Pattern,
    Regex? Exempt = null,
    int ExemptGroup = 1);

/// <summary>One thing the scan found. Carries a class and a location, never a value.</summary>
/// <param name="Path">JSON Pointer-ish path, e.g. <c>/sections/architecture/summary</c>.</param>
/// <param name="Label">The pattern class, e.g. <c>provider_api_key</c>.</param>
/// <param name="Description">What that class means.</param>
public sealed record SecretFinding(string Path, string Label, string Description);

/// <summary>
/// The secret scan: a handover that carries credentials is not portable.
///
/// A handover is written to be moved. It goes into a second model, often at
/// a second vendor, sometimes into a teammate's session. Anything inside it
/// has left the machine it was written on. So a document carrying an API
/// key, a bearer token, a private key or a private absolute path is not a
/// handover with a small problem, it is a credential in transit, and this
/// implementation refuses to store one.
///
/// The rule is fail-closed and it is normative: see spec/README.md. The
/// detection classes, their required safe near-neighbours and their residual
/// limitations are stated in spec/safety-patterns.md. It is a spec rule
/// rather than a schema rule because JSON Schema cannot express "this string
/// looks like a token", which is exactly why the conformance suite checks it
/// separately.
///
/// What this scan is and is not:
///  - It refuses transferable authentication material, not the subject of a
///    sentence. Naming a credential type, a header or an environment
///    variable without binding a value to it is safe and stays valid,
///    because two of the format's own section requirements ask for exactly
///    that.
///  - It refuses that material wherever it appears: in an assignment, in a
///    URL, in a header, in a code block or in unstructured prose.
///  - It is not a guarantee. A secret with no recognisable shape passes,
///    and no scanner catches those. RULE 2 in the extraction recipe is the
///    real defense: carry the meaning, never the value. This is the net
///    underneath.
///  - It never echoes what it matched. A finding names the pattern class
///    and the section, never the value, because an error message is another
///    place a secret can end up.
///
/// Two mechanisms, and the difference matters. Private-key armour, JWT shape
/// and the vendor key prefixes are MENTION matches: there the mention is the
/// leak. Authorization headers, client secrets, application-credentials and
/// URL userinfo are VALUE-SHAPE matches: they fire only when a value is
/// bound to the name. Private paths are a value-shape match with a closed
/// exemption list of reserved principal names that documentation may use.
///
/// Parity with the TypeScript SDK is a parity of OUTCOMES: the same inputs
/// are refused with the same class reported. The expressions are not
/// normative.
/// </summary>
public static class Safety
{
    /// <summary>
    /// Characters that can appear inside transferable authentication
    /// material. Deliberately excludes the punctuation placeholder syntax is
    /// made of, so <c>Bearer &lt;token&gt;</c> never looks like a value.
    /// </summary>
    private const string ValueClass = @"[A-Za-z0-9._~+/=-]";

    /// <summary>The same, widened for a path or URI bound to a variable.</summary>
    private const string PathValueClass = @"[A-Za-z0-9._~+/=:\\-]";

    /// <summary>
    /// The most whitespace allowed where a header permits optional
    /// whitespace. HTTP writes one space or none and forbids any before the
    /// colon.
    /// <para>
    /// NO REPETITION HERE MAY BE RESCANNED. The default
    /// <see cref="Regex"/> engine backtracks, and a repetition it can be made
    /// to walk twice costs quadratic time: measured on 16000 characters of
    /// whitespace after <c>Authorization:</c>, this engine took 163 ms where
    /// Go's non-backtracking RE2 took 4 ms. The ceilings match the TypeScript
    /// SDK exactly and what each gives up is documented there.
    /// </para>
    /// </summary>
    private const string Ows = @"[ \t]{0,32}";

    /// <summary>
    /// The most characters allowed between <c>BEGIN </c> and
    /// <c>PRIVATE KEY</c>. The longest label in use is <c>ENCRYPTED </c>.
    /// </summary>
    private const int PemLabelMax = 32;

    /// <summary>
    /// The ceiling on a JWT's header segment, in base64url characters. Only
    /// this segment needs one: it bounds the scan looking for the FIRST dot,
    /// which is the scan a run of <c>eyJ</c> can restart every three
    /// characters. The payload and signature stay open, which keeps the class
    /// exact and is also the only form Go's RE2 can compile, since it refuses
    /// a repeat count over 1000.
    /// </summary>
    private const int JwtHeaderMax = 256;

    /// <summary>Words a published placeholder is made of.</summary>
    private const string PlaceholderWord =
        "(?:redacted|withheld|omitted|masked|removed|placeholder|changeme|none"
        + "|null|nil|na|todo|tbd|your|my|the|example|sample|dummy|test|fake|token"
        + "|tokens|secret|secrets|api|apikey|key|keys|client|id|value|password"
        + "|passwd|pass|user|username|here|goes|xxx)";

    /// <summary>
    /// A candidate value that is a published placeholder or an explicit
    /// statement that the value was left out. Applied to the captured value
    /// alone, never to the surrounding string: a redaction claim elsewhere in
    /// the same text must never suppress a genuine detection.
    /// </summary>
    private static readonly Regex PlaceholderValue = new(
        @"^(?:x{3,}|\*{3,}|\.{3,}|-{3,}|_{3,}|" + PlaceholderWord
        + "(?:[-_.]" + PlaceholderWord + ")*)[.,;:!?]?$",
        RegexOptions.IgnoreCase);

    /// <summary>
    /// The reserved principal names, published so documentation has home
    /// paths it can write down. It is structurally impossible to tell an
    /// invented username from a real one, so the format reserves a closed
    /// list instead of guessing, in the spirit of the reserved example
    /// domains.
    ///
    /// <c>example</c> is NOT on this list yet: conformance fixture
    /// invalid/secret-private-path.json currently requires
    /// <c>/Users/example/...</c> to be refused. The addition is proposed in
    /// spec/safety-patterns.md and waits on sign-off.
    /// </summary>
    public static readonly IReadOnlyList<string> ReservedPrincipalNames = new[]
    {
        "agent", "ada", "user", "username", "you", "me",
    };

    private static readonly Regex ReservedPrincipal = new(
        "^(?:" + string.Join("|", ReservedPrincipalNames) + ")$",
        RegexOptions.IgnoreCase);

    /// <summary>The patterns applied to every string in a handover.</summary>
    public static readonly IReadOnlyList<SecretPattern> SecretPatterns = new[]
    {
        new SecretPattern(
            "private_key_pem",
            "a PEM-encoded private key",
            // ANCHOR MULTIPLICITY: "BEGIN " is made of characters the label
            // repetition accepts. Given up: armour with a label over 32
            // characters, which no PEM variant in use has.
            new Regex(
                "BEGIN [A-Z ]{0," + PemLabelMax + "}PRIVATE KEY",
                RegexOptions.IgnoreCase)),
        new SecretPattern(
            "authorization_header",
            "an authorization header carrying a credential",
            // SPLIT ENUMERATION: the two runs of optional whitespace
            // straddling the optional scheme keyword can both consume the
            // same space. Given up: more than 32 spaces or tabs at one of
            // those points; the Bearer form is still caught by bearer_token.
            new Regex(
                "Authorization" + Ows + ":" + Ows
                + "(?:Bearer|Basic|Token|Digest|ApiKey|Api-Key)?"
                + Ows + "(" + ValueClass + "{16,})",
                RegexOptions.IgnoreCase),
            PlaceholderValue),
        new SecretPattern(
            "bearer_token",
            "a bearer token",
            new Regex(@"Bearer[ \t]+(" + ValueClass + "{20,})", RegexOptions.IgnoreCase),
            PlaceholderValue),
        new SecretPattern(
            "jwt",
            "a JSON web token",
            // ANCHOR MULTIPLICITY: "eyJ" is made of characters the segment
            // repetition accepts, so a run of it puts an anchor every three
            // characters. Given up: a header segment past 256 base64url
            // characters, meaning one embedding a chain (x5c) or key (jwk).
            new Regex(
                @"eyJ[A-Za-z0-9_-]{1," + JwtHeaderMax + "}"
                + @"\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")),
        new SecretPattern(
            "provider_api_key",
            "a provider API key or access-key id in a vendor format",
            new Regex(
                @"(?:\bsk-[A-Za-z0-9]"
                + @"|\bgh[pousr]_[A-Za-z0-9]{36,}"
                + @"|\bgithub_pat_[A-Za-z0-9_]{22,}"
                + @"|\b(?:AKIA|ASIA)[0-9A-Z]{16}"
                + @"|\bxox[baprs]-[A-Za-z0-9-]{10,}"
                + @"|\bAIza[0-9A-Za-z_-]{35})")),
        new SecretPattern(
            "client_secret",
            "a client secret bound to a value",
            // Measured linear before the change; bounded anyway so a later
            // edit cannot recreate split enumeration here.
            new Regex(
                "client[_-]?secret[\"']?" + Ows + "[:=]" + Ows + "[\"']?("
                + ValueClass + "{8,})",
                RegexOptions.IgnoreCase),
            PlaceholderValue),
        new SecretPattern(
            "google_application_credentials",
            "application-credentials material bound to a value",
            // Bounded on the same ceiling and for the same reason as
            // client_secret; both forms measured linear before the change.
            new Regex(
                "(?:GOOGLE_APPLICATION_CREDENTIALS[\"']?" + Ows + "[:=]" + Ows + "[\"']?("
                + PathValueClass + "{4,})"
                + "|\"type\"" + Ows + ":" + Ows + "\"service_account\")"),
            PlaceholderValue),
        new SecretPattern(
            "private_path",
            "an absolute path inside a home directory or a Windows drive root",
            new Regex(@"(?:/Users/|/home/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)"),
            ReservedPrincipal),
        new SecretPattern(
            "url_credentials",
            "credentials embedded in a URL",
            // The scheme name is bounded rather than open-ended. An unbounded
            // leading repetition has to be retried from every character of the
            // subject, and on a long run of scheme-legal characters that costs
            // O(n^2) on a backtracking engine: a one-megabyte document takes
            // tens of minutes. The ceiling is 32, well above every registered
            // URI scheme, so no reachable input changes verdict.
            new Regex(
                @"[a-zA-Z][a-zA-Z0-9+.-]{0,31}://[A-Za-z0-9._~%+-]+"
                + ":([A-Za-z0-9._~%+-]+)@[A-Za-z0-9.-]"),
            PlaceholderValue),
    };

    /// <summary>
    /// Find secret-shaped material anywhere in a JSON value. Returns every
    /// finding rather than the first, so a model fixing its output sees the
    /// whole list. Pure: it never mutates, logs or echoes anything it
    /// matched.
    /// </summary>
    public static IReadOnlyList<SecretFinding> FindSecretMaterial(JsonNode? value)
    {
        var findings = new List<SecretFinding>();
        Scan(value, "", findings);
        return findings;
    }

    /// <summary>Find secret-shaped material in a bare string.</summary>
    public static IReadOnlyList<SecretFinding> FindSecretMaterial(string text)
    {
        var findings = new List<SecretFinding>();
        ScanString(text, "/", findings);
        return findings;
    }

    /// <summary>True when nothing secret-shaped is present.</summary>
    public static bool IsFreeOfSecretMaterial(JsonNode? value)
        => FindSecretMaterial(value).Count == 0;

    /// <summary>
    /// A safe, actionable sentence about one finding. Names the class and
    /// the location, and says what to do instead. Never includes the matched
    /// value.
    /// </summary>
    public static string DescribeSecretFinding(SecretFinding finding)
        => $"looks like it contains {finding.Description} ({finding.Label}). "
           + "Remove the value: say that the thing exists and where it is configured, never what it is.";

    /// <summary>Fail closed: throw when anything secret-shaped is present.</summary>
    public static void AssertNoSecretMaterial(JsonNode? value)
    {
        var findings = FindSecretMaterial(value);
        if (findings.Count > 0)
        {
            throw new SecretMaterialException(findings);
        }
    }

    /// <summary>
    /// True when the text carries at least one match of this class that is
    /// not exempt. Every match is judged on its own captured value, so a
    /// placeholder in one sentence never excuses a real credential in the
    /// next.
    /// </summary>
    private static bool MatchesClass(string text, SecretPattern entry)
    {
        if (entry.Exempt is null)
        {
            return entry.Pattern.IsMatch(text);
        }
        foreach (Match match in entry.Pattern.Matches(text))
        {
            var group = match.Groups[entry.ExemptGroup];
            if (!group.Success || group.Value.Length == 0
                || !entry.Exempt.IsMatch(group.Value))
            {
                return true;
            }
        }
        return false;
    }

    private static void ScanString(string text, string path, List<SecretFinding> findings)
    {
        foreach (var pattern in SecretPatterns)
        {
            if (MatchesClass(text, pattern))
            {
                findings.Add(new SecretFinding(path, pattern.Label, pattern.Description));
            }
        }
    }

    private static void Scan(JsonNode? value, string path, List<SecretFinding> findings)
    {
        switch (value)
        {
            case null:
                return;
            case JsonValue scalar when scalar.TryGetValue<string>(out var text):
                ScanString(text, path.Length == 0 ? "/" : path, findings);
                return;
            case JsonArray array:
                for (var i = 0; i < array.Count; i += 1)
                {
                    Scan(array[i], $"{path}/{i}", findings);
                }
                return;
            case JsonObject record:
                foreach (var property in record)
                {
                    Scan(property.Value, $"{path}/{property.Key}", findings);
                }
                return;
            default:
                return;
        }
    }
}

/// <summary>
/// Thrown by <see cref="Safety.AssertNoSecretMaterial"/>. Carries findings,
/// never values.
/// </summary>
public sealed class SecretMaterialException : Exception
{
    public IReadOnlyList<SecretFinding> Findings { get; }

    public SecretMaterialException(IReadOnlyList<SecretFinding> findings)
        : base("this handover carries secret material and was not stored: "
               + string.Join("; ", findings.Select(f => $"{f.Path} {f.Label}")))
    {
        Findings = findings;
    }
}
