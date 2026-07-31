"""Normalization: turn what a model actually emitted into a spec-shaped
document.

Models write JSON by hand under pressure. They use the loose
``extractionSections`` key, they write a section as a bare string, they skip
sections they had nothing for, they forget ``soilHandover``. None of that is
interesting, and none of it should cost a user their capture.

One rule governs the whole file, and it is the rule that makes a save and a
validation of the same bytes agree:

    Every member present in the input is present in the output. A member is
    rewritten only in the ways ``spec/normalization-profile.md`` enumerates, a
    value that cannot be rewritten is carried through verbatim, and nothing is
    invented.

So an unknown top-level field, an unknown field on a section, an unknown
section key and an unrecognised provenance label all survive this function and
are refused by ``validate``, at the path they actually occupy. Version one is a
closed world (``spec/versioning.md``): none of those is an extension point, and
deleting them here would mean the same bytes were rejected by ``validate`` and
accepted by ``save``.

Three things this deliberately does NOT do, each of which it used to:

* It does not stamp a ``createdAt``. A document that does not say when it was
  captured is refused by ``validate``, not completed here.
* It does not stamp ``source.recipeVersion``. This function is handed a
  document somebody else wrote, so attributing its own recipe to that document
  destroys the field's only use.
* It does not drop a ``handoverId`` it cannot use. A malformed id reaches
  ``validate`` and is refused there, rather than being dropped here and
  replaced, over the top, with a freshly minted one by the writer.

Mirrors ``packages/sdk-ts/src/normalize.ts`` rewrite for rewrite.
"""

from __future__ import annotations

import re
from typing import Any

from .sections import SECTION_KEYS
from .types import Handover, SPEC_VERSION

# The members each object may carry. Everything else is carried through.
_SECTION_FIELDS = ("status", "summary", "provenance")
_SOURCE_FIELDS = ("client", "model", "provider", "recipeVersion")
_QUALITY_FIELDS = ("missingInputs", "contradictions")
_SAFETY_FIELDS = ("unsafeOmissions",)
_ROOT_FIELDS = (
    "soilHandover",
    "handoverId",
    "projectId",
    "title",
    "createdAt",
    "source",
    "sections",
    "quality",
    "safety",
    "observations",
    "code",
)


def _as_trimmed_string(value: Any) -> str | None:
    if isinstance(value, str) and len(value.strip()) > 0:
        return value.strip()
    return None


def _carry_unknown(
    record: dict[str, Any],
    known: tuple[str, ...],
    consumed: tuple[str, ...] = (),
) -> dict[str, Any]:
    """The members of ``record`` that are neither known nor consumed.

    This is the carry-through that keeps ``validate`` able to see what the
    model actually wrote. It never inspects the values.
    """
    return {
        key: value
        for key, value in record.items()
        if key not in known and key not in consumed
    }


def _normalize_section(value: Any) -> Any:
    """Normalize one section value.

    A bare non-empty string becomes an available section. A string with
    nothing in it, ``None`` and an absent key all become a declared gap,
    because "nothing here" is exactly what ``missing`` states. An object is
    kept, with its status inferred when absent and its unknown members carried
    through. Anything else — a number, a list, a boolean — is carried through
    untouched, so ``validate`` reports it at ``/sections/<key>`` instead of
    this function quietly recording a gap where the model wrote something.
    """
    text = _as_trimmed_string(value)
    if text is not None:
        return {"status": "available", "summary": text}
    if value is None or isinstance(value, str):
        return {"status": "missing", "summary": None}
    if not isinstance(value, dict):
        return value

    summary = _as_trimmed_string(value.get("summary"))
    raw_summary = value.get("summary")
    raw_status = _as_trimmed_string(value.get("status"))
    # A status the model actually wrote is kept exactly as written, even when
    # it is not one of the three. ``validate`` then refuses it at
    # ``/sections/<key>/status``. Rewriting ``Available`` to ``available``
    # would be normalization inventing a claim: the section would count as
    # carrying content and would vanish from the list of what is not
    # captured, and the author would never learn the word was wrong.
    if raw_status is not None:
        status: Any = raw_status
    elif "status" in value:
        status = value["status"]
    elif summary is not None:
        status = "available"
    else:
        status = "missing"

    if summary is not None:
        summary_out: Any = summary
    elif raw_summary is None or isinstance(raw_summary, str):
        summary_out = None
    else:
        summary_out = raw_summary

    normalized: dict[str, Any] = {"status": status, "summary": summary_out}
    # Provenance is carried verbatim whenever it is there at all. Filtering
    # out a label this implementation does not know would delete the one thing
    # that lets a cold reader tell a check from a guess, and the label set is
    # closed for the whole of version one: an unrecognised label is an error,
    # not noise.
    if "provenance" in value:
        normalized["provenance"] = value["provenance"]
    normalized.update(_carry_unknown(value, _SECTION_FIELDS))
    return normalized


def _normalize_string_list(value: Any) -> list[str] | None:
    """Trim a list of prose, or return None when any entry is not usable.

    The caller then leaves the list exactly as written, and ``validate``
    reports the entry that is wrong rather than this function deleting it.
    """
    if not isinstance(value, list):
        return None
    if any(_as_trimmed_string(entry) is None for entry in value):
        return None
    return [entry.strip() for entry in value]


def _normalize_named_object(value: Any, known: tuple[str, ...]) -> Any:
    """Trim the string members this object is known to carry, leave the rest."""
    if not isinstance(value, dict):
        return value
    out: dict[str, Any] = {}
    for key, entry in value.items():
        if key not in known:
            out[key] = entry
            continue
        text = _as_trimmed_string(entry)
        out[key] = entry if text is None else text
    return out


def _normalize_list_object(value: Any, known: tuple[str, ...]) -> Any:
    """The same, for the two objects whose members are lists of prose."""
    if not isinstance(value, dict):
        return value
    out: dict[str, Any] = {}
    for key, entry in value.items():
        if key not in known:
            out[key] = entry
            continue
        entries = _normalize_string_list(entry)
        out[key] = entry if entries is None else entries
    return out


def _normalize_sections(raw: dict[str, Any]) -> dict[str, Any]:
    """All 17 keys declared, then whatever else was written."""
    sections: dict[str, Any] = {}
    for key in SECTION_KEYS:
        sections[key] = _normalize_section(raw.get(key))
    sections.update(_carry_unknown(raw, tuple(SECTION_KEYS)))
    return sections


def normalize_handover(input: Any) -> Handover:
    """Normalize a parsed JSON value into a spec-shaped document.

    The result is not guaranteed valid: run ``validate_handover`` on it. What
    is guaranteed is that nothing the input carried was thrown away, and that
    when the input's ``sections`` is an object or absent, all 17 section keys
    are declared.

    Observations pass through unchanged. Nothing here interprets them,
    reorders them, filters them by ``kind``, rewrites ``data``, or repairs a
    malformed entry. An entry whose ``kind`` this implementation has never
    heard of is the exact case the extension point exists for, so dropping or
    rewriting it would make the format lossy in the one place it promises not
    to be; and unlike the 17 sections, observations are produced by tools, so
    a malformed envelope should be told so by ``validate``, not quietly
    patched here.
    """
    if not isinstance(input, dict):
        # Not an object at all. There is nothing to reshape, and building a
        # document around it would replace the value rather than report it, so
        # it goes to ``validate`` as it arrived: the fail-closed secret scan
        # reaches a non-object root, and a repair here would hide what it
        # found.
        return input
    root: dict[str, Any] = input

    document: dict[str, Any] = {}
    consumed: tuple[str, ...] = ()

    # The declared version of this document. An input that states one keeps
    # it, whatever it says: normalization never upgrades a document and never
    # downgrades one. An input that states none is declared 1.0, which is a
    # claim about the shape this function just produced, not a claim about
    # where the content came from.
    if "soilHandover" in root:
        version = _as_trimmed_string(root["soilHandover"])
        document["soilHandover"] = (
            root["soilHandover"] if version is None else version
        )
    else:
        document["soilHandover"] = SPEC_VERSION

    # An id that is already there is kept, whatever shape it is in: a copy
    # keeps its identity, and an id that is present but malformed is a
    # validation error rather than something to drop. Dropping it would hand
    # the writer a document with no id, and the writer would mint a fresh one
    # over the top of the malformed one nobody was ever told about. A missing
    # id stays missing, because assigning it is the writer's job and
    # normalization is not a writer.
    if "handoverId" in root:
        handover_id = _as_trimmed_string(root["handoverId"])
        document["handoverId"] = (
            root["handoverId"] if handover_id is None else handover_id
        )

    for key in ("projectId", "title"):
        if key in root:
            text = _as_trimmed_string(root[key])
            document[key] = root[key] if text is None else text
        else:
            document[key] = ""

    # No wall clock. A document that does not carry a capture time is refused
    # by ``validate``, not completed here.
    if "createdAt" in root:
        created_at = _as_trimmed_string(root["createdAt"])
        document["createdAt"] = (
            root["createdAt"] if created_at is None else created_at
        )

    # No recipe version is stamped: this function did not write the content,
    # so it is in no position to say which recipe did. ``source`` appears in
    # the output only when the input carried one.
    if "source" in root:
        document["source"] = _normalize_named_object(
            root["source"], _SOURCE_FIELDS
        )

    raw_sections = root.get("sections")
    if isinstance(raw_sections, dict):
        document["sections"] = _normalize_sections(raw_sections)
    elif "sections" in root:
        document["sections"] = raw_sections
    elif isinstance(root.get("extractionSections"), dict):
        # The loose key the rescue prompt asks for. It is consumed only when
        # it is actually the source of ``sections``; a document carrying both
        # is carrying content under a key nothing read, which is
        # ``validate``'s to report.
        document["sections"] = _normalize_sections(root["extractionSections"])
        consumed = ("extractionSections",)
    else:
        document["sections"] = _normalize_sections({})

    if "quality" in root:
        document["quality"] = _normalize_list_object(
            root["quality"], _QUALITY_FIELDS
        )
    if "safety" in root:
        document["safety"] = _normalize_list_object(
            root["safety"], _SAFETY_FIELDS
        )
    if "observations" in root:
        document["observations"] = root["observations"]
    if "code" in root:
        code = _as_trimmed_string(root["code"])
        document["code"] = root["code"] if code is None else code

    document.update(_carry_unknown(root, _ROOT_FIELDS, consumed))
    return document


_FENCED = re.compile(r"```(?:json)?[ \t]*\n(.*?)```", re.IGNORECASE | re.DOTALL)


def extract_json_block(text: str) -> str | None:
    """Pull the first fenced JSON block out of a model's reply, or fall back
    to the first ``{...}`` span. Returns the raw text, not a parsed value.

    Models wrap JSON in prose no matter how firmly the prompt says not to,
    and a user pasting a reply should not have to clean it up by hand.
    """
    fenced = _FENCED.search(text)
    if fenced is not None:
        return fenced.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return text[start : end + 1].strip()
    return None
