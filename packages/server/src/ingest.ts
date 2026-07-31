/**
 * The one door bytes come through.
 *
 * ## Why this file exists at all
 *
 * The HTTP layer used to hold the request body as a string and call
 * `JSON.parse` on it, inline, in two places. Every other surface in this
 * repository — the CLI, the local MCP server, each language SDK — goes through
 * one pre-schema ingestion boundary that receives *bytes* and enforces the four
 * rules a constructed value can no longer show you:
 *
 *   1. encoding    UTF-8, no byte order mark, nothing repaired or transcoded
 *   2. duplicates  a member name repeated inside one object refuses the
 *                  document, before any object is built from it
 *   3. depth       nesting is bounded before anything walks the value
 *   4. numbers     a number is judged from its token text, because a parser
 *                  rounds an oversized integer in silence
 *
 * The security argument is the duplicate rule. With last-wins parsing, the
 * fail-closed secret scan sees one value for `/sections/x` and a consumer
 * parsing the same bytes with a different parser sees another: the document
 * that gets scanned is not the document that gets read. A server that accepts
 * over the network what every other surface refuses is the wrong surface to
 * make that exception on.
 *
 * ## Where the seam is, precisely
 *
 * That boundary is `ingestDocument(bytes: Uint8Array): IngestResult`, exported
 * from `@nativesoil/handover-sdk` (`packages/sdk-ts/src/ingest.ts`). This file
 * calls it. It is the only place in `packages/server` that turns bytes into a
 * value, and it holds no rules of its own: the limits below are the boundary's
 * own object, re-exported, so there is one set of numbers rather than two that
 * have to be kept equal by hand.
 *
 * ## What this file used to be, and why the note is kept
 *
 * Until the boundary landed on this branch, this file was a documented
 * stand-in: it enforced size, byte order mark and encoding, and said plainly
 * that it enforced neither depth nor duplicate member names. That was honest
 * while it was true, and it stopped being true when the boundary arrived
 * without anything here noticing. What the gap actually cost, measured before
 * it was closed, is worth keeping:
 *
 *   - a complete, otherwise valid handover carrying `"projectId"` twice was
 *     accepted, stored and served back, with last-wins deciding which of the
 *     two values the store kept;
 *   - a document 33 levels deep, or carrying `0.92`, or carrying
 *     9007199254740992, got past this door and was written to disk — and then
 *     the store's own read-back went through the boundary, threw, and the
 *     caller was answered `500 internal error`. The row stayed in the index and
 *     every later read of it answered `500` too: a stored handover that could
 *     never be loaded.
 *
 * That is the shape of the failure this door exists to prevent, and it is why
 * this file has no rules of its own to drift.
 */

import { ingestDocument, INGEST_LIMITS } from "@nativesoil/handover-sdk";

export { INGEST_LIMITS };

/** What the door answers. One controlled parse result, or one refusal. */
export type IngestOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Turn one request body into a value, or refuse it.
 *
 * Every rule is the boundary's. The order of the checks is normative and lives
 * there: size, encoding, depth, syntax, duplicate member names, numeric domain.
 * All this function does is restate the boundary's refusal in the shape the two
 * callers in `http.ts` already render as a `400`.
 */
export function ingestRequestBody(bytes: Uint8Array): IngestOutcome {
  const result = ingestDocument(bytes);
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, code: result.issue.code, message: result.issue.message };
}
