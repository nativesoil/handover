using System.Text.Json.Nodes;
using Xunit;

namespace Soil.Handover.Tests;

public class SafetyTests
{
    private static JsonObject WithSection(string text)
        => TestData.Normalized(new JsonObject
        {
            ["handoverId"] = TestData.AValidId,
            ["projectId"] = "secret-test",
            ["title"] = "Secrets",
            ["createdAt"] = TestData.ACaptureTime,
            ["sections"] = new JsonObject { ["architecture"] = text },
        });

    [Fact]
    public void CatchesAProviderApiKey()
    {
        var findings = Safety.FindSecretMaterial(
            WithSection("The key is sk-abc123def456 and it is in the env."));
        Assert.Contains("provider_api_key", findings.Select(f => f.Label));
        Assert.Equal("/sections/architecture/summary", findings[0].Path);
    }

    [Fact]
    public void CatchesAJwt()
    {
        var findings = Safety.FindSecretMaterial(
            WithSection("Session token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def"));
        Assert.Contains("jwt", findings.Select(f => f.Label));
    }

    [Fact]
    public void CatchesABearerTokenAndAnAuthorizationHeader()
    {
        var labels = Safety.FindSecretMaterial(
                WithSection("Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e"))
            .Select(f => f.Label)
            .ToList();
        Assert.Contains("authorization_header", labels);
        Assert.Contains("bearer_token", labels);
    }

    [Theory]
    [InlineData("clone https://ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/o/r.git")]
    [InlineData("the runner env holds AKIAIOSFODNN7EXAMPLE")]
    [InlineData("the bot posts with xoxb-2314789012-4567890123456-AbCdEfGhIjKlMnOpQrStUvWx")]
    [InlineData("maps is keyed with AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY")]
    [InlineData("the token is github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789")]
    public void CatchesTheVendorTokenFormatsThatLeak(string text)
    {
        Assert.Contains(
            "provider_api_key",
            Safety.FindSecretMaterial(WithSection(text)).Select(f => f.Label));
    }

    [Fact]
    public void CatchesCredentialsEmbeddedInAUrl()
    {
        Assert.Contains(
            "url_credentials",
            Safety.FindSecretMaterial(
                    WithSection("postgres://orchard:9f8a7b6c5d4e3f@db.internal:5432/orchard"))
                .Select(f => f.Label));
    }

    // The precedence rule: a redaction claim never suppresses a detection in
    // the same string. The conjunction is refused under the detected class.
    [Fact]
    public void RefusesARealValueEvenWhenTheSameStringClaimsRedaction()
    {
        Assert.Contains(
            "provider_api_key",
            Safety.FindSecretMaterial(WithSection(
                    "The token was redacted: ghp_16C7e42F292c6912E7710c838347Ae178B4a is gone."))
                .Select(f => f.Label));
    }

    [Fact]
    public void CatchesAPemPrivateKey()
    {
        Assert.Contains(
            "private_key_pem",
            Safety.FindSecretMaterial(WithSection("-----BEGIN RSA PRIVATE KEY-----"))
                .Select(f => f.Label));
    }

    [Theory]
    [InlineData("/Users/casey/Developer/thing")]
    [InlineData("/home/deploy/app/config")]
    [InlineData("C:\\Users\\casey\\project")]
    public void CatchesPrivateAbsolutePathsOnMacosLinuxAndWindows(string path)
    {
        Assert.Contains(
            "private_path",
            Safety.FindSecretMaterial(WithSection($"It lives at {path}."))
                .Select(f => f.Label));
    }

    [Fact]
    public void CatchesClientSecretAndApplicationCredentialsBoundToAValue()
    {
        Assert.Contains(
            "client_secret",
            Safety.FindSecretMaterial(
                    WithSection("the app reads client_secret=\"9f8a7b6c5d4e3f2a1b0c\""))
                .Select(f => f.Label));
        Assert.Contains(
            "google_application_credentials",
            Safety.FindSecretMaterial(
                    WithSection("GOOGLE_APPLICATION_CREDENTIALS=/opt/keys/orchard-sa.json"))
                .Select(f => f.Label));
        Assert.Contains(
            "google_application_credentials",
            Safety.FindSecretMaterial(
                    WithSection("the runner loads {\"type\": \"service_account\"}"))
                .Select(f => f.Label));
    }

    // The safe near-neighbour of every class. Refusing any of these would make
    // the format contradict its own section requirements: architecture asks
    // for flag and command names quoted exactly, and safetySummary asks for
    // what was withheld and where it is configured.
    [Theory]
    [InlineData("The service uses an Authorization header.")]
    [InlineData("GOOGLE_APPLICATION_CREDENTIALS is set outside the handover.")]
    [InlineData("The client_secret value was intentionally omitted.")]
    [InlineData("A provider API key exists and is set in the deployment platform.")]
    [InlineData("The endpoint expects bearer credentials; the token is not carried here.")]
    [InlineData("Login returns a JWT; the value is not carried here.")]
    [InlineData("The signing key is a PEM private key held in the platform's secret manager.")]
    [InlineData("The CI job reads a GitHub token from the repository secrets.")]
    [InlineData("Run `soil save --project orchard`; SOIL_HOME selects the store, PORT is 3000.")]
    [InlineData("Send it as `Authorization: Bearer <token>`.")]
    [InlineData("The config template ships client_secret=YOUR_CLIENT_SECRET.")]
    [InlineData("GOOGLE_APPLICATION_CREDENTIALS=REDACTED")]
    [InlineData("The URL is documented as postgres://app:password@db.internal:5432/app.")]
    [InlineData("Initialised /home/ada/.soil-server.")]
    [InlineData("The container mounts /home/agent/.soil.")]
    [InlineData("On Windows it is C:\\Users\\user\\.soil.")]
    public void AcceptsTheSafeNearNeighbours(string text)
    {
        Assert.True(
            Safety.IsFreeOfSecretMaterial(WithSection(text)),
            text + " -> " + string.Join(
                ", ",
                Safety.FindSecretMaterial(WithSection(text)).Select(f => f.Label)));
    }

    [Fact]
    public void FindsMaterialAnywhereNotOnlyInSections()
    {
        var doc = TestData.Normalized(new JsonObject
        {
            ["projectId"] = "secret-test",
            ["title"] = "Secrets",
            ["createdAt"] = TestData.ACaptureTime,
            ["safety"] = new JsonObject
            {
                ["unsafeOmissions"] = new JsonArray("the key sk-abc123 was withheld"),
            },
        });
        Assert.Equal("/safety/unsafeOmissions/0", Safety.FindSecretMaterial(doc)[0].Path);
    }

    [Fact]
    public void LeavesAnOrdinaryHandoverAlone()
    {
        Assert.True(Safety.IsFreeOfSecretMaterial(WithSection(
            "A provider API key exists and is set in the deployment platform. Its value is not carried here. The app listens on port 3000.")));
    }

    [Fact]
    public void DoesNotFlagARelativePathOrAPublicUrl()
    {
        Assert.True(Safety.IsFreeOfSecretMaterial(WithSection(
            "See src/checkout/window.ts and https://example.com/docs")));
    }

    [Fact]
    public void DescribesAFindingWithoutEchoingTheValue()
    {
        var finding = Safety.FindSecretMaterial(WithSection("key sk-supersecret999"))[0];
        var message = Safety.DescribeSecretFinding(finding);
        Assert.Contains("provider_api_key", message);
        Assert.Contains("where it is configured", message);
        Assert.DoesNotContain("supersecret", message);
    }

    [Fact]
    public void AssertPassesACleanDocument()
    {
        Safety.AssertNoSecretMaterial(WithSection("nothing secret"));
    }

    [Fact]
    public void AssertFailsClosedAndTheErrorNeverCarriesTheValue()
    {
        var thrown = Assert.Throws<SecretMaterialException>(
            () => Safety.AssertNoSecretMaterial(
                WithSection("token eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.zzz")));
        Assert.DoesNotContain("eyJhbGciOiJIUzI1NiJ9", thrown.Message);
        Assert.Contains("jwt", thrown.Message);
    }

    [Fact]
    public void ValidateRefusesAStructurallyPerfectHandoverThatCarriesAKey()
    {
        var result = Validate.ValidateHandover(WithSection("key: sk-abc123def"));
        Assert.False(result.Valid);
        Assert.Equal(ValidationIssueKind.Safety, result.Issues[0].Kind);
        Assert.Equal("/sections/architecture/summary", result.Issues[0].Path);
    }

    [Fact]
    public void ValidateReportsSafetyAndStructureProblemsTogether()
    {
        var doc = WithSection("key: sk-abc123def");
        doc["projectId"] = "";
        var kinds = Validate.ValidateHandover(doc).Issues.Select(issue => issue.Kind).ToList();
        Assert.Contains(ValidationIssueKind.Structure, kinds);
        Assert.Contains(ValidationIssueKind.Safety, kinds);
    }
}
