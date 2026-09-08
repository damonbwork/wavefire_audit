# Design: Building and filling the Testwork Grid without ever running Analyze

## The workpaper execution path, and where AI is optional

Executing a workpaper has five steps, any of which may need iteration —
especially attributes, testwork, and documentation:

1. **Develop sample data** — the population/rows to test.
2. **Develop the attributes** — what to test for, and how to judge it.
3. **Upload sample files** — the source documents.
4. **Execute testwork** — determine pass/fail for each (sample,
   attribute) pair, with supporting evidence.
5. **Prepare workpaper documentation** — the record of what was tested
   and found.

AI is an optional accelerant at four of these steps, and every one of
those four already has a genuine non-AI path **except one**:

| Step | AI's role | Non-AI alternative | Status |
|---|---|---|---|
| 1. Sample data | Can identify additional sample fields worth capturing | Paste in or type sample data directly | **Already works** |
| 2. Attributes | Guidance can suggest attribute wording, suggest new attributes | Write attribute wording directly | **Already works** |
| 3. Sample files | *(not an AI step)* | Upload directly | Already works |
| 4. Execute testwork | Analyze determines pass/fail and cites evidence | Review source files and judge each attribute directly | **Missing** — no way to create or fill in the Testwork Grid without running Analyze |
| 5. Documentation | Can prepare testwork documentation (annotated files, summaries) | Complete documentation independently and upload it | **Already works** |

This doc designs the missing piece: a way to build and fill in the
Testwork Grid entirely by hand, for someone who never runs Analyze at
all — or who runs it and then needs to fill in what it couldn't reach.

## What's already there, and why the gap is smaller than it looks

Two real discoveries change the shape of this design substantially:

1. **`_openAttrResultsModal` (the results/override modal opened by
   clicking a Testwork Grid tick) already works with no AI result at
   all.** It derives its own row list directly from Sample Data
   (`_daSampleDataFor(ref).rows`), not from `_wpAnalysisResults[ref]` —
   and `renderRow`'s own `findMatchForSample(fi)` already returns `null`
   gracefully when there's nothing there yet, rendering "…" and "Not
   tested" rather than erroring. Selecting Pass or Fail there already
   calls `_postOverride`, which (confirmed in this doc's own Part 5,
   `pass-fail-override-and-sync-plan.md`) never depends on an AI result
   existing — an override is a real, independent, first-class fact
   about an (attribute, sample) pair, not a correction layered onto a
   required AI baseline. **The modal is already the manual-entry UI.**
2. **The only real blocker is that the Testwork Grid itself never
   renders until `_wpAnalysisResults[ref]` is non-empty**
   (`renderAnalysisResultsGrid`, ~line 11833: `if (!wpResults.length) {
   card.style.display = 'none'; ...; return; }`). Nothing populates that
   array except a completed Analyze run — so there's currently no way to
   even get to a tick to click, if Analyze has never been run.

This means the fix is much smaller than building a whole parallel
manual-entry system: **make the grid render from Sample Data and Test
Attributes alone, with every cell starting as "not yet tested," using
the exact same click-to-open-the-results-modal path that already
works.**

## Design

### 1. An explicit "Create Testwork Grid" action — not implicit appearance

**Revised per direct correction.** The first draft of this design had
the grid appear automatically the moment Sample Data and Test
Attributes both had content — tracing the actual render call sites
showed that would have been unpredictable in practice (`saveAttrRow`
and `saveSampleDataGrid` deliberately don't trigger a full section
re-render on every edit, to avoid disrupting typing), and even fixed to
be reliable, an implicit appearance is the wrong shape for a genuinely
deliberate action: creating the grid is a real step in executing the
workpaper, not a side effect of typing.

Instead: a new button, **"Create Testwork Grid,"** next to "Analyze &
Create Workpaper." Clicking it is the one and only action that brings
the grid into existence. Same preconditions Analyze itself needs — at
least one Sample Data row, at least one titled Test Attribute — checked
the same way, with the same kind of explanation if either is missing.

**What it does**: takes a real snapshot, at that exact moment, into
`_wpAnalysisResults[ref]` (and its `WORKPAPERS[]._analysisResults`
mirror) — one entry per *current* Sample Data row, one `results` entry
per *current* Test Attribute, `title` set and `result` left unset. This
is structurally identical to what Analyze itself produces, just with
every cell blank instead of an AI conclusion — not a separate, parallel
data shape needing its own rendering logic. Two things follow from that:

- **No fallback logic needed anywhere.** `renderAnalysisResultsGrid`
  needs no special-casing at all — it already renders a dash for a
  missing `result`. `_openAttrResultsModal` (already fixed to prefer
  `_wpAnalysisResults[ref]` over live Sample Data when one exists — see
  the sample-alignment bug fix elsewhere in this codebase) is already
  correctly aligned with a manually-created snapshot by construction,
  with no further change.
- **It behaves like Analyze's own output, including its own
  staleness rules.** The grid is a snapshot, not a live view — editing
  Sample Data or Test Attributes afterward does not retroactively
  change it, exactly as a real Analyze run's own output doesn't
  auto-refresh when the underlying data changes later either. To
  rebuild after such a change, use the already-built **"Clear Testwork
  Grid"** button, then **"Create Testwork Grid"** again. Deliberately
  *not* building a "smart merge" that tries to preserve old entries
  while adding new rows/columns in place — that would reintroduce
  exactly the alignment risk the sample-mismatch bug fix just closed
  (old overrides pointing at positions that no longer mean the same
  thing). Clear-then-recreate is a little more manual, but it can't
  silently misattribute anything.

**Button visibility**: "Create Testwork Grid" shows only when no grid
currently exists (`_wpAnalysisResults[ref]` empty). Once created, that
button is replaced by the grid itself (with its own "Clear Testwork
Grid" action) — one clear state transition, not a button whose meaning
changes depending on whether it's been clicked before.

**Filling it in**: once created, the grid renders exactly like an
Analyze-produced one — every cell a dash. Clicking a cell opens the
existing results modal; selecting Pass or Fail calls the existing
`_postOverride`; nothing new to build in that path. Exceptions,
Findings, and Recommendations are added the same way they already can
be today, manually, via "Add" — plus the auto-offer on a manual Fail
described in Part 4 below.

### 2. Minor wording fix in the results modal

`renderRow`'s body text currently reads "Select Pass or Fail below to
**override the AI's result**" unconditionally. Change to something
result-agnostic — e.g., "Select Pass or Fail to record the result for
this sample" when there's no AI result yet (`savedEffective` is
undefined), keeping the existing "override the AI's result" wording
only when a real AI result exists to actually override. Everything else
in the modal (file-link building, expand/collapse, pending-change
tracking, Save) already behaves correctly with no AI baseline.

### 3. Letting a manual entry name its own evidence

Today, `sourceFile`/`page`/`paragraph` on a result only ever come from
an AI mark — there's no field in the results modal for a person to say
"this came from page 4 of Invoice.pdf" when setting a result by hand.
Add three small fields to the modal's expanded row body, shown
alongside the Pass/Fail buttons: a dropdown of this workpaper's
attached original sample files (from `inMemoryFiles[ref].sample`,
filtered to real originals), and optional page/paragraph number inputs.
When set, these persist alongside the override
(`_postOverride`'s existing `overrideNote` parameter already reaches
the backend; the endpoint needs to accept and store `sourceFile`/`page`/
`paragraph` the same way, or these can be folded into the override note
text as a simple "Evidenced by: `<file>`, p. `<n>`" convention if a
schema change is out of scope for a first pass). This isn't required
for the grid to work at all — a manual Pass/Fail with no cited evidence
still renders and persists correctly — but it's what makes a manually-
entered result carry the same evidentiary shape an AI mark does, which
matters for anyone reviewing the workpaper later and wanting to check
the answer against the source.

### 4. Closing the "Fail implies an Exception" gap for overrides generally

This is the one real functional gap this design surfaces that isn't
manual-workflow-specific: **today, setting an override to Fail never
creates an Exception**, whether the override corrects an AI Pass or
records a brand-new manual Fail — `_postOverride` was confirmed (Part 5)
to never touch `wpExceptions` at all. For the AI path this is usually
masked, since Analyze's own post-processing already auto-creates
Exceptions from the AI's own fail marks before anyone gets a chance to
override anything. For a fully manual workpaper, nothing ever creates
that Exception — a person could set a dozen cells to Fail and never see
a single `[Ref]` tag or grid entry unless they separately remember to
open the Exceptions grid and add one by hand for each.

Fix: after a successful override to `'fail'` (in both existing
call sites — `_saveOverride`, the live-tick popup, and
`_openAttrResultsModal`'s own OK-handler), check whether an Exception
already exists for that `(attributeIndex, sampleRowIndex)` pair
(`wpExceptions[ref].some(e => e.attributeIndex === ai && e.sampleRowIndex === fi)`);
if not, offer — small, editable, dismissible, never silent, matching
the established pattern from Part 7's guidance-append offer — to create
one automatically, pre-filled with the override's own note text as the
Exception's description. Declining leaves the Fail tick exactly as set;
nothing about the override itself depends on the Exception existing.

### 5. Explicitly out of scope: manual PDF annotation

Per the workpaper path's own framing, Step 5 (documentation) already has
a genuine non-AI alternative — completing documentation independently
and uploading it — so this design does not build a way to burn manual
grid entries into annotated PDF copies. Worth noting as a natural, low-
risk future extension if ever wanted: every burn function already reads
generically from a `wpResults`-shaped structure and has no actual
dependency on the AI having produced it, so "burn the current grid,
however it was filled in" would be a small, mostly-wiring addition
later, reusing every existing mechanism (bi/bi2/ff/sn, the override-
sync confirmation, the annotation-type selection) rather than requiring
anything new architecturally.

### 6. Findings and Recommendations need no new work

Manual creation of Exceptions, Findings, and Recommendations already
works today via "Add" (`addGridItem`), independent of Analyze — the one
addition in Part 4 above (offering to auto-create a linked Exception on
a manual Fail) closes the remaining gap between "a person can add
anything by hand" and "the app doesn't leave an obvious gap for them to
forget."

### 7. Warning before Analyze overwrites an existing Testwork Grid

Per direct follow-up: if a person creates the grid manually (or ran
Analyze before and is running it again), clicking "Analyze & Create
Workpaper" needs to warn — with a real OK/Cancel choice, not a silent
overwrite — before replacing what's already there.

**There is already real, working precedent for exactly this shape of
warning**, worth extending rather than inventing something new
alongside it: `analyzeWithClaude`'s very first step already detects
existing annotated files and confirms before deleting them
("`Remove existing annotated files? … <strong>N existing annotated
file(s)</strong> will be deleted first. This cannot be undone.`",
via `rcmConfirmDelete`) — Cancel genuinely stops Analyze before any
other work begins. This already covers "related documentation" in the
literal sense of annotated PDF copies. What's missing is the same
treatment for the Testwork Grid's own data (the results themselves and
any pass/fail overrides) — today, `analyzeWithClaude` overwrites
`_wpAnalysisResults[ref]` and leaves stale entries in
`_attrSampleResultsCache[ref]` behind with no warning of any kind, for
either an AI-produced or a manually-created prior grid.

**Design**: extend the existing annotated-files check into one combined
pre-flight check, still the first thing Analyze does, still one dialog,
not two stacked confirmations:
- If `_wpAnalysisResults[ref]` already has entries, or
  `_attrSampleResultsCache[ref]` has any override rows, add that to the
  same warning's message — e.g., "This will also replace the current
  Testwork Grid (every tested result) and clear N existing pass/fail
  override(s)." — combined with the existing annotated-files sentence
  when both apply, so a person sees the whole picture in one place
  rather than clicking through two separate warnings for one action.
- A single Cancel stops Analyze entirely, exactly as it already does
  for the annotated-files case — nothing is touched, whether that means
  files, the grid, or overrides.
- On OK: proceed with Analyze's existing file-deletion step, then — new
  — clear the override cache the same way `clearTestworkGrid` already
  does (`_postOverride(ref, ai, fi, null, null)` for each cached row,
  reusing that exact loop rather than duplicating it) before the new
  results get written. `_wpAnalysisResults[ref]` itself is already
  fully overwritten by Analyze's own existing logic — no separate clear
  needed there.
- If neither annotated files, grid results, nor overrides exist yet
  (a genuinely first-ever Analyze run), no warning shows at all —
  unchanged from today.

**What happens to Exceptions, Findings, and Recommendations linked to
the old grid?** Confirmed by reading the actual auto-populate code
(the block that creates Exceptions/Findings/Recommendations from
Analyze's own results): it only ever *adds*, checking for an exact
duplicate (same type, name, description, and linked file) before
inserting — it has **never**, for either an AI-produced or a
manually-created prior grid, deleted or modified an existing row. This
should stay exactly as-is: **Exceptions, Findings, and Recommendations
are never auto-deleted by Analyze**, regardless of whether they came
from a manual entry, a prior AI run, or the auto-offer in Part 4. They
are real, human-authored (or human-confirmed) judgments, not mechanical
byproducts of the grid the way a raw tick or an override is — erasing
them automatically would be a genuine loss of work, not a safe reset.

The combined warning dialog should say so explicitly, so a person isn't
left wondering: something like "Existing Exceptions, Findings, and
Recommendations will not be deleted, but they may no longer match what
Analyze concludes once it re-runs — review them afterward." This is
the honest caveat: since the old (attribute, sample) pair a manual
Exception references will very likely still mean the same thing after
a fresh Analyze run (Sample Data and Test Attributes haven't
necessarily changed just because Analyze ran again), the Exception
usually keeps pointing at the right thing — but its own conclusion was
written against the OLD grid's answer, which the new run may now
disagree with, and nothing forces a person to reconcile that
automatically. That reconciliation stays a manual step, exactly like it
already is today for a second, real Analyze run overwriting a first
one — this design doesn't change that, it just makes sure the person
running Analyze is told it's happening this time, since a manually-
built grid represents deliberate, standalone work in a way a routine
Analyze re-run's own prior AI output arguably doesn't.

## Data model notes

- No new data shape at all for grid creation itself — "Create Testwork
  Grid" writes a real snapshot into the exact same `_wpAnalysisResults
  [ref]` / `WORKPAPERS[]._analysisResults` structure Analyze itself
  already produces and persists, just with blank `result` values.
  Whatever persistence that already has today (confirmed session-
  durable via the existing `_wpObj._analysisResults` fallback path) a
  manually-created grid inherits automatically — nothing new to build
  or verify there specifically.
- The optional evidence fields (Part 3) are the only genuinely new piece
  of persisted data this design proposes, and only if built — everything
  else reuses `_attrSampleResultsCache`/the existing override table
  exactly as it exists today.
- No change to `wpExceptions[ref]`'s own shape — Part 4's addition reuses
  the exact same row shape and `_getNextTypeNum` numbering every other
  Exception-creation path already uses.
- Part 7's combined warning reuses `clearTestworkGrid`'s existing
  override-clearing loop rather than duplicating it — no new persistence
  logic, just an earlier, shared call to something that already exists.

## Verification (when this is built)

1. Confirm "Create Testwork Grid" is visible only when no grid currently
   exists, and that clicking it with no Sample Data or no Test
   Attributes yet explains what's missing rather than creating an empty
   or broken grid.
2. Click "Create Testwork Grid" with real Sample Data and Test
   Attributes; confirm the grid appears immediately with every cell a
   dash, and that the button itself is replaced by the grid (no longer
   shown) once created.
3. Click a dash tick; confirm the results modal opens showing "Not
   tested" (not an AI-result-implying label), and that selecting Pass or
   Fail and saving updates that cell to the correct symbol with no error
   — with no Analyze run having ever happened for this workpaper.
4. Set one cell to Fail; confirm the offer to auto-create a linked
   Exception appears, and that accepting it creates a properly-numbered,
   properly-linked row in the Exceptions grid; confirm declining leaves
   the Fail tick exactly as set with no Exception created.
5. Add a Sample Data row after creating the grid; confirm the grid does
   NOT show the new row until "Clear Testwork Grid" then "Create
   Testwork Grid" are used again — confirming it behaves as a snapshot,
   not a live view.
6. Click "Analyze & Create Workpaper" on a workpaper with an existing
   manually-created grid (no annotated files yet); confirm the combined
   warning mentions the Testwork Grid and any overrides specifically
   (not just annotated files), Cancel leaves everything completely
   untouched, and OK proceeds, clearing overrides via the same path
   `clearTestworkGrid` uses before the fresh AI results are written.
7. Before that same Analyze run, manually create an Exception linked to
   one cell; confirm it still exists, completely unmodified, after
   Analyze completes — Exceptions/Findings/Recommendations are never
   auto-deleted, regardless of origin.
8. If Part 3's evidence fields are built, confirm a manually-set result
   with a chosen source file and page correctly produces a working file
   link in the results modal, identical in behavior to an AI-cited mark.
