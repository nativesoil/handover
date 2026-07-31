// The conformance suite, run against the .NET SDK.
//
// This is what "Soil Compatible" means, executed. It runs the golden
// fixtures against packages/sdk-dotnet and checks the behaviours that make
// handovers portable rather than merely well-formed:
//
//   1. fixtures      the valid ones validate, the invalid ones fail where
//                    the manifest says they fail, compared as an abstract
//                    semantic location rather than as pointer text
//   1b. boundary     the pre-schema ingestion boundary: encoding, duplicate
//                    member names, nesting depth and the numeric domain,
//                    judged on the BYTES
//   1c. text-unit    every length bound in the format counted in Unicode
//                    code points, on strings where the candidate units
//                    disagree
//   2. identity      the handoverId rules: writer-assigned UUIDv7, copies
//                    keep it, new captures get a new one, codes are not
//                    identity
//   3. observations  the extension point stays forward compatible: unknown
//                    kinds survive a round trip and change nothing about
//                    the sections
//   4. safety        a handover carrying credentials or private absolute
//                    paths is refused, and the refusal never echoes the
//                    value
//   5. normalization the loose shapes a model actually emits become
//                    documents
//   6. store         save, list and read round trip through plain files
//   7. restore       a loaded handover carries its gaps and its framing, and
//                    every field a writer supplied reaches the reader
//   8. determinism   the renderer returns identical bytes for identical
//                    input
//   9. recipe        all 17 sections have guidance, and the rules are
//                    intact
//
// The schema-agreement category runs in the TypeScript runner (run.ts),
// which pins the published JSON Schema to these same fixtures; every SDK is
// pinned to the fixtures here and there, so the schema and the validators
// cannot drift apart. Byte parity with the TypeScript SDK's output surfaces
// is asserted by packages/sdk-dotnet/SoilHandover.Tests.
//
// It exits non-zero on failure, and it prints what failed rather than a
// count.

using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Soil.Handover;

var root = FindRepoRoot();
var fixturesDir = Path.Combine(root, "conformance", "fixtures");

// The two conformance classes, reported separately and never as one green
// blob. "Soil Document Conformant" is a claim about DOCUMENTS: the schema,
// the section semantics, round trips, identity. "Soil Secure Writer
// Conformant" is a claim about BEHAVIOUR: the safety fixtures that must be
// refused, with the right category, storing nothing.
const string Document = "document";
const string SecureWriter = "secure-writer";

// A syntactically valid UUID used where a check needs a document that is
// complete but is not exercising the writer's assignment path.
const string AValidId = "019f7e89-fc00-7000-8000-000000000000";

// A capture time, stated by the document. Nothing here reads a clock.
const string ACaptureTime = "2026-07-22T10:00:00Z";

// The exact shape the official writers emit: UUIDv7, RFC 9562 variant.
var uuidV7Pattern = new Regex(
    "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");

var now = new DateTimeOffset(2026, 7, 22, 10, 0, 0, TimeSpan.Zero);
var suite = new Suite();

// The fixed boundary token every restore-prompt check injects. Production
// takes 128 bits from the platform's cryptographic source instead, which is
// what makes the boundary unforgeable; a fixed token here is what makes a
// check on the rendered bytes possible at all.
var restoreToken = (string)ReadJson(Path.Combine(fixturesDir, "manifest.json"))["restoreBoundaryToken"]!;
var restoreMark = $"soil:{restoreToken}";
var structureShaped = new Regex(@"^\s*(?:===|##)");

CheckFixtures();
CheckIngestionBoundary();
CheckTextUnit();
CheckIdentity();
CheckObservations();
CheckSecretScan();
CheckNormalization();
CheckClosedWorld();
CheckStoreAndRestore();
CheckRestoreBoundary();
CheckDeterminism();
CheckRecipe();

// The two classes are reported separately, always. A single green blob
// would let a writer claim the safety behaviour it never proved.
Console.WriteLine("soil conformance (dotnet, spec 1.0)");
Console.WriteLine($"Soil Document Conformant       {suite.ByClass[Document]} checks");
Console.WriteLine($"Soil Secure Writer Conformant  {suite.ByClass[SecureWriter]} checks");
if (suite.Failures.Count > 0)
{
    Console.WriteLine();
    Console.WriteLine($"{suite.Failures.Count} of {suite.Checks} checks failed");
    Console.WriteLine();
    foreach (var (conformanceClass, category, detail) in suite.Failures)
    {
        Console.WriteLine($"  [{conformanceClass}/{category}] {detail}");
    }
    Console.WriteLine();
    return 1;
}
return 0;

string FindRepoRoot()
{
    var directory = new DirectoryInfo(AppContext.BaseDirectory);
    while (directory is not null)
    {
        if (File.Exists(Path.Combine(directory.FullName, "conformance", "fixtures", "manifest.json")))
        {
            return directory.FullName;
        }
        directory = directory.Parent!;
    }
    throw new InvalidOperationException("could not find the repo root above the runner binary");
}

JsonObject ReadJson(string path) => (JsonObject)JsonNode.Parse(File.ReadAllText(path))!;

// Normalize and assert the object shape, which is what every call in this
// runner feeds it. Normalize.NormalizeHandover itself returns a JsonNode,
// because a root that is not an object is carried through as it arrived
// rather than replaced with a document built around it.
JsonObject Normalized(JsonNode? input) => (JsonObject)Normalize.NormalizeHandover(input)!;

string FixturePath(string file) => Path.GetFullPath(Path.Combine(fixturesDir, file));

// Every provenance label the document's sections carry, without duplicates and
// in the document's own order of first appearance.
List<string> DocumentProvenance(JsonObject handover)
{
    var sections = handover["sections"] as JsonObject;
    var output = new List<string>();
    foreach (var key in Sections.SectionKeys)
    {
        if ((sections?[key] as JsonObject)?["provenance"] is not JsonArray labels)
        {
            continue;
        }
        foreach (var entry in labels)
        {
            var label = (string?)entry;
            if (label is not null && !output.Contains(label))
            {
                output.Add(label);
            }
        }
    }
    return output;
}

string Problems(ValidationResult result)
    => string.Join("; ", result.Issues.Select(issue => $"{issue.Path} {issue.Message}"));

// An abstract semantic location: an ordered sequence of object member names
// and array indices, from the root of the document to the offending value.
// The empty sequence means the document itself.
//
// This is what the harness compares, and it is deliberately not a string. The
// manifest used to bind exact JSON Pointer text, which made a formatting
// choice into a conformance requirement the specification never states: an
// implementation that reports the same place in a different notation was
// failed by the official suite for being spelled differently. A pointer is
// still a fine representation; each runner parses its own representation into
// segments before comparing, and LocationOf is this runner's adapter.
//
// Segments are compared as text, which is all the comparison needs: an index
// and a member name only ever appear where the document's own shape puts them.
static string[] LocationOf(string pointer)
{
    if (pointer.Length == 0 || pointer == "/")
    {
        return Array.Empty<string>();
    }
    return pointer.TrimStart('/').Split('/')
        .Select(token => token.Replace("~1", "/").Replace("~0", "~"))
        .ToArray();
}

// One manifest `location` array, read as segments.
static string[] ManifestLocation(JsonNode? node)
    => node is JsonArray array
        ? array.Select(item => item!.ToString()).ToArray()
        : Array.Empty<string>();

static bool SameLocation(string[] a, string[] b) => a.SequenceEqual(b);

// A semantic location, for a failure message. Never compared.
static string ShowLocation(string[] location)
    => location.Length == 0 ? "the document" : string.Join(" > ", location);

string ReportedLocations(ValidationResult result)
    => result.Issues.Count > 0
        ? string.Join(", ", result.Issues.Select(issue => ShowLocation(LocationOf(issue.Path))))
        : "nothing";

JsonObject Fresh() => Normalized(new JsonObject
{
    ["projectId"] = "identity",
    ["title"] = "Identity",
    ["createdAt"] = ACaptureTime,
    ["sections"] = new JsonObject
    {
        ["executiveSummary"] = "The identity rules, exercised.",
    },
});

// Materialise one boundary fixture: bytes on disk, or a padded document,
// because the size fixtures are a megabyte each and do not belong in a
// repository.
byte[] BoundaryBytes(JsonObject entry)
{
    if (entry["file"] is JsonValue fileValue && fileValue.TryGetValue<string>(out var file))
    {
        return File.ReadAllBytes(FixturePath(file));
    }
    var total = entry["generateBytes"]!.GetValue<int>();
    return System.Text.Encoding.UTF8.GetBytes("{\"pad\":\"" + new string('x', total - 10) + "\"}");
}

// The pre-schema ingestion boundary: encoding, duplicate member names and
// nesting depth, all judged on the bytes before a value exists.
//
// The category is its own because none of it can be seen from a constructed
// value, which is exactly why the three defects survived this long. The
// published JSON Schema and the reference validator are both handed an
// already-parsed value, so both are structurally blind here; that is a fact
// about layers, not a gap in the schema.
void CheckIngestionBoundary()
{
    var manifest = ReadJson(Path.Combine(fixturesDir, "manifest.json"));
    foreach (var entryNode in (JsonArray)manifest["boundary"]!)
    {
        var entry = (JsonObject)entryNode!;
        var name = entry["name"]!.GetValue<string>();
        var expected = entry["ingest"]!.GetValue<string>();
        var result = Ingest.IngestDocument(BoundaryBytes(entry));

        if (expected == "accepted")
        {
            suite.Check(
                "boundary",
                result.Ok,
                $"{name}: must be accepted, was refused with {result.Issue?.Code}");
            if (!result.Ok)
            {
                continue;
            }

            // An accepted document is never merely accepted. The validator
            // runs on it and must return a result, because the one outcome
            // worse than a rejection is a document that is accepted and never
            // scanned.
            var validation = Validate.ValidateHandover(result.Value);
            var after = entry["afterIngest"]?.GetValue<string>();
            if (after == "valid")
            {
                suite.Check(
                    "boundary",
                    validation.Valid,
                    $"{name}: accepted at the boundary, then rejected by the validator: "
                    + Problems(validation));
            }
            else if (after == "refused-by-safety")
            {
                suite.Check(
                    "boundary",
                    validation.Issues.Any(issue => issue.Kind == ValidationIssueKind.Safety),
                    $"{name}: accepted at the boundary, so the fail-closed secret scan must "
                    + "reach it and refuse it",
                    SecureWriter);
            }
            else
            {
                suite.Check(
                    "boundary",
                    !validation.Valid,
                    $"{name}: is not a handover, so the validator must say so rather than "
                    + "accept it");
            }
            continue;
        }

        suite.Check(
            "boundary",
            result.Issue?.Code == expected,
            $"{name}: must be refused with {expected}, got {result.Issue?.Code ?? "acceptance"}");
        if (result.Issue is not null && entry["location"] is JsonArray locationArray)
        {
            var wanted = ManifestLocation(locationArray);
            suite.Check(
                "boundary",
                SameLocation(LocationOf(result.Issue.Path), wanted),
                $"{name}: must report the issue at \"{ShowLocation(wanted)}\", "
                + $"reported \"{ShowLocation(LocationOf(result.Issue.Path))}\"");
        }
    }

    suite.Check(
        "boundary",
        Ingest.MaxDepth == 32 && Ingest.MaxBytes == 1048576,
        $"the boundary limits must be 32 levels and 1048576 bytes, found {Ingest.MaxDepth} "
        + $"and {Ingest.MaxBytes}");
    suite.Check(
        "boundary",
        Ingest.MaxInteger == 9007199254740991L && Ingest.MinInteger == -9007199254740991L,
        "the integer domain must run from -9007199254740991 to 9007199254740991, found "
        + $"{Ingest.MinInteger} to {Ingest.MaxInteger}");
}

// The text unit, exercised at every individually bounded string in the format.
//
// The fixtures pin three of these sites and this pins all five, including the
// 20000-code-point section summary, which is deliberately not a fixture: at
// four bytes per astral character it would be an eighty-kilobyte file in a
// repository whose largest real document is eighteen kilobytes, and a string
// built here costs nothing and proves the same thing.
//
// Everything here is deliberately NOT ASCII. On ASCII the three candidate
// units, code points and UTF-16 code units and UTF-8 bytes, all give the same
// answer, so an ASCII test cannot tell a conformant implementation from one
// counting the wrong thing.
void CheckTextUnit()
{
    // One code point, two UTF-16 code units, four UTF-8 bytes.
    const string astral = "\U0001F600";
    // Two code points, two UTF-16 code units, three UTF-8 bytes, one cluster.
    const string combined = "e\u0301";

    JsonObject TextUnitBase()
    {
        var doc = Normalized(new JsonObject
        {
            ["projectId"] = "text-unit",
            ["title"] = "The text unit",
            ["createdAt"] = ACaptureTime,
            ["sections"] = new JsonObject
            {
                ["executiveSummary"] = "The text unit, exercised.",
            },
        });
        doc["handoverId"] = AValidId;
        return doc;
    }

    JsonObject WithField(string name, JsonNode value)
    {
        var doc = TextUnitBase();
        doc[name] = value;
        return doc;
    }

    JsonObject WithSummary(string text)
    {
        var doc = TextUnitBase();
        ((JsonObject)doc["sections"]!)["architecture"] = new JsonObject
        {
            ["status"] = "available",
            ["summary"] = text,
        };
        return doc;
    }

    JsonObject WithGap(string entry) => WithField("quality", new JsonObject
    {
        ["missingInputs"] = new JsonArray(entry),
    });

    JsonObject WithKind(string kind) => WithField(
        "observations",
        new JsonArray(new JsonObject
        {
            ["kind"] = kind,
            ["data"] = new JsonObject(),
        }));

    var cases = new (string What, string Path, JsonObject At, JsonObject Over)[]
    {
        (
            $"title at {Sections.Limits.Title} code points",
            "/title",
            WithField("title", string.Concat(Enumerable.Repeat(astral, Sections.Limits.Title))),
            WithField("title", string.Concat(Enumerable.Repeat(astral, Sections.Limits.Title + 1)))
        ),
        (
            $"title at {Sections.Limits.Title} code points of combining sequences",
            "/title",
            WithField(
                "title",
                string.Concat(Enumerable.Repeat(combined, Sections.Limits.Title / 2))),
            WithField(
                "title",
                string.Concat(Enumerable.Repeat(combined, Sections.Limits.Title / 2)) + "x")
        ),
        (
            $"section summary at {Sections.Limits.SectionSummary} code points",
            "/sections/architecture/summary",
            WithSummary(
                string.Concat(Enumerable.Repeat(astral, Sections.Limits.SectionSummary))),
            WithSummary(
                string.Concat(Enumerable.Repeat(astral, Sections.Limits.SectionSummary + 1)))
        ),
        (
            $"a stated gap at {Sections.Limits.ListEntry} code points",
            "/quality/missingInputs/0",
            WithGap(string.Concat(Enumerable.Repeat(combined, Sections.Limits.ListEntry / 2))),
            WithGap(
                string.Concat(Enumerable.Repeat(combined, Sections.Limits.ListEntry / 2)) + "x")
        ),
        (
            $"an observation kind at {Sections.Limits.ObservationKind} code points",
            "/observations/0/kind",
            WithKind(
                string.Concat(Enumerable.Repeat(astral, Sections.Limits.ObservationKind))),
            WithKind(
                string.Concat(Enumerable.Repeat(astral, Sections.Limits.ObservationKind + 1)))
        ),
        (
            // projectId is pattern-restricted to ASCII, so all three candidate
            // units agree on it. It is here for the bound, not for the unit.
            $"projectId at {Sections.Limits.ProjectId} code points",
            "/projectId",
            WithField("projectId", new string('p', Sections.Limits.ProjectId)),
            WithField("projectId", new string('p', Sections.Limits.ProjectId + 1))
        ),
    };

    foreach (var entry in cases)
    {
        var at = Validate.ValidateHandover(entry.At);
        var problems = string.Join("; ", at.Issues.Select(i => $"{i.Path} {i.Message}"));
        suite.Check("text-unit", at.Valid, $"{entry.What} must be accepted, refused: {problems}");

        var over = Validate.ValidateHandover(entry.Over);
        suite.Check(
            "text-unit",
            !over.Valid && over.Issues.Any(i => i.Path == entry.Path),
            $"one code point over {entry.What} must be refused at {entry.Path}");
    }

    // The unit itself, on the three cases that separate the candidates.
    suite.Check(
        "text-unit",
        Sections.TextLength(astral) == 1 && astral.Length == 2,
        "a character outside the basic plane is one code point and two UTF-16 code units");
    suite.Check(
        "text-unit",
        Sections.TextLength(combined) == 2,
        "one perceived character written as a base plus a combining mark is two code points, "
        + "not one");
    suite.Check(
        "text-unit",
        Sections.TextLength("caf\u00e9") == 4
        && System.Text.Encoding.UTF8.GetByteCount("caf\u00e9") == 5,
        "a precomposed accented character is one code point and two UTF-8 bytes");
}

void CheckFixtures()
{
    var manifest = ReadJson(Path.Combine(fixturesDir, "manifest.json"));

    foreach (var entryNode in (JsonArray)manifest["valid"]!)
    {
        var entry = (JsonObject)entryNode!;
        var file = (string)entry["file"]!;
        var result = Validate.ValidateHandover(ReadJson(FixturePath(file)));
        suite.Check(
            "fixtures",
            result.Valid,
            $"{file} should be valid but the validator reported: {Problems(result)}");
    }

    foreach (var entryNode in (JsonArray)manifest["invalid"]!)
    {
        var entry = (JsonObject)entryNode!;
        var file = (string)entry["file"]!;
        var location = ManifestLocation(entry["location"]);
        var reason = (string)entry["reason"]!;
        var isSafety = entry.TryGetPropertyValue("kind", out var kindNode)
            && (string?)kindNode == "safety";
        var result = Validate.ValidateHandover(ReadJson(FixturePath(file)));
        // Refusing a safety fixture is writer behaviour, so those two
        // checks count toward the Secure Writer class; structural
        // rejections are document checks.
        var entryClass = isSafety ? SecureWriter : Document;
        suite.Check(
            "fixtures",
            !result.Valid,
            $"{file} should be rejected ({reason}) but validated",
            entryClass);
        suite.Check(
            "fixtures",
            result.Issues.Any(issue => SameLocation(LocationOf(issue.Path), location)),
            $"{file} should report a problem at {ShowLocation(location)}, "
            + $"reported: {ReportedLocations(result)}",
            entryClass);
        if (isSafety)
        {
            suite.Check(
                "safety",
                result.Issues.Any(issue => issue.Kind == ValidationIssueKind.Safety),
                $"{file} should be refused by the secret scan, not merely by shape");
        }
    }
}

// Identity: the handoverId rules, exercised one by one. The letters match
// the fixture list in the specification work: (a) a new handover gets a new
// UUIDv7, (b) a byte-for-byte copy keeps its id, (c) a new capture of the
// same project gets a new one, (d) local codes may collide across stores
// without identity collision, (e) the id survives the store's own update
// path, (f) an invalid or missing id is handled deterministically, and (g)
// is these same checks run by run.ts and run_py.py over the same fixtures.
void CheckIdentity()
{
    var homeA = Directory.CreateTempSubdirectory("soil-identity-a-").FullName;
    var homeB = Directory.CreateTempSubdirectory("soil-identity-b-").FullName;
    try
    {
        var storeA = new HandoverStore(homeA);
        var storeB = new HandoverStore(homeB);

        // (a) a new handover gets a new UUIDv7, assigned by the writer.
        var first = storeA.Save(Fresh());
        var firstDoc = storeA.Read(first.Code);
        var firstId = (string?)firstDoc["handoverId"];
        suite.Check(
            "identity",
            firstId is not null && uuidV7Pattern.IsMatch(firstId),
            "(a) a handover stored without an id must be assigned a UUIDv7 by the writer");

        // (c) a new capture, even of the same project, gets a new handoverId.
        var second = storeA.Save(Fresh());
        var secondId = (string?)storeA.Read(second.Code)["handoverId"];
        suite.Check(
            "identity",
            secondId is not null && secondId != firstId,
            "(c) a new capture of the same project must get a new handoverId");

        // (d) local codes may collide across two stores; identity does not.
        var other = storeB.Save(Fresh());
        var otherId = (string?)storeB.Read(other.Code)["handoverId"];
        suite.Check(
            "identity",
            other.Code == first.Code && otherId != firstId,
            "(d) two stores may both hold a #001, and the two documents must still have different handoverIds");

        // (b) a byte-for-byte copy keeps its handoverId, in any store.
        var copy = (JsonObject)JsonNode.Parse(firstDoc.ToJsonString())!;
        var copyEntry = storeB.Save(copy);
        suite.Check(
            "identity",
            (string?)storeB.Read(copyEntry.Code)["handoverId"] == firstId,
            "(b) a byte-for-byte copy must keep its handoverId when stored again");

        // (e) the store's own update path never changes an id. There is no
        // migration tooling yet, so the rule is pinned on reindex: the
        // files are rewritten around, and identity must come out untouched.
        storeA.Reindex();
        suite.Check(
            "identity",
            (string?)storeA.Read(first.Code)["handoverId"] == firstId,
            "(e) rebuilding the store's index must leave every handoverId unchanged");

        // (f) an invalid or missing id is handled deterministically on
        // validate: a structure issue at /handoverId, never a replacement.
        var withoutId = (JsonObject)firstDoc.DeepClone();
        withoutId.Remove("handoverId");
        var missing = Validate.ValidateHandover(withoutId);
        suite.Check(
            "identity",
            !missing.Valid && missing.Issues.Any(issue =>
                issue.Path == "/handoverId" && issue.Kind == ValidationIssueKind.Structure),
            "(f) a document claiming validity without an id must fail with a structure issue at /handoverId");

        var withBadId = (JsonObject)firstDoc.DeepClone();
        withBadId["handoverId"] = "handover-42";
        var malformed = Validate.ValidateHandover(withBadId);
        suite.Check(
            "identity",
            !malformed.Valid && malformed.Issues.Any(issue => issue.Path == "/handoverId"),
            "(f) a malformed id must fail at /handoverId rather than be replaced");
    }
    finally
    {
        Directory.Delete(homeA, recursive: true);
        Directory.Delete(homeB, recursive: true);
    }
}

// The extension point: unknown kinds survive a full round trip, and the
// sections are read the same with them as without them.
void CheckObservations()
{
    var home = Directory.CreateTempSubdirectory("soil-observations-").FullName;
    try
    {
        var store = new HandoverStore(home);
        var doc = ReadJson(FixturePath(Path.Combine("valid", "observations-unknown-kinds.json")));

        var entry = store.Save(doc);
        var read = store.Read(entry.Code);
        suite.Check(
            "observations",
            read["observations"] is JsonArray attached && attached.Count == 3,
            "an unrecognised observation must survive a save and a read, not be dropped");
        suite.Check(
            "observations",
            JsonNode.DeepEquals(read["observations"], doc["observations"]),
            "an unrecognised observation must round trip unchanged");

        var normalized = Normalized(doc);
        suite.Check(
            "observations",
            JsonNode.DeepEquals(normalized["observations"], doc["observations"]),
            "normalization must not interpret, filter or reorder observations");

        var without = (JsonObject)read.DeepClone();
        without.Remove("observations");
        suite.Check(
            "observations",
            Restore.BuildRestorePrompt(read, restoreToken)
                == Restore.BuildRestorePrompt(without, restoreToken),
            "observations must not change how the 17 sections are read");

        var unknownOnly = (JsonObject)doc.DeepClone();
        unknownOnly["observations"] = new JsonArray(new JsonObject
        {
            ["kind"] = "kind.from.the.future",
            ["data"] = new JsonObject { ["x"] = 1 },
        });
        suite.Check(
            "observations",
            Validate.ValidateHandover(unknownOnly).Valid,
            "a kind this implementation has never heard of must be accepted, not treated as an error");
    }
    finally
    {
        Directory.Delete(home, recursive: true);
    }
}

void CheckSecretScan()
{
    var clean = ReadJson(Path.Combine(root, "examples", "orchard-checkout.json"));
    suite.Check(
        "safety",
        Safety.FindSecretMaterial(clean).Count == 0,
        "the worked example must be free of secret material");

    // One unsafe positive per mandatory class, plus the vendor formats and
    // the precedence case. spec/safety-patterns.md is the normative
    // statement; this table is the minimum an implementation must refuse.
    var cases = new (string Text, string Label)[]
    {
        ("the key is sk-abc123def456", "provider_api_key"),
        ("clone https://ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/o/r.git",
            "provider_api_key"),
        ("the runner env holds AKIAIOSFODNN7EXAMPLE", "provider_api_key"),
        ("the bot posts with xoxb-2314789012-4567890123456-AbCdEfGhIjKlMnOpQrStUvWx",
            "provider_api_key"),
        ("maps is keyed with AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY", "provider_api_key"),
        ("Authorization: Bearer 7f3c1a9e4b2d8c6f0a5e3b1d9c7f2a4e", "bearer_token"),
        ("Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1lMTIzNDU2", "authorization_header"),
        ("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", "jwt"),
        ("-----BEGIN PRIVATE KEY-----", "private_key_pem"),
        ("the app reads client_secret=\"9f8a7b6c5d4e3f2a1b0c\"", "client_secret"),
        ("the runner loads {\"type\": \"service_account\", \"project_id\": \"x\"}",
            "google_application_credentials"),
        ("GOOGLE_APPLICATION_CREDENTIALS=/opt/keys/orchard-sa.json",
            "google_application_credentials"),
        ("it lives at /Users/example/code/app", "private_path"),
        ("it lives at /home/deploy/app", "private_path"),
        ("it lives at C:\\Users\\example\\app", "private_path"),
        ("postgres://orchard:9f8a7b6c5d4e3f@db.internal:5432/orchard", "url_credentials"),
        ("The token was redacted: ghp_16C7e42F292c6912E7710c838347Ae178B4a is gone.",
            "provider_api_key"),
    };

    foreach (var (text, label) in cases)
    {
        var doc = Normalized(new JsonObject
        {
            ["handoverId"] = AValidId,
            ["projectId"] = "scan",
            ["title"] = "Scan",
            ["createdAt"] = ACaptureTime,
            ["sections"] = new JsonObject { ["architecture"] = text },
        });
        var findings = Safety.FindSecretMaterial(doc);
        suite.Check(
            "safety",
            findings.Any(finding => finding.Label == label),
            $"a section carrying {label} must be detected");
        var result = Validate.ValidateHandover(doc);
        suite.Check(
            "safety",
            !result.Valid,
            $"a handover carrying {label} must be rejected, not merely flagged");
        foreach (var issue in result.Issues)
        {
            suite.Check(
                "safety",
                !issue.Message.Contains(text),
                $"a {label} finding must not echo the matched value back");
        }
    }

    // The safe near-neighbour of every class. Refusing any of these would
    // make the format contradict its own section requirements: architecture
    // asks for flag and command names quoted exactly, and safetySummary asks
    // for what was withheld and where it is configured.
    var safeCases = new[]
    {
        "A provider API key exists and is set in the deployment platform. Its value is not carried here.",
        "The service uses an Authorization header.",
        "GOOGLE_APPLICATION_CREDENTIALS is set outside the handover.",
        "The client_secret value was intentionally omitted.",
        "The endpoint expects bearer credentials; the token is not carried here.",
        "Login returns a JWT; the value is not carried here.",
        "The signing key is a PEM private key held in the platform's secret manager.",
        "Run `soil save --project orchard`; SOIL_HOME selects the store and PORT defaults to 3000.",
        "Send it as `Authorization: Bearer <token>`, or as `Authorization: Bearer $TOKEN`.",
        "The config template ships client_secret=YOUR_CLIENT_SECRET.",
        "Initialised /home/ada/.soil-server, and the container mounts /home/agent/.soil.",
        "The URL is documented as postgres://app:password@db.internal:5432/app.",
        "See src/checkout/window.ts and https://example.com/docs",
    };

    foreach (var text in safeCases)
    {
        var safeDoc = Normalized(new JsonObject
        {
            ["handoverId"] = AValidId,
            ["projectId"] = "scan",
            ["title"] = "Scan",
            ["createdAt"] = ACaptureTime,
            ["sections"] = new JsonObject { ["architecture"] = text },
        });
        var safeResult = Validate.ValidateHandover(safeDoc);
        var refused = string.Join(", ", safeResult.Issues.Select(i => $"{i.Path} {i.Kind}"));
        suite.Check(
            "safety",
            safeResult.Valid,
            "naming a credential type, header, environment variable, flag or documented placeholder must stay valid, refused: "
                + refused);
    }
}

void CheckNormalization()
{
    var inner = new JsonObject
    {
        ["projectId"] = "loose-shape",
        ["createdAt"] = ACaptureTime,
        ["title"] = "A reply in the rescue shape",
        ["extractionSections"] = new JsonObject
        {
            ["projectIdentity"] = "A project that exists only to test the loose shape.",
            ["decisions"] = new JsonObject
            {
                ["status"] = "available",
                ["summary"] = "One decision was made.",
            },
            ["blockers"] = new JsonObject
            {
                ["status"] = "missing",
                ["summary"] = null,
            },
        },
    };
    var modelReply = string.Join("\n", new[]
    {
        "Sure, here is the save:",
        "",
        "```json",
        inner.ToJsonString(),
        "```",
        "",
        "Let me know if you want anything changed.",
    });

    var block = Normalize.ExtractJsonBlock(modelReply);
    suite.Check(
        "normalization",
        block is not null,
        "a fenced JSON block inside prose should be extracted");

    var doc = Normalized(JsonNode.Parse(block ?? "{}"));

    // Normalization is not a writer, so the id is still absent here. The
    // only thing standing between this reply and validity must be the id
    // the writer assigns at store time.
    var beforeId = Validate.ValidateHandover(doc);
    suite.Check(
        "normalization",
        !beforeId.Valid
            && beforeId.Issues.Count == 1
            && beforeId.Issues[0].Path == "/handoverId",
        $"a normalized reply should be one writer-assigned id away from valid, got: {Problems(beforeId)}");

    var identified = (JsonObject)doc.DeepClone();
    identified["handoverId"] = AValidId;
    var result = Validate.ValidateHandover(identified);
    suite.Check(
        "normalization",
        result.Valid,
        $"a normalized rescue-shaped reply should be valid once identified, got: {Problems(result)}");
    suite.Check(
        "normalization",
        ((JsonObject)doc["sections"]!).Count == 17,
        "normalization should declare all 17 sections");
    suite.Check(
        "normalization",
        (string?)((JsonObject)((JsonObject)doc["sections"]!)["projectIdentity"]!)["status"] == "available",
        "a bare string section should become an available section");
    suite.Check(
        "normalization",
        (string?)((JsonObject)((JsonObject)doc["sections"]!)["workflow"]!)["status"] == "missing",
        "a section the model never wrote should be recorded as missing, not invented");
    suite.Check(
        "normalization",
        Rescue.RescuePrompt.Contains("extractionSections"),
        "the rescue prompt should ask for the shape normalization accepts");

    // An unrecognised status, wrong capitalisation included, must reach
    // validate and be refused there. Silently rewriting it to "available"
    // would turn a typo into content that counts as captured.
    foreach (var wrong in new[] { "Available", "AVAILABLE", "partial", "notApplicable", "not applicable", "NOT_APPLICABLE" })
    {
        var written = Normalized(new JsonObject
        {
            ["handoverId"] = AValidId,
            ["projectId"] = "status",
            ["createdAt"] = ACaptureTime,
            ["title"] = "Status",
            ["sections"] = new JsonObject
            {
                ["decisions"] = new JsonObject
                {
                    ["status"] = wrong,
                    ["summary"] = "One decision.",
                },
            },
        });
        suite.Check(
            "normalization",
            (string?)((JsonObject)((JsonObject)written["sections"]!)["decisions"]!)["status"] == wrong,
            $"normalization must keep the unrecognised status {wrong} rather than rewrite it");
        var statusResult = Validate.ValidateHandover(written);
        suite.Check(
            "normalization",
            !statusResult.Valid
                && statusResult.Issues.Any(issue =>
                    issue.Path == "/sections/decisions/status"
                    && issue.Kind == ValidationIssueKind.Structure),
            $"an unrecognised status {wrong} must be refused at /sections/decisions/status");
    }
}

// The closed-world contract, and the one invariant that follows from it: a
// save path and a validation of the same bytes give the same verdict.
//
// Version one is closed. The top-level field set, the section field set and
// the eleven provenance labels are fixed, and a reader refuses anything
// outside them. A normalizing implementation therefore may not delete unknown
// content to make a document acceptable, because then the same bytes are
// rejected by validation and accepted by a save. It may not invent the facts a
// reader depends on either: the capture time, the recipe attribution and the
// declared version are all claims only their real author is in a position to
// make.
void CheckClosedWorld()
{
    var canonical = ReadJson(FixturePath("valid/version-exactly-supported.json"));

    // Support is a set of exact versions, not a pattern over the 1.x line.
    suite.Check(
        "closed-world",
        Validate.ValidateHandover(canonical).Valid,
        "a document at exactly the supported version must validate");
    foreach (var unsupported in new[] { "0.9", "1.1", "1.10", "2.0", "1", "1.0.0", "" })
    {
        var candidate = (JsonObject)canonical.DeepClone();
        candidate["soilHandover"] = unsupported;
        suite.Check(
            "closed-world",
            Validate.ValidateHandover(candidate).Issues.Any(issue => issue.Path == "/soilHandover"),
            $"an unsupported format version \"{unsupported}\" must be refused at /soilHandover,"
                + " never inferred from the shape of the string");
    }

    JsonObject WithSection(string key, JsonNode? value)
    {
        var candidate = (JsonObject)canonical.DeepClone();
        ((JsonObject)candidate["sections"]!)[key] = value;
        return candidate;
    }

    JsonObject WithRoot(string key, JsonNode? value)
    {
        var candidate = (JsonObject)canonical.DeepClone();
        candidate[key] = value;
        return candidate;
    }

    var unknownContent = new (string What, JsonObject Document, string Path)[]
    {
        ("an unknown top-level field", WithRoot("grade", 0.92), "/grade"),
        (
            "an unknown field on a section",
            WithSection("decisions", new JsonObject
            {
                ["status"] = "missing",
                ["summary"] = null,
                ["confidence"] = 0.4,
            }),
            "/sections/decisions/confidence"
        ),
        (
            "an unknown section key",
            WithSection("vibes", new JsonObject
            {
                ["status"] = "available",
                ["summary"] = "Good.",
            }),
            "/sections/vibes"
        ),
        (
            "a provenance label outside the eleven",
            WithSection("decisions", new JsonObject
            {
                ["status"] = "available",
                ["summary"] = "One.",
                ["provenance"] = new JsonArray("repo_verified", "vibe_checked"),
            }),
            "/sections/decisions/provenance/1"
        ),
        (
            "an unknown member of source",
            WithRoot("source", new JsonObject
            {
                ["client"] = "a-tool",
                ["temperature"] = 0.7,
            }),
            "/source/temperature"
        ),
    };

    foreach (var (what, document, path) in unknownContent)
    {
        suite.Check(
            "closed-world",
            Validate.ValidateHandover(document).Issues.Any(issue => issue.Path == path),
            $"{what} must be refused at {path}");
        suite.Check(
            "closed-world",
            Validate.ValidateHandover(Normalized(document.DeepClone()))
                .Issues.Any(issue => issue.Path == path),
            $"{what} must survive normalization and still be refused at {path}: a save that"
                + " strips it and a validation that refuses it are two answers about the same bytes");
    }

    // Nothing is invented. Each of these was measured being stamped in.
    var bare = Normalized(new JsonObject
    {
        ["projectId"] = "invents-nothing",
        ["title"] = "Invents nothing",
    });
    suite.Check(
        "closed-world",
        !bare.ContainsKey("createdAt"),
        "normalization must not supply a createdAt the document does not carry: it is the"
            + " anchor every frontier section is read against");
    var identified = (JsonObject)bare.DeepClone();
    identified["handoverId"] = AValidId;
    suite.Check(
        "closed-world",
        Validate.ValidateHandover(identified).Issues.Any(issue => issue.Path == "/createdAt"),
        "a document with no createdAt must be refused, not completed");
    suite.Check(
        "closed-world",
        !bare.ContainsKey("source"),
        "normalization must not attribute its own recipe to a document it did not produce");

    foreach (var declared in new[] { "1.7", "2.0", "0.9" })
    {
        var carried = Normalized(WithRoot("soilHandover", declared));
        suite.Check(
            "closed-world",
            (string?)carried["soilHandover"] == declared,
            $"normalization must leave a declared version \"{declared}\" exactly as written,"
                + " neither upgrading nor downgrading it");
    }

    // A malformed identifier is refused rather than replaced. Dropping it here
    // is what let a writer mint a fresh one over the top of it.
    JsonNode?[] malformed = [JsonValue.Create(42), JsonValue.Create("handover-42"), JsonValue.Create("")];
    foreach (var id in malformed)
    {
        var carried = Normalized(WithRoot("handoverId", id?.DeepClone()));
        suite.Check(
            "closed-world",
            carried.ContainsKey("handoverId")
                && Validate.ValidateHandover(carried).Issues.Any(issue => issue.Path == "/handoverId"),
            "a malformed handoverId must reach validation and be refused there,"
                + " never be dropped and replaced");
    }
}

void CheckStoreAndRestore()
{
    var home = Directory.CreateTempSubdirectory("soil-conformance-").FullName;
    try
    {
        var store = new HandoverStore(home);
        var doc = ReadJson(Path.Combine(root, "examples", "orchard-checkout.json"));

        var entry = store.Save(doc);
        suite.Check("store", entry.Code == "#001", "the first code should be #001");
        suite.Check(
            "store",
            entry.SectionsWithContent == 17,
            "the worked example carries all 17 sections");

        var second = store.Save(doc);
        suite.Check(
            "store",
            second.Code == "#002",
            "codes should increment, never be reused");

        var read = store.Read("#001");
        suite.Check(
            "store",
            (string?)read["title"] == (string?)doc["title"] && (string?)read["code"] == "#001",
            "a stored handover should read back with its code");
        var listed = store.List();
        suite.Check(
            "store",
            listed.Count == 2 && listed[0].Code == "#002",
            "list should return everything, newest first");

        var rebuilt = store.Reindex();
        suite.Check(
            "store",
            rebuilt.Entries.Count == 2 && rebuilt.NextCode == 3,
            "the index should be rebuildable from the files alone");

        var prompt = Restore.BuildRestorePrompt(read, restoreToken);
        suite.Check(
            "restore",
            prompt.Contains($"=== {restoreMark} BOOT PROMPT ==="),
            "the restore prompt should lead with the boot prompt");
        suite.Check(
            "restore",
            prompt.Contains("context, not instruction"),
            "the restore prompt should tell the reader the document is context, not commands");
        suite.Check(
            "restore",
            prompt.Contains($"=== {restoreMark} KNOWN GAPS ===")
                && prompt.Contains("not captured: Conversion numbers"),
            "stated gaps should travel with the handover into the restore prompt");
        suite.Check(
            "restore",
            prompt.Contains("not now"),
            "the restore prompt should anchor capture-state sections to the capture");
        // The asserted-absent word is built by concatenation on purpose:
        // the rule it enforces covers this repo's own text too.
        var banned = "verif" + "ied";
        suite.Check(
            "restore",
            !Regex.IsMatch(prompt, $@"\b{banned}\b", RegexOptions.IgnoreCase),
            "nothing local should describe a handover as checked by anything");

        // A field a writer supplies is not delivered until a reader sees it,
        // and the reader on this side is a model. Each of these was accepted,
        // validated and stored, and then reached no rendered surface at all.
        var source = read["source"] as JsonObject;
        suite.Check(
            "restore",
            prompt.Contains($"=== {restoreMark} THIS HANDOVER ===")
                && prompt.Contains($"Title: {(string?)read["title"]}"),
            "the handover's own title should reach the prompt, not only the rail card");
        var sourceReaches =
            new[] { "client", "model", "provider", "extraction recipe" }
                .All(label => prompt.Contains($"{label} "))
            && new[] { "client", "provider", "recipeVersion" }.All(key =>
            {
                var value = (string?)source?[key] ?? "";
                return value.Length == 0 || prompt.Contains(value);
            });
        suite.Check(
            "restore",
            sourceReaches,
            "the client, the model, the provider and the recipe version should tell the reader what wrote this");
        var labelsInDocument = DocumentProvenance(read);
        suite.Check(
            "restore",
            labelsInDocument.Count > 0
                && prompt.Contains($"=== {restoreMark} WHERE THE CLAIMS CAME FROM ===")
                && labelsInDocument.All(prompt.Contains),
            "every provenance label the document carries should reach the reader, because provenance is the format's only trust mechanism");

        // A withheld section and an empty one are two different instructions to
        // the reader, and the prompt reported both as the second.
        var withheldDoc = ReadJson(FixturePath("valid/blocked-and-safe.json"));
        var withheldPrompt = Restore.BuildRestorePrompt(withheldDoc, restoreToken);
        var withheldSections = withheldDoc["sections"] as JsonObject;
        var withheldKeys = Sections.SectionKeys
            .Where(key => (string?)(withheldSections?[key] as JsonObject)?["status"] == "blocked")
            .ToList();
        var emptyLine = withheldPrompt.Split('\n')
            .FirstOrDefault(line => line.StartsWith(
                "Sections with nothing in them", StringComparison.Ordinal)) ?? "";
        suite.Check(
            "restore",
            withheldKeys.Count > 0
                && withheldKeys.All(key =>
                {
                    var label = Sections.SectionLabels[key];
                    return !emptyLine.Contains(label)
                        && withheldPrompt.Contains($"withheld from {label}");
                }),
            "a withheld section should be named as withheld rather than counted among the empty ones");
        suite.Check(
            "restore",
            withheldKeys.All(key =>
            {
                var note = (string?)(withheldSections?[key] as JsonObject)?["summary"] ?? "";
                return note.Length == 0 || withheldPrompt.Contains(note[..40]);
            }),
            "the note a writer left on a withheld section should travel to the reader");
    }
    finally
    {
        Directory.Delete(home, recursive: true);
    }
}

// The restore-prompt boundary in spec/restore-prompt.md, on adversarial
// documents.
//
// Every fixture in the manifest's restore list is a VALID handover whose
// content is written to be mistaken for the rendered prompt's own structure.
// The rule is that content cannot be mistaken for structure, and it is checked
// here as three outcomes rather than as a mechanism: every line a reader could
// take for structure carries this render's marker; after the first structural
// line, a line carrying the marker is either structure or is visibly escaped;
// and removing one leading backslash from each line of a section's rendered
// block returns that section's summary byte for byte.
//
// What is NOT checked, because it is not what the boundary claims: that
// instruction-shaped text is absent. It travels on purpose.
void CheckRestoreBoundary()
{
    var manifest = ReadJson(Path.Combine(fixturesDir, "manifest.json"));
    var bannerLine = new Regex($"^=== {Regex.Escape(restoreMark)} .+ ===$");
    var headingLine = new Regex($"^## {Regex.Escape(restoreMark)} .+$");

    static string UnescapeLine(string line) => line.StartsWith('\\') ? line[1..] : line;

    foreach (var entryNode in (JsonArray)manifest["restore"]!)
    {
        var entry = (JsonObject)entryNode!;
        var name = (string)entry["name"]!;
        var doc = ReadJson(FixturePath((string)entry["file"]!));

        suite.Check(
            "restore",
            Validate.ValidateHandover(doc).Valid,
            $"{name}: an adversarial fixture must be a valid handover, or it is testing the validator instead");

        var prompt = Restore.BuildRestorePrompt(doc, restoreToken);
        var lines = prompt.Split('\n');

        var unmarked = lines
            .Where(line => structureShaped.IsMatch(line) && !line.Contains(restoreMark))
            .ToList();
        suite.Check(
            "restore",
            unmarked.Count == 0,
            $"{name}: {unmarked.Count} line(s) read as structure without this render's marker, "
            + $"the first being {unmarked.FirstOrDefault() ?? string.Empty}");

        var firstStructural = Array.FindIndex(lines, line => bannerLine.IsMatch(line));
        var borrowed = lines
            .Skip(firstStructural + 1)
            .Where(line => line.Contains(restoreMark)
                && !bannerLine.IsMatch(line)
                && !headingLine.IsMatch(line)
                && !line.StartsWith('\\'))
            .ToList();
        suite.Check(
            "restore",
            borrowed.Count == 0,
            $"{name}: {borrowed.Count} content line(s) carry the marker unescaped, "
            + $"the first being {borrowed.FirstOrDefault() ?? string.Empty}");

        var sections = (JsonObject)doc["sections"]!;
        foreach (var key in Sections.SectionKeys)
        {
            if (sections[key] is not JsonObject section)
            {
                continue;
            }
            var status = section["status"]?.GetValue<string>();
            var summary = section["summary"]?.GetValue<string>();
            if (status != "available" || string.IsNullOrEmpty(summary))
            {
                continue;
            }

            var heading = key == "restoreInstructions"
                ? $"=== {restoreMark} BOOT PROMPT ==="
                : $"## {restoreMark} {Sections.SectionLabels[key]}";
            var offset = key == "restoreInstructions" ? 2 : 1;
            var headingAt = Array.IndexOf(lines, heading);
            suite.Check(
                "restore",
                headingAt >= 0,
                $"{name}: the rendering has no marked heading for {key}");
            if (headingAt < 0)
            {
                continue;
            }
            var anchor = headingAt + offset;
            var summaryLines = summary.Split('\n');
            var block = lines.Skip(anchor).Take(summaryLines.Length).Select(UnescapeLine);
            suite.Check(
                "restore",
                string.Join("\n", block) == summary,
                $"{name}: the rendered block for {key} does not decode back to the section's summary");
        }
    }
}

void CheckDeterminism()
{
    var doc = ReadJson(Path.Combine(root, "examples", "orchard-checkout.json"));
    var once = Render.RenderSaved(doc, "#001");
    var twice = Render.RenderSaved(doc, "#001");
    suite.Check(
        "determinism",
        once == twice,
        "the renderer should return identical bytes for identical input");
    suite.Check(
        "determinism",
        !Regex.IsMatch(once, @"\d+\s*%")
            && !Regex.IsMatch(once, "score", RegexOptions.IgnoreCase),
        "a local save card should report counts, never a score");
}

// The recipe is complete, its text is byte-identical to the canonical files
// in recipes/, and the recipe version travels with every document the
// official writers produce.
void CheckRecipe()
{
    var recipeFile = File.ReadAllText(Path.Combine(root, "recipes", "handover-recipe-v1.txt"));
    suite.Check(
        "recipe",
        Recipe.RenderRecipe() == recipeFile,
        "the SDK's rendered recipe must be byte-identical to recipes/handover-recipe-v1.txt, the single source of truth");
    var rescueFile = File.ReadAllText(Path.Combine(root, "recipes", "rescue-recipe-v1.txt"));
    suite.Check(
        "recipe",
        Rescue.RescuePrompt + "\n" == rescueFile,
        "the SDK's rescue prompt must be byte-identical to recipes/rescue-recipe-v1.txt, the single source of truth");
    suite.Check(
        "recipe",
        Regex.IsMatch(Recipe.RecipeVersion, @"^\d+\.\d+\.\d+$"),
        "the recipe version must be a semver string");

    // The recipe version travels, and it is never invented: an ingestion path
    // is handed a document somebody else wrote, so it may not attribute its own
    // recipe to that document. An input that already states one keeps it, a
    // stored document round-trips it untouched, and a document without one is
    // still valid.
    var unstamped = Normalized(new JsonObject
    {
        ["projectId"] = "recipe-version",
        ["title"] = "Not stamped",
        ["createdAt"] = ACaptureTime,
    });
    suite.Check(
        "recipe",
        !unstamped.ContainsKey("source"),
        "normalization must not write its own recipeVersion onto a document it did not produce");
    var kept = Normalized(new JsonObject
    {
        ["projectId"] = "recipe-version",
        ["title"] = "Kept",
        ["createdAt"] = ACaptureTime,
        ["source"] = new JsonObject { ["recipeVersion"] = "0.9.9" },
    });
    suite.Check(
        "recipe",
        (string?)((JsonObject)kept["source"]!)["recipeVersion"] == "0.9.9",
        "an input that already states a recipeVersion must keep it untouched");
    var home = Directory.CreateTempSubdirectory("soil-recipe-version-").FullName;
    try
    {
        var store = new HandoverStore(home);
        var example = ReadJson(Path.Combine(root, "examples", "orchard-checkout.json"));
        var entry = store.Save(example);
        var storedVersion = store.Read(entry.Code)["source"] is JsonObject storedSource
            ? (string?)storedSource["recipeVersion"]
            : null;
        var exampleVersion = example["source"] is JsonObject exampleSource
            ? (string?)exampleSource["recipeVersion"]
            : null;
        suite.Check(
            "recipe",
            storedVersion == exampleVersion,
            "a document's recipeVersion must round-trip through the store untouched");
    }
    finally
    {
        Directory.Delete(home, recursive: true);
    }
    var withoutOne = ReadJson(FixturePath(Path.Combine("valid", "thin-but-honest.json")));
    suite.Check(
        "recipe",
        !withoutOne.ContainsKey("source") && Validate.ValidateHandover(withoutOne).Valid,
        "a document without a recipeVersion is still valid: other writers may lack one");

    var recipe = Recipe.BuildRecipe();
    suite.Check(
        "recipe",
        Sections.SectionKeys.All(key =>
            Recipe.SectionGuidance.TryGetValue(key, out var guidance) && guidance.Length > 200),
        "every one of the 17 sections needs real guidance, not a label");
    suite.Check(
        "recipe",
        Recipe.SharedRules.Count == 6,
        "the recipe should carry the opening rule and RULES 1 to 5");
    suite.Check(
        "recipe",
        recipe.Instructions.Count == Recipe.SharedRules.Count + 5,
        "the instruction block should be the rules, the lens, the framing and the close");
    foreach (var rule in new[] { "RULE 1", "RULE 2", "RULE 3", "RULE 4", "RULE 5" })
    {
        suite.Check(
            "recipe",
            Recipe.SharedRules.Any(text => text.StartsWith(rule, StringComparison.Ordinal)),
            $"{rule} should be present verbatim");
    }
}

internal sealed class Suite
{
    public int Checks { get; private set; }

    public Dictionary<string, int> ByClass { get; } = new()
    {
        ["document"] = 0,
        ["secure-writer"] = 0,
    };

    public List<(string ConformanceClass, string Category, string Detail)> Failures { get; } = new();

    public void Check(string category, bool condition, string detail, string? conformanceClass = null)
    {
        conformanceClass ??= category == "safety" ? "secure-writer" : "document";
        Checks += 1;
        ByClass[conformanceClass] += 1;
        if (!condition)
        {
            Failures.Add((conformanceClass, category, detail));
        }
    }
}
