# Review Note Status Indicators — Section Dots + Testwork Grid Triangles

Design-only. Extends the existing section-level review-note dot
indicator with a third state (fully resolved: cleared *and* the
clearance approved), and designs a new, analogous per-cell indicator
for the Testwork Grid — a small colored/hollow triangle in each tick
cell's upper-right corner — using the same three-color language.

This design depends on **two things built by
`testwork-grid-cell-interaction-plan.md`** (Part 2 and Part 2b): the
per-cell review notes store (`cellReviewNotes`) and the
Approve/Reject-clearance mechanic. Nothing here works without those
existing first; this doc only adds the visual indicator layer on top.

## Key facts about the existing dot system (read directly from code)

- `injectDogEars()` (`public/index.html:13079-13092`) builds the
  22×22px triangular dog-ear corner per section; it does not draw the
  dot itself.
- `updateDogEarDot(sectionId, total, clearedCount)`
  (`public/index.html:13437-13459`) is the actual dot renderer — a
  7×7px `border-radius:50%` span, `position:absolute;top:2px;right:2px`
  inside the dog-ear corner:
  ```js
  if (total === 0) {
    dot.style.display = 'none';
  } else if (clearedCount < total) {
    dot.style.background = '#ea580c';   // orange — has uncleared note(s)
  } else {
    dot.style.background = '#2563eb';   // blue — all cleared
  }
  ```
- `_rnUpdateDot(ref, sectionId)` (`public/index.html:13372-13379`)
  computes `total`/`clearedCount`, filtering out blank notes first —
  "a dot only counts non-blank notes" is real, existing behavior:
  ```js
  const notes = ((ref && reviewNotes[ref]?.[sectionId]) || []).filter(n => (n.text || '').trim());
  updateDogEarDot(sectionId, notes.length, notes.filter(n => n.status === 'cleared').length);
  ```
  This is a simple "worst case wins" aggregate: **one** open note among
  many cleared ones still turns the whole section's dot orange.
- Today there is **no** per-cell indicator of any kind for review
  notes inside the Testwork Grid. The only things currently stacked
  inside a tick cell are the exception Ref tag and the OVR badge
  (`public/index.html:12159-12160`), both plain text divs, not
  dots/shapes, and neither absolutely positioned. Tick cell columns
  are a fixed **70px wide** (`ATTR_COL_W`, `public/index.html:12110`),
  with `padding:6px 10px` (`public/index.html:12115`) — plenty of room
  for a small 8-10px corner marker without crowding the existing tags,
  but the cell wrapper itself currently has no `position` set, so it
  needs `position:relative` added for an absolutely-positioned corner
  marker to anchor correctly.

## Part A — Third dot state for section-level Review Notes: "Approved"

### What "fully resolved" means, precisely

A single note can have been cleared and re-cleared multiple times
(reopened, cleared again) — Part 2b's Approve/Reject applies to a
**specific clearance** (one entry in that note's `responses[]`), not
to the note as a whole. So "is this note fully resolved" has to look
at the note's **most recent clearance response**, not just its current
`status`:

- **Open tier** (orange): `note.status === 'open'`, **or**
  `note.status === 'cleared'` but that note's latest clearance
  response was **rejected** (`approved === false`) and the note has
  not since been re-cleared/re-approved. A rejected clearance is a
  live disagreement — it should read exactly as urgently as a note
  nobody has cleared yet, not as "already handled."
- **Cleared tier** (blue, existing color, unchanged meaning): the
  note is `'cleared'` and its latest clearance response has **no**
  approval decision yet (`approved` is `undefined` — neither approved
  nor rejected).
- **Approved tier** (new — **hollow dot**): the note is `'cleared'`
  **and** its latest clearance response has `approved === true`.

### Rendering: hollow dot

Same 7×7px circle, same position (`top:2px;right:2px` inside the
dog-ear), but instead of a third solid color, render it **hollow** —
transparent fill with a colored ring, to read visually as "done,
nothing outstanding" rather than adding a third saturated color that
competes with orange/blue for attention:

```css
/* Approved tier — hollow ring instead of a filled dot */
background: transparent;
border: 1.5px solid #2563eb; /* same blue used for "cleared", now unfilled */
box-sizing: border-box;
```

Reusing blue (outlined instead of filled) rather than inventing a
fourth color keeps the palette to exactly two hues total, matching the
request's "using the same colors" instruction for the grid triangles
below, and keeps blue's meaning ("this note's clearance is the
current, non-open state") consistent across both the filled and
hollow variants — hollow is just blue *plus* reviewer sign-off.

### Aggregate logic (worst case, three-way)

`_rnUpdateDot` extends from a two-way to a three-way tier count, still
worst-case-wins, in the natural severity order **Open-tier >
Cleared-tier > Approved-tier**:

```js
function _rnUpdateDot(ref, sectionId) {
  const notes = ((ref && reviewNotes[ref]?.[sectionId]) || []).filter(n => (n.text || '').trim());
  if (!notes.length) { updateDogEarDot(sectionId, 0, null); return; }
  const tier = notes.map(_rnNoteTier).reduce((worst, t) => Math.max(worst, t), 0); // 0=approved,1=cleared,2=open
  updateDogEarDot(sectionId, notes.length, tier);
}
function _rnNoteTier(note) {
  if (note.status !== 'cleared') return 2; // open
  const latest = _rnLatestClearance(note); // last entry in responses[] that represents a clearance action
  if (!latest) return 1;                    // cleared, no clearance response recorded (shouldn't normally happen)
  if (latest.approved === false) return 2;  // rejected — treat as open-tier
  if (latest.approved === true) return 0;   // approved — hollow
  return 1;                                 // cleared, awaiting a decision
}
```

`updateDogEarDot` gains a third branch instead of the current
if/else pair, keyed on the numeric tier rather than the previous
`clearedCount < total` comparison (which can't express three states).

## Part B — Testwork Grid per-cell triangle indicator

### Shape and placement

A right triangle occupying the **upper-right corner** of the tick
cell — per the exact geometric description given: take the cell's
corner as a small square, cut it along the diagonal from **top-left
to bottom-right**, and fill the **upper-right** half (the triangle
whose three corners are the square's top-left, top-right, and
bottom-right points).

Implemented as one small inline SVG per cell (not a CSS border-trick)
specifically so the third, hollow state can share the same markup as
the other two — a border-trick triangle *is* its own border, so it
cannot be made hollow without a second, different technique; an SVG
polygon just switches between `fill` (solid) and `fill="none"` +
`stroke` (hollow) with everything else identical:

```html
<svg class="grid-note-triangle" width="9" height="9" viewBox="0 0 10 10"
     style="position:absolute;top:1px;right:1px;pointer-events:none">
  <polygon points="0,0 10,0 10,10" fill="#ea580c"/>  <!-- open tier -->
</svg>
```
- **Open tier** (orange): `fill="#ea580c"`, no stroke.
- **Cleared tier** (blue): `fill="#2563eb"`, no stroke.
- **Approved tier** (hollow): `fill="none" stroke="#2563eb" stroke-width="1.2"` — an outlined triangle, the same shape, echoing the hollow dot's "blue, but unfilled" treatment.

Sizing: 9×9px sits comfortably in the 70px-wide, `padding:6px 10px`
tick cell without overlapping the centered tick glyph or the stacked
Ref/OVR tags beneath it, which occupy the cell's vertical center and
bottom, not its top corner. The tick cell's wrapper div gains
`position:relative` (currently unset) so the triangle's
`position:absolute;top:1px;right:1px` anchors to the cell itself, not
some further-out ancestor.

### Per-cell tier logic — reuses Part A's tier function

Once `cellReviewNotes[ref][cellKey]` exists (from
`testwork-grid-cell-interaction-plan.md` Part 2), the exact same
`_rnNoteTier`/worst-case-aggregate logic from Part A applies, just
against that cell's own note list instead of a section's:

```js
function _cellNoteTriangleTier(ref, attributeIndex, sampleRowIndex) {
  const key = `${attributeIndex}:${sampleRowIndex}`;
  const notes = (cellReviewNotes[ref]?.[key] || []).filter(n => (n.text || '').trim());
  if (!notes.length) return null; // no triangle at all
  return notes.map(_rnNoteTier).reduce((worst, t) => Math.max(worst, t), 0);
}
```
Returning `null` means **no note has ever existed for this cell** —
render nothing, exactly matching "if a cell never has a review note,
there will be no triangle."

### Persistence — the triangle cannot disappear except on grid clear/rebuild

This is the one genuinely new behavioral rule this design adds, not
just a rendering rule: **once a cell has ever had a non-blank review
note, its triangle must keep showing (in whatever is the current
worst-case color) for the life of that Testwork Grid**, even if every
note on that cell is later cleared and approved (in which case it
simply shows hollow, per Part A's tiering — hollow is still a
triangle, not "no triangle"). The only two things that make a
triangle for a given cell disappear entirely:

1. **`clearTestworkGrid()`** (`public/index.html:37003` region) — this
   already wipes the grid's own `_wpAnalysisResults[ref]` snapshot and
   pass/fail overrides. It must now **also** delete
   `cellReviewNotes[ref]` entirely for that workpaper — today it
   explicitly does not touch Exceptions/Findings/annotated files, but
   cell review notes are keyed by `attributeIndex:sampleRowIndex`
   against a grid that no longer exists once cleared, so keeping them
   around would be meaningless (and could even wrongly reattach to
   different attribute/sample pairs after a rebuild). This is a real,
   new addition to `clearTestworkGrid`'s existing responsibilities,
   not an incidental side effect — call it out explicitly in that
   function's own confirm-dialog copy ("This also clears any review
   notes recorded on individual grid cells") so the existing
   "Exceptions/Findings/annotated files are not affected" guarantee
   stays accurate and this new one is stated just as plainly.
2. **Re-running Analyze**, which rebuilds `_wpAnalysisResults[ref]`
   from scratch (the same snapshot `createTestworkGrid` and Analyze's
   own completion path both write to) — since this already goes
   through the same combined overwrite-warning confirmation Analyze
   uses today before replacing an existing grid (`manual-testwork-grid-plan.md`
   Part 7's "combined pre-flight warning"), `cellReviewNotes[ref]` is
   purged at that same moment, for the same reason as above.

Explicitly **not** a way to clear a triangle: clearing/deleting an
individual note's text, since existing review notes are never
hard-deleted anywhere in this app (only cleared/reopened) — there is
no "delete a note" action to design around here, so this rule needs no
special case for it.

## Files touched

All in `public/index.html`, all additive to
`testwork-grid-cell-interaction-plan.md`'s own file list:
- `updateDogEarDot` / `_rnUpdateDot` (`13372-13459`): three-way tier
  logic, hollow-ring rendering branch.
- New `_rnNoteTier(note)` / `_rnLatestClearance(note)` helpers, shared
  by both the section dot and the new grid triangle.
- Tick-cell template in `renderAnalysisResultsGrid`
  (`~12137-12185`): add `position:relative` to the cell wrapper, a new
  `_cellNoteTriangleTier(...)` call, and the conditional inline-SVG
  triangle markup.
- `clearTestworkGrid()` (`~37003` region) and the Analyze-overwrite
  completion path: purge `cellReviewNotes[ref]`; update
  `clearTestworkGrid`'s confirm-dialog copy to disclose it.

## Verification (for the eventual build)

1. A section with one open and two cleared-and-approved notes shows an
   orange dot (worst case). Clear and approve the last open note —
   dot turns hollow. Reject that same note's clearance afterward
   (Part 2b) — dot returns to orange, not blue.
2. A Testwork Grid cell with no note ever entered shows no triangle.
   Enter a note — orange triangle appears in the upper-right corner,
   correctly sized and non-overlapping with the tick glyph, Ref tag,
   and OVR badge. Clear the note — triangle turns blue. Approve that
   clearance — triangle turns hollow (outline only, not solid).
3. With a hollow (approved) triangle showing, click "Clear Testwork
   Grid" — confirm the dialog now discloses that cell review notes
   will also be cleared, confirm, and confirm the rebuilt grid (via
   "Create Testwork Grid" or Analyze) shows no triangles anywhere,
   even on cells that reuse the same attribute/sample position as
   before.
4. Re-run Analyze over an existing grid that has cell notes/triangles
   — confirm the existing combined overwrite-warning fires as it does
   today, and confirm triangles are gone after the new grid is built,
   without needing a separate, second confirmation just for the notes.
