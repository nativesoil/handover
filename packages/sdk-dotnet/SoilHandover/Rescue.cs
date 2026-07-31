namespace Soil.Handover;

/// <summary>
/// The rescue prompt: the exact text a user pastes into a dead or full
/// thread.
///
/// When a thread is out of room, or the assistant has no tools wired up, no
/// <c>soil save</c> can run inside it. The rescue prompt asks the model for
/// ONE JSON block, which the ingestion path turns into a real handover via
/// <see cref="Normalize.NormalizeHandover"/>. It is the manual on-ramp, and
/// it is the reason the format has to be writable by a model with no tools
/// at all.
///
/// The canonical text lives in <c>recipes/rescue-recipe-v1.txt</c> at the
/// repo root and is BYTE-NORMATIVE. The file carries one trailing newline;
/// the prompt is the file text without it, so <c>RescuePrompt + "\n"</c> is
/// byte-identical to the file.
/// </summary>
public static class Rescue
{
    /// <summary>The rescue prompt, byte-identical to the canonical file minus its trailing newline.</summary>
    public static string RescuePrompt { get; } = Load();

    private static string Load()
    {
        var text = Embedded.Read("Soil.Handover.recipes.rescue-recipe-v1.txt");
        if (!text.EndsWith('\n'))
        {
            throw new InvalidOperationException("the embedded rescue text does not end with a newline");
        }
        return text[..^1];
    }
}
