using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Soil.Handover;

/// <summary>
/// A serializer that produces the same bytes as JavaScript's
/// <c>JSON.stringify(value, null, 2)</c>, which is what the TypeScript store
/// writes. The two SDKs share one on-disk store, so the file bytes have to
/// match exactly: two-space indent, unescaped non-ASCII, property order
/// preserved, and JavaScript's number notation.
/// </summary>
internal static class JsonCanon
{
    /// <summary>Serialize a node the way <c>JSON.stringify(value, null, 2)</c> would.</summary>
    public static string Stringify(JsonNode? node)
    {
        var builder = new StringBuilder();
        Write(builder, node, 0, indent: true);
        return builder.ToString();
    }

    /// <summary>
    /// Serialize a node the way <c>JSON.stringify(value)</c> would: no line
    /// breaks, no space after a colon or a comma. It is what a value inside an
    /// observation payload is shown as when it is not text, so a reader loses
    /// nothing to a shape this renderer has no layout for.
    /// </summary>
    public static string StringifyCompact(JsonNode? node)
    {
        var builder = new StringBuilder();
        Write(builder, node, 0, indent: false);
        return builder.ToString();
    }

    private static void Write(StringBuilder builder, JsonNode? node, int depth, bool indent)
    {
        switch (node)
        {
            case null:
                builder.Append("null");
                return;
            case JsonObject record:
                WriteObject(builder, record, depth, indent);
                return;
            case JsonArray array:
                WriteArray(builder, array, depth, indent);
                return;
            case JsonValue value:
                WriteValue(builder, value);
                return;
            default:
                throw new InvalidOperationException("unsupported JSON node");
        }
    }

    private static void WriteObject(
        StringBuilder builder,
        JsonObject record,
        int depth,
        bool indent)
    {
        if (record.Count == 0)
        {
            builder.Append("{}");
            return;
        }
        builder.Append(indent ? "{\n" : "{");
        var first = true;
        foreach (var property in record)
        {
            if (!first)
            {
                builder.Append(indent ? ",\n" : ",");
            }
            first = false;
            Indent(builder, depth + 1, indent);
            WriteString(builder, property.Key);
            builder.Append(indent ? ": " : ":");
            Write(builder, property.Value, depth + 1, indent);
        }
        if (indent)
        {
            builder.Append('\n');
        }
        Indent(builder, depth, indent);
        builder.Append('}');
    }

    private static void WriteArray(
        StringBuilder builder,
        JsonArray array,
        int depth,
        bool indent)
    {
        if (array.Count == 0)
        {
            builder.Append("[]");
            return;
        }
        builder.Append(indent ? "[\n" : "[");
        for (var i = 0; i < array.Count; i += 1)
        {
            if (i > 0)
            {
                builder.Append(indent ? ",\n" : ",");
            }
            Indent(builder, depth + 1, indent);
            Write(builder, array[i], depth + 1, indent);
        }
        if (indent)
        {
            builder.Append('\n');
        }
        Indent(builder, depth, indent);
        builder.Append(']');
    }

    private static void Indent(StringBuilder builder, int depth, bool indent)
    {
        if (indent)
        {
            builder.Append(' ', depth * 2);
        }
    }

    private static void WriteValue(StringBuilder builder, JsonValue value)
    {
        if (value.TryGetValue<string>(out var text))
        {
            WriteString(builder, text);
            return;
        }
        if (value.TryGetValue<bool>(out var flag))
        {
            builder.Append(flag ? "true" : "false");
            return;
        }
        if (value.TryGetValue<JsonElement>(out var element))
        {
            WriteElement(builder, element);
            return;
        }
        if (value.TryGetValue<int>(out var int32))
        {
            builder.Append(int32.ToString(CultureInfo.InvariantCulture));
            return;
        }
        if (value.TryGetValue<long>(out var int64))
        {
            builder.Append(int64.ToString(CultureInfo.InvariantCulture));
            return;
        }
        if (value.TryGetValue<double>(out var real))
        {
            builder.Append(FormatNumber(real));
            return;
        }
        if (value.TryGetValue<decimal>(out var dec))
        {
            builder.Append(FormatNumber((double)dec));
            return;
        }
        throw new InvalidOperationException("unsupported JSON value");
    }

    private static void WriteElement(StringBuilder builder, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.String:
                WriteString(builder, element.GetString() ?? "");
                return;
            case JsonValueKind.True:
                builder.Append("true");
                return;
            case JsonValueKind.False:
                builder.Append("false");
                return;
            case JsonValueKind.Null:
                builder.Append("null");
                return;
            case JsonValueKind.Number:
                // Parse-and-reformat, the way JSON.parse followed by
                // JSON.stringify would: "1.0" in the input becomes "1".
                if (element.TryGetInt64(out var whole) && !element.GetRawText().Contains('.')
                    && !element.GetRawText().Contains('e') && !element.GetRawText().Contains('E'))
                {
                    builder.Append(whole.ToString(CultureInfo.InvariantCulture));
                    return;
                }
                builder.Append(FormatNumber(element.GetDouble()));
                return;
            default:
                throw new InvalidOperationException("unsupported JSON element");
        }
    }

    /// <summary>
    /// Format a double the way JavaScript's Number-to-string conversion
    /// does for the values that actually occur in handovers: shortest
    /// round-trip decimal notation, no trailing ".0", exponent notation
    /// only outside [1e-6, 1e21) with a lowercase <c>e</c> and no
    /// zero-padded exponent.
    /// </summary>
    private static string FormatNumber(double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value))
        {
            return "null";
        }
        if (value == 0)
        {
            return "0";
        }

        var text = value.ToString("R", CultureInfo.InvariantCulture);
        var exponentAt = text.IndexOfAny(new[] { 'E', 'e' });
        if (exponentAt < 0)
        {
            return text;
        }

        var mantissa = text[..exponentAt];
        var exponent = int.Parse(text[(exponentAt + 1)..], CultureInfo.InvariantCulture);
        var absolute = Math.Abs(value);
        if (absolute >= 1e21 || absolute < 1e-6)
        {
            var sign = exponent < 0 ? "-" : "+";
            return $"{mantissa}e{sign}{Math.Abs(exponent)}";
        }

        // Expand to plain decimal notation.
        var negative = mantissa.StartsWith('-');
        var digits = (negative ? mantissa[1..] : mantissa).Replace(".", "");
        var pointAt = (negative ? mantissa[1..] : mantissa).IndexOf('.');
        var integerLength = (pointAt < 0 ? digits.Length : pointAt) + exponent;

        string plain;
        if (integerLength <= 0)
        {
            plain = "0." + new string('0', -integerLength) + digits;
        }
        else if (integerLength >= digits.Length)
        {
            plain = digits + new string('0', integerLength - digits.Length);
        }
        else
        {
            plain = digits[..integerLength] + "." + digits[integerLength..];
        }
        return negative ? "-" + plain : plain;
    }

    private static void WriteString(StringBuilder builder, string text)
    {
        builder.Append('"');
        foreach (var ch in text)
        {
            switch (ch)
            {
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\\':
                    builder.Append("\\\\");
                    break;
                case '\b':
                    builder.Append("\\b");
                    break;
                case '\f':
                    builder.Append("\\f");
                    break;
                case '\n':
                    builder.Append("\\n");
                    break;
                case '\r':
                    builder.Append("\\r");
                    break;
                case '\t':
                    builder.Append("\\t");
                    break;
                default:
                    if (ch < 0x20)
                    {
                        builder.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        builder.Append(ch);
                    }
                    break;
            }
        }
        builder.Append('"');
    }
}
