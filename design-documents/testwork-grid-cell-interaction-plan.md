# Testwork Grid Cell Interaction — Design

Design-only per request. Covers four related features on the Testwork
Grid's tick cells (the intersection of one attribute × one sample):
(1) click-to-set/override behavior with bulk-override shortcuts,
(2) per-cell review notes with a threaded clearance model plus a new
"Approved" designation, (3) full keyboard navigation of the grid, and
(4) override-modal enhancements (dual tick-mark-explanation display +
a rationale field embedded into the existing vector database).

## Corrections to stated premises

Reading the actual code turned up several places where today's
behavior differs from how the request describes it. These matter
because the new design has to change the *right* thing, not a
remembered-but-inaccurate version of it:

- **The override modal already exists and already does most of
  "part 4"'s override mechanics** — `_openAttrResultsModal(ref,
  attributeIndex, attrRefLabel, attrTitle)` (`public/index.html:37377`).
  It is not a simple "Pass/Fail dropdown" — per sample row it already
  shows a collapsed header (current result + Pass/Fail/Not-tested icon
  + PENDING/OVR badge) that expands into **Pass/Fail buttons**, an
  **explanation textarea** (`placeholder="Explanation (recorded as a
  user override)"`), and an **optional evidence section** (source
  file/page/paragraph). There is no "NOT TESTED" option in the UI
  today — only Pass/Fail. This design extends that existing modal
  rather than replacing it.
- **Every grid cell already calls the same click handler regardless of
  whether it has a result yet** (`public/index.html:12183-12184`):
  `_openAttrResultsModal(...)` fires whether the cell shows a real
  tick or the "not tested" dash. Today there is no
  auto-pass-on-first-click behavior and no adjacent quick-modal — both
  are genuinely new.
- **The override note and the "exception text" sent to the server are
  currently the exact same string** — `_postOverride` (`public/
  index.html:23716`) posts `overrideNote` as both `overrideNote` and
  `exceptionText`, and the server upserts them as two separate columns
  (`override_note`, `exception_text`) holding identical values (`server.js:5912-5934`).
  There is **no existing separate field for "rationale for the
  change"** distinct from the tick-mark explanation itself — that is a
  new field this design adds, not a rename of something that exists.
- **A real, working vector database already exists** — this is not
  new infrastructure to design from scratch. `server.js` has pgvector
  (`CREATE EXTENSION IF NOT EXISTS vector`, `ensureEmbeddingInfra()`,
  `server.js:2171-2183`) and a working Voyage-AI embedding call
  (`_embedText`, `server.js:2185-2213`, model `voyage-4-large`, 1024
  dimensions), already used for two features: reference-file
  suggestions and cross-workpaper attribute-guidance retrieval
  (`server.js:3510-3517`, `3679-3696`). Part 4's "embed the rationale
  so AI can learn from it" is a **new use of existing infrastructure**,
  not a new subsystem.
- **The existing Review Notes system is workpaper-section-level only**,
  keyed by a fixed, hardcoded list of ten section ids (`SECTION_NAMES`,
  `public/index.html:13055-13066` — e.g. `sect-wpinfo`,
  `sect-test-attributes`, `sect-sample-files`...). Nothing today keys a
  note by `(attributeIndex, sampleRowIndex)`. Its statuses are the
  literal strings `'open'`/`'cleared'` (not "Open"/"Cleared" — that
  capitalized pair is a different, unrelated field on Exceptions). A
  "clearance" is not a sibling note — it is a reply object pushed into
  the parent note's own `responses[]` array, which is exactly the
  nesting shape part 2 asks for and this design keeps.
- **No arrow-key navigation exists on the Testwork Grid today.** The
  one existing arrow-key pattern in the app (`public/
  index.html:23457-23479`) is for the Sample Field Extraction grid's
  multi-line textareas, and it **explicitly opts the Test Attributes
  grid out** in favor of click-to-select. The Testwork Grid needs a
  genuinely new navigation implementation; the existing pattern is a
  reasonable template for the "don't steal the keystroke unless it's
  actually a navigation" caution, but the grid shapes differ enough
  that this can't be a copy-paste.
- **No floating window in this app is anchored to the clicked
  element** — all five existing `.notes-window` instances (Review
  Notes, attribute Guidance, Ask Wavefire AI, Mock Extraction Results,
  Extraction Results) open centered and only reposition via manual
  drag. The one place that *does* anchor to a click — the "?" help
  popups (`_toggleHelpPopup`, `public/index.html:26435-26491`) — uses a
  plain `.wf-help-popup` div, not `.notes-window`, with its own
  edge-aware `getBoundingClientRect()` positioning. Part 1's "modal
  immediately to the right of the selected cell" reuses that
  positioning approach, not the centered `.notes-window` one.

## Part 1 — Click behavior: auto-pass, quick modal, and bulk override

### Single click, no existing result (cell shows the "not tested" dash)

1. On click, immediately write a **Pass** result for that cell exactly
   as today's override path does — call the existing `_postOverride(ref,
   attributeIndex, sampleRowIndex, 'pass', '')` and update the tick
   in place (same repaint `_saveOverride` already does for the
   live-tick popup, `public/index.html:23764`). This is a real,
   persisted write, not a placeholder — if the user never opens the
   quick modal or dismisses it without changing anything, the cell
   is genuinely Pass.
2. **Simultaneously**, open a small, non-blocking popover **anchored to
   the immediate right of the clicked cell** (same
   `getBoundingClientRect()`-relative, edge-aware positioning
   `_toggleHelpPopup` already uses, flipping to the left if the cell
   is near the right edge of the viewport) offering:
   - Two buttons, **Pass** / **Fail** (Pass pre-selected/highlighted,
     matching the write that already happened).
   - A single-line explanation field (maps to the existing override
     note — no new field here; this *is* today's `.attr-modal-note`,
     just relocated into the popover).
   - No Evidence section in this quick popover — evidence entry stays
     in the full override modal (part 4 below), reachable if the user
     needs it, so the quick path stays genuinely quick.
3. Choosing **Fail** in the popover re-posts the override as `fail`
   with whatever explanation text is present. Editing the explanation
   text and clicking away (or pressing Enter — see Part 3) saves it
   against whatever result (Pass or Fail) is currently selected.
4. Clicking anywhere outside the popover closes it without further
   action — the auto-Pass (or whatever the user last chose inside it)
   stands, exactly like any other override.

### Single click, cell already has a result (pass or fail, from Analyze or a prior override)

1. Open the **existing** `_openAttrResultsModal`, unchanged in this
   respect — it already restricts itself to the one clicked
   attribute/sample pair for editing that cell's own Pass/Fail +
   explanation + evidence.
2. **New**: add two buttons to this modal's header (next to the
   existing per-row content), each opening a second-level bulk-action
   picker:
   - **"Override other attributes for this sample"** — lists every
     other attribute as a checkbox list (label + title, same styling
     as the Exceptions grid's row selection checkboxes), lets the user
     multi-select, then applies the *same* result + explanation
     entered in the current modal to every selected (attribute, this
     sample) pair via one `_postOverride` call per selected attribute
     — reusing the existing single-cell override path in a loop,
     exactly like `_openAttrResultsModal`'s own OK handler already
     loops over `pending[fi]` today.
   - **"Override this attribute for other samples"** — the mirror
     case: lists every other sample row as a checkbox list, applies
     the same result + explanation to (this attribute, each selected
     sample).
   - Both pickers show a plain confirmation summary before applying
     ("This will mark N cells as Fail with the explanation: '...' —
     Continue?") since this is a multi-cell write, not a single
     override — matching the app's existing pattern of confirming
     before an irreversible-feeling bulk action (e.g. `clearTestworkGrid`'s
     own confirm dialog).
   - Each affected cell goes through `_syncOverrideToAnnotatedFiles`
     exactly as a single override does today, so annotated sample
     files stay consistent — this already loops sequentially per
     changed row in the existing OK handler and needs no new
     mechanism, just a larger input set.

## Part 2 — Per-cell review notes

### Data model

New store, parallel to the existing workpaper-section `reviewNotes`
object but keyed one level deeper:

```js
// { [ref]: { [`${attributeIndex}:${sampleRowIndex}`]: [ noteObj, ... ] } }
const cellReviewNotes = {};
```

Reuses the **exact same** `noteObj` shape the existing Review Notes
system already uses (`public/index.html:13000-13008`) —
`id/authorId/author/ts/text/status/clearedBy/clearedByName/clearedAt/attachments/responses[]`
— so every existing rendering/permission helper
(`_rnCanClearNote`, `_rnFindNote`, the response-thread renderer) is
reused unmodified, just pointed at `cellReviewNotes[ref][cellKey]`
instead of `reviewNotes[ref][sectionId]`. This is a real, deliberate
reuse — not a parallel reimplementation — since the shape, the
clearance-as-nested-response model, and the permission rule
(`_rnCanClearNote`: author or admin/superadmin only) already match
part 2's requirements exactly for the "open a note / clear a note"
half of the ask.

### New third status: "Approved"

Add a status value `'approved'` alongside the existing `'open'`/`'cleared'`.
Semantics, per explicit request: **approved is a property of a
clearance**, not of the note itself — it means "the original reviewer
looked at how this note was cleared and agrees with it." So:

- Only shown as selectable once a note is already `'cleared'` — the
  UI adds an **"Approve clearance"** action next to each clearance
  response in the thread (each element of `responses[]`, not the note
  header), consistent with the request's wording ("designate a
  cleared note as approved" refers to endorsing *that specific
  clearance instance* — since a note can be cleared, reopened, and
  cleared again, potentially by different users, each with its own
  approval state).
- New field per response object: `approved: boolean`,
  `approvedBy`/`approvedByName`/`approvedAt` — added to the existing
  `responses[]` entry shape, not a new top-level array.
- Permission: **only the original note's author (`note.authorId`) or an
  admin/superadmin** may approve — a new guard `_rnCanApproveClearance(note)`
  mirroring the exact same shape as `_rnCanClearNote(note)`
  (`public/index.html:13018-13024`) but checking `note.authorId`
  specifically (not "whoever can clear," which today includes admins
  clearing on someone else's behalf — approval is deliberately
  narrower, matching "only the original reviewer or the admin").
- Visual: an approved clearance gets a small green "✓ Approved by
  {name}" badge under that response, same visual language as the
  existing OVR/PENDING badges elsewhere in the grid.

### Entry point

Per explicit request, cell review notes are **not** a separate button
— they live inside the same modal used for overriding the result
(`_openAttrResultsModal`). Add a "Review Notes" collapsible section
per row (same expand/collapse affordance the row's own Pass/Fail
section already uses), showing:
- The existing thread UI (note text, author, timestamp, nested
  clearance responses, Approve action) reused from the workpaper-level
  Review Notes window's own rendering function, parameterized to
  render into this smaller inline area instead of the floating
  `.notes-window`.
- An "Add note" affordance matching `addNewReviewNote()`'s existing
  behavior, writing into `cellReviewNotes[ref][cellKey]` instead.
- The grid's own dog-ear/indicator convention
  (`injectDogEars()`-style) is not reused verbatim (there's no room
  for a literal dog-ear on a tick cell) — instead, a cell with at
  least one non-blank, unresolved note gets a small dot indicator on
  the tick cell itself, matching the existing "dot only counts
  non-blank notes" rule already established for workpaper-level notes
  earlier this session.

## Part 2b — Same Approve/Reject mechanic, retrofitted onto the existing section-level Review Notes

Per explicit follow-up, the Approve concept from Part 2 is not
cell-notes-only — it extends to the **existing, already-shipped**
workpaper-section Review Notes system (the `reviewNotes[ref][sectionId]`
store and its floating `.notes-window`, `public/index.html:13000-13066`
and the dog-ear-triggered window itself). This is a retrofit onto
real, in-production functionality, not new-system design, so it's
scoped narrowly to what changes:

- **Reject, not just Approve**: a clearance response can now be marked
  `approved: true` (as in Part 2) or `approved: false` with a reason —
  i.e. the reviewer looked at how a note was cleared and disagrees.
  Add `rejectedReason` (free text) alongside the existing
  `approved`/`approvedBy`/`approvedByName`/`approvedAt` fields on the
  response object. A rejected clearance does **not** auto-reopen the
  parent note (that stays a distinct, deliberate action the reviewer
  can also take separately, same as today) — rejection is a
  judgment recorded on that clearance, exactly parallel to approval,
  not a state-machine transition.
- **Bulk action, one or many clearances, one or more users**: the
  existing Review Notes window gains a selection checkbox on each
  clearance response (not on the parent note — clearances specifically,
  matching "clearance comments by one or more users"), plus a small
  action bar (appears once at least one is checked) with **Approve
  selected** / **Reject selected** buttons — both apply to every
  checked clearance in one action, regardless of which parent note or
  which user authored each one, so a reviewer can, in one pass,
  approve three different users' clearances across several different
  notes.
- **Optional additional review note in the same action**: the bulk
  action bar includes one optional textarea, "Add a note (optional)."
  If filled in when Approve/Reject-selected is clicked, it posts as a
  **new top-level note** on the same section (via the existing
  `addNewReviewNote`-equivalent path) in the same operation — not
  attached to any single clearance, since the reviewer may be
  commenting on the batch as a whole (e.g. "Reviewed and agree with
  all of these, see also..."). This keeps the one new textarea genuinely
  optional and doesn't force a 1:1 note-per-clearance relationship
  that isn't what's being asked for.
- **Permission — identical rule to Part 2, reused, not reinvented**:
  `_rnCanApproveClearance(note)` (defined in Part 2) is the single
  source of truth for both the per-cell and the section-level notes —
  only `note.authorId` (the original reviewer who wrote the note being
  cleared) or an admin/superadmin may approve or reject a clearance on
  it. In the bulk picker, a checkbox for a given clearance is simply
  not rendered (rather than rendered-and-disabled) when the current
  user fails `_rnCanApproveClearance` for that clearance's parent note
  — so a reviewer bulk-approving across several notes only ever sees
  the subset they're actually allowed to act on, including in a mixed
  batch where they authored some notes and not others.

### Files touched (addition to the list above)

- The existing Review Notes window renderer (the function that draws
  `reviewNotes[ref][sectionId]` into the `.notes-window`, alongside
  `addNewReviewNote`/`_rnFindNote`/`_rnCanClearNote`): add the
  per-clearance checkbox, the bulk action bar, and calls into the same
  `_rnCanApproveClearance` guard Part 2 introduces.
- No server/schema changes beyond what Part 2 already adds
  (`approved`/`approvedBy`/`approvedByName`/`approvedAt` on a response
  object, now also `rejectedReason`) — review notes are stored
  client-side/per-workpaper today the same way the rest of that
  system already persists (confirm exact persistence path — e.g.
  `_saveWorkpaperToDB` — at build time and extend it, rather than
  assuming a dedicated notes table exists).

### Verification (addition)

1. As the original author of Note A and Note B (both already cleared
   by other users), open the bulk picker: confirm both clearances are
   checkable, check both, click "Reject selected" with a reason —
   confirm both clearances show a rejected badge with that reason, and
   neither parent note silently reopened.
2. As a user who authored neither note, confirm the bulk picker shows
   no checkable clearances at all (not disabled ones).
3. As an admin who authored neither note, confirm all clearances are
   checkable regardless of author, and that approving a mixed batch
   (some notes theirs, most not) succeeds for all of them.
4. Approve two clearances and enter an optional note in the same
   action — confirm exactly one new top-level note is created (not one
   per clearance) alongside the two approvals.

## Part 3 — Keyboard navigation

### Scope and activation

A cell becomes "selected" (for keyboard purposes) when clicked — track
this in one new module-level variable, e.g. `_selectedGridCell = {
ref, attributeIndex, sampleRowIndex } | null`, set on every cell click
alongside the existing `_wpChatSetLastFocus` call already made there
(`public/index.html:12183`), and cleared when focus leaves the grid
(clicking elsewhere, closing the workpaper, etc).

### Behavior, precisely per the spec given

- **Arrow keys** (Up/Down/Left/Right), with no modal open and a cell
  selected: move `_selectedGridCell` to the adjacent cell in that
  direction (Left/Right = adjacent attribute column, same sample row;
  Up/Down = adjacent sample row, same attribute column) and visually
  focus it (a highlighted border, not a click — must not reopen the
  auto-pass-on-first-click behavior from Part 1, since arrow-key
  landing is navigation, not a click).
- **Enter**, no modal open: same effect as ArrowDown — advance one row
  down, *unless* the currently selected cell is on the grid's bottom
  row, in which case Enter (or ArrowDown) advances to the **top of the
  next column to the right** (row 1, attribute index + 1) — this
  matches the spreadsheet-style "Enter wraps to the next column" habit
  explicitly requested.
- **Enter, with a modal open**: acts as "OK" — commits the modal's
  pending change(s) exactly as clicking the modal's own OK button
  does. This requires the override modal's keydown handling to check
  "is any `.notes-window`/popover currently open" before falling
  through to grid-navigation Enter handling — a simple top-of-function
  guard checking a shared `_anyModalOpen()` helper (new, trivial: `!!document.querySelector('.notes-window[style*="flex"], .wf-help-popup')`).
- **Boundary behavior**: any action that would move off the grid's
  edge is a no-op — explicitly including the bottom-right cell, where
  Enter/ArrowDown/ArrowRight all do nothing (there is no "next column"
  because there is no next column). ArrowUp on the top row, ArrowLeft
  on the leftmost column, ArrowDown on the bottom row (when not also
  triggering the wrap-right behavior — see below) are all plain
  no-ops.
- **Reconciling "Down/Enter wraps right on the bottom row" with "moving
  off the grid does nothing"**: the wrap-right behavior *is* the
  defined action for Down/Enter on the bottom row **as long as there
  is a column to the right**; once the selected cell is bottom-row
  *and* rightmost-column (i.e., the last cell in the grid), that
  wrap target no longer exists, so per the explicit "no where to go ...
  nothing should happen" rule, Down/Enter there is a no-op too. The
  two rules aren't in conflict — the wrap is the fallback for
  "bottom row, more columns remain," and pure no-op is the fallback
  for "nowhere left at all."
- **Mouse click** always still works as an alternative to arrow-key
  navigation, exactly as today — clicking a cell selects it (and
  triggers Part 1's click behavior) regardless of keyboard state.

### Implementation shape

One new `keydown` listener, gated the same defensive way the existing
Sample Field Extraction one is (bail immediately if the key isn't one
we care about, bail if `document.activeElement` is inside a live text
input so normal typing/cursor movement is never hijacked — the
override modal's own explanation textarea must keep normal arrow-key
text-cursor behavior while it's focused, which is exactly why the
"is a modal open → Enter means OK" rule takes priority and why plain
arrow keys should only drive grid navigation when the focus is the
grid cell itself, not a textarea inside an open modal).

## Part 4 — Override modal: dual explanation display + embedded rationale

### Show existing and new tick-mark explanation together

When `_openAttrResultsModal` opens a row that already has a saved
override note (or an AI-authored note, if no override exists yet),
show it as **read-only context above** the existing editable
explanation textarea — e.g. a small "Current explanation:" block
followed by the existing `.attr-modal-note` textarea now labeled
"New/revised explanation." This is a display-only addition; the
textarea's existing behavior (free text, posted as `overrideNote` on
OK) is unchanged.

Per explicit request, entering new text here and clicking OK must
**overwrite the existing annotated sample file(s)** with the revised
language — this already happens today via
`_syncOverrideToAnnotatedFiles`, which the OK handler already calls
per changed row (`public/index.html:37701-37713`); no new mechanism
needed, just confirming the existing sync path fires whenever the
explanation text changes, not only when the Pass/Fail result changes
(a small but real behavior check: today's sync call needs to trigger
on note-only edits too, not just result flips — this is the one place
in Part 4 that touches existing logic rather than purely adding to
it).

### New rationale field, embedded for AI learning

Add a second, distinct textarea: **"Why are you changing this?"** —
this is new, not a rename of the explanation field (see the premise
correction above: today there is only one note field, serving as both
the tick-mark text and the audit trail). This field is:

- Stored as a new column, `override_rationale`, on the same
  `attribute_sample_results` upsert `_postOverride`/the server
  endpoint already perform (`server.js:5912-5934`) — one additional
  bound parameter, same statement shape.
- **Embedded into the existing vector infrastructure**, reusing
  `_embedText`/pgvector exactly as reference-file suggestions and
  attribute-guidance retrieval already do (`server.js:2185-2213`,
  `3510-3517`). Concretely: a new table `override_rationale_embeddings`
  (tenant_id, workpaper_ref, attribute_index, sample_row_index,
  old_result, new_result, old_note, new_note, rationale_text,
  embedding vector(1024), created_at) — kept separate from
  `attribute_current_embeddings`/`attribute_edit_history` rather than
  overloading either, since this is a distinct kind of record (a
  *reason for disagreeing with Analyze on one sample*, not an edit to
  the attribute's own language) even though it feeds the same
  eventual purpose. "Chunked" per the request means: embed the
  rationale text together with enough surrounding context (attribute
  title, old→new result, old→new note) in one chunk per override event
  — not literally splitting one short rationale into multiple chunks,
  since a single override's rationale is short-form text, not a
  document; chunking in the "split long text for embedding" sense
  applies if a rationale is unusually long (over roughly 2,000
  characters — reuse whatever chunk-size convention
  `ensureEmbeddingInfra`/existing ingestion already uses, if any is
  found at build time, rather than inventing a new threshold).
- **Where this feeds back in**: this design does not build a new
  retrieval UI. It reuses the existing retrieval pattern (cross-
  workpaper attribute similarity search, `server.js:3679-3696`) as the
  natural consumer — when a user is later editing that same
  attribute's Additional Information/Success/Failure Criteria (the
  existing attribute-editing UI), the existing
  guidance-suggestion mechanism gains one more evidence source: past
  override rationales for this attribute (or similar attributes,
  via the same cosine-similarity query), surfaced the same way
  existing suggestions are today. This directly answers the "also
  reference the guidance button" note — the existing "AI Guidance"
  button/modal (`_toggleAttrGuidanceModal`, `public/
  index.html:12284`) is the natural place this shows up, since it
  already assembles per-sample reasoning for an attribute; it gains a
  new section, "Past overrides on this attribute," listing rationale
  text alongside the old→new result it explains.

## Files touched

All in `public/index.html` unless noted:
- `renderAnalysisResultsGrid` / the tick-cell template (`~12137-12185`):
  new onclick branching (has-result vs. no-result), `_selectedGridCell`
  tracking, a small dot indicator for cells with open review notes.
- New: `_openCellQuickPopover(...)` (Part 1's anchored quick
  Pass/Fail popover), reusing `_toggleHelpPopup`'s positioning math.
- New: `_openBulkOverridePicker(mode, ref, attributeIndex, sampleRowIndex, result, note)`
  for the two bulk-override buttons in `_openAttrResultsModal`.
- `_openAttrResultsModal` (`37377` on): dual explanation display, new
  rationale textarea, the two new bulk-override header buttons, a new
  per-row "Review Notes" collapsible section.
- New `cellReviewNotes` store + `_rnCanApproveClearance` +
  reuse-not-fork of the existing note-rendering functions
  parameterized by store/key.
- New grid keydown listener implementing Part 3.
- `_toggleAttrGuidanceModal`/`_buildAttrGuidanceSections`
  (`~12264-12332`): new "Past overrides on this attribute" section.
- `server.js`: `attribute_sample_results` gains `override_rationale`;
  new `override_rationale_embeddings` table + `ensureEmbeddingInfra()`
  extension; override endpoint (`5912-5934`) embeds and stores the
  rationale on write; extend the existing attribute-similarity query
  (`3679-3696`) to also search this new table.

## Verification (for the eventual build)

1. Click an untested cell — confirm it immediately becomes Pass
   (persisted — reload the workpaper and confirm it stayed Pass) and
   the anchored quick popover appears to its right (or left, near a
   viewport edge), pre-selected on Pass.
2. Click a cell with an existing result — confirm the full override
   modal opens (unchanged for the single-cell case), and that both new
   bulk-override buttons correctly multi-write to every checked
   attribute/sample after a confirm step, including a correct
   `_syncOverrideToAnnotatedFiles` prompt for every affected annotated
   file.
3. Add a cell review note, clear it as a second user, approve that
   clearance as the original author — confirm a non-author,
   non-admin third user cannot see/use the Approve action; confirm an
   admin can approve on the original author's behalf.
4. From a selected cell, exercise every arrow direction, Enter with no
   modal open (including the bottom-row-wraps-right case and the
   bottom-right-cell no-op case), and Enter with a modal open (acts as
   OK) — confirm no case throws focus outside the grid or double-fires
   a save.
5. Edit only the explanation text (no result change) on an already-
   overridden cell with an annotated file — confirm the sync-to-
   annotated-files prompt still fires (this is the one existing-logic
   change flagged above). Enter a rationale, confirm a row lands in
   `override_rationale_embeddings` with a non-null embedding, and that
   it appears under "Past overrides on this attribute" in that
   attribute's Guidance modal.
