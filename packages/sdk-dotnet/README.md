# @nativesoil/handover-sdk for .NET

The C# SDK for the Soil Handover format, targeting .NET 8. It mirrors the
observable behaviour of the TypeScript SDK (`packages/sdk-ts`, the
canonical implementation): the same documents validate, the same documents
are refused with the same category, the same store layout and file bytes,
and byte-identical restore prompts and rail cards for the same input.

`System.Text.Json` only. Zero external packages in the SDK itself; the test
project uses xUnit.

## Layout

```
packages/sdk-dotnet/
  SoilHandover/            the SDK (net8.0, zero dependencies)
  SoilHandover.Tests/      xUnit tests, including byte-parity tests
    golden/                reference bytes produced by the TypeScript SDK
  tools/generate-golden.mjs  regenerates golden/ from packages/sdk-ts
```

## Use it

Documents are `JsonObject` values from `System.Text.Json.Nodes`. The format
allows content this SDK has never heard of (observation kinds from newer
producers) to pass through byte for byte, and a static POCO would silently
drop exactly that, so the JSON DOM is the document type on purpose.

```csharp
using System.Text.Json.Nodes;
using Soil.Handover;

// Validate anything.
var result = Validate.ValidateHandover(JsonNode.Parse(json));
foreach (var issue in result.Issues)
{
    Console.WriteLine($"{issue.Path} {issue.Message}");
}

// Normalize a model reply (the loose rescue shape included), then store it.
var block = Normalize.ExtractJsonBlock(modelReply);
var doc = Normalize.NormalizeHandover(JsonNode.Parse(block!));
var store = new HandoverStore();       // ~/.soil, or SOIL_HOME
var entry = store.Save(doc);           // assigns the handoverId, allocates #NNN
Console.WriteLine(Render.RenderSaved(store.Read(entry.Code), entry.Code));

// Load it anywhere.
var restored = store.Read("#001");
Console.WriteLine(Restore.BuildRestorePrompt(restored));
```

The pieces, one type per concern, mirroring the TypeScript modules:

| Type            | Mirrors        | What it does                                                             |
| --------------- | -------------- | ------------------------------------------------------------------------ |
| `Sections`      | `sections.ts`  | The 17 keys, tiers, labels, statuses, provenance labels, bounds          |
| `Validate`      | `validate.ts`  | Every problem at once, with JSON paths; structure and safety kinds       |
| `Safety`        | `safety.ts`    | The fail-closed secret scan; names the class, never the value            |
| `Normalize`     | `normalize.ts` | Loose model output becomes a spec-shaped document; never invents content |
| `HandoverStore` | `store.ts`     | Plain JSON files under `~/.soil`; same layout, codes and file bytes      |
| `Restore`       | `restore.ts`   | The restore prompt, byte-identical to the TypeScript SDK's               |
| `Check`         | `check.ts`     | The ten deterministic rules, the band they map to, and the observation   |
| `Render`        | `render.ts`    | The rail cards, byte-identical to the TypeScript SDK's                   |
| `Identity`      | `identity.ts`  | UUIDv7 generation and the `handoverId` shape                             |
| `Recipe`        | `recipe.ts`    | The extraction recipe, embedded from the byte-normative `recipes/` files |
| `Rescue`        | `rescue.ts`    | The rescue prompt, embedded from the byte-normative `recipes/` files     |

## Identity

The store is a writer, so it assigns identity: a document that arrives
without a `handoverId` gets a fresh UUIDv7 (RFC 9562) at save time, and a
document that already carries one keeps it, because a copy keeps its
identity. Normalization never mints an id, reading never mints an id, and
rebuilding the index never changes one. A malformed id is a validation
error, never a silent replacement.

## The recipe texts

The canonical recipe texts live in `recipes/` at the repo root and are
byte-normative. This SDK embeds those files as resources at build time, so
`Recipe.RenderRecipe()` and `Rescue.RescuePrompt` are the exact bytes of
the canonical files, and a test compares the embedded copies against the
repo files so they cannot drift. `Recipe.RecipeVersion` states which version
those texts are at. Nothing in this SDK writes that value into a document it
did not produce: `source.recipeVersion` records which recipe produced a
document, so a tool that stamped it onto everything it touched would destroy
the field's only use. Normalization keeps a `recipeVersion` an input states,
and adds none.

## Parity with the TypeScript SDK

`SoilHandover.Tests/golden/` holds output bytes produced by the TypeScript
SDK for fixed inputs: restore prompts, rail cards, normalized documents,
and stored files. The parity tests rebuild the same outputs in .NET and
assert byte identity.

### Regenerating the golden files

After an intentional change to the TypeScript SDK:

```bash
pnpm build
node packages/sdk-dotnet/tools/generate-golden.mjs
```

## Run the tests and the conformance suite

```bash
dotnet test packages/sdk-dotnet/SoilHandover.Tests
dotnet run --project conformance/dotnet
```

The conformance runner reports the two classes separately, like the other
runners:

```
soil conformance (dotnet, spec 1.0)
Soil Document Conformant       <count> checks
Soil Secure Writer Conformant  <count> checks
```

The counts are not reproduced here, for the reason
[conformance/README.md](../../conformance/README.md) gives: nothing in the
specification defines what one check is, the corpus grows, and a number in
prose that nothing derives goes stale without anybody noticing. Run it and
read your own. The `schema` and `mcp` categories run in the TypeScript runner
only, which is why its document count is higher; every SDK is pinned to the
same fixtures, so none can drift from the schema alone.

## Deviations from the TypeScript SDK, and why

- Documents are `JsonObject`, not typed records. The format requires
  unknown observation kinds to round trip unchanged and the store files to
  be byte-identical across SDKs; the JSON DOM preserves property order and
  unknown content, a static type would not.
- `Recipe` parses its parts (shared rules, lens, framing, close, section
  guidance) out of the embedded canonical file instead of duplicating the
  strings in source. Byte identity with `recipes/` holds by construction.
- The store serializes through an internal writer that matches
  JavaScript's `JSON.stringify(value, null, 2)` bytes, because
  `System.Text.Json`'s own indented writer differs in escaping. The parity
  tests pin the store files byte for byte against the TypeScript store.
- There is no MCP server in this package, so the `mcp` conformance
  category does not apply here, same as the Python runner.
