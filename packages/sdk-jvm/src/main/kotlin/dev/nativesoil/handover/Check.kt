/**
 * Save-time checking and grading: the open baseline.
 *
 * [checkHandover] is deterministic, lint-style analysis of the handover
 * document itself. Every rule has an id, a severity and a plain-language
 * explanation, all documented openly in `docs/checking.md`. Same input, same
 * report, byte for byte, and byte-identical to the TypeScript reference in
 * `packages/sdk-ts/src/check.ts` for the same document. Nothing here calls a
 * model, reaches the network, or measures anything outside the document.
 *
 * The boundary, stated plainly: the baseline checker is deterministic
 * analysis of the document itself. Whether a handover actually restores a
 * session is a different question, answered only by a real load.
 *
 * The grade band belongs to the report and stops there. It is printed on the
 * card, present in `--json`, and it decides the exit code. It is NOT written
 * into the document: the `quality.capture` observation this module builds
 * carries counts, names and findings, and no band, no score and no aggregate
 * of any kind. A judgement made by a producer the reader never met has no
 * business travelling inside the thing it judges.
 *
 * Two string units live in this module and they answer two different
 * questions. The `notes` bound is counted in Unicode code points with
 * [textLength], the format's unit. The rule thresholds and the numbers
 * quoted inside finding messages are counted in UTF-16 code units, which is
 * what `String.length` already is on this runtime and what the reference
 * measures with JavaScript's `String.prototype.length`.
 */
@file:JvmName("Check")

package dev.nativesoil.handover

import java.util.regex.Pattern
import kotlin.math.floor
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The version of this rule set. It moves when a rule is added or tuned, so a
 * report always says which rules produced it.
 */
const val CHECK_VERSION: String = "1.0.0"

/** The grade bands, best first. */
@JvmField
val CHECK_GRADES: List<String> = listOf("strong", "adequate", "thin", "failing")

/**
 * The three severities. A `problem` undermines the document's ability to
 * restore anything. A `caution` is a concrete weakness worth fixing.
 * `advice` is a soft signal that never lowers the grade.
 *
 * Severity classifies the individual rule outcome. It is never a judgement
 * of the handover, and summing severities into one word is the report's
 * business, not the document's.
 */
@JvmField
val CHECK_SEVERITIES: List<String> = listOf("problem", "caution", "advice")

/**
 * Every rule in the baseline, with its one-line explanation, in the order
 * the reference declares them. The full rationale for each lives in
 * `docs/checking.md`.
 */
@JvmField
val CHECK_RULES: Map<String, String> = linkedMapOf(
    "completeness.missing-without-reason" to
        "a section is declared missing with no reason stated anywhere",
    "completeness.no-durable-truth" to
        "no durable-tier section carries content, so nothing outlives the session",
    "self-containment.fetch-pointer" to
        "the text sends the reader somewhere else instead of carrying the content",
    "time.unanchored" to
        "a frontier section uses time words with no capture-time anchor",
    "decisions.entry-without-reason" to
        "a decision is stated with no recorded reason, which invites relitigation",
    "anchors.no-exact-values" to
        "the section talks about configuration but carries no exact values",
    "gaps.blocked-without-omission-note" to
        "a section was withheld but the safety record does not say what or where",
    "restore.absent" to
        "content was captured but there are no restore instructions to boot it",
    "restore.thin" to
        "the restore instructions are far shorter than the content they must boot",
    "size.one-liner" to
        "a one-line section in an otherwise rich document reads as thinness",
)

/**
 * One finding from one rule. [section] is the section key the finding points
 * at, or null for a document-level finding.
 */
data class CheckFinding(
    @JvmField val rule: String,
    @JvmField val severity: String,
    @JvmField val section: String?,
    @JvmField val message: String,
)

/** Findings counted by severity. */
data class CheckCounts(
    @JvmField val problems: Int,
    @JvmField val cautions: Int,
    @JvmField val advice: Int,
)

/**
 * The whole report. Ephemeral output: nothing in it is part of the document.
 * [grade] is the band, report only: it is never written onto a handover.
 */
data class CheckReport(
    @JvmField val checkVersion: String,
    @JvmField val grade: String,
    @JvmField val counts: CheckCounts,
    @JvmField val findings: List<CheckFinding>,
    @JvmField val sections: SectionCounts,
)

/**
 * The grade mapping, documented in `docs/checking.md` and applied nowhere
 * else. Counts in, band out, no judgement calls:
 *
 *     failing   3 or more problems
 *     thin      1 or 2 problems, or 6 or more cautions
 *     adequate  no problems, 1 to 5 cautions
 *     strong    no problems, no cautions; advice never lowers the grade
 */
fun gradeFromCounts(counts: CheckCounts): String = when {
    counts.problems >= 3 -> "failing"
    counts.problems >= 1 || counts.cautions >= 6 -> "thin"
    counts.cautions >= 1 -> "adequate"
    else -> "strong"
}

// The reference implementation runs on JavaScript strings, so its trim and
// its regex \s are ECMAScript's. Java's String.trim and regex \s cover a
// different set at the edges (a no-break space, a byte order mark), and a
// checker that trims or matches differently produces a different report for
// the same document. So the ECMAScript whitespace set is spelled out once
// here and used everywhere in this file. Java's default \b and \d are
// already the ASCII sets ECMAScript uses, and CASE_INSENSITIVE without
// UNICODE_CASE is exactly ECMAScript's ASCII case folding for these
// patterns.
private const val JS_WHITESPACE: String =
    "\t\n\u000B\u000C\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005" +
        "\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF"

private const val WS_CLASS: String =
    "\\t\\n\\x0B\\f\\r \\u00a0\\u1680\\u2000-\\u200a" +
        "\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"

internal fun jsTrim(text: String): String = text.trim { it in JS_WHITESPACE }

/**
 * The prefix of [text] that fits in at most [units] UTF-16 code units, never
 * splitting a surrogate pair.
 */
private fun u16Slice(text: String, units: Int): String {
    if (text.length <= units) return text
    var end = units
    if (end > 0 && text[end - 1].isHighSurrogate()) end -= 1
    return text.substring(0, end)
}

private fun pattern(regex: String): Pattern =
    Pattern.compile(regex, Pattern.CASE_INSENSITIVE)

/**
 * Phrases that point away from the document. A handover assumes its reader
 * has nothing else, so "see the repo" is content that failed to travel. Each
 * pattern is a heuristic: deterministic, documented, and tuned to phrases
 * that present somewhere else as where the content lives.
 */
private val FETCH_POINTERS: List<Pattern> = listOf(
    pattern(
        "\\bsee (?:the )?(?:repo|repository|docs|documentation|readme|wiki" +
            "|codebase|source|thread|conversation|chat)\\b"
    ),
    pattern("\\bin the (?:docs|documentation|readme|wiki)\\b"),
    pattern("\\bconsult\\b"),
    pattern("\\brefer to\\b"),
    pattern("\\b(?:see|check|visit|read|browse)[$WS_CLASS]+https?://"),
    pattern(
        "\\b(?:described|documented|explained|detailed|available|found)" +
            "[$WS_CLASS]+(?:at|in)[$WS_CLASS]+https?://"
    ),
)

/** Words that are true only at one moment. */
private val VOLATILE_TERMS: Pattern = pattern(
    "\\b(?:currently|right now|now|today|tonight|yesterday|tomorrow" +
        "|this week|last week|this morning|this afternoon|at the moment" +
        "|just now|recently)\\b"
)

/** Phrases that pin volatile words to the capture. */
private val CAPTURE_ANCHORS: Pattern = pattern(
    "\\b(?:at capture|at the capture|as of (?:this|the) capture" +
        "|at the time of capture|when this was (?:captured|written)" +
        "|at save time|as of \\d{4}-\\d{2}-\\d{2})\\b"
)

/** Verbs that state a decision. Scoped to the decisions section only. */
private val DECISION_VERBS: Pattern = pattern(
    "\\b(?:decided|decision|locked|chose|chosen|agreed|settled|adopted" +
        "|picked|selected|went with|opted|will use|use[sd]?|switched to" +
        "|migrated to|standardi[sz]ed)\\b"
)

/**
 * Markers that a reason was recorded. `cannot` and `could not` count because
 * a stated inability is a stated reason.
 */
private val REASON_MARKERS: Pattern = pattern(
    "\\b(?:because|since|due to|so that|reason|why|after|caused|led to" +
        "|avoid|avoids|avoided|prevent|prevents|prevented|otherwise" +
        "|rather than|instead of|cannot|could not)\\b"
)

/** Terms that say the section is talking about configuration. */
private val CONFIG_TERMS: Pattern = pattern(
    "\\b(?:config|configuration|configured|environment variable|env var" +
        "|port|version|pinned|flag|timeout|limit|ceiling|budget|quota" +
        "|threshold)\\b"
)

private val ASCII_DIGIT: Pattern = Pattern.compile("\\d")

private val WS_RUN: Pattern = Pattern.compile("[$WS_CLASS]+")

private val ENTRY_MARKER: Pattern =
    Pattern.compile("^(?:\\d+[.)][$WS_CLASS]+|[-*•▸][$WS_CLASS]+)")

/** The floor parameters for the restore-instructions length rule. */
private const val RESTORE_MIN_CHARS = 300
private const val RESTORE_FRACTION = 0.05
private const val RESTORE_APPLIES_FROM = 1000

/** The parameters for the one-liner rule. */
private const val ONE_LINER_MAX_CHARS = 40
private const val ONE_LINER_MIN_SECTIONS = 5
private const val ONE_LINER_MIN_MEDIAN = 200

private fun sectionObject(handover: JsonObject, key: String): JsonObject? =
    (handover["sections"] as? JsonObject)?.get(key) as? JsonObject

private fun sectionStatus(handover: JsonObject, key: String): String? =
    asStringOrNull(sectionObject(handover, key)?.get("status"))

private fun availableSummary(handover: JsonObject, key: String): String? {
    val section = sectionObject(handover, key) ?: return null
    if (asStringOrNull(section["status"]) != "available") return null
    val summary = asStringOrNull(section["summary"]) ?: return null
    return if (jsTrim(summary).isNotEmpty()) summary else null
}

private fun firstMatch(text: String, patterns: List<Pattern>): String? {
    for (candidate in patterns) {
        val matcher = candidate.matcher(text)
        if (matcher.find()) return matcher.group()
    }
    return null
}

/**
 * Split a section's prose into entries: numbered items, bulleted items, and
 * blank-line-separated paragraphs. Deterministic, no interpretation.
 */
fun splitEntries(text: String): List<String> {
    val entries = mutableListOf<String>()
    val current = mutableListOf<String>()
    fun flush() {
        if (current.isNotEmpty()) entries.add(current.joinToString(" "))
        current.clear()
    }
    for (raw in text.split("\n")) {
        val line = jsTrim(raw)
        if (line.isEmpty()) {
            flush()
            continue
        }
        if (ENTRY_MARKER.matcher(line).find()) {
            flush()
        }
        current.add(line)
    }
    flush()
    return entries
}

/** The lower median of a list of numbers. */
private fun lowerMedian(values: List<Int>): Int {
    if (values.isEmpty()) return 0
    val ordered = values.sorted()
    return ordered[(ordered.size - 1) / 2]
}

private fun preview(text: String, max: Int = 60): String {
    val flat = jsTrim(WS_RUN.matcher(text).replaceAll(" "))
    return if (flat.length <= max) flat else "${u16Slice(flat, max - 1)}…"
}

private fun noteCount(handover: JsonObject, container: String, key: String): Int =
    ((handover[container] as? JsonObject)?.get(key) as? JsonArray)?.size ?: 0

/**
 * Check a handover: run every rule, count the findings, map the counts to a
 * grade band. The input is assumed structurally valid; run [validateHandover]
 * first, the way the CLI does.
 *
 * Pure and deterministic on purpose. No I/O, no clock, no randomness, no
 * model. The report is honest exactly because every finding can be traced to
 * a documented rule and re-produced by anyone from the same bytes.
 */
fun checkHandover(handover: JsonObject): CheckReport {
    val findings = mutableListOf<CheckFinding>()
    fun add(rule: String, severity: String, message: String, section: String? = null) {
        findings.add(CheckFinding(rule, severity, section, message))
    }

    val missingInputs = noteCount(handover, "quality", "missingInputs")
    val unsafeOmissions = noteCount(handover, "safety", "unsafeOmissions")

    // completeness.missing-without-reason: a gap is fine, an unexplained gap
    // is not. A reason can live in the section's own note or in the
    // document-level quality.missingInputs list.
    if (missingInputs == 0) {
        for (key in SECTION_KEYS) {
            val section = sectionObject(handover, key) ?: continue
            if (asStringOrNull(section["status"]) != "missing") continue
            val summary = section["summary"]
            val blank = summary == null || summary is JsonNull ||
                jsTrim(asStringOrNull(summary) ?: "").isEmpty()
            if (blank) {
                add(
                    "completeness.missing-without-reason",
                    "caution",
                    "declared missing, with no note here and nothing in" +
                        " quality.missingInputs saying why",
                    key,
                )
            }
        }
    }

    // gaps.blocked-without-omission-note: blocked means withheld for safety,
    // and the safety record is where the withheld fact is supposed to be.
    for (key in SECTION_KEYS) {
        if (sectionStatus(handover, key) == "blocked" && unsafeOmissions == 0) {
            add(
                "gaps.blocked-without-omission-note",
                "caution",
                "withheld for safety, but safety.unsafeOmissions does not" +
                    " name what exists or where it is configured",
                key,
            )
        }
    }

    // completeness.no-durable-truth: with zero durable sections, nothing in
    // the document outlives the session it came from.
    val durableAvailable = SECTION_KEYS.count { key ->
        SECTION_TIERS[key] == SectionTier.DURABLE &&
            availableSummary(handover, key) != null
    }
    if (durableAvailable == 0) {
        add(
            "completeness.no-durable-truth",
            "problem",
            "none of the six durable-tier sections carries content, so the" +
                " project's lasting truth did not travel",
        )
    }

    // self-containment.fetch-pointer: per section. A pointer inside the
    // restore instructions is a problem, because the boot prompt must stand
    // alone; in any other section it is a caution.
    for (key in SECTION_KEYS) {
        val text = availableSummary(handover, key) ?: continue
        val match = firstMatch(text, FETCH_POINTERS) ?: continue
        add(
            "self-containment.fetch-pointer",
            if (key == "restoreInstructions") "problem" else "caution",
            "sends the reader elsewhere (\"${preview(match, 40)}\"), but a" +
                " handover reader has no repo, no docs and no earlier thread",
            key,
        )
    }

    // time.unanchored: frontier sections describe a moment. Time words with
    // no capture anchor in the same section will read as the present to a
    // reader arriving later.
    for (key in SECTION_KEYS) {
        if (SECTION_TIERS[key] != SectionTier.FRONTIER) continue
        val text = availableSummary(handover, key) ?: continue
        val volatile = VOLATILE_TERMS.matcher(text)
        if (volatile.find() && !CAPTURE_ANCHORS.matcher(text).find()) {
            add(
                "time.unanchored",
                "caution",
                "uses \"${volatile.group()}\" with no capture-time anchor," +
                    " so a later reader cannot tell when it was true",
                key,
            )
        }
    }

    // decisions.entry-without-reason: a decision with no recorded reason is
    // the exact thing a later session relitigates.
    val decisionsText = availableSummary(handover, "decisions")
    if (decisionsText != null) {
        splitEntries(decisionsText).forEachIndexed { i, entry ->
            if (DECISION_VERBS.matcher(entry).find() &&
                !REASON_MARKERS.matcher(entry).find()
            ) {
                add(
                    "decisions.entry-without-reason",
                    "caution",
                    "entry ${i + 1} states a decision with no recorded" +
                        " reason (\"${preview(entry)}\")",
                    "decisions",
                )
            }
        }
    }

    // anchors.no-exact-values: architecture and constraints that mention
    // configuration but carry no digits have probably lost their pins.
    for (key in listOf("architecture", "constraints")) {
        val text = availableSummary(handover, key)
        if (text != null && CONFIG_TERMS.matcher(text).find() &&
            !ASCII_DIGIT.matcher(text).find()
        ) {
            add(
                "anchors.no-exact-values",
                "advice",
                "mentions configuration but holds no numbers, versions or" +
                    " pins; exact values are what survive a move",
                key,
            )
        }
    }

    // restore.absent and restore.thin: the restore instructions are the boot
    // prompt. Captured content with no boot prompt, or a boot prompt far
    // smaller than the content, will not bring a cold session back.
    val restoreText = availableSummary(handover, "restoreInstructions")
    val otherAvailableChars = SECTION_KEYS
        .filter { it != "restoreInstructions" }
        .sumOf { key -> availableSummary(handover, key)?.length ?: 0 }
    if (restoreText == null && otherAvailableChars > 0) {
        add(
            "restore.absent",
            "problem",
            "content was captured but restoreInstructions is empty, so" +
                " nothing tells the next session how to begin",
            "restoreInstructions",
        )
    }
    if (restoreText != null && otherAvailableChars >= RESTORE_APPLIES_FROM) {
        val floor = maxOf(
            RESTORE_MIN_CHARS,
            floor(otherAvailableChars * RESTORE_FRACTION).toInt(),
        )
        if (restoreText.length < floor) {
            add(
                "restore.thin",
                "problem",
                "the restore instructions are ${restoreText.length}" +
                    " characters against $otherAvailableChars of captured" +
                    " content, below the documented floor of $floor",
                "restoreInstructions",
            )
        }
    }

    // size.one-liner: in a document whose sections are otherwise
    // substantial, a near-empty available section is a thinness signal, not
    // an error.
    val availableLengths = SECTION_KEYS
        .mapNotNull { key -> availableSummary(handover, key)?.length }
    if (availableLengths.size >= ONE_LINER_MIN_SECTIONS &&
        lowerMedian(availableLengths) >= ONE_LINER_MIN_MEDIAN
    ) {
        for (key in SECTION_KEYS) {
            val text = availableSummary(handover, key) ?: continue
            if (text.length < ONE_LINER_MAX_CHARS) {
                add(
                    "size.one-liner",
                    "advice",
                    "carries ${text.length} characters in a document whose" +
                        " sections are otherwise substantial",
                    key,
                )
            }
        }
    }

    // Deterministic order: document-level findings first, then sections in
    // canonical order, then rule id, then message.
    fun sectionIndex(key: String?): Int =
        if (key == null) -1 else SECTION_KEYS.indexOf(key)
    val sorted = findings.sortedWith(
        compareBy({ sectionIndex(it.section) }, { it.rule }, { it.message })
    )

    val counts = CheckCounts(
        problems = sorted.count { it.severity == "problem" },
        cautions = sorted.count { it.severity == "caution" },
        advice = sorted.count { it.severity == "advice" },
    )

    return CheckReport(
        checkVersion = CHECK_VERSION,
        grade = gradeFromCounts(counts),
        counts = counts,
        findings = sorted,
        sections = countSections(handover),
    )
}

/**
 * The upper bound on `notes` in a `quality.capture` payload, in Unicode code
 * points, the unit every length bound in this format is counted in. See
 * [textLength] and `spec/value-domain.md`.
 *
 * `notes` is short, non-evaluative context: what the producer wants a reader
 * to know about how the examination was made. The bound is deliberately too
 * small for the field to become a container for a hidden aggregate, and
 * [checkObservation] refuses anything longer rather than truncating a claim
 * in the middle.
 */
const val CHECK_NOTES_MAX_CHARS: Int = 280

/**
 * The note this module writes when the caller supplies none. It states what
 * kind of examination ran and nothing about how the result compares to
 * anything, because a comparison is a judgement.
 */
const val CHECK_DEFAULT_NOTES: String =
    "Structural examination of the document by the open deterministic" +
        " baseline. Section statuses and rule outcomes only."

/**
 * Package a report as a `quality.capture` observation, ready to attach to
 * the stored handover.
 *
 * [producedBy] names the tool that ran the check, with a version, e.g.
 * `soil-cli/0.1.0`; [producedAt] is when the check ran (ISO 8601); [notes]
 * is short non-evaluative context, at most [CHECK_NOTES_MAX_CHARS] code
 * points, defaulting to [CHECK_DEFAULT_NOTES].
 *
 * The payload is a closed field set, documented in `spec/observations.md`:
 *
 *     sectionsWithContent · missingSections · blockedSections ·
 *     findings · checkVersion · notes
 *
 * and nothing else. In particular no `grade`, no band, no score, and no
 * counts-by-severity roll-up. Those exist in the report, where the reader
 * can see who produced them and when; they do not exist on the document,
 * where a later reader would meet the verdict without ever meeting the
 * producer.
 *
 * This does not make the band underivable, and pretending otherwise would
 * be its own dishonesty. Anyone holding this payload plus the published
 * mapping in `docs/checking.md` can count the severities and recompute the
 * band exactly. The difference is who makes that derivation, and whether
 * the threshold is in front of them when they do.
 */
@JvmOverloads
fun checkObservation(
    handover: JsonObject,
    report: CheckReport,
    producedBy: String,
    producedAt: String,
    notes: String? = null,
): JsonObject {
    val resolved = notes ?: CHECK_DEFAULT_NOTES
    require(textLength(resolved) <= CHECK_NOTES_MAX_CHARS) {
        "quality.capture notes must be at most $CHECK_NOTES_MAX_CHARS" +
            " code points, got ${textLength(resolved)}"
    }
    // Section KEYS, not prose labels: `missingSections` and
    // `blockedSections` are addresses a reader can look up, the same
    // identifiers `location` uses.
    fun named(status: String): JsonArray = JsonArray(
        SECTION_KEYS
            .filter { sectionStatus(handover, it) == status }
            .map { JsonPrimitive(it) }
    )
    val findings = JsonArray(
        report.findings.map { finding ->
            JsonObject(
                linkedMapOf<String, JsonElement>(
                    "rule" to JsonPrimitive(finding.rule),
                    // JSON-Pointer-ish, the same shape a validation issue
                    // uses. "/" is the document itself, for a rule that is
                    // not about one section.
                    "location" to JsonPrimitive(
                        if (finding.section == null) "/"
                        else "/sections/${finding.section}"
                    ),
                    "observed" to JsonPrimitive(finding.message),
                    "severity" to JsonPrimitive(finding.severity),
                )
            )
        }
    )
    return JsonObject(
        linkedMapOf<String, JsonElement>(
            "kind" to JsonPrimitive("quality.capture"),
            "producedBy" to JsonPrimitive(producedBy),
            "producedAt" to JsonPrimitive(producedAt),
            "data" to JsonObject(
                linkedMapOf<String, JsonElement>(
                    "checkVersion" to JsonPrimitive(report.checkVersion),
                    "sectionsWithContent" to
                        JsonPrimitive(report.sections.withContent),
                    "missingSections" to named("missing"),
                    "blockedSections" to named("blocked"),
                    "findings" to findings,
                    "notes" to JsonPrimitive(resolved),
                )
            ),
        )
    )
}

/**
 * A report as the ordered JSON value the reference prints for `--json`, so
 * a caller that serializes it emits the same bytes the Node CLI does.
 */
fun checkReportJson(report: CheckReport): JsonObject = JsonObject(
    linkedMapOf<String, JsonElement>(
        "checkVersion" to JsonPrimitive(report.checkVersion),
        "grade" to JsonPrimitive(report.grade),
        "counts" to JsonObject(
            linkedMapOf<String, JsonElement>(
                "problems" to JsonPrimitive(report.counts.problems),
                "cautions" to JsonPrimitive(report.counts.cautions),
                "advice" to JsonPrimitive(report.counts.advice),
            )
        ),
        "findings" to JsonArray(
            report.findings.map { finding ->
                val entry = linkedMapOf<String, JsonElement>(
                    "rule" to JsonPrimitive(finding.rule),
                    "severity" to JsonPrimitive(finding.severity),
                )
                if (finding.section != null) {
                    entry["section"] = JsonPrimitive(finding.section)
                }
                entry["message"] = JsonPrimitive(finding.message)
                JsonObject(entry)
            }
        ),
        "sections" to JsonObject(
            linkedMapOf<String, JsonElement>(
                "withContent" to JsonPrimitive(report.sections.withContent),
                "missing" to JsonPrimitive(report.sections.missing),
                "blocked" to JsonPrimitive(report.sections.blocked),
                "notApplicable" to JsonPrimitive(report.sections.notApplicable),
                "total" to JsonPrimitive(report.sections.total),
            )
        ),
    )
)
