#!/usr/bin/env node
/**
 * The recipes are self-sufficient: everything a valid document requires is
 * stated in the text a model actually receives.
 *
 * WHY THIS EXISTS
 *
 * `soil save` with no argument prints the extraction recipe, and in the
 * intended flow that printed text is THE ONLY THING THE MODEL EVER SEES. The
 * user pastes it into a chat window that has no access to this repository, no
 * schema, no spec, and no examples. Whatever the recipe fails to say, the
 * model has to guess, and every wrong guess is a refused save at the exact
 * moment a thread is dying.
 *
 * Nothing used to test that. The install guide's smoke test feeds
 * `examples/orchard-checkout.json` — a document that already exists and
 * already validates — so it proves the CLI works and proves nothing at all
 * about whether the instruction that PRODUCES documents can be followed. A
 * cold walkthrough found the hole on its first attempt: the recipe named the
 * three GAP statuses and never named `available`, the one every populated
 * section needs, and it named four of the eleven provenance labels while
 * never saying that `provenance` is a list. A model obeying the text produced
 * a document the tool refused, twice over, for reasons the text never
 * covered.
 *
 * WHAT MAKES THIS DIFFERENT FROM A LIST KEPT BESIDE THE RECIPE
 *
 * Every requirement below is READ OUT OF `spec/handover.schema.json` at run
 * time, never written down here. A new required field, a fifth section
 * status, a twelfth provenance label or an eighteenth section fails this
 * check on the commit that adds it, instead of silently making the recipe
 * incomplete again the way the last one did.
 *
 * WHAT IT ESTABLISHES, AND WHAT IT DOES NOT
 *
 * It establishes PRESENCE: that every closed-set member, every required root
 * key and every section key the schema demands appears in the recipe text,
 * and that each list-valued field the recipe names is shown as a literal JSON
 * array rather than described. That is a necessary condition for a model to
 * be able to comply, and it is the condition that failed.
 *
 * It does NOT establish that the surrounding prose is CORRECT, that a model
 * will read the enumeration the way a person would, or that a document
 * produced from the recipe is any good. Presence is not comprehension, and a
 * text can name every allowed value and still mislead about which one to pick.
 * What answers that is a real model authoring a real document from the printed
 * text alone and the save being accepted on the first attempt. This script
 * cannot perform that run and does not claim to: it removes the failure mode
 * where compliance was not even POSSIBLE.
 *
 * Run it from the repository root:  node scripts/check-recipe-sufficiency.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "./lib/prose.mjs";

const schema = JSON.parse(
  readFileSync(join(ROOT, "spec/handover.schema.json"), "utf8"),
);

/* ------------------------------------------------------------------ */
/* The schema, walked                                                  */
/* ------------------------------------------------------------------ */

/** Resolve a local `$ref` one hop. The schema uses no remote refs. */
function deref(node) {
  let seen = 0;
  while (node && typeof node["$ref"] === "string") {
    if (seen++ > 20) throw new Error("the schema's $refs cycle");
    const path = node["$ref"].replace(/^#\//, "").split("/");
    let target = schema;
    for (const step of path) target = target?.[step];
    if (target === undefined) {
      throw new Error(`the schema has a dangling $ref: ${node["$ref"]}`);
    }
    node = target;
  }
  return node;
}

/**
 * Every named property in the schema, resolved, keyed by the property NAME.
 *
 * The name is what a recipe can say, so the name is what this indexes. Two
 * properties sharing a name would have to share a shape for the index to be
 * honest; the schema has no such pair, and this throws if one appears.
 */
function propertyIndex() {
  const index = new Map();
  const visit = (node, seen) => {
    node = deref(node);
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    for (const [name, raw] of Object.entries(node.properties ?? {})) {
      const resolved = deref(raw);
      const existing = index.get(name);
      if (existing !== undefined && existing !== resolved) {
        throw new Error(
          `the schema now has two different properties named "${name}"; ` +
            "this check indexes by name and can no longer tell them apart",
        );
      }
      index.set(name, resolved);
      visit(resolved, seen);
      if (resolved?.items) visit(resolved.items, seen);
    }
    for (const branch of node.allOf ?? []) visit(branch, seen);
    if (node.items) visit(node.items, seen);
  };
  visit(schema, new Set());
  for (const def of Object.values(schema["$defs"] ?? {})) {
    visit(def, new Set());
  }
  return index;
}

const PROPERTIES = propertyIndex();

/**
 * The closed sets a model has to write from, taken from the schema's enums.
 *
 * A field's members live either on the field (`status`) or on its items
 * (`provenance`), and both forms are collected, so a set that moves from one
 * shape to the other is still counted.
 */
function closedSets() {
  const sets = [];
  for (const [name, node] of PROPERTIES) {
    const members = node?.enum ?? deref(node?.items ?? {})?.enum;
    if (Array.isArray(members) && members.length > 0) {
      sets.push({ field: name, members });
    }
  }
  if (sets.length === 0) {
    throw new Error("the schema declares no enums; this check parsed nothing");
  }
  return sets;
}

/** The fields a model writes as a JSON array. */
function listFields() {
  return [...PROPERTIES]
    .filter(([, node]) => node?.type === "array")
    .map(([name]) => name);
}

const SECTION_KEYS = deref(schema.properties.sections).required;
const ROOT_REQUIRED = schema.required;
const CLOSED_SETS = closedSets();
const LIST_FIELDS = listFields();

/**
 * Members that identify their set on sight, because no other closed set uses
 * the same word.
 *
 * A recipe reaches for a closed set either by naming the field or by using one
 * of its values, and the second form is worth catching: a text that says
 * `{"status":"missing"}` without the word `status` has still put the model in
 * front of the whole set. But `blocked` is BOTH a section status and a
 * provenance label, so a rescue prompt naming the four statuses would look
 * like a prompt reaching for the eleven labels, and would be told to
 * enumerate a set it never asks for. A shared word identifies nothing, so it
 * triggers nothing; the field name still does.
 */
const SHARED_MEMBERS = new Set(
  CLOSED_SETS.flatMap(({ members }) => members).filter(
    (member, _i, all) => all.indexOf(member) !== all.lastIndexOf(member),
  ),
);

if (!Array.isArray(SECTION_KEYS) || SECTION_KEYS.length === 0) {
  throw new Error("the schema no longer lists its required section keys");
}

/**
 * The required root keys a model is NOT asked to write, each with the schema
 * language that says so.
 *
 * These are exemptions, so they are held to the schema rather than trusted: if
 * the schema stops describing one of them this way, the exemption is no longer
 * earned and the check fails instead of quietly excusing a field the model now
 * has to supply. A required field that is not in this table is not exempt,
 * which is what makes a newly required field fail rather than pass.
 */
const WRITER_ASSIGNED = new Map([
  ["handoverId", /assigned by the writer/i],
  ["code", /written by a store/i],
]);

for (const [name, evidence] of WRITER_ASSIGNED) {
  const description = PROPERTIES.get(name)?.description ?? "";
  if (!evidence.test(description)) {
    throw new Error(
      `"${name}" is exempted here as writer-assigned, but the schema no ` +
        "longer describes it that way; re-earn the exemption or drop it",
    );
  }
}

/* ------------------------------------------------------------------ */
/* The recipes                                                         */
/* ------------------------------------------------------------------ */

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-token presence: `provenanceMap` does not contain `provenance`. */
const names = (text, token) => new RegExp(`\\b${escape(token)}\\b`).test(text);
/** Shown as a literal JSON array, not merely described as one. */
const showsList = (text, field) =>
  new RegExp(`"${escape(field)}"\\s*:\\s*\\[`).test(text);

/**
 * The two recipes, and how much of the canonical shape each one commits to.
 *
 * The extraction recipe asks the model for a spec-shaped document, so every
 * required root key applies to it. The rescue prompt deliberately asks for a
 * LOOSER shape — `extractionSections` holding plain strings — which
 * `normalizeHandover` turns into a spec-shaped document
 * (spec/normalization-profile.md). Two root keys are therefore supplied
 * downstream rather than by the model, and they are exempted here by name and
 * with a reason. Everything else, including any newly required root key, still
 * has to be in the text.
 */
const RECIPES = [
  {
    file: "recipes/handover-recipe-v1.txt",
    rootExempt: new Map(),
    alsoNames: [],
  },
  {
    file: "recipes/rescue-recipe-v1.txt",
    rootExempt: new Map([
      ["soilHandover", "normalization stamps the format version"],
      ["sections", "the model writes `extractionSections`, normalized into it"],
    ]),
    alsoNames: ["extractionSections"],
  },
];

const problems = [];
let checked = 0;

for (const recipe of RECIPES) {
  const text = readFileSync(join(ROOT, recipe.file), "utf8");
  const fail = (message) => problems.push(`${recipe.file}: ${message}`);

  // 1. Every section the schema requires is named.
  for (const key of SECTION_KEYS) {
    checked += 1;
    if (!names(text, key)) fail(`never names the required section \`${key}\``);
  }

  // 2. Every required root key is named, or exempted with a reason.
  for (const key of ROOT_REQUIRED) {
    if (WRITER_ASSIGNED.has(key)) continue;
    if (recipe.rootExempt.has(key)) continue;
    checked += 1;
    if (!names(text, key)) fail(`never names the required root key \`${key}\``);
  }
  for (const key of recipe.alsoNames) {
    checked += 1;
    if (!names(text, key)) {
      fail(`never names \`${key}\`, the key its exemptions depend on`);
    }
  }

  // 3. A closed set the recipe reaches for is enumerated IN FULL. Naming the
  //    field, or any one member, is what makes the whole set the model's
  //    problem: it now has to pick a value, and every value outside the set is
  //    a refused document.
  for (const { field, members } of CLOSED_SETS) {
    const reached =
      names(text, field) ||
      members.some(
        (member) => !SHARED_MEMBERS.has(member) && names(text, member),
      );
    if (!reached) continue;
    for (const member of members) {
      checked += 1;
      if (!names(text, member)) {
        fail(
          `asks for \`${field}\` but never names the allowed value ` +
            `"${member}" (${members.length} in the set)`,
        );
      }
    }
  }

  // 4. A list-valued field the recipe names is SHOWN as a list. "optional
  //    `provenance`" is how a model comes to write a bare string into an
  //    array field; `"provenance": [...]` is not.
  for (const field of LIST_FIELDS) {
    if (!names(text, field)) continue;
    checked += 1;
    if (!showsList(text, field)) {
      fail(
        `names the list-valued \`${field}\` but never shows it as a JSON ` +
          `array (expected \`"${field}": [\` somewhere in the text)`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* The verdict                                                         */
/* ------------------------------------------------------------------ */

for (const problem of problems) console.error(`  ✗ ${problem}`);

if (problems.length > 0) {
  console.error(
    `\nrecipe sufficiency: ${problems.length} requirement(s) the schema ` +
      "imposes are not stated in the text a model receives.\n" +
      "The recipe is the only thing the model sees. What it does not say, " +
      "the model has to guess.",
  );
  process.exit(1);
}

console.log(
  `recipe sufficiency: ${checked} requirement(s) checked against ` +
    `spec/handover.schema.json across ${RECIPES.length} recipe(s) — ` +
    `${SECTION_KEYS.length} sections, ${ROOT_REQUIRED.length} required root ` +
    `keys, ${CLOSED_SETS.length} closed set(s), ` +
    `${LIST_FIELDS.length} list-valued field(s).`,
);
