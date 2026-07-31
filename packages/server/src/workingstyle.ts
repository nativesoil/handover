/**
 * Working-style capture on the server's MCP endpoint: the four questions
 * `soil_save` asks alongside the 17 sections, and the observation the answers
 * ride on.
 *
 * This exists because the endpoint's own documentation said it offered the
 * same three tools as the local stdio server, each with one addition. It was
 * an addition AND an omission: the server's save took no working-style input
 * and its load rendered no working-style evidence, so a document carrying a
 * correctly formed `working.style` observation showed its evidence block
 * through the local surface and nothing at all through this one. The sentence
 * was repaired by making it true rather than by narrowing it.
 *
 * Ground rules, all load-bearing and identical to the local server's:
 *
 *  - OPTIONAL AND FAIL-SOFT. A save with no answers is stored exactly as it
 *    would have been without this feature. An answer that is missing, empty,
 *    the wrong type or too long is dropped, never a save error. Dropped, not
 *    truncated: a shortened recorded instance would be a different statement
 *    than the one the model made.
 *  - AND THE DROP IS NAMED. Fail-soft is the right call for an optional extra,
 *    and for a while it was the whole rule, which made it half of one: an
 *    answer the caller wrote went nowhere and the receipt said nothing, so a
 *    model had no way to tell a recorded answer from a discarded one. The drop
 *    stays, because shortening would change the statement and refusing would
 *    cost a user their capture over an optional field. What it now also does is
 *    report which answer did not travel and why, at the path the caller stated
 *    it under, so the caller can state it again in a shape that fits.
 *  - AT MOST ONE OBSERVATION PER SAVE. The answers ride as a single
 *    `working.style` entry attributed to this server, attached before
 *    validation so the same structural checks and the same fail-closed secret
 *    scan apply inside it as everywhere else in the document.
 *  - EVIDENCE, NEVER A GRADE. What the load shows names the producer and shows
 *    the instances. It never counts, scores or ranks anything: that is reader
 *    rule 2 of spec/observations.md, and a test pins it.
 *
 * Showing the answers at load is not here. `buildRestorePrompt` in the SDK does
 * it for every surface at once, so this endpoint and the local one cannot drift
 * apart, and so the block carries the render's own marker: a block assembled
 * outside the prompt would have to spell its heading in static text, and a
 * heading spelled inside a recorded instance would then render as a second one.
 *
 * `packages/mcp/src/workingstyle.ts` carries the questions and the capture by
 * hand. The two packages carrying it depend only on the SDK, and the questions
 * one server asks are not part of the format, so the copies are kept in step
 * deliberately. Change one, change both.
 */

import type { HandoverObservation } from "@nativesoil/handover-sdk";

/**
 * Who recorded the answers. This server names itself, so a reader can weigh
 * the claim and can tell an instance recorded here from one recorded by the
 * local stdio server, exactly as spec/observations.md asks of a `producedBy`.
 */
export const WORKING_STYLE_PRODUCER = "@nativesoil/handover-server 0.2.0";

/**
 * An answer longer than this is dropped. Four sentences about one moment fit
 * comfortably; a payload that does not was not an answer to the question.
 */
export const WORKING_STYLE_ANSWER_LIMIT = 2000;

/** One question: the schema key, the few-word situation label the recorded
 * instance is filed under, and the question as put to the extracting model. */
export interface WorkingStyleQuestion {
  readonly key: string;
  readonly situation: string;
  readonly question: string;
}

/**
 * The four questions, fixed, and word for word the local server's. A question
 * that differed would file the same kind of moment under a different situation
 * label, and the two servers' documents would stop being comparable.
 */
export const WORKING_STYLE_QUESTIONS: readonly WorkingStyleQuestion[] =
  Object.freeze([
    {
      key: "blocker",
      situation: "How the last blocker was handled",
      question:
        "The last time this thread hit a blocker, what did it concretely do? Two to four sentences about that one moment: what blocked the work, what was actually done, and what happened next. A recorded instance, not a habit.",
    },
    {
      key: "conflict",
      situation: "How conflicting instructions were resolved",
      question:
        "When instructions or preferences conflicted in this thread, what happened? Two to four sentences about one actual case: what clashed, and how it was resolved.",
    },
    {
      key: "integration",
      situation: "How new work was checked before it was trusted",
      question:
        "When new work landed in this thread, how was it integrated and checked before anyone trusted it? Two to four sentences about one actual instance, in this project's own terms.",
    },
    {
      key: "assumption",
      situation: "An assumption this thread made and how it was caught",
      question:
        "Name an assumption this thread made, and how it was tested or caught. Two to four sentences about that specific assumption and what happened when it met reality.",
    },
  ]);

/** The `workingStyle` property of the `soil_save` input schema. */
export function workingStyleSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const entry of WORKING_STYLE_QUESTIONS) {
    properties[entry.key] = { type: "string", description: entry.question };
  }
  return {
    type: "object",
    additionalProperties: false,
    description:
      "Four questions about how this project actually works, answered from real moments in this thread. Each answer is a recorded instance: what happened, in two to four sentences, never a general adjective. All of it is optional: skip any question you cannot answer from something that actually happened, and a save without answers succeeds unchanged. Answers travel on the handover as evidence attributed to this server, and nothing grades them.",
    properties,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One answer the caller stated that was not recorded, and why not. */
export interface WorkingStyleDrop {
  /** The path the caller stated it under, so the report names their spelling. */
  readonly path: string;
  /** What is wrong with it, in the validator's vocabulary. */
  readonly message: string;
}

/**
 * What one save's working-style capture came to: the observation to attach when
 * anything survived, and every stated answer that did not, so the save can say
 * so.
 */
export interface WorkingStyleCapture {
  readonly observation?: HandoverObservation;
  readonly dropped: readonly WorkingStyleDrop[];
}

/**
 * Turn the model's answers into at most one `working.style` observation, and
 * name whatever it could not use.
 *
 * The observation is absent when there is nothing worth recording, and the save
 * proceeds without one, byte for byte as it would have before. Never throws:
 * this runs inside every save, and a bad answer must never cost a user their
 * capture. What it does not do any more is stay quiet about it. A stated answer
 * that goes nowhere comes back in `dropped`, at the path the caller wrote it
 * under, and the save reports it.
 *
 * An absent answer is not a drop. Skipping a question is the documented way to
 * answer none of them, and a report naming four absences on every save without
 * answers would bury the one line that matters.
 */
export function captureWorkingStyle(
  value: unknown,
  now: Date,
): WorkingStyleCapture {
  if (value === undefined) return { dropped: [] };
  if (!isRecord(value)) {
    return {
      dropped: [{ path: "/workingStyle", message: "must be an object" }],
    };
  }

  const instances: { situation: string; response: string }[] = [];
  const dropped: WorkingStyleDrop[] = [];
  for (const entry of WORKING_STYLE_QUESTIONS) {
    const raw = value[entry.key];
    if (raw === undefined) continue;
    const path = `/workingStyle/${entry.key}`;
    if (typeof raw !== "string") {
      dropped.push({ path, message: "must be a string" });
      continue;
    }
    const response = raw.trim();
    if (response.length === 0) {
      dropped.push({ path, message: "must not be empty" });
      continue;
    }
    if (response.length > WORKING_STYLE_ANSWER_LIMIT) {
      dropped.push({
        path,
        message: `is longer than the ${WORKING_STYLE_ANSWER_LIMIT} this server records for one answer`,
      });
      continue;
    }
    instances.push({ situation: entry.situation, response });
  }
  if (instances.length === 0) return { dropped };

  return {
    observation: {
      kind: "working.style",
      producedBy: WORKING_STYLE_PRODUCER,
      producedAt: now.toISOString(),
      data: { instances },
    },
    dropped,
  };
}
