"""The rescue prompt: the exact text a user pastes into a dead or full thread.

When a thread is out of room, or the assistant has no tools wired up, no
``soil save`` can run inside it. The rescue prompt asks the model for ONE
JSON block, which the SDK ingests as a real handover via
``extract_json_block`` and ``normalize_handover``. It is the manual on-ramp,
and it is the reason the format has to be writable by a model with no tools
at all.

The source of truth for this text is the specification's published rescue
prompt, as carried in ``packages/sdk-ts/src/rescue.ts``; it is copied byte
for byte, never paraphrased, and a parity test asserts that the two SDKs
expose identical text.

The block it asks for uses the loose shape (``extractionSections``, plain
strings). ``normalize_handover`` turns that into a spec-shaped document,
which is how the manual on-ramp reaches the same store as everything else.

Pure string, standard library only.
"""

RESCUE_PROMPT = """SOIL RESCUE SAVE — spec v1.0 · recipe v1.4.0

Produce a SAVE of everything important in THIS conversation so it can be reloaded into a fresh AI session. Output ONE fenced ```json code block and nothing else (no text before or after).

The JSON object must have EXACTLY these top-level keys and no others:
- "projectId": a short stable slug for the project (lowercase, hyphens), e.g. "billing-rework"
- "title": a short human title for this save
- "createdAt": when this save is being written, as an ISO 8601 UTC timestamp, e.g. "2026-07-29T14:12:00Z". State it as best you know it. It is the anchor every later reader judges the state against, nothing downstream fills it in for you, and a block without it is refused.
- "source": an object with exactly one key, "recipeVersion", set to the recipe version printed on the FIRST LINE above, copied exactly: the three numbers only, with no leading "v", so a first line reading "recipe v1.4.2" gives "1.4.2". Report the version you were actually handed, never one you assume.
- "extractionSections": an object containing ALL 17 of these keys, in this order:
    projectIdentity, decisions, workflow, architecture, constraints, rejectedPaths,
    executiveSummary, currentTask, latestUserIntent, sessionDelta, blockers, nextSteps, openQuestions,
    sessionActivity, restoreInstructions, provenanceMap, safetySummary

What each section holds (fill EVERY one from this conversation):
- projectIdentity: what the project is, its purpose, who it is for, the project's own working language (its named concepts and terms with their agreed meanings — enumerate them, do not sample), and how the user likes to work.
- decisions: ENUMERATE every settled decision with its reasoning, even ones decided long ago. List them all; do not summarise them away.
- workflow: how the work is run, the review/done rules, and the standing "always do X / never do Y" corrections.
- architecture: the durable shape of the system or work and how the parts fit (by name, never private absolute paths).
- constraints: the hard invariants this project must never violate, each with why it binds.
- rejectedPaths: what was tried or considered and deliberately discarded, and why.
- executiveSummary: one screen orienting a cold reader: what this is, where it stands, the single most important next thing.
- currentTask: the task in flight, the approach and why, how far along, what "done" looks like, plus the live current status.
- latestUserIntent: the last substantive direction the user gave, in their own words; it overrides any stale earlier plan.
- sessionDelta: what changed this session versus where it started (decided, built, reversed, learned, unblocked).
- blockers: what is blocking progress, what was tried, and the dependency it imposes.
- nextSteps: the concrete, ordered next actions, specific enough to start immediately.
- openQuestions: what is genuinely still undecided, so the next model does not assume.
- sessionActivity: the consequential actions taken this session and their outcomes (meaning only, never raw logs).
- restoreInstructions: ONE paste-ready, standalone boot prompt covering the WHOLE working state so a cold model can continue with the smallest practical loss of operationally important state; state known or suspected omissions instead of implying completeness.
- provenanceMap: where the load-bearing claims came from and how confident you are; never present a guess as checked.
- safetySummary: anything you withheld for safety; say that it exists and where it is configured, never its value. "none" if nothing.

Rules:
- Each section value is a single plain-prose string. If you have nothing for a section, set that key to the object {"status":"missing","summary":null} instead of a string. If the section has no subject in this project at all, set it to {"status":"not_applicable","summary":"why it does not apply"} instead: that one tells the next model to stop looking, so it needs its reason, and "missing" is the honest answer whenever you cannot give one. If you are holding a section back for safety, set it to {"status":"blocked","summary":"what you withheld, never its value"}. Those status words are a closed set of exactly four — "available" (a section carrying content, which is what a plain-prose string already means, so you never have to write it), "missing", "blocked", "not_applicable" — and any other word refuses the whole block.
- SELF-CONTAINED IS THE RULE: assume the reader has ONLY this block, no repo, no docs, no links, no earlier thread. INLINE the content in every section. Never point outward, no "see the repo", "in the docs", "refer to the file", or a bare link, in ANY section; if the reader would have to fetch something, paste it in instead.
- Write about the PROJECT, not about the act of saving. The save itself is not a decision, task, or next step.
- Do NOT include any secrets, API keys, tokens, passwords, or private absolute file paths. Credential-shaped material that is detected refuses the whole block and nothing is stored, but that scan is a net and not a guarantee: a secret with no recognisable shape goes straight through it. Keeping them out is your job, not the scanner's.
- Output ONLY the ```json block."""
