/**
 * Handover identity: the `handoverId`.
 *
 * Every stored handover carries one globally unique id, a UUIDv7 (RFC 9562).
 * It is assigned by the writer at store time when the document does not
 * already carry one; the extraction recipe never asks a model to invent an
 * id, because an id a model makes up is an id two documents can share.
 *
 * The id is opaque. It is never derived from the document's content, never
 * reused, and carries no meaning beyond identity: the timestamp embedded in a
 * UUIDv7 is an implementation detail of how uniqueness is generated, not a
 * fact a reader may lean on. A byte-for-byte copy of a handover keeps its
 * handoverId; a new capture, even of the same project a minute later, gets a
 * new one; migration never changes it.
 *
 * The local `#NNN` code is a different thing entirely: a short human handle
 * assigned by one store, for typing. Two stores can both hold a `#001`
 * without any identity collision, because identity lives here.
 */

import { randomBytes } from "node:crypto";

/**
 * The shape of a `handoverId`: canonical lowercase UUID text, 8-4-4-4-12 hex.
 *
 * The pattern accepts any UUID version on purpose. The official writers emit
 * UUIDv7, but a reader treats the id as opaque, so it does not police which
 * version another writer chose.
 */
export const HANDOVER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Does this value have the shape of a `handoverId`? */
export function isHandoverId(value: unknown): value is string {
  return typeof value === "string" && HANDOVER_ID_PATTERN.test(value);
}

/**
 * Generate a UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then the
 * version and variant bits, then 74 random bits.
 *
 * `now` exists for tests; production callers let it default. The randomness
 * comes from the platform CSPRNG, and nothing about the result is derived
 * from any document.
 */
export function uuidv7(now: Date = new Date()): string {
  const bytes = randomBytes(16);
  let ms = now.getTime();
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
