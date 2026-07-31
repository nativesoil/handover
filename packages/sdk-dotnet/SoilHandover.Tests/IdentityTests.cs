using System.Text.RegularExpressions;
using Xunit;

namespace Soil.Handover.Tests;

public class IdentityTests
{
    private static readonly Regex UuidV7 =
        new("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");

    [Fact]
    public void GeneratesACanonicalUuidv7()
    {
        var id = Identity.Uuidv7();
        Assert.Matches(UuidV7, id);
        Assert.True(Identity.IsHandoverId(id));
    }

    [Fact]
    public void EmbedsTheGivenMillisecondTimestamp()
    {
        var moment = new DateTimeOffset(2026, 7, 22, 10, 0, 0, TimeSpan.Zero);
        var id = Identity.Uuidv7(moment);
        var hex = id.Replace("-", "")[..12];
        var ms = Convert.ToInt64(hex, 16);
        Assert.Equal(moment.ToUnixTimeMilliseconds(), ms);
    }

    [Fact]
    public void NeverReturnsTheSameIdTwice()
    {
        var seen = new HashSet<string>();
        for (var i = 0; i < 1000; i += 1)
        {
            Assert.True(seen.Add(Identity.Uuidv7(TestData.Now)));
        }
    }

    [Fact]
    public void ThePatternAcceptsAnyUuidVersionOnPurpose()
    {
        // A reader treats the id as opaque, so it does not police which
        // version another writer chose.
        Assert.True(Identity.IsHandoverId("123e4567-e89b-42d3-a456-426614174000"));
        Assert.False(Identity.IsHandoverId("123E4567-E89B-42D3-A456-426614174000"));
        Assert.False(Identity.IsHandoverId("handover-42"));
        Assert.False(Identity.IsHandoverId(null));
        Assert.False(Identity.IsHandoverId(42));
    }
}
