# Design: Auto-detecting available context for Analyze, without losing user choice

## The question

Today, the "Analyze" options modal presents four independent groups of
checkboxes controlling what context gets sent to the AI as part of the
Analyze request — separate and distinct from the four annotation-mechanism
checkboxes (bi/ff/sn/bi2), which control *how* results get drawn back onto
files, not what informs the analysis itself:

- **Knowledge Base**: company/organization context, control & risk analyst
  notes
- **Audit Elements**: audit description, assessment entities, risks &
  controls, financial statement accounts/footnotes
- **Workpaper Elements**: process/control narrative (text), process/control
  narrative (attached file), test description
- **Test Attribute Details**: one consolidated toggle for description +
  additional info + pass/failure criteria (`aopt-attrdetails`, wired to
  `attrDesc`/`attrAddl`/`success`/`failure` in `_analysisOptions`)

Every one of these is an explicit, user-set checkbox before each Analyze
run. The proposal on the table: search each underlying field, determine
whether real data actually exists for it, and automatically send
everything available every time — removing the modal's decision entirely,
not just pre-filling it. This doc works through the implications of doing
that, and recommends a middle path instead of the full-automation version.

## Current behavior, precisely

- `_analysisOptions` (public/index.html, `runAnalysisWithOptions()`,
  ~line 24683) is built directly from checkbox states at the moment
  "Analyze" is clicked — nothing here is auto-detected from underlying
  data today; every box reflects only what the user last set (or the
  modal's own defaults, if never touched).
- `_buildAttrPromptWithReferenceFiles` (~line 28400) already has an
  analogous "does the data exist" check for attribute-level fields —
  `if (opts.attrDesc !== false && a.desc)`, `if (opts.attrAddl &&
  a.additionalInfo)`, etc. — the OPTION being on is necessary but not
  sufficient; the actual field also has to be non-empty. This means the
  "does data exist" detection this proposal asks for is not new work at
  the per-field level — it already happens for every option, every run.
  What's proposed is removing the OTHER half of that condition (the
  user's own checkbox) and relying on data-existence alone.
- `downloadTestGuidance()` (~line 27917) already reproduces the exact
  system prompt and user message content from the most recently
  captured real request (`window._lastRealClaudeRequestBody`), and — in
  its fallback path when no real request has been captured yet — an
  "ANALYSIS OPTIONS SELECTED" section listing every checkbox's state.
  This is the existing transparency mechanism a person uses today to see
  exactly what was sent; it currently requires a separate deliberate
  download after the fact.
- The annotation-*type* checkboxes (which mechanisms to burn: bi/ff/sn/
  bi2) are a genuinely separate decision from what's proposed here — they
  already save a standing per-user preference
  (`_annotationTypeSelection`, persisted via `/api/auth/annotation-type-
  prefs`) and are explicitly out of scope for this doc, which is only
  about the WHAT-CONTEXT-TO-SEND checkboxes.

## Implications of full automatic send (no modal, no choice)

**Real benefits:**
- Eliminates the single most common real failure mode: forgetting to
  check something that was actually relevant, silently degrading a run
  with no warning and no visible sign anything was left out.
- The same workpaper analyzed twice (by the same person, or two
  different people) uses the same inputs every time — a UI choice no
  longer determines what the AI saw, which is a genuine reproducibility
  improvement.
- Removes the need for a new or infrequent user to understand what these
  categories even mean before their first successful Analyze run.

**Real costs — not just "less convenient," but functionally different:**

1. **Token cost and prompt dilution.** Several of these categories are not
   small strings — an attached narrative *file* is a whole document
   block; audit-level risk/control lists and FS account/footnote lists
   can be long, and are shared across every workpaper in the audit, not
   scoped to this one. Always including everything means every Analyze
   call pays for the largest possible context regardless of whether it's
   relevant to this attribute set, and — beyond raw cost — there is a
   real, plausible quality risk: audit-wide content written for a
   different control in the same audit could dilute or confuse the
   model's attention on this workpaper's own, narrower attributes. This
   matters more now than it used to, given Part 7's classification
   guidance (see `pass-fail-override-and-sync-plan.md`) depends on the
   model treating attribute-scoped `additionalInfo` as the more
   authoritative, closely-scoped signal — more generic, workpaper-wide
   noise in the same prompt works against that design intent.
2. **Loss of a deliberate testing technique.** An auditor may want to
   test an attribute *in isolation* — without company-level or
   audit-level framing — specifically to see whether the AI reaches the
   same conclusion independently, as a bias or sanity check on the
   result. Full automation removes the ability to do this at all, not
   merely makes it less convenient — there's no way to ask for "just the
   attribute and the sample, nothing else" once the option to exclude
   something no longer exists.
3. **Weaker documented judgment.** The current "options selected" record
   (in `downloadTestGuidance`'s fallback path) is itself a piece of audit
   evidence — it shows a person considered these categories and made a
   call about what to rely on. If every run always includes everything
   available, that section becomes mechanically identical every time and
   stops representing a judgment at all — which cuts against what
   auditors often specifically need to demonstrate (that inputs were
   considered, not simply defaulted).
4. **Traceability of the annotated output.** This is the sharpest
   implication for "the resulting annotation" specifically. An annotated
   PDF's own burned note/reasoning text is meant to be checkable against
   the attached sample and the attribute's own definition — that's the
   whole point of a self-contained audit deliverable. If every run always
   pulls in company-wide and audit-wide context, the AI's own reasoning
   can start leaning on things that never appear anywhere in the
   exported deliverable at all — a note reading "per company policy"
   with the actual policy text sitting only in a Knowledge Base field
   never attached to or referenced by the workpaper itself. That makes
   the annotated file less self-contained and harder for a reviewer to
   verify standalone using only what was actually exported alongside it.
5. **Implicit coupling across workpapers.** "Automatically send
   everything available" means someone editing audit-level risk data,
   entities, or FS accounts *for a different workpaper in the same
   audit* can silently start influencing THIS workpaper's next Analyze
   run, with nobody having explicitly decided that coupling should exist
   run-to-run.

## Recommendation: auto-detect and default-check, don't remove the choice

Rather than eliminating the modal, apply auto-detection to what it
defaults to, not whether it exists:

1. **On modal open, check every box for which the underlying field
   actually has real data**, using the same "does this field have
   content" logic `_buildAttrPromptWithReferenceFiles` and its siblings
   already apply per-option today (non-empty narrative text, an actually
   attached narrative file, at least one entity/risk/FS account row,
   etc.) — extended to run once, up front, per category, rather than
   only checked deep inside the prompt-building step after the user has
   already committed to a selection.
2. **Leave every box unchecked when no real data exists for it** — no
   change from today's practical outcome (an empty field contributes
   nothing to the prompt either way), but this also means a person is
   never shown a checked box promising context that doesn't actually
   exist, and never has to manually discover that some categories are
   simply inapplicable to this workpaper.
3. **Keep the modal visible and every box genuinely toggleable** — this
   preserves all three things full automation would give up: the ability
   to deliberately exclude something (the isolation-testing case), a
   real recorded judgment (leaving good defaults checked is still a
   choice, just a fast, low-friction one), and no silent behavior change
   for anyone relying on today's granular control.
4. **Surface the resulting payload more prominently, not just on
   request.** `downloadTestGuidance()` already captures exactly what was
   sent; today it requires a separate, easy-to-forget download click
   after the fact. A short, always-visible summary immediately after
   Analyze completes (e.g., "This run included: audit description, test
   attribute details, and 2 sample files — see full detail") would give
   most of the "just tell me what happened" value the auto-send proposal
   is really after, without weakening the annotated file's own
   self-containment or giving up the ability to exclude something on
   purpose beforehand.

This gets the primary, real benefit motivating the original proposal —
nobody has to remember what these categories mean or manually discover
what's populated before their first successful run — while keeping every
cost identified above avoidable: cost/dilution (still opt-out available
per category), the isolation-testing technique (still possible), the
documented-judgment property (still real, just faster to arrive at), and
the annotated file's own traceability (context inclusion is still a
visible, deliberate act, not an invisible default).

## If full automation is wanted anyway

Should the auto-send-everything version still be preferred over the
above, worth building as an explicit, named, opt-in preference rather
than the only behavior — mirroring the already-established pattern for
`_annotationTypeSelection` (a saved per-user default, persisted via its
own `/api/auth/...` endpoint, but never silently forced). Concretely: a
single "Always include everything available — don't ask me" toggle,
defaulting OFF, that skips the modal's context-selection step for that
person specifically going forward, while the payload-summary
transparency in point 4 above becomes non-optional in that mode (since
there's no longer an upfront review step to catch a surprise before the
call is made). This confines the more serious traceability and
documented-judgment tradeoffs to people who have explicitly asked for
them, rather than making them the default experience for every user of
the app.

## Data model / implementation notes (not yet built)

- No server-side change — this is entirely a client-side change to how
  `_analysisOptions`'s checkboxes are pre-populated when the modal opens,
  not to what `_analysisOptions` itself contains or how it's consumed
  downstream.
- The "does this category have real data" check for each group needs to
  be written once per category (Knowledge Base entries, each Audit
  Element, each Workpaper Element, Test Attribute Details) — reusing
  whatever accessor each category's own checkbox currently maps to
  (e.g., `wpNarrative[ref]`, the audit's own entities/risks/FS-accounts
  arrays, `wpTestAttributes[ref]` having any `desc`/`additionalInfo`/
  `successCriteria`/`failureCriteria` populated across its rows) rather
  than duplicating field-reading logic that already exists elsewhere.
- The optional "always include everything, don't ask me" preference (if
  built) needs its own small persisted field, analogous to
  `annotation_type_prefs`.

## Verification (when this is built)

1. Open the Analyze options modal for a workpaper with no narrative, no
   attached narrative file, and no populated attribute Additional
   Information/criteria; confirm those specific boxes come up unchecked
   while boxes for genuinely populated categories (e.g., Test Attribute
   Details, if descriptions exist) come up checked.
2. Manually uncheck one auto-checked box, run Analyze, and confirm (via
   `downloadTestGuidance`) that category's content is genuinely absent
   from the real, captured request — the auto-check is a default, not a
   forced inclusion.
3. Add data to a previously-empty category (e.g., write a narrative),
   reopen the modal without reloading the page, and confirm that box now
   comes up checked — the detection reflects current, live data, not a
   one-time snapshot from page load.
4. If the opt-in "always include everything" preference is built,
   confirm enabling it skips the modal's review step entirely for that
   user going forward, and that the post-Analyze payload summary is
   shown unconditionally in that mode.

**Implemented and verified** (2026-09-07), the recommendation above (not
full automation): `_analysisOptionDataAvailability(ref)` computes
availability for all ten context categories from the same underlying
accessors the real prompt-building code reads
(`_kbCompanyNotes`/`wpLinkedControls`+`analyst_notes`/`AUDITS`'s own
`desc`/`currentAuditEntities`/`auditLinkedControls`/`auditLinkedFs`/
`wp.narrative`/`wpNarrativeRefFiles`/`wp.testDesc`/`wpTestAttributes`).
`openAnalysisOptionsDialog()` now calls it fresh every time the modal
opens, setting each checkbox's default from real data (never a static
HTML default) and toggling a small `ti-circle-check` dot next to each
label as the "which ones have data" indicator. A live summary line
(`_updateAnalysisOptionsSummary()`, wired to every checkbox's `onchange`)
shows how many categories will actually be sent, how many have data
available, and explicitly calls out anything left unchecked despite
having data — addressing "improve the summary of data sent to AI" for
the pre-run side. `downloadTestGuidance()`'s post-run "ANALYSIS OPTIONS
SELECTED" report reuses the exact same availability function to annotate
each line with "(no data available for this workpaper)" or "(excluded
despite having data)" as appropriate, so the two summaries — before and
after a run — can never disagree about what was actually available.
Separately, per explicit request, "Search external sources for guidance
on improving the test" (`aopt-guidance-web-search`, a Guidance-only
setting unrelated to Analyze's own context categories) now defaults
unchecked, both in the static HTML and `_guidanceWebSearchPref`'s own
default value.

Verified against the dev server: seeded one category with real data and
confirmed only it came up checked with its dot visible, all others
correctly unchecked with no dot; toggled it off and confirmed the live
summary updated to show "0 categories... Excluded despite having data:
Test Attribute Details"; confirmed the report-annotation logic correctly
labels a no-data category and a deliberately-excluded-despite-data
category; confirmed the web-search checkbox and its backing preference
both default to unchecked/false.

**Revised per direct correction** (2026-09-07): the live, dynamically
computed summary line above was simplified to a static legend —
`_updateAnalysisOptionsSummary()` now just explains what the checkmark
dot itself means ("✓ means Wavefire already has data available for
that item") rather than tallying what's checked/excluded on every
change. The redundant "Legend" row that had separately been added near
the top of the modal (explaining the same dot) was removed, since the
simplified summary line now says the same thing in the one place. The
function is still called on open and still wired to every checkbox's
`onchange` so no other call site needed to change, but no longer
inspects checkbox state at all.
