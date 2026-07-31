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
 * The regular expressions here are an implementation detail and are not
 * normative. Another implementation may detect the same classes by any means
 * that produces the required verdict for the published fixtures. The patterns
 * are kept free of lookahead so they port to Go's regexp engine unchanged.
 *
 * NO REPETITION HERE MAY BE RESCANNED, and that is a rule about the file
 * rather than about any one pattern. Four of the five official engines
 * backtrack: Node, Python's `re`, `java.util.regex` and .NET's default
 * `Regex`. On those, a repetition that the engine can be made to walk more
 * than once costs quadratic time in two distinct ways, and both are reachable
 * from a single document string:
 *
 *  - SPLIT ENUMERATION. Two unbounded repetitions that can both consume the
 *    same character, with only an optional element between them, make the
 *    engine try every way of dividing one run between them.
 *  - ANCHOR MULTIPLICITY. A literal anchor whose own characters belong to the
 *    repetition that follows it appears every few characters in a run built
 *    out of that anchor, and each occurrence starts a fresh scan of the rest.
 *
 * A bound converts both into a constant per starting position, which makes
 * the whole scan linear in the length of the string. The ceilings below are
 * each set well above the longest real instance of the thing being bounded,
 * so no input a credential can actually take changes verdict; what each one
 * gives up is recorded beside it. Go's RE2 does not backtrack and pays none
 * of this, but the class is one taxonomy across five languages and the
 * expressions stay in step. See `spec/safety-patterns.md`; the expressions
 * are not normative, the classes are.
 *
 * Not every repetition needs a ceiling, and the ones left open are left open
 * deliberately. A trailing repetition is walked once and never divided,
 * because nothing follows it that can fail and send the engine back: `{16,}`
 * closing a value, or the `+` closing a private path. A repetition reachable
 * only after an already-bounded one has succeeded is likewise safe, because
 * the bound in front of it caps how many starting positions can reach it: the
 * JWT payload is the case, and it is measured rather than assumed. The rule
 * is about repetitions the engine can be sent back through, not about every
 * `+` in the file, and adding a ceiling where none is needed costs detection
 * for nothing.
 */

/**
 * The most whitespace allowed where a header permits optional whitespace.
 * HTTP writes one space or none, and forbids any before the colon; a
 * documentation table might align a value a few columns out. Thirty-two is
 * far above both.
 */
const OWS = "[ \\t]{0,32}";

/**
 * The most characters allowed between `BEGIN ` and `PRIVATE KEY` in PEM
 * armour. The longest label in use is `ENCRYPTED ` at ten.
 */
const PEM_LABEL_MAX = 32;

/**
 * The ceiling on a JWT's header segment, in base64url characters. A JOSE
 * header carrying `alg`, `typ`, `kid`, `cty` and `crit` runs to about 140, so
 * 256 leaves room and still bounds the walk.
 *
 * This is the only segment that needs a ceiling, and the payload and the
 * signature deliberately keep theirs open. The scan that a run of `eyJ` can
 * restart every three characters is the one looking for the FIRST dot, so
 * bounding the header is what makes the pattern linear. Bounding the payload
 * as well buys nothing, because the header ceiling already caps how many
 * anchors can reach one shared dot at a third of it; measured on the
 * arrangement built to exploit exactly that, an open payload was faster than
 * a bounded one. Leaving them open also keeps the class exact: a token is
 * detected however long its payload and signature run.
 *
 * There is a second reason not to reach for a large ceiling here. Go's RE2
 * refuses a repeat count over 1000 at compile time, so a bound wide enough
 * for a real payload could not be written in one of the five languages at
 * all. The conformance suite caught that, which is what it is for.
 */
const JWT_HEADER_MAX = 256;

/**
 * Characters that can appear inside transferable authentication material.
 * Deliberately excludes the punctuation that placeholder syntax is made of
 * (`<`, `>`, `$`, `{`, `}`), so `Bearer <token>` and `client_secret=${VALUE}`
 * never look like values in the first place.
 */
const VALUE = "[A-Za-z0-9._~+/=-]";

/** The same, widened for a filesystem path or URI bound to a variable. */
const PATH_VALUE = "[A-Za-z0-9._~+/=:\\\\-]";

/**
 * Words a published placeholder is made of. A candidate value built only from
 * these, joined by `-`, `_` or `.`, is documentation rather than a credential.
 */
const PLACEHOLDER_WORD =
  "(?:redacted|withheld|omitted|masked|removed|placeholder|changeme|none|null|nil|na|todo|tbd|your|my|the|example|sample|dummy|test|fake|token|tokens|secret|secrets|api|apikey|key|keys|client|id|value|password|passwd|pass|user|username|here|goes|xxx)";

/**
 * A candidate value that is a published placeholder or an explicit statement
 * that the value was left out. Applied to the captured value alone, never to
 * the surrounding string: a redaction claim elsewhere in the same text must
 * never suppress a genuine detection. See the precedence rule in
 * `spec/safety-patterns.md`.
 */
const PLACEHOLDER_VALUE = new RegExp(
  `^(?:x{3,}|\\*{3,}|\\.{3,}|-{3,}|_{3,}|${PLACEHOLDER_WORD}(?:[-_.]${PLACEHOLDER_WORD})*)[.,;:!?]?$`,
  "i",
);

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
export const RESERVED_PRINCIPAL_NAMES: readonly string[] = Object.freeze([
  "agent",
  "ada",
  "user",
  "username",
  "you",
  "me",
]);

const RESERVED_PRINCIPAL = new RegExp(
  `^(?:${RESERVED_PRINCIPAL_NAMES.join("|")})$`,
  "i",
);

/** A named pattern. The label is stable and safe to show a user or a model. */
export interface SecretPattern {
  /** Stable class name, e.g. `provider_api_key`. Never the matched text. */
  readonly label: string;
  /** What the class means, for an error message a person has to act on. */
  readonly description: string;
  readonly pattern: RegExp;
  /**
   * Applied to one capture group of a match, never to the whole string. When
   * it matches, that match is documentation rather than a credential and is
   * skipped; other matches in the same string are still judged on their own.
   */
  readonly exempt?: RegExp;
  /** Which capture group {@link exempt} judges. Defaults to 1. */
  readonly exemptGroup?: number;
}

/** The patterns applied to every string in a handover. */
export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  Object.freeze({
    label: "private_key_pem",
    description: "a PEM-encoded private key",
    // ANCHOR MULTIPLICITY: `BEGIN ` is itself made of characters the label
    // repetition accepts, so a run built out of it puts an anchor every six
    // characters and each one rescanned the rest. Bounded at 32, against a
    // longest real label of `ENCRYPTED ` at ten. Given up: armour with more
    // than 32 characters of label, which no PEM variant in use has.
    pattern: new RegExp(`BEGIN [A-Z ]{0,${PEM_LABEL_MAX}}PRIVATE KEY`, "i"),
  }),
  Object.freeze({
    label: "authorization_header",
    description: "an authorization header carrying a credential",
    // SPLIT ENUMERATION: the two runs of optional whitespace straddling the
    // optional scheme keyword can both consume the same space, so a run of
    // whitespace that never resolves into a value was divided between them
    // every possible way. Each is bounded at 32. Given up: a header whose
    // name, scheme keyword and value are separated by more than 32 spaces or
    // tabs. HTTP writes one or none and forbids any before the colon, and the
    // `Bearer` form of that string is still caught by `bearer_token`.
    pattern: new RegExp(
      `Authorization${OWS}:${OWS}(?:Bearer|Basic|Token|Digest|ApiKey|Api-Key)?${OWS}(${VALUE}{16,})`,
      "i",
    ),
    exempt: PLACEHOLDER_VALUE,
  }),
  Object.freeze({
    label: "bearer_token",
    description: "a bearer token",
    pattern: new RegExp(`Bearer[ \\t]+(${VALUE}{20,})`, "i"),
    exempt: PLACEHOLDER_VALUE,
  }),
  Object.freeze({
    label: "jwt",
    description: "a JSON web token",
    // ANCHOR MULTIPLICITY: `eyJ` is itself made of characters the segment
    // repetition accepts, so `eyJ` repeated puts an anchor every three
    // characters and each one rescanned the rest looking for a dot that is
    // not there. Bounding the header is enough, for the reason given at
    // JWT_HEADER_MAX. Given up: a token whose header segment runs past 256
    // base64url characters, which means one carrying an embedded certificate
    // chain (`x5c`) or public key (`jwk`) rather than the usual
    // `alg`/`typ`/`kid`. A token with an ordinary header is unaffected however
    // long its payload or signature.
    pattern: new RegExp(
      `eyJ[A-Za-z0-9_-]{1,${JWT_HEADER_MAX}}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+`,
    ),
  }),
  Object.freeze({
    label: "provider_api_key",
    description: "a provider API key or access-key id in a vendor format",
    pattern:
      /(?:\bsk-[A-Za-z0-9]|\bgh[pousr]_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{22,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35})/,
  }),
  Object.freeze({
    label: "client_secret",
    description: "a client secret bound to a value",
    // Measured linear today: the binding operator disambiguates the two runs
    // of whitespace, so neither is rescanned. Bounded anyway, on the same
    // ceiling as the other headers, so that inserting an optional element
    // between them later cannot quietly recreate split enumeration.
    pattern: new RegExp(
      `client[_-]?secret["']?${OWS}[:=]${OWS}["']?(${VALUE}{8,})`,
      "i",
    ),
    exempt: PLACEHOLDER_VALUE,
  }),
  Object.freeze({
    label: "google_application_credentials",
    description: "application-credentials material bound to a value",
    // Bounded on the same ceiling and for the same prophylactic reason as
    // `client_secret`; both forms measured linear before the change.
    pattern: new RegExp(
      `(?:GOOGLE_APPLICATION_CREDENTIALS["']?${OWS}[:=]${OWS}["']?(${PATH_VALUE}{4,})|"type"${OWS}:${OWS}"service_account")`,
    ),
    exempt: PLACEHOLDER_VALUE,
  }),
  Object.freeze({
    label: "private_path",
    description:
      "an absolute path inside a home directory or a Windows drive root",
    pattern: /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/,
    exempt: RESERVED_PRINCIPAL,
  }),
  Object.freeze({
    label: "url_credentials",
    description: "credentials embedded in a URL",
    // The scheme name is bounded rather than open-ended. An unbounded leading
    // repetition has to be retried from every character of the subject, and on
    // a long run of scheme-legal characters that costs O(n^2) on a
    // backtracking engine: a one-megabyte document takes tens of minutes. The
    // ceiling is 32, well above every registered URI scheme, so no reachable
    // input changes verdict. See spec/safety-patterns.md; the expressions are
    // not normative, the classes are.
    pattern:
      /[a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/[A-Za-z0-9._~%+-]+:([A-Za-z0-9._~%+-]+)@[A-Za-z0-9.-]/,
    exempt: PLACEHOLDER_VALUE,
  }),
]);

/**
 * A global clone per pattern, built once. The public patterns stay non-global
 * because a `g` regex carries mutable state, and a shared stateful regex is a
 * bug waiting for a second caller.
 */
const GLOBAL_PATTERNS: readonly RegExp[] = SECRET_PATTERNS.map(
  ({ pattern }) =>
    new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    ),
);

/** One thing the scan found. Carries a class and a location, never a value. */
export interface SecretFinding {
  /** JSON Pointer-ish path, e.g. `/sections/architecture/summary`. */
  readonly path: string;
  /** The pattern class, e.g. `provider_api_key`. */
  readonly label: string;
  /** What that class means. */
  readonly description: string;
}

/**
 * True when the text carries at least one match of this class that is not
 * exempt. Every match is judged on its own captured value, so a placeholder in
 * one sentence never excuses a real credential in the next.
 */
function matchesClass(
  text: string,
  entry: SecretPattern,
  global: RegExp,
): boolean {
  global.lastIndex = 0;
  for (const match of text.matchAll(global)) {
    if (entry.exempt === undefined) return true;
    const value = match[entry.exemptGroup ?? 1];
    if (value === undefined || !entry.exempt.test(value)) return true;
  }
  return false;
}

function scanString(
  text: string,
  path: string,
  findings: SecretFinding[],
): void {
  SECRET_PATTERNS.forEach((entry, index) => {
    const global = GLOBAL_PATTERNS[index];
    if (global !== undefined && matchesClass(text, entry, global)) {
      findings.push({
        path,
        label: entry.label,
        description: entry.description,
      });
    }
  });
}

function scan(value: unknown, path: string, findings: SecretFinding[]): void {
  if (typeof value === "string") {
    scanString(value, path === "" ? "/" : path, findings);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scan(item, `${path}/${index}`, findings));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    scan(nested, `${path}/${key}`, findings);
  }
}

/**
 * Find secret-shaped material anywhere in a value. Returns every finding
 * rather than the first, so a model fixing its output sees the whole list.
 * Pure: it never mutates, logs or echoes anything it matched.
 */
export function findSecretMaterial(value: unknown): SecretFinding[] {
  const findings: SecretFinding[] = [];
  scan(value, "", findings);
  return findings;
}

/** True when nothing secret-shaped is present. */
export function isFreeOfSecretMaterial(value: unknown): boolean {
  return findSecretMaterial(value).length === 0;
}

/**
 * A safe, actionable sentence about one finding. Names the class and the
 * location, and says what to do instead. Never includes the matched value.
 */
export function describeSecretFinding(finding: SecretFinding): string {
  return `looks like it contains ${finding.description} (${finding.label}). Remove the value: say that the thing exists and where it is configured, never what it is.`;
}

/** Thrown by {@link assertNoSecretMaterial}. Carries findings, never values. */
export class SecretMaterialError extends Error {
  readonly findings: readonly SecretFinding[];
  constructor(findings: readonly SecretFinding[]) {
    const detail = findings
      .map((finding) => `${finding.path} ${finding.label}`)
      .join("; ");
    super(
      `this handover carries secret material and was not stored: ${detail}`,
    );
    this.name = "SecretMaterialError";
    this.findings = findings;
  }
}

/** Fail closed: throw when anything secret-shaped is present. */
export function assertNoSecretMaterial(value: unknown): void {
  const findings = findSecretMaterial(value);
  if (findings.length > 0) {
    throw new SecretMaterialError(findings);
  }
}
