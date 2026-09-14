# Mock Extraction Results — Design

## Context and a correction to the stated premise

The request that prompted this doc described the inline "Extraction
results" table (under "Data to Extract From Sample Files") as "not
technically part of the workpaper... used solely to mock up what
[extraction] would produce." Reading the actual code shows that's not
quite accurate today, and the distinction matters for what to build:

- **`readSampleFilesIntoGrid(ref)`** (`public/index.html:35102`) is a
  real extraction run — it reads the actual attached sample files and,
  regardless of which mode is selected, **always persists every found
  record** to `wpExtractedDataRecords[ref]` and then to Postgres via
  `saveExtractedDataRecordsToDB(ref)` (a real `extracted_data_records`
  table, loaded back on open via `loadExtractedDataFromDB`/a sibling
  records-load call). The inline "Extraction results" table
  (`renderExtractedDataResults`, `public/index.html:36561`) is simply
  rendering that real, saved data.
- So today, there is no "mock" mode at all — every extraction result
  shown is genuine, saved workpaper data, whether or not "Add extracted
  data to the Sample Data grid above" is checked.

**What this document actually designs**, honoring the real intent
behind the request: a genuinely new, separate **dry-run** capability —
"Mock Extraction Results" — that lets a user see what an extraction
*would* produce, in a floating, movable/resizable window, **without**
writing anything to `wpExtractedDataRecords`/Postgres. This is a real,
new mode, not a renaming of what exists today.

## Two ways to implement "mock," with a recommendation

### Option A — Run the real extraction, just don't save it
Call the exact same per-file extraction pipeline
(`_sdExtractFromOneFile` and the surrounding logic in
`readSampleFilesIntoGrid`) against the real attached sample files and
the real field definitions in `wpExtractedData[ref]`, but skip the two
persistence calls (`wpExtractedDataRecords[ref] = ...` /
`saveExtractedDataRecordsToDB(ref)`) and render the result into the new
floating modal instead of the inline table.
- **Pro**: genuinely shows what a real run would find — the most
  literally accurate "preview."
- **Con**: still a real AI call against real sample files, with real
  AI-unit cost — "mock" is a slightly misleading name for something
  that costs the same as the real thing and reads real documents; the
  only thing it actually saves the user from is polluting the saved
  Sample Data grid record.

### Option B — Synthetic, zero-cost placeholder data (recommended)
Generate clearly-fake illustrative values for each defined field — one
synthetic row per field set, values like `"[Sample Invoice Number]"` or
a short synthetic example inferred from the field's own Title/
Description/Guidance text — with **no AI call and no file reads at
all**. This is a genuine, instant, free preview of the *shape* of the
output (column headers, general structure) to sanity-check field
definitions before committing to a real, costly, saved run.
- **Pro**: instant, free, and matches "mock" literally — no real data
  is read or produced, so there's no ambiguity about whether it should
  be persisted (it categorically shouldn't be, and isn't).
- **Con**: doesn't tell the user whether their Guidance wording will
  actually find real data in their real files — it only validates field
  *shape*, not extraction *quality*.
- **Recommendation**: build Option B. It's cheap, fast, unambiguous
  about what it is, and matches the word "mock" precisely. If real,
  cost-bearing dry-run capability against real files without saving is
  wanted later, that's Option A as a clearly-labeled follow-up
  ("Preview run — uses AI, does not save"), not this feature.

## UI changes

1. **New button, next to "Extract Sample Data"** (`sd-readfiles-btn`,
   `public/index.html:3284`), same toolbar row: **"Mock Extraction
   Results"** — styled distinctly from the real action's orange button
   (e.g. a neutral `btn-s` with a "flask"/beaker-style icon) so the two
   are never visually confused, given one is free/instant and the other
   is a real, costly, saved action.
2. **A new floating window**, reusing the exact `.notes-window` pattern
   already established this session (Review Notes, the attribute
   Guidance window, the Workpaper Chat Assistant, and now the help
   popups) — draggable by its header via the existing `makeDraggable()`
   helper, natively resizable via CSS `resize: both`, and explicitly
   **not** a dimmed full-screen modal, so the workpaper stays visible
   and usable underneath it, per the same "movable and resizable"
   requirement already applied to those other floating windows.
3. **Window content**: the same table shape
   `renderExtractedDataResults` already renders (one column per defined
   field's Title, one row of synthetic values), plus:
   - A clear, impossible-to-miss banner at the top: *"Preview only —
     these are synthetic example values. Nothing has been saved to this
     workpaper."*
   - A "Close" button (and the standard header ✕).
   - Deliberately **no** "Download" or "Add to Sample Data grid" action
     in this window — those actions only make sense for real results,
     and offering them here would blur the exact distinction this
     feature exists to draw.
4. **No inline section changes** — the existing "Extraction results"
   table, its append-mode checkbox, and its Download/Clear buttons stay
   exactly as they are today for the real "Extract Sample Data" action.

## Generating the synthetic values

For each field in `wpExtractedData[ref]` (Title/Description/Guidance),
produce one plausible-looking example value — this can be as simple as
a small, deterministic template (`"[Example: " + title + "]"`) for a
first version, with a possible later refinement using a cheap AI call
*on the field definitions alone* (never touching sample files) to
generate a more realistic-looking example per field, if the plain
placeholder proves too unconvincing to be useful. Recommend shipping
the simple template first — it costs nothing and already validates the
column shape, which is the actual stated goal.

## Files touched (for the eventual build)

All in `public/index.html`:
- New button next to `sd-readfiles-btn`.
- New floating window markup (mirrors the existing `.notes-window`-
  based windows' HTML shape).
- New `_openMockExtractionResults()` / `_closeMockExtractionResults()`
  functions: gather `wpExtractedData[ref]`, synthesize one example row,
  render into the new window's own table (a copy of
  `renderExtractedDataResults`'s rendering logic, retargeted to the new
  window's elements), call `makeDraggable()` on open.
- No server-side changes — this feature deliberately never reaches
  `/api/extracted-data*` at all.

## Verification (for the eventual build)

1. Define two or three extracted-data fields with only Title/
   Description filled in (no sample files needed at all). Click "Mock
   Extraction Results" — confirm the floating window opens with one
   synthetic example row, correctly labeled as a preview, and that
   `wpExtractedDataRecords[ref]` / Postgres are both completely
   untouched (no network call to `/api/extracted-data*` fires).
2. Confirm the window can be dragged by its header and resized via the
   corner handle, and that the underlying page stays fully visible and
   clickable around it.
3. Confirm clicking "Extract Sample Data" afterward still behaves
   exactly as it does today (real files, real save, inline table) —
   this feature must have zero effect on that existing path.

## Built and verified (2026-09-13)

Implemented per Option B, exactly as designed above:
- New neutral `btn-s` "Mock Extraction Results" button (flask icon)
  next to the orange "Extract Sample Data" button.
- New `#mock-extract-overlay` floating window (`.notes-window` pattern
  — draggable via `makeDraggable()`, natively resizable, non-modal),
  with the required "Preview only..." banner and no Download/Add-to-
  grid actions.
- `_openMockExtractionResults()` / `_closeMockExtractionResults()`:
  read `wpExtractedData[ref]`, render one synthetic
  `"[Example: <Title>]"` row per field with a Title — no AI call, no
  file reads, no writes to `wpExtractedDataRecords`/Postgres.
- Verified with synthetic in-memory state (no live backend login
  available in this environment): button renders correctly next to
  Extract Sample Data; clicking it opens the window with the correct
  banner and one example row per defined field; `wpExtractedDataRecords`
  stays empty after opening; the header's `cursor:move` confirms
  `makeDraggable` is wired; the empty-fields case shows the intended
  "define at least one field" guidance text instead of an empty table.
