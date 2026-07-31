using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Soil.Handover;

/// <summary>
/// Handover identity: the <c>handoverId</c>.
///
/// Every stored handover carries one globally unique id, a UUIDv7 (RFC
/// 9562). It is assigned by the writer at store time when the document does
/// not already carry one; the extraction recipe never asks a model to invent
/// an id, because an id a model makes up is an id two documents can share.
///
/// The id is opaque. It is never derived from the document's content, never
/// reused, and carries no meaning beyond identity: the timestamp embedded in
/// a UUIDv7 is an implementation detail of how uniqueness is generated, not
/// a fact a reader may lean on. A byte-for-byte copy of a handover keeps its
/// handoverId; a new capture, even of the same project a minute later, gets
/// a new one; migration never changes it.
///
/// The local <c>#NNN</c> code is a different thing entirely: a short human
/// handle assigned by one store, for typing. Two stores can both hold a
/// <c>#001</c> without any identity collision, because identity lives here.
/// </summary>
public static partial class Identity
{
    /// <summary>
    /// The shape of a <c>handoverId</c>: canonical lowercase UUID text,
    /// 8-4-4-4-12 hex.
    ///
    /// The pattern accepts any UUID version on purpose. The official writers
    /// emit UUIDv7, but a reader treats the id as opaque, so it does not
    /// police which version another writer chose.
    /// </summary>
    public static Regex HandoverIdPattern => HandoverIdRegex();

    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")]
    private static partial Regex HandoverIdRegex();

    /// <summary>Does this value have the shape of a <c>handoverId</c>?</summary>
    public static bool IsHandoverId(object? value)
        => value is string text && HandoverIdPattern.IsMatch(text);

    /// <summary>
    /// Generate a UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then the
    /// version and variant bits, then 74 random bits.
    ///
    /// <paramref name="now"/> exists for tests; production callers let it
    /// default. The randomness comes from the platform CSPRNG, and nothing
    /// about the result is derived from any document.
    /// </summary>
    public static string Uuidv7(DateTimeOffset? now = null)
    {
        var bytes = new byte[16];
        RandomNumberGenerator.Fill(bytes);

        var ms = (now ?? DateTimeOffset.UtcNow).ToUnixTimeMilliseconds();
        for (var i = 5; i >= 0; i -= 1)
        {
            bytes[i] = (byte)(ms & 0xFF);
            ms >>= 8;
        }

        bytes[6] = (byte)((bytes[6] & 0x0F) | 0x70);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);

        var hex = Convert.ToHexString(bytes).ToLowerInvariant();
        return new StringBuilder(36)
            .Append(hex, 0, 8).Append('-')
            .Append(hex, 8, 4).Append('-')
            .Append(hex, 12, 4).Append('-')
            .Append(hex, 16, 4).Append('-')
            .Append(hex, 20, 12)
            .ToString();
    }
}
