using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Soil.Handover;

/// <summary>
/// The pre-schema ingestion boundary.
///
/// Everything else in this SDK receives a value. This class is the one place
/// that receives BYTES, and it is the only place where the rules that cannot
/// be seen from a constructed value are enforced:
///
/// <list type="number">
///   <item>size: the byte count is bounded before anything decodes, and it is
///   unrecoverable once a value exists.</item>
///   <item>encoding: the bytes must be UTF-8, with no byte order mark, and
///   nothing is ever repaired or transcoded.</item>
///   <item>duplicates: a member name repeated inside one object refuses the
///   document, before any object is built from it.</item>
///   <item>depth: nesting is bounded before anything walks the value, so a
///   deep document is refused rather than crashing the walker.</item>
///   <item>numbers: a number is judged from its token text, because a parser
///   rounds an oversized integer in silence.</item>
/// </list>
///
/// Why a boundary rather than the same checks scattered about. A JSON parser
/// is lossy on exactly these points: by the time you hold a JsonObject, the
/// byte order mark has been stripped, the recursion that would have blown the
/// stack has already run, and the length of what arrived is gone — whitespace,
/// escapes and member order are not recoverable from a value. The safety scan
/// and the validator both walk a constructed value, so neither can see any of
/// it.
///
/// On this runtime the duplicate case is worse than lossy. Executed and
/// observed on .NET 8: <c>JsonNode.Parse("{\"a\":1,\"a\":2}")</c> succeeds,
/// and the first indexer or enumeration of the result throws
/// <c>ArgumentException: An item with the same key has already been added</c>
/// — an uncontrolled exception from deep inside a getter, where the caller
/// expected a validation result. Also observed: <c>File.ReadAllText</c>
/// detects and strips a byte order mark and transcodes a UTF-16 file, so the
/// document a reader saw was not the document on disk. Both are why the
/// boundary reads bytes and never a convenience string.
///
/// The security argument for the duplicate rule is the decisive one. With
/// last-wins, the fail-closed secret scan sees one value for /sections/x and
/// a consumer parsing the same bytes with a different parser sees another.
/// The document that gets scanned is then not the document that gets read.
///
/// The depth ceiling is derived, not observed. The deepest structure a
/// handover needs without custom observation data is 4 levels; the deepest
/// fixture in this repository is 6; the lowest hard parser ceiling among the
/// five official implementations is <c>JsonReaderOptions.MaxDepth</c>, which
/// defaults to 64 on this very runtime. 32 sits at half of that.
///
/// Mechanism note for this surface: duplicate detection uses
/// <c>Utf8JsonReader</c>, the runtime's own low-level streaming reader. It
/// hands over member names one token at a time, before any node exists, it
/// validates UTF-8 as it goes, and it carries a depth of its own that is
/// pinned to the same ceiling. No package is added; this SDK has none and
/// gains none.
///
/// The order of the checks is normative and identical on every surface: size,
/// encoding, depth, syntax, duplicate member names, numeric domain. The first
/// five are spec/ingestion.md; the sixth is spec/value-domain.md.
/// </summary>
public static class Ingest
{
    /// <summary>Max nesting of containers. The root container is level 1.</summary>
    public const int MaxDepth = 32;

    /// <summary>Max bytes in one serialized handover.</summary>
    public const int MaxBytes = 1048576;

    /// <summary>
    /// The largest integer a handover may hold, and its negative counterpart:
    /// the ends of the safe-integer range, 2^53 - 1. Beyond them a double can
    /// no longer tell two neighbouring integers apart, so a document carrying
    /// such a value means one thing to a reader with 64-bit floats and another
    /// to a reader with arbitrary-precision integers. This runtime has
    /// <c>decimal</c> and <c>BigInteger</c> and would notice nothing wrong,
    /// which is precisely why the bound is stated rather than inherited from
    /// whatever the local numeric type happens to manage. See
    /// <c>spec/value-domain.md</c>.
    /// </summary>
    public const long MaxInteger = 9007199254740991L;

    /// <summary>The negative end of the integer domain.</summary>
    public const long MinInteger = -9007199254740991L;

    /// <summary>
    /// The decimal spelling of <see cref="MaxInteger"/>. The range check
    /// compares digit strings rather than converting, because on the surfaces
    /// where this rule matters most the conversion is what loses the answer.
    /// Equal-length decimal strings compare correctly under ordinal order, so
    /// digit count plus one comparison decides the question exactly, with the
    /// same arithmetic on all five surfaces.
    /// </summary>
    private const string MaxIntegerDigits = "9007199254740991";

    /// <summary>A JSON number token in the integer form: no fraction, no exponent.</summary>
    private static readonly System.Text.RegularExpressions.Regex IntegerToken =
        new("^-?(?:0|[1-9][0-9]*)$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>
    /// Judge one JSON number token against the integer domain, from its TEXT.
    /// Null means the token is inside the domain.
    ///
    /// The two refusals are separate codes because they are separate mistakes:
    /// a fraction or an exponent is a producer writing a value the format does
    /// not carry, while a twenty-digit integer is a producer writing a value no
    /// reader can carry back. 1e2 is 100 and is refused all the same, because
    /// deciding integrality of an arbitrary decimal needs exact decimal
    /// arithmetic the five runtimes do not share.
    /// </summary>
    private static string? JudgeNumberToken(string token)
    {
        if (!IntegerToken.IsMatch(token))
        {
            return ErrorCode.NumberNotAnInteger;
        }
        var digits = token.StartsWith('-') ? token[1..] : token;
        if (digits.Length > MaxIntegerDigits.Length)
        {
            return ErrorCode.NumberOutOfRange;
        }
        if (digits.Length == MaxIntegerDigits.Length
            && string.CompareOrdinal(digits, MaxIntegerDigits) > 0)
        {
            return ErrorCode.NumberOutOfRange;
        }
        return null;
    }

    /// <summary>The message for one numeric refusal. Names a class, never a value.</summary>
    private static string NumberMessage(string code)
        => code == ErrorCode.NumberNotAnInteger
            ? "a number in a handover must be written as an integer, with no fraction part "
              + "and no exponent"
            : $"a number in a handover must lie between {MinInteger} and {MaxInteger}";

    /// <summary>The stable error codes. Identical strings on every surface.</summary>
    public static class ErrorCode
    {
        public const string DocumentTooLarge = "document.too_large";
        public const string EncodingByteOrderMark = "encoding.byte_order_mark";
        public const string EncodingUnsupported = "encoding.unsupported_encoding";
        public const string EncodingInvalidUtf8 = "encoding.invalid_utf8";
        public const string StructureDepthExceeded = "structure.depth_exceeded";
        public const string SyntaxInvalidJson = "syntax.invalid_json";
        public const string StructureDuplicateMember = "structure.duplicate_member";
        public const string NumberNotAnInteger = "number.not_an_integer";
        public const string NumberOutOfRange = "number.out_of_range";

        /// <summary>Every code this boundary can report.</summary>
        public static readonly IReadOnlyList<string> All = new[]
        {
            DocumentTooLarge,
            EncodingByteOrderMark,
            EncodingUnsupported,
            EncodingInvalidUtf8,
            StructureDepthExceeded,
            SyntaxInvalidJson,
            StructureDuplicateMember,
            NumberNotAnInteger,
            NumberOutOfRange,
        };
    }

    private static readonly (string Encoding, byte[] Bytes)[] ByteOrderMarks =
    {
        // The four-byte marks come first: a UTF-32LE mark begins with the two
        // bytes of a UTF-16LE mark, so testing the short one first would
        // misname it.
        ("UTF-32LE", new byte[] { 0xFF, 0xFE, 0x00, 0x00 }),
        ("UTF-32BE", new byte[] { 0x00, 0x00, 0xFE, 0xFF }),
        ("UTF-8", new byte[] { 0xEF, 0xBB, 0xBF }),
        ("UTF-16LE", new byte[] { 0xFF, 0xFE }),
        ("UTF-16BE", new byte[] { 0xFE, 0xFF }),
    };

    private static bool StartsWith(ReadOnlySpan<byte> data, ReadOnlySpan<byte> prefix)
        => data.Length >= prefix.Length && data[..prefix.Length].SequenceEqual(prefix);

    /// <summary>
    /// The encoding the first four bytes imply, following the detection rule
    /// in RFC 4627 section 3: the first token of a JSON text is always ASCII,
    /// so the position of the NUL padding names the encoding without decoding
    /// anything. Null means the bytes are consistent with UTF-8.
    /// </summary>
    private static string? SniffUnitWidth(ReadOnlySpan<byte> data)
    {
        if (data.Length < 4)
        {
            return null;
        }
        byte a = data[0], b = data[1], c = data[2], d = data[3];
        if (a == 0 && b == 0 && c == 0 && d != 0) return "UTF-32BE";
        if (a != 0 && b == 0 && c == 0 && d == 0) return "UTF-32LE";
        if (a == 0 && b != 0 && c == 0 && d != 0) return "UTF-16BE";
        if (a != 0 && b == 0 && c != 0 && d == 0) return "UTF-16LE";
        return null;
    }

    /// <summary>RFC 6901: <c>~</c> becomes <c>~0</c> and <c>/</c> becomes <c>~1</c>.</summary>
    private static string EscapePointerSegment(string segment)
        => segment.Replace("~", "~0", StringComparison.Ordinal)
            .Replace("/", "~1", StringComparison.Ordinal);

    /// <summary>
    /// Bound the nesting without recursing and without building a value.
    /// String-aware, because a brace inside a string is content. It reports
    /// nothing but depth: the text may still be malformed here, and the reader
    /// is the authority on syntax.
    ///
    /// The numeric domain is NOT checked here. This walk runs before the
    /// reader, on bytes that may be malformed, so a run of characters is not
    /// yet a number. It is judged in the reader pass instead, from
    /// <c>Utf8JsonReader.ValueSpan</c>.
    /// </summary>
    private static IngestIssue? ScanDepth(ReadOnlySpan<byte> text)
    {
        var depth = 0;
        for (var i = 0; i < text.Length; i++)
        {
            var ch = text[i];
            if (ch == (byte)'"')
            {
                i++;
                while (i < text.Length)
                {
                    if (text[i] == (byte)'\\') { i += 2; continue; }
                    if (text[i] == (byte)'"') { break; }
                    i++;
                }
                continue;
            }
            if (ch is (byte)'{' or (byte)'[')
            {
                depth++;
                if (depth > MaxDepth)
                {
                    return new IngestIssue(
                        ErrorCode.StructureDepthExceeded,
                        "",
                        $"a serialized handover must nest at most {MaxDepth} levels, found {depth}");
                }
            }
            else if (ch is (byte)'}' or (byte)']')
            {
                depth--;
            }
        }
        return null;
    }

    /// <summary>
    /// Ingest one serialized handover from bytes. This is the boundary: the
    /// value it returns has been checked for encoding, size, depth and
    /// duplicate member names, in that order, and nothing was repaired.
    /// </summary>
    public static IngestResult IngestDocument(ReadOnlyMemory<byte> data)
    {
        if (data.Length > MaxBytes)
        {
            return Refuse(
                ErrorCode.DocumentTooLarge,
                $"a serialized handover must be at most {MaxBytes} bytes, got {data.Length}");
        }

        foreach (var (encoding, mark) in ByteOrderMarks)
        {
            if (StartsWith(data.Span, mark))
            {
                return Refuse(
                    ErrorCode.EncodingByteOrderMark,
                    "a serialized handover must not begin with a byte order mark; these bytes "
                    + $"open with a {encoding} mark. A producer must not write one, and a reader "
                    + "must not strip one.");
            }
        }

        var sniffed = SniffUnitWidth(data.Span);
        if (sniffed is not null)
        {
            return Refuse(
                ErrorCode.EncodingUnsupported,
                $"a serialized handover must be UTF-8; these bytes are {sniffed}. Other encodings "
                + "are invalid and are never converted.");
        }

        // Strict UTF-8, throwing rather than substituting U+FFFD: a repaired
        // document is not the document that arrived. The default
        // `Encoding.UTF8` replaces silently, which is why this is its own
        // instance.
        try
        {
            _ = StrictUtf8.GetCharCount(data.Span);
        }
        catch (DecoderFallbackException)
        {
            return Refuse(
                ErrorCode.EncodingInvalidUtf8,
                "a serialized handover must be valid UTF-8; these bytes are not, and malformed "
                + "UTF-8 is refused rather than repaired");
        }

        return IngestUtf8(data);
    }

    /// <summary>
    /// Ingest a serialized handover that has already been decoded to text,
    /// e.g. a JSON block lifted out of a model's reply. The encoding rules
    /// that survive decoding still apply: a leading U+FEFF is a byte order
    /// mark whether it arrived as three bytes or as one character.
    /// </summary>
    public static IngestResult IngestText(string text)
    {
        if (text.StartsWith('\uFEFF'))
        {
            return Refuse(
                ErrorCode.EncodingByteOrderMark,
                "a serialized handover must not begin with a byte order mark; this text opens "
                + "with a UTF-8 mark. A producer must not write one, and a reader must not "
                + "strip one.");
        }
        var bytes = Encoding.UTF8.GetBytes(text);
        if (bytes.Length > MaxBytes)
        {
            return Refuse(
                ErrorCode.DocumentTooLarge,
                $"a serialized handover must be at most {MaxBytes} bytes, got {bytes.Length}");
        }
        return IngestUtf8(bytes);
    }

    /// <summary>Ingest bytes, or throw <see cref="IngestException"/>.</summary>
    public static JsonNode? IngestDocumentOrThrow(ReadOnlyMemory<byte> data)
    {
        var result = IngestDocument(data);
        if (result.Issue is not null)
        {
            throw new IngestException(result.Issue);
        }
        return result.Value;
    }

    /// <summary>Ingest decoded text, or throw <see cref="IngestException"/>.</summary>
    public static JsonNode? IngestTextOrThrow(string text)
    {
        var result = IngestText(text);
        if (result.Issue is not null)
        {
            throw new IngestException(result.Issue);
        }
        return result.Value;
    }

    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    private static IngestResult IngestUtf8(ReadOnlyMemory<byte> data)
    {
        // Depth first, and before anything recurses: JsonNode.Parse recurses,
        // the safety scan recurses, the validator recurses. A document that
        // would break them is refused here with a structured error instead.
        var deep = ScanDepth(data.Span);
        if (deep is not null)
        {
            return new IngestResult(null, deep);
        }

        // The reader pass: it decides syntax AND sees duplicate member names,
        // because it hands over names one at a time rather than a finished
        // dictionary. Its own MaxDepth is pinned to the same ceiling as a
        // second line of defence; the scan above is the one that binds.
        var duplicate = FindDuplicateMember(data.Span, out var syntaxFailed, out var badNumber);
        if (syntaxFailed)
        {
            return Refuse(
                ErrorCode.SyntaxInvalidJson,
                "the input is not a single well-formed JSON document");
        }

        JsonNode? value;
        try
        {
            value = JsonNode.Parse(data.Span);
        }
        catch (JsonException)
        {
            return Refuse(
                ErrorCode.SyntaxInvalidJson,
                "the input is not a single well-formed JSON document");
        }

        if (duplicate is not null)
        {
            return new IngestResult(null, duplicate);
        }
        // The numeric domain last: a document that breaks both rules is a
        // structural refusal on every surface rather than a race between two.
        if (badNumber is not null)
        {
            return new IngestResult(null, badNumber);
        }
        return new IngestResult(value, null);
    }

    /// <summary>
    /// One container the reader is currently inside.
    /// </summary>
    private sealed class Frame
    {
        public bool IsObject;
        public readonly HashSet<string> Names = new(StringComparer.Ordinal);
        /// <summary>The member name or array index this frame is inside.</summary>
        public string? Cursor;
        /// <summary>The next array position, unused for objects.</summary>
        public int Index;
    }

    /// <summary>
    /// Walk the token stream with <c>Utf8JsonReader</c>, recording the first
    /// duplicate member name. The duplicate is reported only after the whole
    /// document has read cleanly, so a malformed document is a syntax refusal
    /// on every surface rather than a race between two rules.
    /// </summary>
    private static IngestIssue? FindDuplicateMember(
        ReadOnlySpan<byte> data,
        out bool syntaxFailed,
        out IngestIssue? badNumber)
    {
        syntaxFailed = false;
        badNumber = null;
        var options = new JsonReaderOptions
        {
            MaxDepth = MaxDepth,
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
        };
        var reader = new Utf8JsonReader(data, isFinalBlock: true, state: new JsonReaderState(options));

        var frames = new List<Frame>();
        IngestIssue? found = null;

        try
        {
            while (reader.Read())
            {
                switch (reader.TokenType)
                {
                    case JsonTokenType.StartObject:
                    case JsonTokenType.StartArray:
                    {
                        var isObject = reader.TokenType == JsonTokenType.StartObject;
                        frames.Add(new Frame
                        {
                            IsObject = isObject,
                            Cursor = isObject ? null : "0",
                        });
                        break;
                    }

                    case JsonTokenType.EndObject:
                    case JsonTokenType.EndArray:
                        RemoveLast(frames);
                        AdvanceArray(frames);
                        break;

                    case JsonTokenType.PropertyName:
                    {
                        var name = reader.GetString() ?? "";
                        var top = frames[^1];
                        if (!top.Names.Add(name) && found is null)
                        {
                            var segments = frames
                                .Take(frames.Count - 1)
                                .Select(frame => frame.Cursor)
                                .Where(cursor => cursor is not null)
                                .Select(cursor => EscapePointerSegment(cursor!))
                                .Append(EscapePointerSegment(name));
                            found = new IngestIssue(
                                ErrorCode.StructureDuplicateMember,
                                "/" + string.Join("/", segments),
                                "a serialized handover must not repeat a member name inside one "
                                + "object: with a repeated name, two readers of the same bytes "
                                + "can hold different documents");
                        }
                        top.Cursor = name;
                        break;
                    }

                    default:
                        // A scalar value. Inside an array it advances the
                        // position; inside an object the member name already
                        // named it.
                        //
                        // The numeric domain is judged HERE, from the literal
                        // token text in `reader.ValueSpan`, before any
                        // conversion. `GetInt64` would throw on a forty-digit
                        // token and `GetDouble` would round it, and both of
                        // those are the evidence going missing rather than the
                        // question being answered.
                        if (reader.TokenType == JsonTokenType.Number && badNumber is null)
                        {
                            var token = Encoding.ASCII.GetString(reader.ValueSpan);
                            var code = JudgeNumberToken(token);
                            if (code is not null)
                            {
                                var where = frames
                                    .Select(frame => frame.Cursor)
                                    .Where(cursor => cursor is not null)
                                    .Select(cursor => EscapePointerSegment(cursor!));
                                var joined = string.Join("/", where);
                                badNumber = new IngestIssue(
                                    code,
                                    joined.Length == 0 ? "" : "/" + joined,
                                    NumberMessage(code));
                            }
                        }
                        AdvanceArray(frames);
                        break;
                }
            }
        }
        catch (JsonException)
        {
            syntaxFailed = true;
            badNumber = null;
            return null;
        }

        return found;
    }

    private static void AdvanceArray(List<Frame> frames)
    {
        if (frames.Count == 0 || frames[^1].IsObject)
        {
            return;
        }
        var top = frames[^1];
        top.Index += 1;
        top.Cursor = top.Index.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    private static void RemoveLast<T>(List<T> list)
    {
        if (list.Count > 0)
        {
            list.RemoveAt(list.Count - 1);
        }
    }

    private static IngestResult Refuse(string code, string message)
        => new(null, new IngestIssue(code, "", message));
}

/// <summary>One refusal. Carries a class and a location, never document content.</summary>
/// <param name="Code">The stable code, e.g. <c>structure.duplicate_member</c>.</param>
/// <param name="Path">JSON Pointer to the offending place, or <c>""</c> for the document.</param>
/// <param name="Message">A sentence a person can act on. Never echoes a value.</param>
public sealed record IngestIssue(string Code, string Path, string Message);

/// <summary>What the boundary returns: one controlled canonical parse result.</summary>
public sealed record IngestResult(JsonNode? Value, IngestIssue? Issue)
{
    /// <summary>True when the document passed the boundary.</summary>
    public bool Ok => Issue is null;
}

/// <summary>Thrown by the <c>OrThrow</c> entry points.</summary>
public sealed class IngestException : Exception
{
    public IngestException(IngestIssue issue) : base(issue.Message) => Issue = issue;

    /// <summary>The refusal, with its stable code and location.</summary>
    public IngestIssue Issue { get; }
}
