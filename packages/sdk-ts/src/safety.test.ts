import { describe, expect, it } from "vitest";

import {
  SecretMaterialError,
  assertNoSecretMaterial,
  describeSecretFinding,
  findSecretMaterial,
  isFreeOfSecretMaterial,
} from "./safety.js";
import { normalizeHandover } from "./normalize.js";
import { validateHandover } from "./validate.js";

const AT = "2026-07-22T10:00:00.000Z";

function withSection(text: string): unknown {
  return normalizeHandover({
    handoverId: "019f7e89-fc00-7000-8000-000000000000",
    projectId: "secret-test",
    title: "Secrets",
    createdAt: AT,
    sections: { architecture: text },
  });
}

function labels(text: string): string[] {
  return findSecretMaterial(withSection(text)).map((finding) => finding.label);
}

describe("findSecretMaterial refuses transferable material", () => {
  it("catches a provider API key", () => {
    const findings = findSecretMaterial(
      withSection("The key is sk-abc123def456 and it is in the env."),
    );
    expect(findings.map((f) => f.label)).toContain("provider_api_key");
    expect(findings[0]?.path).toBe("/sections/architecture/summary");
  });

  it("catches the vendor token formats that actually leak", () => {
    for (const text of [
      "clone with https://ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/o/r.git",
      "the runner env holds AKIAIOSFODNN7EXAMPLE",
      "the bot posts with xoxb-2314789012-4567890123456-AbCdEfGhIjKlMnOpQrStUvWx",
      "maps is keyed with AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
      "the fine-grained token is github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789",
    ]) {
      expect(labels(text)).toContain("provider_api_key");
    }
  });

  it("catches a JWT", () => {
    expect(
      labels("Session token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def"),
    ).toContain("jwt");
  });

  it("catches a bearer token and an authorization header", () => {
    expect(
      labels("Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e"),
    ).toEqual(expect.arrayContaining(["authorization_header", "bearer_token"]));
  });

  it("catches a PEM private key", () => {
    expect(labels("-----BEGIN RSA PRIVATE KEY-----")).toContain(
      "private_key_pem",
    );
  });

  it("catches private absolute paths on macOS, Linux and Windows", () => {
    for (const path of [
      "/Users/casey/Developer/thing",
      "/home/deploy/app/config",
      "C:\\Users\\casey\\project",
    ]) {
      expect(labels(`It lives at ${path}.`)).toContain("private_path");
    }
  });

  it("catches a client secret and application credentials bound to a value", () => {
    expect(labels('"client_secret": "9f8a7b6c5d4e3f2a1b0c"')).toContain(
      "client_secret",
    );
    expect(labels("client_secret=9f8a7b6c5d4e3f2a1b0c")).toContain(
      "client_secret",
    );
    expect(
      labels("GOOGLE_APPLICATION_CREDENTIALS=/opt/keys/orchard-sa.json"),
    ).toContain("google_application_credentials");
    expect(labels('{"type": "service_account", "project_id": "x"}')).toContain(
      "google_application_credentials",
    );
  });

  it("catches credentials embedded in a URL", () => {
    expect(
      labels("postgres://orchard:9f8a7b6c5d4e3f@db.internal:5432/orchard"),
    ).toContain("url_credentials");
  });

  it("finds material anywhere, not only in sections", () => {
    const doc = normalizeHandover({
      projectId: "secret-test",
      title: "Secrets",
      createdAt: AT,
      safety: { unsafeOmissions: ["the key sk-abc123 was withheld"] },
    });
    expect(findSecretMaterial(doc)[0]?.path).toBe("/safety/unsafeOmissions/0");
  });

  it("refuses a real value even when the same string claims redaction", () => {
    // The precedence rule: a redaction claim never suppresses a detection in
    // the same string. The conjunction is refused under the detected class.
    expect(
      labels(
        "The token was redacted: ghp_16C7e42F292c6912E7710c838347Ae178B4a is gone.",
      ),
    ).toContain("provider_api_key");
  });
});

describe("findSecretMaterial accepts the safe near-neighbours", () => {
  it("accepts naming a header, an environment variable or a credential type", () => {
    for (const text of [
      "The service uses an Authorization header.",
      "GOOGLE_APPLICATION_CREDENTIALS is set outside the handover.",
      "The client_secret value was intentionally omitted.",
      "A provider API key exists and is set in the deployment platform.",
      "The endpoint expects bearer credentials; the token is not carried here.",
      "Login returns a JWT; the value is not carried here.",
      "The signing key is a PEM private key held in the platform's secret manager.",
      "The CI job reads a GitHub token from the repository secrets.",
    ]) {
      expect(isFreeOfSecretMaterial(withSection(text))).toBe(true);
    }
  });

  it("accepts exact flag and environment-variable names without values", () => {
    // spec/sections.md asks `architecture` for flag and command names quoted
    // exactly. The scan must not make that requirement impossible to obey.
    expect(
      isFreeOfSecretMaterial(
        withSection(
          "Run `soil save --project orchard`; SOIL_HOME selects the store and PORT defaults to 3000.",
        ),
      ),
    ).toBe(true);
  });

  it("accepts published placeholders", () => {
    for (const text of [
      "Send it as `Authorization: Bearer <token>`.",
      'curl -H "Authorization: Bearer $TOKEN" https://api.example.com',
      "client_secret=YOUR_CLIENT_SECRET",
      "GOOGLE_APPLICATION_CREDENTIALS=REDACTED",
      "postgres://app:password@db.internal:5432/app",
    ]) {
      expect(isFreeOfSecretMaterial(withSection(text))).toBe(true);
    }
  });

  it("accepts home paths that use a reserved principal name", () => {
    for (const text of [
      "Initialised /home/ada/.soil-server.",
      'The container mounts { "SOIL_HOME": "/home/agent/.soil" }.',
      "On Windows it is C:\\Users\\user\\.soil.",
    ]) {
      expect(isFreeOfSecretMaterial(withSection(text))).toBe(true);
    }
  });

  it("leaves an ordinary handover alone", () => {
    expect(
      isFreeOfSecretMaterial(
        withSection(
          "A provider API key exists and is set in the deployment platform. Its value is not carried here. The app listens on port 3000.",
        ),
      ),
    ).toBe(true);
  });

  it("does not flag a relative path or a public URL", () => {
    expect(
      isFreeOfSecretMaterial(
        withSection("See src/checkout/window.ts and https://example.com/docs"),
      ),
    ).toBe(true);
  });
});

describe("describeSecretFinding", () => {
  it("names the class and says what to do, without echoing the value", () => {
    const finding = findSecretMaterial(withSection("key sk-supersecret999"))[0];
    expect(finding).toBeDefined();
    const message = describeSecretFinding(finding!);
    expect(message).toContain("provider_api_key");
    expect(message).toContain("where it is configured");
    expect(message).not.toContain("supersecret");
  });
});

describe("assertNoSecretMaterial", () => {
  it("passes a clean document", () => {
    expect(() =>
      assertNoSecretMaterial(withSection("nothing secret")),
    ).not.toThrow();
  });

  it("fails closed, and the error never carries the value", () => {
    try {
      assertNoSecretMaterial(
        withSection("token eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.zzz"),
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SecretMaterialError);
      expect((error as Error).message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect((error as Error).message).toContain("jwt");
    }
  });
});

describe("the scan cannot be made to walk a repetition twice", () => {
  // Every one of these is a run built so that some repetition in the pattern
  // file could be restarted from many positions, or divided between two
  // adjacent repetitions every possible way. On a backtracking engine that
  // costs quadratic time, and the scan runs on the request path before any
  // lock, so one document stalls the process for everybody.
  //
  // The budget is deliberately loose, because the fault it guards against is
  // not subtle. Measured on this file before the bounds went in, the first
  // subject at 200000 characters extrapolates to about ninety seconds and a
  // full 1 MiB document to tens of minutes; every subject below now runs in
  // single-digit milliseconds. A budget of five seconds cannot pass by luck
  // and cannot fail on a slow machine.
  const BUDGET_MS = 5000;
  const N = 200_000;
  const subjects: Record<string, string> = {
    // SPLIT ENUMERATION, straddling the optional scheme keyword.
    "authorization header, then whitespace that never becomes a value":
      "Authorization:" + " ".repeat(N),
    "the same with tabs mixed in":
      "Authorization:" + " \t".repeat(Math.floor(N / 2)),
    // ANCHOR MULTIPLICITY: the anchor is built from characters the repetition
    // that follows it accepts, so it recurs every few characters.
    "PEM armour opener repeated": "BEGIN ".repeat(Math.floor(N / 6)),
    "JWT prefix repeated": "eyJ".repeat(Math.floor(N / 3)),
    "JWT prefix, then one long segment with no dot": "eyJ" + "a".repeat(N),
    // The near-neighbours of the two above.
    "client secret, then whitespace": "client_secret=" + " ".repeat(N),
    "application credentials, then whitespace":
      "GOOGLE_APPLICATION_CREDENTIALS=" + " ".repeat(N),
    "scheme-legal characters with no scheme separator": "a".repeat(N),
    "URL userinfo that never closes": "http://" + "a".repeat(N),
  };

  for (const [name, subject] of Object.entries(subjects)) {
    it(`stays fast on ${name}`, () => {
      const started = performance.now();
      findSecretMaterial(subject);
      expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    });
  }

  it("is the guard it claims to be: the old shapes really were quadratic", () => {
    // Non-vacuity, in-band. The pattern this reconstructs is the one the file
    // carried before the bounds: two unbounded whitespace repetitions with an
    // optional keyword between them. If this ever stops being slow, the
    // budget above has stopped meaning anything and should be re-derived.
    const unbounded = new RegExp(
      "Authorization[ \\t]*:[ \\t]*" +
        "(?:Bearer|Basic|Token|Digest|ApiKey|Api-Key)?[ \\t]*" +
        "([A-Za-z0-9._~+/=-]{16,})",
      "i",
    );
    // Each size is measured several times and the FASTEST run is kept. A busy
    // machine can only ever add time to a run, never remove it, so the minimum
    // is the sample least contaminated by whatever else the machine is doing.
    // A single sample per size is what made this check fire on a loaded runner
    // while the property it asserts was perfectly intact: the small size costs
    // little enough that one unlucky pause makes it look like the large one.
    const time = (n: number): number => {
      const subject = "Authorization:" + " ".repeat(n);
      let fastest = Infinity;
      for (let run = 0; run < 5; run += 1) {
        const started = performance.now();
        unbounded.test(subject);
        fastest = Math.min(fastest, performance.now() - started);
      }
      return fastest;
    };
    time(2000); // warm
    const small = time(4000);
    const large = time(16000);
    // Quadratic means four times the input costs about sixteen times the
    // work. Eight is a wide floor that still cannot be reached by anything
    // linear.
    expect(large).toBeGreaterThan(small * 8);
  });
});

describe("what the bounds give up, stated exactly", () => {
  const b64 = (n: number): string =>
    Array.from(
      { length: n },
      (_, i) => "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-"[i % 38],
    ).join("");

  it("still catches every PEM label in use, and stops at 32 characters", () => {
    for (const label of ["", "RSA ", "EC ", "DSA ", "OPENSSH ", "ENCRYPTED "]) {
      expect(labels(`-----BEGIN ${label}PRIVATE KEY-----`)).toContain(
        "private_key_pem",
      );
    }
    expect(labels(`-----BEGIN ${"A".repeat(32)}PRIVATE KEY-----`)).toContain(
      "private_key_pem",
    );
    expect(
      labels(`-----BEGIN ${"A".repeat(33)}PRIVATE KEY-----`),
    ).not.toContain("private_key_pem");
  });

  it("still catches a header however it is spaced in practice", () => {
    const token = "7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e";
    for (const gap of ["", " ", "  ", "\t", " \t "]) {
      for (const scheme of ["", "Bearer ", "Basic ", "Token ", "ApiKey "]) {
        expect(labels(`Authorization:${gap}${scheme}${token}`)).toContain(
          "authorization_header",
        );
      }
    }
  });

  it("hands the widely-spaced Bearer form to bearer_token instead", () => {
    // The one shape the 32-character ceiling gives up is still refused, by
    // the neighbouring class. The document is rejected either way, which is
    // what fail-closed means.
    const wide = `Authorization: Bearer${" ".repeat(33)}7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e`;
    expect(labels(wide)).not.toContain("authorization_header");
    expect(labels(wide)).toContain("bearer_token");
  });

  it("still catches a JWT with any ordinary header, at any payload size", () => {
    for (const [h, p, s] of [
      [17, 15, 7],
      [33, 200, 43],
      [95, 1500, 342],
      [140, 4000, 683],
      [256, 60000, 1024],
    ]) {
      expect(labels(`token eyJ${b64(h!)}.${b64(p!)}.${b64(s!)}`)).toContain(
        "jwt",
      );
    }
  });

  it("gives up only a JWT header past 256 characters", () => {
    // That means a token embedding a certificate chain (`x5c`) or a public
    // key (`jwk`) in its header, not one carrying `alg`, `typ` and `kid`.
    expect(labels(`token eyJ${b64(257)}.${b64(200)}.${b64(43)}`)).not.toContain(
      "jwt",
    );
  });
});

describe("validateHandover with the secret scan", () => {
  it("refuses a structurally perfect handover that carries a key", () => {
    const result = validateHandover(withSection("key: sk-abc123def"));
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.kind).toBe("safety");
    expect(result.issues[0]?.path).toBe("/sections/architecture/summary");
  });

  it("reports safety and structure problems together", () => {
    const doc = withSection("key: sk-abc123def") as { projectId: string };
    doc.projectId = "";
    const kinds = validateHandover(doc).issues.map((issue) => issue.kind);
    expect(kinds).toContain("structure");
    expect(kinds).toContain("safety");
  });
});
