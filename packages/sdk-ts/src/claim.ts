/**
 * Claim identity: the content-derived identifier for one item of project
 * knowledge.
 *
 * A claim is a durable statement about the project — a decision, a
 * constraint, a rejected path — and its identifier is a hash of what it says,
 * not a number something allocated. That is the property everything else
 * leans on: the same statement of the same kind gets the same identifier in
 * every implementation, on every machine, with no shared allocation state, so
 * two saves that address the same claim agree about which claim that was
 * without ever coordinating. A sequential identifier cannot promise that: it
 * depends on shared mutable state, and a deleted document silently re-points
 * every identifier after it.
 *
 * The cost of the property is that normalization must be byte-exact across
 * five languages, and the failure mode is silent: a one-byte divergence does
 * not crash anything, it splits one claim into two, and a stored reference to
 * the claim resolves for one reader and dangles for another. So the
 * rules below are defined on bytes, not on any language's notion of a
 * character class, and the contract is pinned by the corpus in
 * `conformance/fixtures/claims/identity.json` — which this implementation
 * follows, never the other way around. The corpus's rows that must DIFFER
 * are the load-bearing half: every convenient built-in that looks like these
 * rules — the general-purpose lower-casing helpers, the `\s` whitespace
 * class, the Unicode-aware trims, every normalization form, every
 * locale-aware operation — passes the sameness rows and fails those, because
 * each gives a different answer in at least one of the five languages or at
 * least one locale. None of them appears here, and `claim.test.ts` holds
 * this file's source to that.
 *
 * The kinds are exactly the section keys whose tier is durable, read from
 * the tier table in `sections.ts` rather than restated, so the two cannot
 * drift. Rank order puts constraints and decisions first: those are the two
 * kinds no bound on rendering may ever drop.
 */

import { createHash } from "node:crypto";

import { SECTION_KEYS, SECTION_TIERS, type SectionKey } from "./sections.js";

/**
 * A claim kind. At the type level this is a section key; the value set is
 * narrower — exactly the durable-tier keys, enumerated at runtime by
 * {@link CLAIM_KINDS} — because the tier table's values are not visible to
 * the type system. {@link isClaimKind} is the runtime narrowing.
 */
export type ClaimKind = SectionKey;

/**
 * The two kinds that rank first, in order. This names their rank, not their
 * membership: membership comes only from the tier table, and a key listed
 * here that ever stopped being durable would simply stop being a kind.
 */
const RANKED_FIRST: readonly SectionKey[] = ["constraints", "decisions"];

const DURABLE_KEYS: readonly SectionKey[] = SECTION_KEYS.filter(
  (key) => SECTION_TIERS[key] === "durable",
);

/**
 * The claim kinds, in rank order: constraints and decisions first, then the
 * remaining durable section keys in their canonical order.
 */
export const CLAIM_KINDS: readonly ClaimKind[] = Object.freeze([
  ...RANKED_FIRST.filter((key) => DURABLE_KEYS.includes(key)),
  ...DURABLE_KEYS.filter((key) => !RANKED_FIRST.includes(key)),
]);

/** Is this value one of the claim kinds? */
export function isClaimKind(value: unknown): value is ClaimKind {
  return (
    typeof value === "string" &&
    (CLAIM_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The domain string hashed ahead of every claim, so a claim identifier can
 * never collide with a hash somebody derives from the same text for another
 * purpose. Versioned because the derivation is frozen: a future change to
 * the rules is a new domain, never a quiet change under this one.
 */
export const CLAIM_ID_DOMAIN = "soil.claim.v1";

/**
 * The identifier length in lowercase hexadecimal characters: 16, which is
 * 64 bits of the digest. Long enough that a store would need billions of
 * claims before two distinct statements are likely to share an identifier,
 * and short enough to sit in a rendered line without becoming the line.
 */
export const CLAIM_ID_LENGTH = 16;

/** Thrown when a claim identifier cannot be derived from the input. */
export class ClaimIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimIdentityError";
  }
}

/** The four whitespace bytes. Exactly these; nothing else is whitespace. */
const WHITESPACE_BYTES = new Set([0x09, 0x0a, 0x0d, 0x20]);

/**
 * Normalize a statement to the bytes that are hashed, per the rules stated
 * in the corpus:
 *
 * 1. Encode the statement as UTF-8.
 * 2. Whitespace is exactly the four bytes 0x09, 0x0A, 0x0D and 0x20.
 * 3. Remove leading and trailing whitespace bytes.
 * 4. Replace every remaining maximal run of whitespace bytes with one 0x20.
 * 5. Fold the bytes 0x41..0x5A (A..Z) to 0x61..0x7A (a..z).
 * 6. Nothing else changes: no Unicode normalization form, no locale, and
 *    every byte of 0x80 and above passes through untouched.
 *
 * Every rule touches only bytes below 0x80, and no byte of a multi-byte
 * UTF-8 sequence is below 0x80, so the transform cannot corrupt a sequence
 * and needs no decoder. What the rules erase is what a model restating the
 * same fact cannot be expected to hold steady — capitalisation and the
 * shape of the spaces between words. What they keep is everything else:
 * a no-break space is content, upper and lower Greek are two statements,
 * and the composed and decomposed spellings of the same accented word are
 * two statements. Where that costs a duplicate claim, it costs it
 * identically in every implementation, which is the property being bought.
 */
function normalizeStatementBytes(statement: string): Buffer {
  // An unpaired surrogate has no UTF-8 encoding. This runtime would quietly
  // substitute U+FFFD and hash that; other runtimes refuse the encode or
  // keep the surrogate, so the only answer all five can give identically is
  // no identifier at all.
  for (let i = 0; i < statement.length; i += 1) {
    const unit = statement.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < statement.length ? statement.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      throw new ClaimIdentityError(
        "a claim statement must be well-formed text: it carries an unpaired surrogate, which has no UTF-8 encoding",
      );
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new ClaimIdentityError(
        "a claim statement must be well-formed text: it carries an unpaired surrogate, which has no UTF-8 encoding",
      );
    }
  }

  const input = Buffer.from(statement, "utf8");
  const out: number[] = [];
  let pendingSpace = false;
  for (const byte of input) {
    if (WHITESPACE_BYTES.has(byte)) {
      // A run at the start of the statement is dropped rather than held:
      // rule 3. A run anywhere else is held as one pending space, so a run
      // at the end never lands: rules 3 and 4 in one pass.
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out.push(0x20);
      pendingSpace = false;
    }
    out.push(byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte);
  }
  return Buffer.from(out);
}

/**
 * Normalize a claim statement, returning the normalized text.
 *
 * This is the byte transform of {@link claimId} surfaced as a string, so a
 * caller can show a user exactly which spelling of their statement is the
 * one that carries identity. The bytes returned by this function are the
 * bytes the identifier is derived from.
 */
export function normalizeClaimStatement(statement: string): string {
  return normalizeStatementBytes(statement).toString("utf8");
}

/**
 * Derive the identifier of a claim from its kind and its statement.
 *
 * The identifier is the first {@link CLAIM_ID_LENGTH} lowercase hexadecimal
 * characters of SHA-256 over: the UTF-8 bytes of {@link CLAIM_ID_DOMAIN},
 * one 0x0A byte, the UTF-8 bytes of the kind key, one 0x0A byte, the
 * normalized statement bytes. The framing is unambiguous without any
 * escaping because none of the three parts can contain 0x0A: the domain and
 * the kind keys are fixed identifiers without one, and normalization turns
 * every 0x0A in the statement into 0x20 or removes it at the edges.
 *
 * The kind is hashed as written, unfolded: it is one of six fixed keys, not
 * prose, so there is nothing to normalize and folding it would only blur
 * the line between an identifier and a statement.
 *
 * Refused, with a {@link ClaimIdentityError}: a kind outside
 * {@link CLAIM_KINDS}, and a statement that is empty once normalized —
 * there is nothing to identify, and an identifier for the empty statement
 * would be one identifier shared by every way of saying nothing.
 */
export function claimId(kind: string, statement: string): string {
  if (!isClaimKind(kind)) {
    throw new ClaimIdentityError(
      `a claim kind must be one of the durable section keys (${CLAIM_KINDS.join(
        ", ",
      )}); got ${JSON.stringify(kind)}`,
    );
  }
  const normalized = normalizeStatementBytes(statement);
  if (normalized.length === 0) {
    throw new ClaimIdentityError(
      "a claim statement must say something: it is empty once normalized",
    );
  }
  const hash = createHash("sha256");
  hash.update(Buffer.from(CLAIM_ID_DOMAIN, "utf8"));
  hash.update(Buffer.from([0x0a]));
  hash.update(Buffer.from(kind, "utf8"));
  hash.update(Buffer.from([0x0a]));
  hash.update(normalized);
  return hash.digest("hex").slice(0, CLAIM_ID_LENGTH);
}
