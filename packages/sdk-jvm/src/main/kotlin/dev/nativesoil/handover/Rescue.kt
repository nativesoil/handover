/**
 * The rescue prompt: the exact text a user pastes into a dead or full thread.
 *
 * When a thread is out of room, or the assistant has no tools wired up, no
 * `soil save` can run inside it. The rescue prompt asks the model for ONE JSON
 * block, which the store ingests as a real handover after [normalizeHandover].
 * It is the manual on-ramp, and it is the reason the format has to be writable
 * by a model with no tools at all.
 *
 * The canonical text lives in `recipes/rescue-recipe-v1.txt` at the repo root
 * and is BYTE-NORMATIVE. It is packaged into the jar as a resource generated
 * from that file at build time; the file carries one trailing newline that the
 * prompt itself does not, matching the other SDKs.
 */
@file:JvmName("Rescue")

package dev.nativesoil.handover

/** The rescue prompt, byte-identical to `recipes/rescue-recipe-v1.txt`. */
@JvmField
val RESCUE_PROMPT: String =
    loadRecipeResource("rescue-recipe-v1.txt").removeSuffix("\n")

/** The rescue prompt, for callers that prefer a method to a field. */
fun rescuePrompt(): String = RESCUE_PROMPT
