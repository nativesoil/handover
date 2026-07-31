#!/usr/bin/env node
/**
 * Generates docs/compatibility.md, compatibility/readme-snippet.md and the
 * marked block inside README.md, from compatibility/environments.yaml and
 * compatibility/integrations.yaml.
 *
 * One dataset, and the outputs named at the top of this comment. The README
 * used to hold a hand-pasted copy of the snippet, so the rows proven only
 * through a hosted connector read exactly like rows anybody can reproduce
 * locally. The generator now writes the README block itself, between
 * `<!-- BEGIN GENERATED: compatibility -->` and its END marker, and the drift
 * guard compares every one of the outputs. A hand edit is caught, not pasted
 * forward.
 *
 * The data is two lists, and the split is the structure of both outputs.
 * `client_surfaces` holds third-party clients, one row per client surface and
 * claim, because a product's desktop app and its web page have different
 * integration properties and one row for both hides the difference: a
 * sentence derived from a client-level field once said that clients with
 * perfectly good desktop apps do not run on your computer at all.
 * `runs_in` therefore describes a surface, never a client, and a row that
 * pairs `elsewhere` with a local integration path is refused here rather
 * than becoming that sentence again. `product_surfaces` holds what this
 * repository ships, and it alone reaches the README table: the client rows
 * are either another company's service or another company's documentation,
 * and a reader who installs this repository gets neither.
 *
 * The README carries three columns. That is a ceiling, not a coincidence:
 * a wide matrix is unreadable on a phone, and the full detail has a page of
 * its own. What the README keeps is what a reader decides with: the surface,
 * what works, and whether they can check it themselves or are taking our
 * word for it. The audit labels stay on the generated page, where the column
 * that carries them is defined.
 *
 * Deterministic: the same input bytes always produce the same output bytes.
 * The date stamped at the bottom of the generated page is the maximum
 * evidence date found in the source data, never a wall-clock call.
 *
 * No dependencies. The source files are written in a deliberate YAML subset:
 * top-level keys holding lists, list items of `key: value` pairs, flow
 * arrays (inline or wrapped to the next line), and nested lists of strings.
 * The parser throws on anything outside the subset, so a hand edit that
 * strays is caught by the drift guard instead of being silently misread.
 *
 * The emitted markdown matches what prettier produces for the same content
 * (padded table cells, dash rows the width of the column), so the generated
 * files pass `prettier --check` byte for byte.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ */
/* YAML subset parser                                                  */
/* ------------------------------------------------------------------ */

function stripQuotes(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseScalarOrFlow(raw) {
  const value = raw.trim();
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) {
      throw new Error(`unterminated flow array: ${value}`);
    }
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((part) => stripQuotes(part.trim()));
  }
  return stripQuotes(value);
}

function parseYamlSubset(text, file) {
  const doc = {};
  let list = null; // the list under the current top-level key
  let item = null; // the current list item
  let nestedKey = null; // a nested key awaiting list entries or a flow array

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#|$)/.test(line)) continue;
    const fail = (message) => {
      throw new Error(`${file}:${i + 1}: ${message}`);
    };

    let m;
    if ((m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*$/))) {
      list = [];
      doc[m[1]] = list;
      item = null;
      nestedKey = null;
    } else if ((m = line.match(/^ {2}- ([A-Za-z_][A-Za-z0-9_]*): (.*)$/))) {
      if (!list) fail("list item before any top-level key");
      item = { [m[1]]: parseScalarOrFlow(m[2]) };
      list.push(item);
      nestedKey = null;
    } else if ((m = line.match(/^ {4}([A-Za-z_][A-Za-z0-9_]*):\s*$/))) {
      if (!item) fail("nested key outside a list item");
      nestedKey = m[1];
      item[nestedKey] = [];
    } else if ((m = line.match(/^ {4}([A-Za-z_][A-Za-z0-9_]*): (.*)$/))) {
      if (!item) fail("field outside a list item");
      item[m[1]] = parseScalarOrFlow(m[2]);
      nestedKey = null;
    } else if (nestedKey !== null && (m = line.match(/^ {6}(\[.*\])\s*$/))) {
      // A flow array prettier wrapped onto its own line.
      item[nestedKey] = parseScalarOrFlow(m[1]);
      nestedKey = null;
    } else if (nestedKey !== null && (m = line.match(/^ {6}- (.*)$/))) {
      item[nestedKey].push(stripQuotes(m[1].trim()));
    } else {
      fail(`line outside the supported YAML subset: ${line.trim()}`);
    }
  }
  return doc;
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                   */
/* ------------------------------------------------------------------ */

/** A markdown table formatted the way prettier formats tables. */
function table(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(
      3,
      header.length,
      ...rows.map((row) => (row[column] ?? "").length),
    ),
  );
  const render = (cells) =>
    "| " +
    cells
      .map((cell, column) => (cell ?? "").padEnd(widths[column]))
      .join(" | ") +
    " |";
  return [
    render(headers),
    "| " + widths.map((width) => "-".repeat(width)).join(" | ") + " |",
    ...rows.map(render),
  ].join("\n");
}

/** Repo-root-relative links, rebased for a file that lives in docs/. */
function rebaseLinksForDocs(text) {
  return text.replace(/\]\((?!https?:|#|\.\.\/)/g, "](../");
}

/** The capability cell: the features this row claims, or "none run". */
function capability(entry) {
  const listed = entry.capability ?? [];
  return listed.length > 0 ? listed.join(", ") : "none";
}

/** "a", "a and b", "a, b and c". */
function inWordsList(items) {
  if (items.length === 0) throw new Error("nothing to list");
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The reader-facing answer to the only question an evidence label is for.
 * The label itself is audit vocabulary and stays in the evidence table on
 * the generated page; this is what it means for the person reading.
 */
const CHECKABLE = {
  "reproducible-in-repo": "yes, an artefact here does it",
  "open-integration-observed": "a report of one real run is here",
  "hosted-integration-observed":
    "the report is here, the run is not repeatable",
  "maintainer-attested": "no, our word only",
  "source-reviewed": "no, a reading, never a run",
  planned: "nothing to check yet",
};

function checkable(entry) {
  const answer = CHECKABLE[entry.evidence];
  if (answer === undefined) {
    throw new Error(
      `${rowName(entry)} carries evidence "${entry.evidence}", which has no ` +
        `reader-facing answer; add one deliberately rather than leaving the ` +
        `column to guess`,
    );
  }
  return answer;
}

/**
 * `reproducible_in_repo` and `evidence` are two fields describing one fact,
 * and the generated column is derived from the second of them. They are held
 * to each other here so a row cannot say a reader can reproduce it in one
 * field and something else in the other.
 */
function checkFieldsAgree(entries) {
  for (const entry of entries) {
    const claimsRepo = entry.reproducible_in_repo === "yes";
    const labelledRepo = entry.evidence === "reproducible-in-repo";
    if (claimsRepo !== labelledRepo) {
      throw new Error(
        `${rowName(entry)} has reproducible_in_repo "${entry.reproducible_in_repo}" ` +
          `and evidence "${entry.evidence}"; a row that a reader can ` +
          `reproduce here carries both, and one that cannot carries neither`,
      );
    }
  }
}

/**
 * How a product surface is reached, in words. The stored values are the keys
 * the data uses; a reader meets the wording, never the key.
 */
const CONNECTION = {
  "local-cli": "the command-line tool",
  "local-mcp": "the local server, over stdio",
  "self-hosted-http": "the self-hostable server, over HTTP",
  local: "as a library, in your own code",
};

function connection(entry) {
  const words = CONNECTION[entry.integration];
  if (words === undefined) {
    throw new Error(
      `${rowName(entry)} carries integration "${entry.integration}", which ` +
        `has no wording; add one deliberately rather than printing the key`,
    );
  }
  return words;
}

/**
 * The integration paths a client surface can use, in words, from a closed
 * set. An unknown path throws rather than printing the key.
 */
const PATH_WORDS = {
  "local-stdio-mcp": "a local MCP server, started by the client",
  "remote-http-mcp": "an MCP server you run yourself, over HTTP",
  "hosted-cloud": "the hosted Native Soil connector",
  "manual-paste": "copy and paste",
};

/** Short path names, for telling two rows of one surface apart. */
const PATH_SHORT = {
  "local-stdio-mcp": "local MCP",
  "remote-http-mcp": "HTTP MCP",
  "hosted-cloud": "hosted",
  "manual-paste": "paste",
};

function paths(entry) {
  const listed = entry.paths ?? [];
  if (listed.length === 0) {
    throw new Error(`${rowName(entry)} lists no integration path`);
  }
  for (const path of listed) {
    if (PATH_WORDS[path] === undefined) {
      throw new Error(
        `${rowName(entry)} carries path "${path}", which is not in the ` +
          `closed set: ${Object.keys(PATH_WORDS).join(", ")}`,
      );
    }
  }
  return listed;
}

/**
 * Where a client surface runs. Two values, and an unrecognised one throws.
 * The field describes the surface, never the client as a whole: the same
 * product can be a page in a browser on one row and a desktop process on
 * another. A page in a browser cannot start a process on the reader's
 * machine, so a row that pairs `elsewhere` with the local path is refused
 * here, before it can become a generated sentence about the wrong surface.
 */
function runsIn(entry) {
  const value = entry.runs_in ?? "";
  if (value !== "elsewhere" && value !== "your machine") {
    throw new Error(
      `${rowName(entry)} needs runs_in: "elsewhere" or "your machine", and ` +
        `has "${value}"`,
    );
  }
  if (value === "elsewhere" && paths(entry).includes("local-stdio-mcp")) {
    throw new Error(
      `${rowName(entry)} runs elsewhere and claims a local stdio path; a ` +
        `surface that is a page in a browser or an app on a phone cannot ` +
        `start a local process, so one of the two fields is wrong`,
    );
  }
  return value;
}

/**
 * Whose statement a client row rests on. Two values. A vendor's
 * documentation supports what a surface can attach, and it never supports a
 * run, so a vendor-documented row is refused here unless it is `unproven`
 * and `source-reviewed` with the page it rests on cited as a URL. No
 * handover pair is ever claimed on a vendor's word.
 */
function capabilitySource(entry) {
  const value = entry.capability_source ?? "";
  if (value === "this-repository") return value;
  if (value !== "vendor-documentation") {
    throw new Error(
      `${rowName(entry)} needs capability_source: "vendor-documentation" or ` +
        `"this-repository", and has "${value}"`,
    );
  }
  if (!/^https:\/\//.test(entry.vendor_doc ?? "")) {
    throw new Error(
      `${rowName(entry)} rests on vendor documentation and must cite it: ` +
        `vendor_doc with an https URL`,
    );
  }
  if (entry.maturity !== "unproven" || entry.evidence !== "source-reviewed") {
    throw new Error(
      `${rowName(entry)} rests on vendor documentation, which supports a ` +
        `surface and never a run; the row must stay maturity "unproven" ` +
        `and evidence "source-reviewed"`,
    );
  }
  return value;
}

/** The claim-rests-on cell, from the source and the evidence together. */
function claimRestsOn(entry) {
  if (capabilitySource(entry) === "vendor-documentation") {
    return `[the vendor's documentation](${entry.vendor_doc})`;
  }
  switch (entry.evidence) {
    case "maintainer-attested":
      return "our internal log";
    case "open-integration-observed":
    case "hosted-integration-observed":
      return "a session report committed here";
    case "reproducible-in-repo":
      return "an artefact in this repository";
    case "source-reviewed":
      return "a reading of the code here";
    case "planned":
      return "nothing yet";
    default:
      throw new Error(
        `${rowName(entry)} carries evidence "${entry.evidence}", which has ` +
          `no claim-rests-on wording`,
      );
  }
}

/**
 * What works, for the columns that fold maturity and capability into one
 * cell: `works` means everything listed was exercised end to end, and the
 * other three values say so in the cell rather than relying on a legend the
 * reader has to find.
 */
function whatWorks(entry) {
  switch (entry.maturity) {
    case "works":
      return capability(entry);
    case "partial":
      return `${capability(entry)}, and only some of it`;
    case "unproven":
      return "nothing has been run";
    case "planned":
      return "nothing yet, intended";
    default:
      throw new Error(
        `${rowName(entry)} carries maturity "${entry.maturity}", which is ` +
          `not one of works, partial, unproven or planned`,
      );
  }
}

/**
 * The capability words, defined where a reader meets them. The tables say
 * `save, load, list, validate, check` and a reader should not have to leave
 * the table to learn what a word claims, so the legend is emitted beside the
 * tables, by this generator, in both places that carry them: a hand-kept copy
 * beside a generated table is how the two drift apart.
 *
 * One line per word, in the reader's terms. The map is closed the way the
 * other vocabularies here are: a product row carrying a word with no line
 * fails generation rather than standing unexplained in a published table.
 */
const CAPABILITY_LEGEND_LINES = {
  save: "**save** stores a handover. Every save is validated against the schema and scanned for credential-shaped values and private paths, and a document that fails either gate is not stored. The scan is pattern-based: a net, not a guarantee.",
  load: "**load** renders a stored handover back as the restore prompt a new session continues from.",
  list: "**list** shows what the store holds.",
  validate:
    "**validate** answers whether a file is a correct handover, with the exact path of each fault and an exit code a script can gate on.",
  check:
    "**check** grades content quality against the published rules: the document is checked and graded, and the grade never blocks a save.",
  "shared projects":
    "**shared projects** means one project store that several members save to and load from.",
};

/** A legend bullet, wrapped to the width the rest of these pages use. */
function legendBullet(text) {
  const [first, ...rest] = wrap(text, 76).split("\n");
  return ["- " + first, ...rest.map((line) => "  " + line)].join("\n");
}

function capabilityLegend(entries) {
  const used = new Set(entries.flatMap((entry) => entry.capability ?? []));
  for (const word of used) {
    if (CAPABILITY_LEGEND_LINES[word] === undefined) {
      throw new Error(
        `the capability word "${word}" has no legend line; add one ` +
          `deliberately rather than leaving a table word unexplained`,
      );
    }
  }
  const bullets = Object.keys(CAPABILITY_LEGEND_LINES)
    .filter((word) => used.has(word))
    .map((word) => legendBullet(CAPABILITY_LEGEND_LINES[word]));
  return ["What each capability word claims:", "", ...bullets].join("\n");
}

/** One name per row, unique enough to key the evidence table and bullets. */
function rowName(entry) {
  if (entry.client !== undefined) {
    const short = (entry.paths ?? [])
      .map((path) => PATH_SHORT[path] ?? path)
      .join(" + ");
    return short === ""
      ? `${entry.client} (${entry.surface})`
      : `${entry.client} (${entry.surface}; ${short})`;
  }
  return entry.surface ?? entry.integration ?? "an unnamed row";
}

/** An empty cell reads as "none stated", never as blank. */
function orNoneStated(value) {
  const text = (value ?? "").trim();
  return text === "" ? "none stated" : text;
}

/** An absent evidence date reads as "never", because that is what it means. */
function evidenceDate(entry) {
  const text = (entry.evidence_date ?? "").trim();
  return text === "" ? "never" : text;
}

/** One evidence-source-and-limitation bullet per entry. */
function evidenceBullets(entries) {
  const bullets = [];
  for (const entry of entries) {
    const sources = entry.evidence_source ?? [];
    const parts = sources.length > 0 ? [...sources] : ["No evidence source."];
    parts.push(`Limitation: ${orNoneStated(entry.limitation)}`);
    bullets.push(
      `- **${rowName(entry)}** (${entry.evidence}): ${parts.join(" ")}`,
    );
  }
  return bullets.join("\n");
}

function maxEvidenceDate(...entryLists) {
  let max = "";
  for (const entries of entryLists) {
    for (const entry of entries) {
      const date = entry.evidence_date ?? "";
      if (date > max) max = date;
    }
  }
  if (max === "") throw new Error("no evidence_date value in the source data");
  return max;
}

/* ------------------------------------------------------------------ */
/* Load the source data                                                */
/* ------------------------------------------------------------------ */

function load(relativePath) {
  return parseYamlSubset(
    readFileSync(join(ROOT, relativePath), "utf8"),
    relativePath,
  );
}

const {
  client_surfaces: clientSurfaces,
  product_surfaces: productSurfaces,
  operating_systems: operatingSystems,
} = load("compatibility/environments.yaml");
const { integrations } = load("compatibility/integrations.yaml");
const lastGenerated = maxEvidenceDate(
  clientSurfaces,
  productSurfaces,
  integrations,
);

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

checkFieldsAgree(clientSurfaces);
checkFieldsAgree(productSurfaces);

for (const entry of clientSurfaces) {
  paths(entry);
  runsIn(entry);
  capabilitySource(entry);
  const hosted = entry.paths.includes("hosted-cloud");
  if (hosted !== (entry.hosted_dependency === "yes")) {
    throw new Error(
      `${rowName(entry)}: hosted_dependency must be "yes" exactly when the ` +
        `row's path is the hosted connector`,
    );
  }
}

for (const entry of productSurfaces) {
  connection(entry);
  if ((entry.for_whom ?? "").trim() === "") {
    throw new Error(
      `${rowName(entry)} needs for_whom: a surface a reader cannot place ` +
        `themselves against is a surface they skip`,
    );
  }
  if (entry.hosted_dependency !== "no") {
    throw new Error(
      `${rowName(entry)} is a product surface and must carry ` +
        `hosted_dependency "no"; the hosted service has no rows here`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Derived groups                                                      */
/* ------------------------------------------------------------------ */

const hostedRows = clientSurfaces.filter(
  (entry) => entry.hosted_dependency === "yes",
);
const hostedClientNames = [...new Set(hostedRows.map((entry) => entry.client))];
const clientSurfacePair = (entry) => `${entry.client} (${entry.surface})`;
const elsewherePairs = clientSurfaces
  .filter((entry) => runsIn(entry) === "elsewhere")
  .map(clientSurfacePair);
const vendorRows = clientSurfaces.filter(
  (entry) => entry.capability_source === "vendor-documentation",
);
const localRunRows = clientSurfaces.filter(
  (entry) =>
    entry.capability_source === "this-repository" &&
    !entry.paths.includes("hosted-cloud") &&
    (entry.evidence === "reproducible-in-repo" ||
      entry.evidence === "open-integration-observed"),
);

/* ------------------------------------------------------------------ */
/* Numbers written in this page's voice                                */
/* ------------------------------------------------------------------ */

/**
 * A small number written the way this page writes numbers.
 *
 * The prose below states how many rows carry a label, and that figure used to
 * be typed into this template by hand. A hardcoded figure inside a generator
 * is the worst version of an unbound count: the compatibility job reruns this
 * script and fails when the committed outputs drift from it, so the number
 * inherits all the credibility of being generated while nothing ever compares
 * it to the data it describes. It was correct when written and would have gone
 * stale on the next row anybody added.
 *
 * It throws rather than falling back to digits, because a generator emitting a
 * different voice than the one it was written in is a silent change to a
 * published page, and these tables will not plausibly reach a hundred rows.
 */
const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

function inWords(n, capitalise = false) {
  if (!Number.isInteger(n) || n < 0 || n > 99) {
    throw new Error(
      `inWords covers 0 to 99 and was handed ${n}; widen it deliberately rather than letting the page change voice`,
    );
  }
  const word =
    n < 20
      ? ONES[n]
      : `${TENS[Math.floor(n / 10)]}${n % 10 === 0 ? "" : `-${ONES[n % 10]}`}`;
  return capitalise ? word[0].toUpperCase() + word.slice(1) : word;
}

/**
 * Reflow a paragraph to the width the rest of these pages are written at.
 *
 * Prettier preserves prose wrapping, so a paragraph carrying an interpolated
 * value has to wrap itself: the words are a different length once the data
 * changes, and hand-wrapping around a value that moves produces a ragged page.
 */
function wrap(paragraph, width = 78) {
  const lines = [];
  let line = "";
  for (const word of paragraph.split(/\s+/).filter(Boolean)) {
    if (line === "") line = word;
    else if (`${line} ${word}`.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Shared prose blocks                                                 */
/* ------------------------------------------------------------------ */

const attestedRows = clientSurfaces.filter(
  (entry) => entry.evidence === "maintainer-attested",
).length;

/**
 * Whether any row has been through a hosted integration with a committed
 * report. The page used to assert flatly that none had, which is another claim
 * about the data that nothing checked.
 */
const hostedObserved = clientSurfaces.filter(
  (entry) => entry.evidence === "hosted-integration-observed",
).length;
const hostedObservedSentence =
  hostedObserved === 0
    ? "No row currently qualifies for hosted-integration-observed, because no hosted run has a report committed here."
    : `${inWords(hostedObserved, true)} of them qualify for hosted-integration-observed, on the strength of a hosted run with a report committed here.`;

const VOCABULARY = `### What the columns mean

**Maturity** is the primary axis, because a reader wants to know which
features exist and which of them work:

- **works**: every capability listed has been exercised end to end.
- **partial**: some of the listed capability works, the rest is not exercised.
- **unproven**: nothing exercised. The claim rests on a surface, not on a run.
- **planned**: nothing exercised and nothing claimed. Intent only.

**Evidence** is a second axis and never collapses into the first. Saying
something works when only we have seen it is not the same claim as saying it
works and here is how you check:

- **reproducible-in-repo**: an artefact in this repository reproduces it. CI,
  the conformance suite, or a runnable example anybody can run.
- **open-integration-observed**: a real run against an openly available
  integration, recorded in a report committed here. Repeatable by hand, not
  automated.
- **hosted-integration-observed**: a real run that went through a hosted
  service, recorded in a report committed here.
- **maintainer-attested**: the maintainers ran it and logged it internally.
  There is no artefact a reader can inspect.
- **source-reviewed**: read from source, specification or the vendor's
  documentation, never executed.
- **planned**: nothing has been run. The row states an intention, and carries
  no evidence.

${wrap(
  `An internal log with no publicly reproducible artefact is a maintainer ` +
    `attestation, not a demonstration. ${inWords(attestedRows, true)} of the ` +
    `${inWords(clientSurfaces.length)} client rows carry that label: they ` +
    `were exercised through the hosted connector, and a reader outside the ` +
    `maintainers cannot check any of them. ${hostedObservedSentence}`,
)}

**Where a claim comes from** is a third axis, on the client rows. What a
client CAN do and what WE have shown are different statements, and each row
says whose statement it is: the vendor's own documentation, cited in the row,
or this repository's record. Vendor documentation supports what a surface can
attach. It never supports a run, so a row resting on it stays unproven with
its evidence read from documentation, and no handover is ever claimed to have
travelled anywhere on a vendor's word.

**Can you check it yourself** is the Evidence column said in the words it
means for a reader, and it is the column the README keeps. **Evidence** holds
the label itself, because the label is what a row is audited against.

The page is three tables because a reader arrives with one of three
questions. Client surfaces answer somebody picking a client, one row per
surface and claim, because a product's desktop app and its web page have
different integration properties and one row for both hides the difference.
This repository's own rows answer somebody deciding what to run, described by
who each is for. The evidence table carries how every row was proven, so
neither of the first two leads with audit vocabulary.`;

const hostedAttested = hostedRows.filter(
  (entry) => entry.evidence === "maintainer-attested",
).length;

const attestedClause =
  hostedAttested === hostedRows.length
    ? "Every hosted row rests on a maintainer log nobody outside this project can inspect."
    : `${inWords(hostedAttested, true)} of the hosted rows rest on a maintainer log nobody outside this project can inspect.`;

/**
 * The same fact as hostedObservedSentence, for a surface that does not define
 * the labels. One count, two readerships, and neither wording is typed in
 * beside the other.
 */
const noHostedReportSentence =
  hostedObserved === 0
    ? "No hosted run has a report committed here, so the hosted rows stop at our word."
    : `${inWords(hostedObserved, true)} of them go further, on the strength of a hosted run with its report committed here.`;

/**
 * What is genuinely absent from a local install, in plain words and derived
 * from the data: the hosted runs, and the surfaces that cannot have a local
 * path at all. Function that is absent, not evidence that is absent; the
 * block after this one carries the other case, and the two are never one
 * sentence.
 *
 * The subject of the opening sentence is a parameter, because the block is
 * printed on two kinds of page. The compatibility page carries the client
 * table the sentence counts, so it counts. The README does not, and a count
 * of rows a reader cannot see sends them hunting through the wrong page, so
 * there the sentence names where the rows live instead.
 */
const notInRepo = (rowsPhrase) =>
  [
    wrap(
      `${rowsPhrase} record runs through ` +
        `the hosted Native Soil connector: a separate service with accounts, ` +
        `whose code is not here and which nothing here calls. Installing this ` +
        `repository gives you none of those runs. The clients are ` +
        `${inWordsList(hostedClientNames)}.`,
    ),
    "",
    wrap(
      `${inWordsList(elsewherePairs)} are a page in a browser or an app on a ` +
        `phone. Nothing that runs elsewhere can start a process on your ` +
        `machine, so those surfaces have no local path: the hosted connector, ` +
        `or plain copy and paste through the recipe and the restore prompt, ` +
        `is how they reach the format.`,
    ),
    "",
    wrap(`${attestedClause} ${noHostedReportSentence}`),
  ].join("\n");

/**
 * The README summary asserts that every surface this repository ships is
 * backed by an artefact here that reproduces it. That is a claim about the
 * data exactly the way a number is: it is checked here so a weaker row cannot
 * be added while the front page keeps the strong sentence.
 */
for (const entry of productSurfaces) {
  if (entry.maturity !== "works" || entry.evidence !== "reproducible-in-repo") {
    throw new Error(
      `${rowName(entry)} carries maturity "${entry.maturity}" and evidence ` +
        `"${entry.evidence}"; the README summary says every product surface ` +
        `is reproduced by an artefact here, so reword that summary in this ` +
        `generator deliberately before adding a weaker row`,
    );
  }
}

/**
 * The other case: surfaces whose vendors document a local path this
 * repository has not run. Absence of a recorded run is a statement about the
 * evidence here, never about the client, and this block exists so the two
 * are never read from one cell.
 */
const NOT_YET_RUN = [
  wrap(
    `${inWordsList(vendorRows.map(clientSurfacePair))} run on your machine, ` +
      `and each vendor's own documentation covers attaching local MCP ` +
      `servers; every such row cites the page it rests on. That is the ` +
      `vendor's statement about the surface, read from documentation, never ` +
      `a run: no save or load of this format is recorded through those rows.`,
  ),
  "",
  wrap(
    `${inWordsList(localRunRows.map(clientSurfacePair))} ` +
      `${localRunRows.length === 1 ? "has" : "have"} gone further on the ` +
      `local path: a recorded session against the local server this ` +
      `repository ships, with the session report committed here.`,
  ),
].join("\n");

/* ------------------------------------------------------------------ */
/* docs/compatibility.md                                               */
/* ------------------------------------------------------------------ */

/**
 * Client surfaces, for a reader picking a client. Maturity leads, the claim
 * source is a column of its own, and the audit detail lives in the evidence
 * table further down.
 */
const clientTable = table(
  [
    "Client",
    "Surface",
    "Maturity",
    "Capability",
    "Reached through",
    "The claim rests on",
  ],
  clientSurfaces.map((entry) => [
    entry.client,
    entry.surface,
    entry.maturity,
    capability(entry),
    paths(entry)
      .map((path) => PATH_WORDS[path])
      .join("; "),
    claimRestsOn(entry),
  ]),
);

/** The product's own surfaces, described by who each is for. */
const productTable = table(
  ["Surface", "Who it is for", "What works", "Can you check it yourself"],
  productSurfaces.map((entry) => [
    entry.surface,
    entry.for_whom,
    whatWorks(entry),
    checkable(entry),
  ]),
);

/** Every row above, held to its proof. This table keeps the audit columns. */
const evidenceTable = table(
  [
    "Row",
    "Evidence",
    "Can you check it yourself",
    "Reproducible here",
    "How it connects",
    "Evidence date",
    "Limitation",
  ],
  [
    ...clientSurfaces.map((entry) => [
      rowName(entry),
      entry.evidence,
      checkable(entry),
      entry.reproducible_in_repo,
      paths(entry)
        .map((path) => PATH_WORDS[path])
        .join("; "),
      evidenceDate(entry),
      orNoneStated(entry.limitation),
    ]),
    ...productSurfaces.map((entry) => [
      rowName(entry),
      entry.evidence,
      checkable(entry),
      entry.reproducible_in_repo,
      connection(entry),
      evidenceDate(entry),
      orNoneStated(entry.limitation),
    ]),
  ],
);

const integrationsTable = table(
  [
    "Integration",
    "Maturity",
    "What",
    "Evidence",
    "Reproducible here",
    "Hosted service",
    "Evidence date",
    "Limitation",
  ],
  integrations.map((entry) => [
    entry.integration,
    entry.maturity,
    entry.what,
    entry.evidence,
    entry.reproducible_in_repo,
    entry.hosted_dependency,
    evidenceDate(entry),
    orNoneStated(entry.limitation),
  ]),
);

const operatingSystemsTable = table(
  ["Operating system", "Suites green in CI", "Last green"],
  operatingSystems.map((entry) => [
    entry.os,
    entry.suites.join(", "),
    entry.last_green,
  ]),
);

const docsPage = `# Compatibility

<!--
  Generated by scripts/generate-compatibility.mjs from
  compatibility/environments.yaml and compatibility/integrations.yaml.
  Do not edit this file by hand: edit the source data and rerun
  \`node scripts/generate-compatibility.mjs\`. The compatibility workflow
  fails when this file drifts from the source.
-->

What this format and its implementations can do, how mature each path is,
and how each claim was proven. The machine-readable source of truth lives in
[compatibility/environments.yaml](../compatibility/environments.yaml) and
[compatibility/integrations.yaml](../compatibility/integrations.yaml); this
page, the block in the README and
[compatibility/readme-snippet.md](../compatibility/readme-snippet.md) are all
generated from those two files, and CI fails when any of the three drifts.

${VOCABULARY}

## Client surfaces

One row per client surface and claim. A product's desktop app, its web page,
its CLI and its IDE form are different surfaces, and they get different rows
because what is true of one is routinely false of another.

${clientTable}

Model families exercised in the runs behind these rows: OpenAI, Anthropic
and xAI.

### What is not in this repository

${notInRepo(
  `${inWords(hostedRows.length, true)} of the ` +
    `${inWords(clientSurfaces.length)} client rows above`,
)}

### Documented by the vendor, not yet run here

${NOT_YET_RUN}

## This repository's own surfaces

${wrap(
  `${inWords(productSurfaces.length, true)} surfaces, every one of them ` +
    `shipped here and run on your own machine, from a checkout of this ` +
    `repository. No account, and nothing over the network.`,
)}

${productTable}

${capabilityLegend(productSurfaces)}

## The evidence, row by row

Every row above, with how it was proven, when, and what that proof does not
cover.

${evidenceTable}

### Evidence sources and limitations

${rebaseLinksForDocs(evidenceBullets([...clientSurfaces, ...productSurfaces]))}

## Integrations

${integrationsTable}

### Evidence sources and limitations

${rebaseLinksForDocs(evidenceBullets(integrations))}

## Operating systems

What continuous integration proves per operating system, from the CI matrix
on main. The portable core is pnpm build, the root vitest suite, the Python
tests, the Go tests, and the TypeScript, Python and Go conformance runners.

${operatingSystemsTable}

The JVM and .NET suites run on one operating system because their code is
pure managed runtime and they are the slowest suites in the repository.

Last generated from source data: ${lastGenerated}, the most recent evidence
date in the source files.
`;

/* ------------------------------------------------------------------ */
/* compatibility/readme-snippet.md, and the same block inside README.md */
/* ------------------------------------------------------------------ */

// The README carries a summary, never a copy of the tables: a compact copy
// of the full matrix is how rows proven only through a hosted connector came
// to look like rows anybody can reproduce locally, and later how the front
// page grew a second page's worth of evidence prose. Every figure and every
// name in the summary is derived from the same rows the full page is built
// from, so the sentence a reader decides with cannot drift from the data.
//
// One body, written out twice, and the link to the generated page is the one
// thing that differs between the two copies. A relative link resolves from
// the file it sits in, so `docs/compatibility.md` is right in README.md at
// the root and dead in compatibility/readme-snippet.md one directory down.
// The snippet is a file people open, not only a block people paste, so it
// gets the path that works from where it is.

/** "the local CLI", from "Local CLI": an article, and the case a phrase gets
 *  mid-sentence. */
const midSentence = (surface) =>
  `the ${surface[0].toLowerCase()}${surface.slice(1)}`;

const sdkSurfaces = productSurfaces.filter((entry) =>
  /\bSDK\b/.test(entry.surface),
);
const nonSdkSurfaces = productSurfaces.filter(
  (entry) => !/\bSDK\b/.test(entry.surface),
);
if (sdkSurfaces.length === 0 || nonSdkSurfaces.length === 0) {
  throw new Error(
    "the README summary phrases the product surfaces as tools plus SDKs, " +
      "and one of the two groups is empty; reword the summary deliberately",
  );
}
if (localRunRows.length === 0) {
  throw new Error(
    "the README summary names the clients with recorded local sessions, and " +
      "no row qualifies; reword the summary deliberately",
  );
}

// The client rows, partitioned by what their claim rests on. The partition
// must be exhaustive: a new evidence class reaches the summary by a
// deliberate sentence, never by falling out of the count.
const reportedRows = clientSurfaces.filter(
  (entry) =>
    entry.evidence === "open-integration-observed" ||
    entry.evidence === "hosted-integration-observed",
);
const attestedOnlyRows = clientSurfaces.filter(
  (entry) => entry.evidence === "maintainer-attested",
);
const readingRows = clientSurfaces.filter(
  (entry) =>
    entry.evidence === "source-reviewed" || entry.evidence === "planned",
);
if (
  reportedRows.length + attestedOnlyRows.length + readingRows.length !==
  clientSurfaces.length
) {
  throw new Error(
    "a client row carries an evidence label the README summary does not " +
      "count; add it to the partition deliberately",
  );
}

const bodyWithLink = (pageLink) => `## Status and compatibility

${wrap(
  `${inWords(productSurfaces.length, true)} surfaces ship in this ` +
    `repository and run on your own machine: ` +
    `${inWordsList(nonSdkSurfaces.map((entry) => midSentence(entry.surface)))}, and ` +
    `${inWords(sdkSurfaces.length)} SDKs held to one conformance contract. ` +
    `Every one of those rows is backed by an artefact in this repository ` +
    `that reproduces it, in continuous integration on ` +
    `${inWords(operatingSystems.length)} operating systems. ` +
    `${inWordsList(localRunRows.map(clientSurfacePair))} have recorded ` +
    `sessions against the local MCP server, with the session reports ` +
    `committed here.`,
)}

${wrap(
  `The third-party client surfaces are a separate list with separate ` +
    `evidence. Of the ${inWords(clientSurfaces.length)} client rows, ` +
    `${inWords(reportedRows.length)} are real runs with session reports ` +
    `committed here, ${inWords(attestedOnlyRows.length)} rest on the ` +
    `maintainers' internal log for runs through the hosted Native Soil ` +
    `connector, and ${inWords(readingRows.length)} rest on documentation ` +
    `or a reading of source, never a run. Installing this repository gives ` +
    `you none of the hosted rows.`,
)}

${wrap(
  `The complete compatibility and evidence matrix, every row with how it ` +
    `was proven and when, is in [docs/compatibility.md](${pageLink}).`,
)}`;

const readmeBody = bodyWithLink("docs/compatibility.md");

const readmeSnippet = `<!--
  Generated by scripts/generate-compatibility.mjs from
  compatibility/environments.yaml and compatibility/integrations.yaml.
  Do not edit by hand. This is the body of the generated block in README.md,
  with the one relative link rewritten for this file's own location; the
  generator writes both, and the compatibility workflow fails when either
  drifts from the source data.
-->

${bodyWithLink("../docs/compatibility.md")}
`;

/* ------------------------------------------------------------------ */
/* README.md, written in place between markers                         */
/* ------------------------------------------------------------------ */

const BEGIN = "<!-- BEGIN GENERATED: compatibility -->";
const END = "<!-- END GENERATED: compatibility -->";

function spliceReadme(readme) {
  const from = readme.indexOf(BEGIN);
  const to = readme.indexOf(END);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(
      `README.md is missing the generated-block markers ${BEGIN} / ${END}`,
    );
  }
  return (
    readme.slice(0, from) + `${BEGIN}\n\n${readmeBody}\n\n` + readme.slice(to)
  );
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

writeFileSync(join(ROOT, "docs/compatibility.md"), docsPage);
writeFileSync(join(ROOT, "compatibility/readme-snippet.md"), readmeSnippet);
const readmePath = join(ROOT, "README.md");
writeFileSync(readmePath, spliceReadme(readFileSync(readmePath, "utf8")));
console.log(
  `generated docs/compatibility.md, compatibility/readme-snippet.md and the ` +
    `README block (source data through ${lastGenerated})`,
);
