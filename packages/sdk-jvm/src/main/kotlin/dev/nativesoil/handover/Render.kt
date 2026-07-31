/**
 * The rail card: the ASCII shape Soil prints after a save, a load, or a list.
 *
 * Design contract, do not break:
 *  - PURE. No I/O, no clock, no randomness. Same input, byte-identical output,
 *    which is why the tests can pin whole cards.
 *  - SAFE BY CALLER. The renderer formats already-safe text. It does not scan,
 *    redact or reconstruct anything.
 *  - COMPUTED LAYOUT. A fixed 2-space gutter, a continuous left rail, and
 *    rules extended to a fixed inner width. Alignment is computed from content,
 *    never hardcoded, so the card lands identically in every terminal.
 *
 * The card reports counts and names: how many sections carry content, which
 * ones do not, and what was held back on purpose. It never reports a score. A
 * local save has no opinion about how good your handover is.
 *
 * The save card and the load card carry the same two head blocks, and they do
 * so on purpose. A field a writer supplies has not been delivered until a
 * reader sees it, and a field shown on the way in and dropped on the way out is
 * the same defect as one never stored: `written by` names the tool, the model,
 * the provider and the extraction recipe behind the document, and `what this
 * document carries` names the withheld sections as withheld rather than as
 * empty. Which section carries which provenance label is a per-section mapping
 * and lives in the restore prompt; the card names the kinds of claim present,
 * which is what fits in a column.
 *
 * Byte for byte with `packages/sdk-ts/src/render.ts`.
 */
@file:JvmName("Render")

package dev.nativesoil.handover

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

private const val GUTTER = "  "
private const val INNER_WIDTH = 52
private const val RAIL_INDENT = "│   "
private const val WRAP_WIDTH = 46

/** Wrap prose to `width` columns on word boundaries. Never splits a word. */
@JvmOverloads
fun wrap(text: String, width: Int = WRAP_WIDTH): List<String> {
    val out = mutableListOf<String>()
    for (paragraph in text.split("\n")) {
        var line = ""
        for (word in paragraph.split(Regex("\\s+")).filter { it.isNotEmpty() }) {
            line = when {
                line.isEmpty() -> word
                line.length + 1 + word.length <= width -> "$line $word"
                else -> {
                    out.add(line)
                    word
                }
            }
        }
        out.add(line)
    }
    return out
}

private fun masthead(state: String, code: String? = null): String {
    val head = "┌─ SOIL · $state "
    val tail = if (code != null) " $code ─" else ""
    val fill = maxOf(1, INNER_WIDTH - head.length - tail.length)
    return "$GUTTER$head${"─".repeat(fill)}$tail"
}

private fun sectionRule(label: String): String {
    val head = "├─ $label "
    val fill = maxOf(1, INNER_WIDTH - head.length)
    return "$GUTTER$head${"─".repeat(fill)}"
}

private fun footer(text: String): String = "$GUTTER└─ $text"

private fun blank(): String = "$GUTTER│"

private fun line(text: String): String = "$GUTTER$RAIL_INDENT$text"

private fun prose(text: String): List<String> = wrap(text).map { line(it) }

private fun sectionNames(keys: List<String>): String =
    keys.joinToString(", ") { SECTION_LABELS.getValue(it) }

private fun keysWithStatus(handover: JsonObject, status: String): List<String> {
    val sections = handover["sections"] as? JsonObject
    return SECTION_KEYS.filter { key ->
        asStringOrNull((sections?.get(key) as? JsonObject)?.get("status")) == status
    }
}

/** Width of the label column inside the rail, e.g. `sections    `. */
private const val LABEL_WIDTH = 12

/** The one count line. Structural presence, stated as such. */
private fun contentCountLine(counts: SectionCounts): String =
    "${counts.withContent} / ${counts.total} sections carrying content"

/**
 * A labelled row whose value wraps under itself, keeping the label column
 * clear: the eye should be able to run down the labels without meeting text.
 */
private fun labelled(label: String, value: String): List<String> {
    val width = maxOf(LABEL_WIDTH, label.length + 2)
    return wrap(value, WRAP_WIDTH - width).mapIndexed { i, text ->
        line("${(if (i == 0) label else "").padEnd(width)}$text")
    }
}

private fun noteList(handover: JsonObject, container: String, key: String): List<String> =
    ((handover[container] as? JsonObject)?.get(key) as? JsonArray)
        ?.mapNotNull { asStringOrNull(it) } ?: emptyList()

/**
 * The `source` fields, as the rows that show them.
 *
 * Labelled rather than joined with separators, because a reader met with
 * `chatgpt · gpt-5 · openai` has to guess which token is the tool, which is the
 * model and which is the provider. The label column says which is which, and it
 * is the same block on the save card and the load card, so a field a writer
 * supplied is a field the next reader meets. A row is omitted when the field is
 * absent; a document with no `source` gets no block at all.
 */
private fun sourceRows(handover: JsonObject): List<String> {
    val source = handover["source"] as? JsonObject
    val rows = listOf(
        "client" to asStringOrNull(source?.get("client")),
        "model" to asStringOrNull(source?.get("model")),
        "provider" to asStringOrNull(source?.get("provider")),
        "recipe" to asStringOrNull(source?.get("recipeVersion")),
    )
    val out = mutableListOf<String>()
    for ((label, value) in rows) {
        if (value.isNullOrEmpty()) continue
        out.addAll(labelled(label, value))
    }
    return out
}

/** The `written by` block, or nothing when the document names no source. */
private fun writtenByBlock(handover: JsonObject): List<String> {
    val rows = sourceRows(handover)
    if (rows.isEmpty()) return emptyList()
    return listOf(sectionRule("written by"), blank()) + rows + blank()
}

/**
 * Every provenance label the document's sections carry, in the frozen order of
 * the label set, each label appearing once.
 *
 * The card shows which KINDS of claim a document holds. Which section carries
 * which label is a mapping, and a mapping belongs where a reader can act on it
 * per section, which is the restore prompt.
 */
private fun provenanceLabelsPresent(handover: JsonObject): List<String> {
    val sections = handover["sections"] as? JsonObject
    val seen = mutableSetOf<String>()
    for (key in SECTION_KEYS) {
        val labels = (sections?.get(key) as? JsonObject)?.get("provenance") as? JsonArray
        labels?.mapNotNull { asStringOrNull(it) }?.forEach { seen.add(it) }
    }
    return PROVENANCE_LABELS.filter { seen.contains(it) }
}

/** The one row that says which kinds of claim this document holds. */
private fun provenanceRow(handover: JsonObject): List<String> {
    val labels = provenanceLabelsPresent(handover)
    if (labels.isEmpty()) return emptyList()
    return labelled("provenance", labels.joinToString(", "))
}

/**
 * The observations attached to the document, as the rows that name them.
 *
 * Kinds and producers, never payloads. `data` is free-form and opaque to the
 * specification, so a renderer cannot know how to lay out a payload it has never
 * seen, and a renderer that guessed would be inventing a shape the producer did
 * not agree to. What a reader needs from a card is that the evidence is there,
 * what kind it is and who is answerable for it; the payload is one
 * `soil load --json` away, and `spec/observations.md` says how to read it.
 *
 * Both lists are deduplicated and joined into one wrapping row each, so a
 * hundred entries of one kind cost one row rather than a hundred.
 */
private fun evidenceRows(handover: JsonObject): List<String> {
    val observations = handover["observations"] as? JsonArray ?: return emptyList()
    val kinds = mutableListOf<String>()
    val producers = mutableListOf<String>()
    for (entry in observations) {
        val observation = entry as? JsonObject ?: continue
        val kind = asStringOrNull(observation["kind"])
        if (!kind.isNullOrEmpty() && !kinds.contains(kind)) kinds.add(kind)
        val producer = asStringOrNull(observation["producedBy"])
        if (!producer.isNullOrEmpty() && !producers.contains(producer)) producers.add(producer)
    }
    val out = mutableListOf<String>()
    if (kinds.isNotEmpty()) out.addAll(labelled("evidence", kinds.joinToString(", ")))
    if (producers.isNotEmpty()) {
        out.addAll(labelled("recorded", producers.joinToString(", ")))
    }
    return out
}

/** The card printed after `soil save`. */
fun renderSaved(handover: JsonObject, code: String): String {
    val counts = countSections(handover)
    val missing = keysWithStatus(handover, "missing")
    val blocked = keysWithStatus(handover, "blocked")
    val notApplicable = keysWithStatus(handover, "not_applicable")
    val title = asStringOrNull(handover["title"]) ?: ""
    val projectId = asStringOrNull(handover["projectId"]) ?: ""

    val out = mutableListOf<String>()
    out.add(masthead("handover saved", code))
    out.add(blank())
    out.addAll(prose(title))
    out.add(line(projectId))
    out.add(blank())
    out.addAll(writtenByBlock(handover))
    out.add(sectionRule("what this document carries"))
    out.add(blank())
    out.add(line(contentCountLine(counts)))
    if (missing.isNotEmpty()) {
        out.addAll(labelled("no content", sectionNames(missing)))
    }
    if (blocked.isNotEmpty()) {
        out.addAll(labelled("held back", sectionNames(blocked)))
    }
    if (notApplicable.isNotEmpty()) {
        out.addAll(labelled("no subject", sectionNames(notApplicable)))
    }
    out.addAll(provenanceRow(handover))
    out.addAll(evidenceRows(handover))
    out.add(blank())

    val gaps = noteList(handover, "quality", "missingInputs")
    if (gaps.isNotEmpty()) {
        out.add(sectionRule("stated gaps"))
        out.add(blank())
        for (gap in gaps) {
            wrap(gap, WRAP_WIDTH - 2).forEachIndexed { i, text ->
                out.add(line(if (i == 0) "▸ $text" else "  $text"))
            }
        }
        out.add(blank())
    }

    // The gaps' sibling in `quality`. It reached the restore prompt and not this
    // card, which left the writer no way to see that what it recorded landed.
    val contradictions = noteList(handover, "quality", "contradictions")
    if (contradictions.isNotEmpty()) {
        out.add(sectionRule("unresolved contradictions"))
        out.add(blank())
        for (contradiction in contradictions) {
            wrap(contradiction, WRAP_WIDTH - 2).forEachIndexed { i, text ->
                out.add(line(if (i == 0) "▸ $text" else "  $text"))
            }
        }
        out.add(blank())
    }

    val omissions = noteList(handover, "safety", "unsafeOmissions")
    if (omissions.isNotEmpty()) {
        out.add(sectionRule("held back · by design"))
        out.add(blank())
        for (omission in omissions) {
            wrap(omission, WRAP_WIDTH - 2).forEachIndexed { i, text ->
                out.add(line(if (i == 0) "▸ $text" else "  $text"))
            }
        }
        out.add(blank())
    }

    out.add(sectionRule("local"))
    out.add(blank())
    out.addAll(prose("stored on this machine · no account · no network"))
    out.add(blank())
    out.add(footer("load it in another thread, model, or tool"))
    out.add("")
    out.add("          ❯ soil load $code")
    return out.joinToString("\n")
}

/** The card printed above the restore prompt on `soil load`. */
fun renderLoaded(handover: JsonObject): String {
    val counts = countSections(handover)
    val missing = keysWithStatus(handover, "missing")
    // A withheld section is not an empty one. The save card said so and this one
    // did not, so a reader of the load door could not tell a section nobody
    // could see from one somebody decided not to move, which is the one
    // distinction that says whether to go looking elsewhere.
    val blocked = keysWithStatus(handover, "blocked")
    val notApplicable = keysWithStatus(handover, "not_applicable")
    val code = asStringOrNull(handover["code"]) ?: ""
    val title = asStringOrNull(handover["title"]) ?: ""
    val projectId = asStringOrNull(handover["projectId"]) ?: ""
    val createdAt = asStringOrNull(handover["createdAt"]) ?: ""

    val out = mutableListOf<String>()
    out.add(masthead("handover loaded", code.ifEmpty { null }))
    out.add(blank())
    out.addAll(prose(title))
    out.add(line("$projectId · saved $createdAt"))
    out.add(blank())
    out.addAll(writtenByBlock(handover))
    out.add(sectionRule("what this document carries"))
    out.add(blank())
    out.add(line(contentCountLine(counts)))
    if (missing.isNotEmpty()) {
        out.addAll(labelled("no content", sectionNames(missing)))
    }
    if (blocked.isNotEmpty()) {
        out.addAll(labelled("held back", sectionNames(blocked)))
    }
    if (notApplicable.isNotEmpty()) {
        out.addAll(labelled("no subject", sectionNames(notApplicable)))
    }
    out.addAll(provenanceRow(handover))
    out.addAll(evidenceRows(handover))
    out.add(blank())
    out.add(sectionRule("read it this way"))
    out.add(blank())
    out.addAll(
        prose(
            "durable sections still hold · frontier sections describe the moment of capture, not now · check fast-moving state before trusting it"
        )
    )
    out.add(blank())
    out.add(footer("the restore prompt follows · paste it into the new session"))
    return out.joinToString("\n")
}

/** The card printed by `soil list`. */
fun renderList(entries: List<StoreEntry>): String {
    val out = mutableListOf<String>()
    out.add(masthead("handovers"))
    out.add(blank())
    if (entries.isEmpty()) {
        out.addAll(prose("nothing saved yet · run `soil save` to start"))
        out.add(blank())
        out.add(footer("local store · ~/.soil"))
        return out.joinToString("\n")
    }
    for (entry in entries) {
        val title =
            if (entry.title.length > 28) "${entry.title.substring(0, 27)}…"
            else entry.title
        out.add(
            line(
                "▸ ${entry.code}  ${title.padEnd(28)} ${
                    entry.sectionsWithContent.toString().padStart(2)
                }/17"
            )
        )
    }
    out.add(blank())
    // The ratio is the one number here, so the one number says what it is.
    out.addAll(prose("the ratio counts sections carrying content"))
    out.add(blank())
    out.add(footer("${entries.size} stored · load one with `soil load #NNN`"))
    return out.joinToString("\n")
}

private fun pluralize(n: Int, word: String): String =
    "$n $word${if (n == 1) "" else "s"}"

/**
 * The card printed by `soil check`: the grade band, the findings grouped by
 * section, and the boundary the checker lives behind. Deterministic like
 * every renderer here; the report is already sorted, and this only lays it
 * out.
 */
fun renderCheck(handover: JsonObject, report: CheckReport): String {
    val out = mutableListOf<String>()
    out.add(
        masthead(
            "handover checked",
            asStringOrNull(handover["code"])?.takeIf { it.isNotEmpty() },
        )
    )
    out.add(blank())
    out.addAll(prose(asStringOrNull(handover["title"]) ?: ""))
    out.add(line(asStringOrNull(handover["projectId"]) ?: ""))
    out.add(blank())
    out.add(sectionRule("grade"))
    out.add(blank())
    out.add(line(report.grade))
    out.add(
        line(
            "${pluralize(report.counts.problems, "problem")} · ${
                pluralize(report.counts.cautions, "caution")
            } · ${report.counts.advice} advice"
        )
    )
    out.add(blank())
    out.add(sectionRule("findings"))
    out.add(blank())
    if (report.findings.isEmpty()) {
        out.addAll(prose("none · every rule passed on this document"))
        out.add(blank())
    } else {
        val groups = LinkedHashMap<String, MutableList<CheckFinding>>()
        for (finding in report.findings) {
            val label =
                if (finding.section == null) "the document"
                else SECTION_LABELS.getValue(finding.section)
            groups.getOrPut(label) { mutableListOf() }.add(finding)
        }
        for ((label, group) in groups) {
            out.add(line(label))
            for (finding in group) {
                out.add(line("▸ ${finding.rule} · ${finding.severity}"))
                for (text in wrap(finding.message, WRAP_WIDTH - 2)) {
                    out.add(line("  $text"))
                }
            }
            out.add(blank())
        }
    }
    out.add(
        footer("checked from the document alone · only a real load proves restore")
    )
    return out.joinToString("\n")
}

/** The card printed by `soil validate`. */
fun renderValidation(result: ValidationResult, label: String): String {
    val unsafe = result.issues.filter { it.kind == ValidationIssueKind.SAFETY }
    val out = mutableListOf<String>()
    out.add(
        masthead(
            when {
                result.valid -> "valid handover"
                unsafe.isNotEmpty() -> "refused · secret material"
                else -> "not a handover"
            }
        )
    )
    out.add(blank())
    out.add(line(label))
    out.add(blank())
    if (result.valid) {
        out.add(sectionRule("shape"))
        out.add(blank())
        out.addAll(prose("every required field is present and well formed"))
        out.add(blank())
        out.add(
            footer("structure only · this says nothing about how good the content is")
        )
        return out.joinToString("\n")
    }
    if (unsafe.isNotEmpty()) {
        out.add(sectionRule("nothing was stored"))
        out.add(blank())
        for (issue in unsafe) {
            wrap("${issue.path} ${issue.message}", WRAP_WIDTH - 2).forEachIndexed { i, text ->
                out.add(line(if (i == 0) "✗ $text" else "  $text"))
            }
        }
        out.add(blank())
    }

    val structural = result.issues.filter { it.kind != ValidationIssueKind.SAFETY }
    if (structural.isNotEmpty()) {
        out.add(sectionRule("${structural.size} problem(s)"))
        out.add(blank())
        for (issue in structural) {
            wrap("${issue.path.ifEmpty { "/" }} ${issue.message}", WRAP_WIDTH - 2)
                .forEachIndexed { i, text ->
                    out.add(line(if (i == 0) "✗ $text" else "  $text"))
                }
        }
        out.add(blank())
    }

    out.add(
        footer(
            if (unsafe.isNotEmpty()) "remove the value, keep the meaning, then save again"
            else "fix these and validate again"
        )
    )
    return out.joinToString("\n")
}
