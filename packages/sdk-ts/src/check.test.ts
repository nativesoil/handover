/**
 * The open save-time baseline, tested rule by rule: every rule has a case
 * that trips it and a case that passes it, the grade mapping is pinned, the
 * worked example grades honestly, and the whole thing is deterministic.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CHECK_DEFAULT_NOTES,
  CHECK_GRADES,
  CHECK_NOTES_MAX_CHARS,
  CHECK_RULES,
  CHECK_SEVERITIES,
  checkHandover,
  checkObservation,
  gradeFromCounts,
  splitEntries,
  type CheckReport,
  type CheckRuleId,
} from "./check.js";
import { normalizeHandover } from "./normalize.js";
import { renderCheck } from "./render.js";
import { textLength, type SectionKey } from "./sections.js";
import type { Handover } from "./types.js";
import { validateHandover } from "./validate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const NOW = new Date("2026-07-22T10:00:00Z");
const ID = "019f7e89-fc00-7000-8000-000000000000";

function doc(input: Record<string, unknown>): Handover {
  return normalizeHandover({
    handoverId: ID,
    projectId: "check-test",
    title: "Check test",
    ...input,
  });
}

function readExample(): Handover {
  return JSON.parse(
    readFileSync(join(ROOT, "examples/orchard-checkout.json"), "utf8"),
  ) as Handover;
}

function findingsFor(
  report: CheckReport,
  rule: CheckRuleId,
  section?: SectionKey,
) {
  return report.findings.filter(
    (finding) =>
      finding.rule === rule &&
      (section === undefined || finding.section === section),
  );
}

/** Prose long enough to count as substantial without saying anything odd. */
function filler(seed: string): string {
  return `${seed} `.repeat(40).trim();
}

describe("checkHandover", () => {
  it("is deterministic: same input, same report, byte for byte", () => {
    const example = readExample();
    const first = checkHandover(example);
    const second = checkHandover(example);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("does not touch the document it checks", () => {
    const example = readExample();
    const before = JSON.stringify(example);
    checkHandover(example);
    expect(JSON.stringify(example)).toBe(before);
  });

  it("grades the worked example strong or adequate, with no problems", () => {
    const report = checkHandover(readExample());
    expect(["strong", "adequate"]).toContain(report.grade);
    expect(report.counts.problems).toBe(0);
  });

  it("grades the thin-but-honest fixture thin: valid is not the same as strong", () => {
    const thin = JSON.parse(
      readFileSync(
        join(ROOT, "conformance/fixtures/valid/thin-but-honest.json"),
        "utf8",
      ),
    ) as Handover;
    const report = checkHandover(thin);
    expect(report.grade).toBe("thin");
    // The gaps are stated in quality.missingInputs, so no per-section
    // missing-without-reason findings pile on top.
    expect(findingsFor(report, "completeness.missing-without-reason")).toEqual(
      [],
    );
  });

  it("every finding carries a rule id that is documented", () => {
    const report = checkHandover(doc({ sections: {} }));
    for (const finding of report.findings) {
      expect(Object.keys(CHECK_RULES)).toContain(finding.rule);
      expect(finding.message.length).toBeGreaterThan(0);
    }
  });
});

describe("completeness.missing-without-reason", () => {
  it("flags a missing section when no reason is stated anywhere", () => {
    const report = checkHandover(doc({ sections: { decisions: "One." } }));
    expect(
      findingsFor(report, "completeness.missing-without-reason", "workflow"),
    ).toHaveLength(1);
  });

  it("stays quiet when the section carries its own note", () => {
    const report = checkHandover(
      doc({
        sections: {
          decisions: "One.",
          workflow: {
            status: "missing",
            summary: "The thread held no workflow discussion.",
          },
        },
      }),
    );
    expect(
      findingsFor(report, "completeness.missing-without-reason", "workflow"),
    ).toEqual([]);
  });

  it("stays quiet when quality.missingInputs states the reason", () => {
    const report = checkHandover(
      doc({
        sections: { decisions: "One." },
        quality: { missingInputs: ["The thread began at the save request."] },
      }),
    );
    expect(findingsFor(report, "completeness.missing-without-reason")).toEqual(
      [],
    );
  });
});

describe("gaps.blocked-without-omission-note", () => {
  it("flags a blocked section when the safety record is empty", () => {
    const report = checkHandover(
      doc({
        sections: {
          decisions: "One.",
          architecture: { status: "blocked", summary: null },
        },
      }),
    );
    expect(
      findingsFor(report, "gaps.blocked-without-omission-note", "architecture"),
    ).toHaveLength(1);
  });

  it("stays quiet when safety.unsafeOmissions names what was withheld", () => {
    const report = checkHandover(
      doc({
        sections: {
          decisions: "One.",
          architecture: { status: "blocked", summary: null },
        },
        safety: {
          unsafeOmissions: [
            "Provider credentials exist in the deployment platform. Values withheld.",
          ],
        },
      }),
    );
    expect(findingsFor(report, "gaps.blocked-without-omission-note")).toEqual(
      [],
    );
  });
});

describe("completeness.no-durable-truth", () => {
  it("flags a document whose durable tier is entirely empty", () => {
    const report = checkHandover(
      doc({ sections: { executiveSummary: "Only the moment survived." } }),
    );
    expect(findingsFor(report, "completeness.no-durable-truth")).toHaveLength(
      1,
    );
    expect(
      findingsFor(report, "completeness.no-durable-truth")[0]?.severity,
    ).toBe("problem");
  });

  it("stays quiet once one durable section carries content", () => {
    const report = checkHandover(
      doc({
        sections: {
          executiveSummary: "The moment.",
          decisions: "We chose files because they outlive databases.",
        },
      }),
    );
    expect(findingsFor(report, "completeness.no-durable-truth")).toEqual([]);
  });
});

describe("self-containment.fetch-pointer", () => {
  it("flags a section that points at the repo instead of carrying content", () => {
    const report = checkHandover(
      doc({
        sections: { architecture: "For the full schema, see the repo." },
      }),
    );
    const found = findingsFor(
      report,
      "self-containment.fetch-pointer",
      "architecture",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("caution");
  });

  it("treats a pointer inside the restore instructions as a problem", () => {
    const report = checkHandover(
      doc({
        sections: {
          decisions: "One.",
          restoreInstructions: "Start by reading the setup, see the docs.",
        },
      }),
    );
    const found = findingsFor(
      report,
      "self-containment.fetch-pointer",
      "restoreInstructions",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("problem");
  });

  it("flags a URL presented as where the content lives", () => {
    const report = checkHandover(
      doc({
        sections: {
          workflow:
            "The release steps are documented at https://example.com/wiki.",
        },
      }),
    );
    expect(
      findingsFor(report, "self-containment.fetch-pointer", "workflow"),
    ).toHaveLength(1);
  });

  it("leaves a URL that is stated as a fact alone", () => {
    const report = checkHandover(
      doc({
        sections: {
          architecture:
            "The service runs at https://api.example.com behind a proxy.",
        },
      }),
    );
    expect(
      findingsFor(report, "self-containment.fetch-pointer", "architecture"),
    ).toEqual([]);
  });
});

describe("time.unanchored", () => {
  it("flags time words in a frontier section with no capture anchor", () => {
    const report = checkHandover(
      doc({ sections: { currentTask: "We are deploying the fix now." } }),
    );
    expect(findingsFor(report, "time.unanchored", "currentTask")).toHaveLength(
      1,
    );
  });

  it("stays quiet when the section anchors itself to the capture", () => {
    const report = checkHandover(
      doc({
        sections: {
          currentTask: "At capture, the fix was mid-deploy and unconfirmed.",
        },
      }),
    );
    expect(findingsFor(report, "time.unanchored", "currentTask")).toEqual([]);
  });

  it("does not police durable sections, which are meant to hold over time", () => {
    const report = checkHandover(
      doc({
        sections: { decisions: "We currently prefer files because they last." },
      }),
    );
    expect(findingsFor(report, "time.unanchored")).toEqual([]);
  });
});

describe("decisions.entry-without-reason", () => {
  it("flags a decision entry with no recorded reason", () => {
    const report = checkHandover(
      doc({
        sections: {
          decisions:
            "1. We chose Postgres.\n\n2. We chose Redis because reads dominate.",
        },
      }),
    );
    const found = findingsFor(report, "decisions.entry-without-reason");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("entry 1");
  });

  it("accepts a reason stated as an inability", () => {
    const report = checkHandover(
      doc({
        sections: {
          decisions:
            "Copy ships in its own commits. Locked by the founder, who cannot review a string buried in a logic diff.",
        },
      }),
    );
    expect(findingsFor(report, "decisions.entry-without-reason")).toEqual([]);
  });

  it("ignores text that does not state a decision", () => {
    const report = checkHandover(
      doc({
        sections: {
          decisions: "The team is still weighing both storage options.",
        },
      }),
    );
    expect(findingsFor(report, "decisions.entry-without-reason")).toEqual([]);
  });
});

describe("anchors.no-exact-values", () => {
  it("flags configuration talk that carries no exact values", () => {
    const report = checkHandover(
      doc({
        sections: {
          architecture:
            "The service reads its configuration from the environment and honours a request timeout.",
        },
      }),
    );
    const found = findingsFor(
      report,
      "anchors.no-exact-values",
      "architecture",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("advice");
  });

  it("stays quiet when the pins are present", () => {
    const report = checkHandover(
      doc({
        sections: {
          architecture:
            "The service reads its configuration from the environment: port 3000, timeout 30s, Node pinned at 20.",
        },
      }),
    );
    expect(findingsFor(report, "anchors.no-exact-values")).toEqual([]);
  });
});

describe("restore rules", () => {
  it("flags captured content with no restore instructions at all", () => {
    const report = checkHandover(
      doc({ sections: { decisions: "We chose files because they last." } }),
    );
    const found = findingsFor(report, "restore.absent");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("problem");
  });

  it("flags restore instructions far shorter than the captured content", () => {
    const report = checkHandover(
      doc({
        sections: {
          decisions: filler("We chose files because they last."),
          architecture: filler(
            "A worker pool feeds a queue that a scheduler drains.",
          ),
          restoreInstructions: "Continue the work as before.",
        },
      }),
    );
    expect(findingsFor(report, "restore.thin")).toHaveLength(1);
  });

  it("accepts restore instructions proportionate to the content", () => {
    const report = checkHandover(
      doc({
        sections: {
          decisions: filler("We chose files because they last."),
          restoreInstructions: filler(
            "You are continuing this project. Its rules and their reasons follow in full.",
          ),
        },
      }),
    );
    expect(findingsFor(report, "restore.thin")).toEqual([]);
    expect(findingsFor(report, "restore.absent")).toEqual([]);
  });

  it("does not demand a long boot prompt for a small capture", () => {
    const report = checkHandover(
      doc({
        sections: {
          decisions: "We chose files because they last.",
          restoreInstructions: "Continue: split the parser next.",
        },
      }),
    );
    expect(findingsFor(report, "restore.thin")).toEqual([]);
  });
});

describe("size.one-liner", () => {
  it("flags a one-line section inside an otherwise rich document", () => {
    const rich = filler("Substantial prose that carries real content.");
    const report = checkHandover(
      doc({
        sections: {
          projectIdentity: rich,
          decisions: rich,
          architecture: rich,
          workflow: rich,
          restoreInstructions: rich,
          blockers: "None known.",
        },
      }),
    );
    const found = findingsFor(report, "size.one-liner", "blockers");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("advice");
  });

  it("stays quiet in a document that is short throughout", () => {
    const report = checkHandover(
      doc({
        sections: {
          projectIdentity: "A small tool.",
          decisions: "Files, because they last.",
          workflow: "Trunk-based.",
          blockers: "None known.",
          nextSteps: "Split the parser.",
        },
      }),
    );
    expect(findingsFor(report, "size.one-liner")).toEqual([]);
  });
});

describe("grade mapping", () => {
  it("maps counts to bands exactly as documented", () => {
    expect(gradeFromCounts({ problems: 0, cautions: 0, advice: 0 })).toBe(
      "strong",
    );
    expect(gradeFromCounts({ problems: 0, cautions: 0, advice: 9 })).toBe(
      "strong",
    );
    expect(gradeFromCounts({ problems: 0, cautions: 1, advice: 0 })).toBe(
      "adequate",
    );
    expect(gradeFromCounts({ problems: 0, cautions: 5, advice: 0 })).toBe(
      "adequate",
    );
    expect(gradeFromCounts({ problems: 0, cautions: 6, advice: 0 })).toBe(
      "thin",
    );
    expect(gradeFromCounts({ problems: 1, cautions: 0, advice: 0 })).toBe(
      "thin",
    );
    expect(gradeFromCounts({ problems: 2, cautions: 9, advice: 0 })).toBe(
      "thin",
    );
    expect(gradeFromCounts({ problems: 3, cautions: 0, advice: 0 })).toBe(
      "failing",
    );
  });
});

describe("splitEntries", () => {
  it("splits numbered items, bullets and paragraphs", () => {
    expect(
      splitEntries("Intro line:\n\n1. First.\n2. Second\ncontinued.\n- Third."),
    ).toEqual(["Intro line:", "1. First.", "2. Second continued.", "- Third."]);
  });
});

describe("checkObservation", () => {
  const options = {
    producedBy: "soil-cli/0.1.0",
    producedAt: "2026-07-22T10:00:00Z",
  };

  it("packages the report as a valid quality.capture observation", () => {
    const example = readExample();
    const report = checkHandover(example);
    const observation = checkObservation(example, report, options);
    expect(observation.kind).toBe("quality.capture");
    expect(observation.producedBy).toBe("soil-cli/0.1.0");
    expect(observation.producedAt).toBe("2026-07-22T10:00:00Z");
    expect(observation.data["sectionsWithContent"]).toBe(17);
    expect(observation.data["missingSections"]).toEqual([]);
    expect(observation.data["blockedSections"]).toEqual([]);

    const attached = {
      ...example,
      observations: [...(example.observations ?? []), observation],
    };
    expect(validateHandover(attached).valid).toBe(true);
  });

  it("writes exactly the documented closed field set, and nothing else", () => {
    const example = readExample();
    const observation = checkObservation(
      example,
      checkHandover(example),
      options,
    );
    expect(Object.keys(observation.data).sort()).toEqual([
      "blockedSections",
      "checkVersion",
      "findings",
      "missingSections",
      "notes",
      "sectionsWithContent",
    ]);
  });

  it("carries no grade, no band and no aggregate anywhere in the payload", () => {
    const example = readExample();
    const observation = checkObservation(
      example,
      checkHandover(example),
      options,
    );
    expect(observation.data["grade"]).toBeUndefined();
    expect(observation.data["score"]).toBeUndefined();
    expect(observation.data["counts"]).toBeUndefined();
    const serialized = JSON.stringify(observation);
    for (const band of CHECK_GRADES) {
      expect(serialized).not.toContain(`"${band}"`);
    }
  });

  it("gives every finding a rule, a location, an observation and a severity", () => {
    const thin = doc({ sections: { executiveSummary: "One line." } });
    const observation = checkObservation(thin, checkHandover(thin), options);
    const findings = observation.data["findings"] as readonly Record<
      string,
      unknown
    >[];
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(Object.keys(finding).sort()).toEqual([
        "location",
        "observed",
        "rule",
        "severity",
      ]);
      expect(CHECK_SEVERITIES).toContain(finding["severity"]);
      expect(String(finding["location"]).startsWith("/")).toBe(true);
    }
  });

  it("bounds notes and refuses a longer one rather than truncating it", () => {
    const example = readExample();
    const report = checkHandover(example);
    expect(textLength(CHECK_DEFAULT_NOTES)).toBeLessThanOrEqual(
      CHECK_NOTES_MAX_CHARS,
    );
    expect(
      checkObservation(example, report, { ...options, notes: "Ran offline." })
        .data["notes"],
    ).toBe("Ran offline.");
    expect(() =>
      checkObservation(example, report, {
        ...options,
        notes: "x".repeat(CHECK_NOTES_MAX_CHARS + 1),
      }),
    ).toThrow(/at most 280 code points/);
    // The bound is code points, so a note of astral characters is refused at
    // the same count and not at half of it. Before the unit was decided this
    // one passed at 140 characters and failed at 141.
    expect(
      () =>
        checkObservation(example, report, {
          ...options,
          notes: String.fromCodePoint(0x1f600).repeat(CHECK_NOTES_MAX_CHARS),
        }).data["notes"],
    ).not.toThrow();
    expect(() =>
      checkObservation(example, report, {
        ...options,
        notes: String.fromCodePoint(0x1f600).repeat(CHECK_NOTES_MAX_CHARS + 1),
      }),
    ).toThrow(/at most 280 code points/);
  });
});

describe("renderCheck", () => {
  it("prints the grade, the findings with rule ids, and the boundary", () => {
    const example = readExample();
    const report = checkHandover(example);
    const card = renderCheck(example, report);
    expect(card).toContain("handover checked");
    expect(card).toContain(report.grade);
    for (const finding of report.findings) {
      expect(card).toContain(finding.rule);
    }
    expect(card).toContain("only a real load");
  });

  it("says so when every rule passes", () => {
    const clean = doc({
      sections: {
        decisions: "We chose files because they last.",
        restoreInstructions: "Continue: split the parser next.",
      },
      quality: {
        missingInputs: ["A short thread; most sections had no material."],
      },
    });
    const report = checkHandover(clean);
    expect(report.grade).toBe("strong");
    expect(renderCheck(clean, report)).toContain("every rule passed");
  });

  it("is deterministic", () => {
    const example = readExample();
    const report = checkHandover(example);
    expect(renderCheck(example, report)).toBe(renderCheck(example, report));
  });
});
