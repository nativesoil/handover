from datetime import datetime, timezone

import pytest

from soil_handover import (
    SecretMaterialError,
    assert_no_secret_material,
    describe_secret_finding,
    find_secret_material,
    is_free_of_secret_material,
    normalize_handover,
    validate_handover,
)

AT = "2026-07-22T10:00:00Z"


def with_section(text):
    return normalize_handover(
        {
            "handoverId": "019f7e89-fc00-7000-8000-000000000000",
            "projectId": "secret-test",
            "title": "Secrets",
            "createdAt": AT,
            "sections": {"architecture": text},
        })


def labels(text):
    return [f.label for f in find_secret_material(with_section(text))]


class TestRefusesTransferableMaterial:
    def test_catches_a_provider_api_key(self):
        findings = find_secret_material(
            with_section("The key is sk-abc123def456 and it is in the env.")
        )
        assert "provider_api_key" in [f.label for f in findings]
        assert findings[0].path == "/sections/architecture/summary"

    @pytest.mark.parametrize(
        "text",
        [
            "clone https://ghp_16C7e42F292c6912E7710c838347Ae178B4a"
            "@github.com/o/r.git",
            "the runner env holds AKIAIOSFODNN7EXAMPLE",
            "the bot posts with"
            " xoxb-2314789012-4567890123456-AbCdEfGhIjKlMnOpQrStUvWx",
            "maps is keyed with AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
            "the fine-grained token is"
            " github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789",
        ],
    )
    def test_catches_the_vendor_token_formats_that_leak(self, text):
        assert "provider_api_key" in labels(text)

    def test_catches_a_jwt(self):
        assert "jwt" in labels(
            "Session token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def"
        )

    def test_catches_a_bearer_token_and_an_authorization_header(self):
        found = labels("Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e")
        assert "authorization_header" in found
        assert "bearer_token" in found

    def test_catches_a_pem_private_key(self):
        assert "private_key_pem" in labels("-----BEGIN RSA PRIVATE KEY-----")

    @pytest.mark.parametrize(
        "path",
        [
            "/Users/casey/Developer/thing",
            "/home/deploy/app/config",
            "C:\\Users\\casey\\project",
        ],
    )
    def test_catches_private_absolute_paths_on_all_platforms(self, path):
        assert "private_path" in labels(f"It lives at {path}.")

    def test_catches_a_client_secret_bound_to_a_value(self):
        assert "client_secret" in labels(
            'the app reads client_secret="9f8a7b6c5d4e3f2a1b0c"'
        )
        assert "client_secret" in labels("client_secret=9f8a7b6c5d4e3f2a1b0c")

    def test_catches_application_credentials_bound_to_a_value(self):
        assert "google_application_credentials" in labels(
            "GOOGLE_APPLICATION_CREDENTIALS=/opt/keys/orchard-sa.json"
        )
        assert "google_application_credentials" in labels(
            '{"type": "service_account", "project_id": "x"}'
        )

    def test_catches_credentials_embedded_in_a_url(self):
        assert "url_credentials" in labels(
            "postgres://orchard:9f8a7b6c5d4e3f@db.internal:5432/orchard"
        )

    def test_finds_material_anywhere_not_only_in_sections(self):
        doc = normalize_handover(
            {
                "projectId": "secret-test",
                "title": "Secrets",
                "createdAt": AT,
                "safety": {
                    "unsafeOmissions": ["the key sk-abc123 was withheld"]
                },
            })
        assert find_secret_material(doc)[0].path == "/safety/unsafeOmissions/0"

    def test_a_redaction_claim_never_suppresses_a_real_value(self):
        # The precedence rule: a redaction claim never suppresses a detection
        # in the same string. The conjunction is refused under the class.
        assert "provider_api_key" in labels(
            "The token was redacted:"
            " ghp_16C7e42F292c6912E7710c838347Ae178B4a is gone."
        )


class TestAcceptsTheSafeNearNeighbours:
    @pytest.mark.parametrize(
        "text",
        [
            "The service uses an Authorization header.",
            "GOOGLE_APPLICATION_CREDENTIALS is set outside the handover.",
            "The client_secret value was intentionally omitted.",
            "A provider API key exists and is set in the deployment platform.",
            "The endpoint expects bearer credentials; the token is not"
            " carried here.",
            "Login returns a JWT; the value is not carried here.",
            "The signing key is a PEM private key held in the platform's"
            " secret manager.",
            "The CI job reads a GitHub token from the repository secrets.",
        ],
    )
    def test_naming_a_credential_type_header_or_variable(self, text):
        assert is_free_of_secret_material(with_section(text))

    def test_exact_flag_and_environment_variable_names_without_values(self):
        # spec/sections.md asks `architecture` for flag and command names
        # quoted exactly. The scan must not make that impossible to obey.
        assert is_free_of_secret_material(
            with_section(
                "Run `soil save --project orchard`; SOIL_HOME selects the"
                " store and PORT defaults to 3000."
            )
        )

    @pytest.mark.parametrize(
        "text",
        [
            "Send it as `Authorization: Bearer <token>`.",
            'curl -H "Authorization: Bearer $TOKEN" https://api.example.com',
            "client_secret=YOUR_CLIENT_SECRET",
            "GOOGLE_APPLICATION_CREDENTIALS=REDACTED",
            "postgres://app:password@db.internal:5432/app",
        ],
    )
    def test_published_placeholders(self, text):
        assert is_free_of_secret_material(with_section(text))

    @pytest.mark.parametrize(
        "text",
        [
            "Initialised /home/ada/.soil-server.",
            'The container mounts { "SOIL_HOME": "/home/agent/.soil" }.',
            "On Windows it is C:\\Users\\user\\.soil.",
        ],
    )
    def test_home_paths_using_a_reserved_principal_name(self, text):
        assert is_free_of_secret_material(with_section(text))

    def test_leaves_an_ordinary_handover_alone(self):
        assert is_free_of_secret_material(
            with_section(
                "A provider API key exists and is set in the deployment"
                " platform. Its value is not carried here. The app listens"
                " on port 3000."
            )
        )

    def test_does_not_flag_a_relative_path_or_a_public_url(self):
        assert is_free_of_secret_material(
            with_section(
                "See src/checkout/window.ts and https://example.com/docs"
            )
        )


class TestDescribeSecretFinding:
    def test_names_the_class_and_says_what_to_do_without_echoing(self):
        findings = find_secret_material(with_section("key sk-supersecret999"))
        assert findings
        message = describe_secret_finding(findings[0])
        assert "provider_api_key" in message
        assert "where it is configured" in message
        assert "supersecret" not in message


class TestAssertNoSecretMaterial:
    def test_passes_a_clean_document(self):
        assert_no_secret_material(with_section("nothing secret"))

    def test_fails_closed_and_the_error_never_carries_the_value(self):
        with pytest.raises(SecretMaterialError) as excinfo:
            assert_no_secret_material(
                with_section("token eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.zzz")
            )
        assert "eyJhbGciOiJIUzI1NiJ9" not in str(excinfo.value)
        assert "jwt" in str(excinfo.value)


class TestValidateWithTheSecretScan:
    def test_refuses_a_structurally_perfect_handover_carrying_a_key(self):
        result = validate_handover(with_section("key: sk-abc123def"))
        assert result.valid is False
        assert result.issues[0].kind == "safety"
        assert result.issues[0].path == "/sections/architecture/summary"

    def test_reports_safety_and_structure_problems_together(self):
        doc = with_section("key: sk-abc123def")
        doc["projectId"] = ""
        kinds = [issue.kind for issue in validate_handover(doc).issues]
        assert "structure" in kinds
        assert "safety" in kinds
