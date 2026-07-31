/**
 * The cross-language corpus for `checkHandover` and `renderCheck`.
 *
 * One list of documents, designed to attack a port rather than to flatter
 * it: documents where every rule fires and where none does, counts sitting
 * exactly on each grade-band edge, thresholds met and missed by one, content
 * outside the Basic Multilingual Plane where a wrong string unit changes the
 * numbers a message quotes, and a decisions section with enough entries that
 * a wrong sort order changes the report.
 *
 * The corpus is INPUT only. The expected outputs are produced from the built
 * TypeScript reference by the per-language golden generators, never written
 * by hand, so a golden can only ever say what the reference says.
 *
 * Consumed by `scripts/generate-check-parity.mjs` (Go and JVM goldens),
 * `packages/sdk-dotnet/tools/generate-golden.mjs` (.NET goldens) and, as the
 * emitted corpus files, by the Python parity test, which runs the reference
 * live over the same documents.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The 17 section keys, in canonical order. */
const KEYS = [
  "projectIdentity",
  "decisions",
  "workflow",
  "architecture",
  "constraints",
  "rejectedPaths",
  "executiveSummary",
  "currentTask",
  "latestUserIntent",
  "sessionDelta",
  "blockers",
  "nextSteps",
  "openQuestions",
  "sessionActivity",
  "restoreInstructions",
  "provenanceMap",
  "safetySummary",
];

/** Fixed producer fields for the observation goldens. */
export const CHECK_OBSERVATION_PRODUCER = {
  producedBy: "soil-cli/0.1.0",
  producedAt: "2026-07-22T10:00:00Z",
};

/**
 * Pad a prose prefix with filler to an exact length in UTF-16 code units,
 * which is the unit the reference's thresholds are measured in. The filler
 * matches no rule pattern, so the padded section stays quiet.
 */
function pad(prefix, target) {
  if (prefix.length > target) {
    throw new Error(`prefix is already ${prefix.length} of ${target}`);
  }
  return prefix + "x".repeat(target - prefix.length);
}

/** All 17 sections declared, the named ones available, the rest missing. */
function sections(overrides) {
  const out = {};
  for (const key of KEYS) {
    const value = overrides[key];
    if (value === undefined) {
      out[key] = { status: "missing", summary: null };
    } else if (typeof value === "string") {
      out[key] = { status: "available", summary: value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

let serial = 0;

/** One corpus document: a complete, valid handover with a load code. */
function doc(name, body) {
  serial += 1;
  const id = `019f7e89-fc00-7000-8000-${String(serial).padStart(12, "0")}`;
  return {
    name,
    document: {
      soilHandover: "1.0",
      handoverId: id,
      projectId: body.projectId,
      title: body.title,
      createdAt: "2026-07-22T10:00:00Z",
      sections: sections(body.sections),
      ...(body.quality !== undefined ? { quality: body.quality } : {}),
      ...(body.safety !== undefined ? { safety: body.safety } : {}),
      code: `#${String(serial).padStart(3, "0")}`,
    },
  };
}

/** Quiet filler prose: long enough to be substantial, matching no rule. */
const CALM =
  "The project keeps its lasting truth written down in plain files, and" +
  " each section of this document repeats what the sessions agreed on in" +
  " full sentences so a cold reader can pick the work up without asking" +
  " anything. ";

function calm(target) {
  let text = "";
  while (text.length < target) text += CALM;
  return text.slice(0, target).trimEnd() + ".";
}

/** A proportionate restore prompt for a document of `other` content units. */
function restoreFor(other) {
  const floor = Math.max(300, Math.floor(other * 0.05));
  return pad(
    "You are continuing this project cold. Read the durable sections" +
      " first, hold every locked decision with its reason, and begin from" +
      " the next steps exactly as written. ",
    floor + 50,
  );
}

function readRepoJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

/**
 * Build the corpus. `root` is the repository root; three members are the
 * repository's own worked example and two conformance fixtures, carried in
 * so the corpus grades real documents and not only constructed ones.
 */
export function buildCheckCorpus(root) {
  serial = 0;
  const corpus = [];

  const orchard = readRepoJson(root, "examples/orchard-checkout.json");
  corpus.push({ name: "orchard", document: { ...orchard, code: "#901" } });

  const thin = readRepoJson(
    root,
    "conformance/fixtures/valid/thin-but-honest.json",
  );
  corpus.push({
    name: "thin-but-honest",
    document: { ...thin, code: "#902" },
  });

  const blocked = readRepoJson(
    root,
    "conformance/fixtures/valid/blocked-and-safe.json",
  );
  corpus.push({
    name: "blocked-and-safe",
    document: { ...blocked, code: "#903" },
  });

  // Every rule that can coexist with an empty durable tier, in one document:
  // no durable truth, absent restore instructions, unexplained gaps, a
  // silently blocked section, unanchored time words, a fetch pointer and a
  // one-liner inside otherwise substantial sections.
  corpus.push(
    doc("every-rule-a", {
      projectId: "rule-storm-a",
      title: "A capture that failed at the durable tier",
      sections: {
        architecture: { status: "blocked", summary: null },
        executiveSummary: calm(400),
        currentTask:
          "Right Now the retry path is half designed and the widget" +
          " re-mount is not written, which is where the work stopped." +
          pad(" The step list is agreed. ", 180),
        latestUserIntent:
          "For the exact wording of the direction, see the repo history" +
          " and settle it there. " +
          pad("The framing was about attribution. ", 160),
        sessionDelta: calm(320),
        blockers: "None known.",
        nextSteps: calm(280),
        sessionActivity: calm(300),
        provenanceMap: calm(240),
        safetySummary: calm(260),
      },
    }),
  );

  // The other half of the rule set: decision entries without reasons in
  // every list shape, configuration prose with no digits, a pointer inside
  // the restore instructions with a thin restore prompt behind it, and the
  // one-liner threshold met on one section and missed by one unit on its
  // neighbour. Entries 10 to 12 fire beside entries 1 to 9, so a port whose
  // ordering differs from the reference produces a different report.
  corpus.push(
    doc("every-rule-b", {
      projectId: "rule-storm-b",
      title: "A rich capture that keeps pointing elsewhere",
      sections: {
        projectIdentity: calm(400),
        decisions: [
          "1. We chose Postgres.",
          "2. We chose Redis because reads dominate the load.",
          "3. The team adopted trunk-based work.",
          "4) We locked the release train.",
          "5. Copy ships alone, since the founder reviews every string.",
          "6. We went with plain files.",
          "7. We settled on weekly deploys, so that the window stays safe.",
          "8. We picked the hosted widget.",
          "9. The parser was standardized.",
          "- We picked the delivery partner.",
          "\u2022 We opted for one shared cutoff module.",
          "\u25b8 Session state was migrated to the server.",
          "",
          "The remaining storage question is still open on both sides.",
        ].join("\n"),
        workflow:
          "Refer to the wiki for the full release checklist and keep it" +
          " open while deploying. " +
          pad("The steps are ordered. ", 200),
        architecture:
          "The service reads its configuration from the environment and" +
          " honours a request timeout and a memory ceiling.",
        constraints:
          "The bundle budget is a hard limit and the request quota is" +
          " pinned by the platform flag.",
        rejectedPaths: calm(240),
        executiveSummary:
          "As of 2026-07-22 the address step is deployed and recently" +
          " the retry work started. " +
          pad("The effect is unread. ", 180),
        currentTask:
          "Today the decline message is being drafted for review." +
          pad(" The logic waits on it. ", 170),
        latestUserIntent:
          "The direction is documented at https://example.com/wiki and" +
          " was restated in the thread. " +
          pad("It outranks cleanup. ", 160),
        sessionDelta: calm(300),
        blockers: "None.",
        nextSteps: calm(260),
        openQuestions: pad("Which store wins? ", 39),
        sessionActivity: calm(280),
        restoreInstructions:
          "Start from the setup, see the docs, then continue the retry" +
          " work where it stopped.",
        provenanceMap: pad("Sections map to sources. ", 40),
        safetySummary: calm(220),
      },
    }),
  );

  // No findings at all: every rule has a passing case in one document.
  {
    const decisions =
      "1. We chose plain files because they outlive databases.\n\n" +
      "2. We locked the cutoff module, since two implementations drifted" +
      " apart across a season boundary.\n\n" +
      "3. We adopted small reviewable steps because attribution needs" +
      " one change per deploy.";
    const other =
      400 +
      decisions.length +
      300 +
      260 +
      240 +
      220 +
      380 +
      200 +
      180 +
      200 +
      160 +
      170 +
      150 +
      210 +
      190 +
      170;
    corpus.push(
      doc("clean-strong", {
        projectId: "clean-strong",
        title: "A capture every rule passes",
        sections: {
          projectIdentity: calm(400),
          decisions,
          workflow: calm(300),
          architecture: pad(
            "Node is pinned at 20, the app listens on 3000 and the" +
              " cutoff logic lives in one module. ",
            260,
          ),
          constraints: pad(
            "The bundle stays under 180 KB and nothing deploys after" +
              " the weekly cutoff. ",
            240,
          ),
          rejectedPaths: calm(220),
          executiveSummary: calm(380),
          currentTask: pad(
            "At capture, the retry path was half designed and the" +
              " re-mount step was not written. ",
            200,
          ),
          latestUserIntent: calm(180),
          sessionDelta: calm(200),
          blockers: pad("Nothing is blocked at capture. ", 160),
          nextSteps: calm(170),
          openQuestions: pad(
            "Whether the effect can be measured this early. ",
            150,
          ),
          sessionActivity: calm(210),
          restoreInstructions: restoreFor(other),
          provenanceMap: calm(190),
          safetySummary: calm(170),
        },
      }),
    );
  }

  // Advice only: two soft signals and nothing else, and the band stays
  // strong, because advice never lowers the grade.
  corpus.push(
    doc("advice-only-strong", {
      projectId: "advice-only",
      title: "Configuration prose with every number stripped",
      sections: {
        projectIdentity: calm(300),
        decisions:
          "We chose the hosted widget because card data must never touch" +
          " our servers.",
        workflow: calm(240),
        architecture:
          "The service reads its configuration from the environment and" +
          " honours a request timeout.",
        constraints:
          "The mobile bundle has a ceiling and the deploy window is a" +
          " hard limit.",
        executiveSummary: calm(300),
        currentTask: pad("At capture, the design was mid-review. ", 200),
        nextSteps: calm(200),
        restoreInstructions: restoreFor(1800),
        sessionActivity: calm(220),
      },
      quality: {
        missingInputs: [
          "The thread held no material for the remaining sections.",
        ],
      },
    }),
  );

  // The adequate band's upper edge: exactly five unexplained gaps, and
  // nothing worse. Twelve sections carry content, five are missing with a
  // null note and an empty quality record.
  corpus.push(
    doc("edge-adequate-5-cautions", {
      projectId: "edge-adequate",
      title: "Five unexplained gaps and nothing worse",
      sections: {
        projectIdentity: calm(320),
        decisions:
          "We locked the storage layout because rebuilding an index must" +
          " never lose a document.",
        workflow: calm(260),
        architecture: pad(
          "The store is rooted at one directory, version 1. ",
          220,
        ),
        constraints: pad(
          "One writer at a time, enforced by a lock, 1 root. ",
          200,
        ),
        rejectedPaths: calm(200),
        executiveSummary: calm(300),
        currentTask: pad("At capture, the index work was mid-flight. ", 200),
        latestUserIntent: calm(180),
        sessionDelta: calm(190),
        nextSteps: calm(180),
        restoreInstructions: restoreFor(2450),
      },
    }),
  );

  // One more unexplained gap and the same document crosses into thin.
  corpus.push(
    doc("edge-thin-6-cautions", {
      projectId: "edge-thin-cautions",
      title: "Six unexplained gaps tip the band",
      sections: {
        projectIdentity: calm(320),
        decisions:
          "We locked the storage layout because rebuilding an index must" +
          " never lose a document.",
        workflow: calm(260),
        architecture: pad(
          "The store is rooted at one directory, version 1. ",
          220,
        ),
        constraints: pad(
          "One writer at a time, enforced by a lock, 1 root. ",
          200,
        ),
        rejectedPaths: calm(200),
        executiveSummary: calm(300),
        currentTask: pad("At capture, the index work was mid-flight. ", 200),
        latestUserIntent: calm(180),
        sessionDelta: calm(190),
        restoreInstructions: restoreFor(2270),
      },
    }),
  );

  // The thin band's lower edge: exactly one problem, no cautions.
  corpus.push(
    doc("edge-thin-1-problem", {
      projectId: "edge-thin-problem",
      title: "A rich capture with a boot prompt far too small",
      sections: {
        projectIdentity: calm(320),
        decisions:
          "We locked the layout because a rebuilt index must never lose" +
          " a document.",
        workflow: calm(260),
        executiveSummary: calm(300),
        currentTask: pad("At capture, the work was mid-flight. ", 200),
        nextSteps: calm(180),
        sessionActivity: calm(200),
        restoreInstructions: pad("Continue the work as agreed. ", 250),
      },
      quality: {
        missingInputs: [
          "The thread held no material for the remaining sections.",
        ],
      },
    }),
  );

  // Two problems: the same thin restore prompt, now also pointing away.
  corpus.push(
    doc("edge-thin-2-problems", {
      projectId: "edge-two-problems",
      title: "A boot prompt that is small and points elsewhere",
      sections: {
        projectIdentity: calm(320),
        decisions:
          "We locked the layout because a rebuilt index must never lose" +
          " a document.",
        workflow: calm(260),
        executiveSummary: calm(300),
        currentTask: pad("At capture, the work was mid-flight. ", 200),
        nextSteps: calm(180),
        sessionActivity: calm(200),
        restoreInstructions: pad("For the boot steps, see the docs. ", 250),
      },
      quality: {
        missingInputs: [
          "The thread held no material for the remaining sections.",
        ],
      },
    }),
  );

  // The failing edge: exactly three problems, zero cautions.
  corpus.push(
    doc("edge-failing-3-problems", {
      projectId: "edge-failing",
      title: "Nothing durable, and the boot prompt points away",
      sections: {
        executiveSummary: calm(400),
        currentTask: pad("At capture, the moment was all there was. ", 300),
        sessionDelta: calm(300),
        nextSteps: calm(200),
        sessionActivity: calm(220),
        restoreInstructions: pad(
          "Begin by reading the setup, see the docs. ",
          60,
        ),
      },
      quality: {
        missingInputs: [
          "The durable tier had no material in this thread at all.",
        ],
      },
    }),
  );

  // Content outside the Basic Multilingual Plane, combining sequences, a
  // no-break space and a byte order mark inside summaries: every number the
  // report quotes here moves if a port counts code points or bytes instead
  // of UTF-16 units, and the previews slice astral content.
  {
    const emoji =
      "\u{1f331}\u{1f30d}\u{1f680}\u{1f525}" +
      "\u{1f4e6}\u{1f9ed}\u{1fab4}\u{1f33e}"; // 8 astral characters
    const astral = emoji.repeat(40); // 640 UTF-16 units
    const decisions =
      "1. We chose \u{1f331} plain files \u{1f30d} because they last" +
      " across every boundary the project has met and the reasons" +
      " travel.\n\n" +
      "2. We picked \u{1f9ed} the compass path " +
      emoji.repeat(6) +
      " och den v\u00e4gen h\u00e5ller \u00e4nnu.\n\n" +
      "3. Beslutet om sko\u0308rden \u2615 st\u00e5r kvar utan endring.";
    corpus.push(
      doc("unicode-attack", {
        projectId: "unicode-attack",
        title:
          "Inneh\u00e5ll utanf\u00f6r grundplanet \u{1f30d} med" +
          " smala mellanslag",
        sections: {
          projectIdentity:
            astral +
            " Ett projekt som odlar jord \u{1f331} och h\u00e5ller" +
            " varje beslut vid liv med kombinerande tecken:" +
            " e\u0301 a\u030a o\u0308 och ett\u00a0no-break" +
            " mellanslag mitt i raden.",
          decisions,
          workflow:
            "caf\u00e9 see the repo f\u00f6r hela fl\u00f6det " +
            astral.slice(0, 320),
          executiveSummary: {
            status: "available",
            summary: "\u00a0\ufeffEtt kort l\u00e4ge.\u00a0",
          },
          currentTask:
            "\u{1f41b} fixing this week: the parser boundary " +
            emoji.repeat(20),
          sessionDelta: astral.slice(0, 400) + " vid sparandet.",
          blockers: emoji.repeat(2) + "!",
          nextSteps: astral.slice(0, 300) + " n\u00e4sta steg finns.",
          sessionActivity: astral.slice(0, 260) + " sessionen loggades.",
          restoreInstructions: emoji.repeat(9) + " forts\u00e4tt.",
          provenanceMap: astral.slice(0, 240) + " kartan \u00e4r hel.",
        },
        quality: {
          missingInputs: [
            "Tr\u00e5den h\u00f6ll inget material f\u00f6r de" +
              " \u00e5terst\u00e5ende sektionerna.",
          ],
        },
      }),
    );
  }

  // The restore floor, missed by one unit: 8000 units of other content put
  // the floor at 400, and the prompt carries 399.
  corpus.push(
    doc("restore-floor-under", {
      projectId: "restore-floor-under",
      title: "One unit under the documented restore floor",
      sections: {
        projectIdentity: pad("The lasting truth, written in full. ", 4000),
        decisions: pad(
          "We locked the floor rule because a rich capture with a" +
            " two-line boot prompt loses itself at load. ",
          2000,
        ),
        workflow: pad("The steps, in order, with nothing implied. ", 2000),
        restoreInstructions: pad("Continue the rework where it stopped. ", 399),
      },
      quality: {
        missingInputs: [
          "The thread held no material for the remaining sections.",
        ],
      },
    }),
  );

  // The same document sitting exactly on the floor: 400 units passes.
  corpus.push(
    doc("restore-floor-exact", {
      projectId: "restore-floor-exact",
      title: "Exactly on the documented restore floor",
      sections: {
        projectIdentity: pad("The lasting truth, written in full. ", 4000),
        decisions: pad(
          "We locked the floor rule because a rich capture with a" +
            " two-line boot prompt loses itself at load. ",
          2000,
        ),
        workflow: pad("The steps, in order, with nothing implied. ", 2000),
        restoreInstructions: pad("Continue the rework where it stopped. ", 400),
      },
      quality: {
        missingInputs: [
          "The thread held no material for the remaining sections.",
        ],
      },
    }),
  );

  // One unit under the point where the floor rule applies at all: 999 units
  // of other content, and a nine-unit prompt is left alone.
  corpus.push(
    doc("restore-floor-not-applied", {
      projectId: "restore-not-applied",
      title: "Too small a capture to demand a long boot prompt",
      sections: {
        projectIdentity: pad("A small tool with one lasting rule. ", 333),
        decisions: pad("We chose files because they outlive databases. ", 333),
        workflow: pad("One step at a time, reviewed. ", 333),
        restoreInstructions: "Continue.",
      },
      quality: {
        missingInputs: [
          "The thread held no material for the remaining sections.",
        ],
      },
    }),
  );

  // The one-liner rule at its median edge: five available sections whose
  // lower median is exactly 200, and a 39-unit section fires.
  corpus.push(
    doc("one-liner-median-edge", {
      projectId: "one-liner-edge",
      title: "A lower median exactly at the one-liner threshold",
      sections: {
        projectIdentity: pad("The lasting rule of the project. ", 200),
        decisions: pad("We chose files because they outlive databases. ", 250),
        workflow: pad("One step at a time, reviewed in order. ", 200),
        blockers: pad("None known at capture. ", 39),
        restoreInstructions: pad("Continue where the work stopped. ", 300),
      },
      quality: {
        missingInputs: [
          "The thread held no material for the remaining sections.",
        ],
      },
    }),
  );

  // The same document one unit under the median threshold: nothing fires.
  corpus.push(
    doc("one-liner-median-under", {
      projectId: "one-liner-under",
      title: "A lower median one unit under the threshold",
      sections: {
        projectIdentity: pad("The lasting rule of the project. ", 199),
        decisions: pad("We chose files because they outlive databases. ", 250),
        workflow: pad("One step at a time, reviewed in order. ", 199),
        blockers: pad("None known at capture. ", 39),
        restoreInstructions: pad("Continue where the work stopped. ", 300),
      },
      quality: {
        missingInputs: [
          "The thread held no material for the remaining sections.",
        ],
      },
    }),
  );

  return corpus;
}
