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

### 1. Render the grid without requiring a prior Analyze run

`renderAnalysisResultsGrid(ref)` gains a fallback: when
`_wpAnalysisResults[ref]` is empty but both Sample Data and Test
Attributes have at least one real row, build a **synthetic, never-
persisted** `wpResults`-shaped array on the fly, purely for this render
pass — one entry per Sample Data row, each attribute's `results` entry
carrying `{ title, result: undefined }` (no `marks`, no `sourceFile`).
This is deliberately **not** written to `_wpAnalysisResults[ref]` or the
backend — it's a rendering convenience, recomputed fresh every time,
exactly mirroring what `_openAttrResultsModal`'s own row list already
does independently. Nothing about the grid's own tick-rendering logic
needs to change: `TICK[result] || '–'` already renders an `undefined`
result as a dash, and `_findOverrideFor(ref, ai, fi)` already wins over
a missing AI result exactly the same way it wins over a real one
(`const result = overrideRow?.override_result || aiResult;`) — a
manually-set Pass/Fail shows up correctly with no further change.

The section header and empty-state messaging adjust slightly: when
showing the synthetic (never-analyzed) grid, note that every cell is
untested and invite the person to click one to record a result, rather
than implying an Analyze run already happened.

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

## Data model notes

- No new persisted fields for the grid-rendering fallback itself — the
  synthetic `wpResults` used when nothing has been analyzed yet is never
  written anywhere, purely computed at render time from data (Sample
  Data, Test Attributes) that already persists on its own.
- The optional evidence fields (Part 3) are the only genuinely new piece
  of persisted data this design proposes, and only if built — everything
  else reuses `_attrSampleResultsCache`/the existing override table
  exactly as it exists today.
- No change to `wpExceptions[ref]`'s own shape — Part 4's addition reuses
  the exact same row shape and `_getNextTypeNum` numbering every other
  Exception-creation path already uses.

## Verification (when this is built)

1. In a workpaper with Sample Data and Test Attributes populated but
   Analyze never run, confirm the Testwork Grid section becomes visible,
   every cell shows a dash, and the section communicates that nothing
   has been tested yet.
2. Click a dash tick; confirm the results modal opens showing "Not
   tested" (not an AI-result-implying label), and that selecting Pass or
   Fail and saving updates that cell to the correct symbol with no error
   — with no Analyze run having ever happened for this workpaper.
3. Set one cell to Fail; confirm the offer to auto-create a linked
   Exception appears, and that accepting it creates a properly-numbered,
   properly-linked row in the Exceptions grid; confirm declining leaves
   the Fail tick exactly as set with no Exception created.
4. Run a real Analyze on a workpaper afterward (or before) and confirm
   the synthetic-grid fallback never interferes with real AI results —
   once `_wpAnalysisResults[ref]` is genuinely non-empty, the real data
   is used, not the synthetic fallback, exactly as it works today.
5. If Part 3's evidence fields are built, confirm a manually-set result
   with a chosen source file and page correctly produces a working file
   link in the results modal, identical in behavior to an AI-cited mark.
