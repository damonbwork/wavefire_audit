# Workpaper Review Lock — Design

## Context

The app has two, deliberately independent review mechanisms today:

1. **Per-item "Reviewed" buttons** — scattered on individual sample
   files and testwork items (`markFileReviewed`/`fileReviewState`,
   `public/index.html:31569`). These are a reviewer's personal
   checklist — "I've looked at this specific thing" — and any user can
   toggle any of these at any time, independently of every other one.
   **This design does not change that mechanism at all.** It stays
   exactly as free-form and overridable as it is today, by design.
2. **The workpaper-level "Reviewed" button** in the workpaper header
   (`wp-review-btn` / `addWPReview()` / `wpReviewLog[ref]`,
   `public/index.html:7709`) — today this is just a log: pressing it
   appends `{reviewer, ts}` to `wpReviewLog[ref]` and stamps a "Date
   reviewed" field. It has no effect on anyone's ability to edit the
   workpaper.

This design adds a **lock** driven by mechanism #2, and a separate,
lighter-weight **designated-reviewer** concept that exists independently
of it. Per explicit direction, the two are related but not coupled:
anyone can name a reviewer at any time, but the lock is only ever
engaged by an actual review sign-off, which may be performed by a
different person than whoever was named.

## Definitions

- **Designated reviewer** (`w.reviewer`, the existing `wpd-reviewer`
  dropdown, `public/index.html:2722`) — informational. Says who is
  expected/intended to review the workpaper. Any user can set or change
  this at any time. Setting it has **no locking effect** and does not
  require the named person to be the one who eventually signs off.
- **Reviewed / signed off** (`wpReviewLog[ref]`, the header "Reviewed"
  button) — an actual, timestamped review event performed by whoever
  pressed the button, stamped with **their own** identity via
  `_admCurrentUserName()` (already correct — never the designated
  reviewer's name unless they happen to be the same person). The most
  recent entry in `wpReviewLog[ref]` (index 0, since `addWPReview`
  unshifts) is the **active reviewer of record** — the person whose
  removal/unlock authority governs the lock below.
- **Locked** — once `wpReviewLog[ref].length > 0`, the workpaper is
  locked: edits are blocked for everyone except the active reviewer of
  record and an admin/superadmin (see Permission rule below).

## Superadmin override (explicit)

A superadmin (`_currentDisplayUser.is_superadmin`) can change the
**designated reviewer** dropdown and can set or clear the **reviewed/
locked state** at any time, regardless of who is the active reviewer of
record or whether the workpaper is currently locked — this is already
implied by the Permission rule below for edits/clearing, but is called
out here explicitly since it's a hard requirement, not just a
side-effect: a superadmin's own "Reviewed" press becomes the new active
reviewer of record exactly like anyone else's (it still stamps *their*
identity, not a bypass-flagged entry), and a superadmin's "Clear" always
succeeds on the active entry even if they aren't that reviewer. Tenant
`admin` role gets the same edit/clear rights per the Permission rule
below, but this bullet exists to make explicit that `is_superadmin`
alone is always sufficient, independent of tenant-level `role`.

## Permission rule

A user may make an edit to a locked workpaper only if at least one of:

- `req` user's identity matches the active reviewer of record
  (`wpReviewLog[ref][0].reviewer`, compared by user id — see Identity
  matching below, not by display-name string), **or**
- the user is an admin for the current tenant (`_currentDisplayUser.role
  === 'admin'`) or a superadmin (`_currentDisplayUser.is_superadmin`).

Everyone else gets a blocked edit with a clear, non-destructive message
(see UI below) rather than a silent no-op or a confusing server error.

**Removing the reviewer (unlocking)** uses the *same* rule, phrased as
its own explicit action rather than an edit side-effect: the active
reviewer of record can always remove their own sign-off, and an
admin/superadmin can always remove anyone's, via the existing "Clear"
link on the top review-log entry (`clearWPReviewEntry`, already wired —
see Implementation, it just needs the permission check added). No one
else sees a "Clear" control on the active entry at all (older, already-
superseded log entries below it are historical and stay clearable by
admins only, matching today's audit-trail intent — see Multiple sign-
offs below).

## Identity matching

`wpReviewLog` entries currently store only a display-name string
(`reviewer`), which is not a safe key to gate permissions on (two users
can share a rendered name, and a renamed user would silently lose their
own unlock rights). Add a `reviewerId` field (the acting user's stable
`user_id`) alongside the existing `reviewer` display string on every new
entry going forward; permission checks use `reviewerId` when present and
fall back to comparing `reviewer` against `_admCurrentUserName()` for
old entries created before this field existed (never break existing
workpapers already reviewed under the old shape).

## What "locked" blocks

This is now a precise allow-list, not a general principle: while locked,
**exactly two things** remain editable by any user, and every other
mutation to the workpaper is blocked with a hard warning (see below).

### The two carve-outs (editable by any user, even while locked)

1. **Clearing an existing review comment** — the per-section reviewer
   note-taking mechanism (`reviewNotes[ref][sectionId]`, the "notes"
   window opened via `openNotesWindow(sectionId)`, `public/index.html
   :12059, 12255`), specifically its per-entry "cleared" toggle
   (`data-cleared`, `public/index.html:12135, 12223, 12304`). Any user
   may mark an existing comment cleared/resolved (or un-clear it) while
   the workpaper is locked. **Entering a brand-new comment is NOT
   included in this carve-out** — see below.
2. **The per-item "lower-tier" review marks** — the personal-checklist
   "Reviewed" buttons scattered on individual sample files and testwork
   items (mechanism #1 in Context above; `markFileReviewed`/
   `fileReviewState`, `public/index.html:31569`). Any user may set or
   clear any of these at any time regardless of lock state, exactly as
   today — unrelated by design to the header-level review lock.

Both carve-outs stay exactly as unrestricted as they are today — no new
permission check is added to either of these two code paths.

### Explicitly NOT part of either carve-out (blocked while locked)

- **Adding a new review comment/note** — a brand-new entry in the same
  `reviewNotes` window described above is a workpaper content change,
  not a clear/resolve action, and is blocked like everything else.
  `closeNotesWindow(save)`'s save path must distinguish "an existing
  entry's cleared-state changed" from "the entry text itself changed or
  a new entry was added" — see Implementation sketch below for exactly
  how.
- Every other mutation to the workpaper's own content: attribute edits,
  sample data edits, Analyze runs (`analyzeWithClaude`,
  `createTestworkGrid`), override saves (`_saveOverride`,
  `_openAttrResultsModal`'s OK-handler), Exceptions/Findings/
  Recommendations add/edit/reclassify/delete (`addGridItem`,
  `_reclassifyGridItem`, `_deleteGridItem`), file uploads/deletes to the
  sample/reference buckets, narrative/notes text fields (other than the
  one carve-out above), the "Clear Sample Data"/"Clear Testwork Grid"
  buttons, and the **designated-reviewer dropdown** (superseding the
  earlier draft of this design, which had left the designated-reviewer
  dropdown unguarded while locked — per this explicit instruction, it
  is now locked like everything else except the two carve-outs; the
  Superadmin override section already covers a superadmin's ability to
  change it regardless).
- The active reviewer's or an admin's/superadmin's own edits are still
  exempt from all of the above, per the Permission rule below — this
  section describes what's blocked *for everyone else*.
- Viewing, exporting (xlsx/PDF), and printing remain unrestricted for
  everyone regardless of lock state (read-only by nature, not a
  mutation).

### Hard warning on a blocked attempt

Per explicit instruction, a blocked attempt gets a **hard warning**, not
a passive toast: an actual modal dialog (reuse the existing
`rcmConfirmDelete`-style modal shell, OK-only — no "proceed anyway"
option, since there is no possible confirmation that makes the action
allowed) stating plainly that the workpaper cannot be updated while in a
reviewed state, naming the active reviewer, and stating that only that
reviewer or an admin can remove the "Reviewed" lock before changes can
be made. This replaces the earlier draft's lighter rate-limited toast
for anything outside the two carve-outs (the toast approach may still
be appropriate specifically for rapid-fire attempts like typing into a
locked text field — debounce so the user gets one hard dialog per
distinct attempt, e.g. per field-blur or per button click, not one per
keystroke).

## Multiple sign-offs / re-review after unlock

`wpReviewLog[ref]` already keeps every past entry, not just the latest
— this stays true. When the active (index-0) entry is cleared, the
workpaper unlocks immediately, and the cleared entry does **not**
disappear from the log; it simply stops being the active entry (matches
today's `clearWPReviewEntry` behavior exactly — no change needed there
beyond the permission gate). If someone (the same or a different person)
presses "Reviewed" again later, a new entry is unshifted to index 0 and
the workpaper re-locks under that new active reviewer.

## UI

- **Header "Reviewed" button**: unchanged in appearance/behavior for
  the person who is allowed to press it. Once locked, for every other
  user the button still shows the "Reviewed ✓" green state (so they can
  see it's reviewed) but the log's "Clear" affordance next to it is
  hidden for anyone but the active reviewer/an admin (not merely
  disabled-looking — hidden, so no one is invited to click something
  that will just reject them).
- **Blocked-edit feedback**: per the Hard warning subsection above, a
  blocked attempt (anything outside the two carve-outs) shows an actual
  modal dialog, not a passive toast — reading e.g. *"This workpaper was
  reviewed and signed off by Jane Doe on Sep 3, 2026. It cannot be
  updated while in a reviewed state. Only Jane or an admin can remove
  the review lock before changes can be made."* Debounced per distinct
  attempt (field-blur/button-click), not per keystroke.
- A locked workpaper also gets a small persistent indicator near the
  header "Reviewed" pill (e.g. a lock glyph) so the state is visible at
  a glance without needing to attempt an edit first.
- **Confirmation bubble on locking**: the instant a user presses the
  header "Reviewed" button (`addWPReview()`, transitioning the
  workpaper into locked state), show a small transient bubble/tooltip
  next to the button — informational only, auto-dismissing after a few
  seconds, not a modal and not requiring acknowledgment — reading e.g.
  *"Workpaper locked. Only [reviewer name] or an admin can make further
  changes."* This fires once, at the moment of locking, for the person
  who just performed the sign-off (so they immediately know the effect
  of the action they just took), and is separate from the hard-warning
  modal above, which fires later for anyone *else* who then attempts a
  blocked edit.

## Precisely how the reviewed indicator gets removed

The "reviewed indicator" is actually three things rendered from one
source (`wpReviewLog[ref]`), and clearing must update all three
consistently — this is exactly what the existing `clearWPReviewEntry`
already does today for the log itself; this section specifies the
permission gate around it and confirms nothing about its existing
mechanics needs to change:

1. **The review-log list** (`wp-review-log` container, rendered by
   `renderWPReviewLog`) — each entry shows `<reviewer name> · <date +
   time>` with its own "Clear" link (`public/index.html:7776-7787`).
   Clicking "Clear" on an entry calls `clearWPReviewEntry(idx)`, which
   does `wpReviewLog[ref].splice(idx, 1)` — the entry is removed
   **outright**, not soft-deleted or flagged; there is no "undo" once
   cleared (matches today's behavior — worth flagging since this is a
   destructive action gated only by the permission check, not by a
   confirmation dialog today; see Open question below).
2. **The header "Reviewed" pill/button** (`wp-review-btn`) — after a
   clear, `resetWPReviewBtn()` re-checks `wpReviewLog[ref].length`; if
   the log is now empty it reverts the button to its unreviewed style
   (white background, "Reviewed" plain text, no checkmark). If other
   (older) entries remain below the one just cleared, the button stays
   in its green "Reviewed ✓" state, because the workpaper is still
   reviewed under the next entry down — see below for what "next entry
   down" means for the lock specifically.
3. **The "Date reviewed" field** (`updateWPDateReviewed`, both the
   workpaper-detail page's own field and the `.wp-review-date-cell` in
   the workpaper list row) — recomputed from `wpReviewLog[ref][0]`
   (the new top entry, if any) after the splice; if the log is now
   empty this field reverts to `'—'` in tertiary/italic style. It is
   never left showing a stale date after a clear.

**Which entry actually gets cleared, precisely:**

- The "Clear" link on the **active** entry (index 0 — the current
  reviewer of record) is the one gated by the Permission rule /
  Superadmin override above: visible only to the active reviewer
  themselves, a tenant admin, or a superadmin (everyone else does not
  see this particular "Clear" link at all, per the UI section above).
  Clicking it: removes index 0, and if a prior entry now exists at the
  new index 0, that prior reviewer immediately becomes the new active
  reviewer of record and **the workpaper stays locked** under them
  (does not fall through to "unreviewed" just because the most recent
  sign-off was undone) — only when the log becomes fully empty does the
  workpaper actually unlock. This case (multiple entries, clearing the
  top one) is expected to be rare in practice but the mechanism should
  behave correctly rather than accidentally unlocking under someone's
  stale older sign-off, or accidentally staying "locked" with no valid
  active reviewer.
- "Clear" links on any **non-active** (older, already-superseded)
  entries stay visible to admins/superadmins only (unchanged from
  today's implicit behavior, now made an explicit permission check per
  the Implementation sketch below) and never affect the lock, since the
  lock only ever looks at index 0.
- There is intentionally no separate "unlock without clearing history"
  action — unlocking IS clearing the active log entry. This keeps there
  being exactly one mechanism to reason about instead of two competing
  ones (a "lock flag" and a "log," which could drift out of sync).

**Open question worth confirming before building:** should clearing the
*active* entry (the one that actually unlocks the workpaper) get its own
small confirmation prompt (reusing `_sdShowGenericConfirm`), given it's
now a higher-stakes action than before (removing it also reopens the
workpaper to edits, not just tidying a log)? Recommend yes, to avoid an
accidental click silently reopening a signed-off workpaper — flagging
this explicitly rather than assuming either way.

## Review Notes — structural redesign

**Implemented and verified (Sep 8, 2026).** Built exactly as designed
below, with two scope notes:
- The lock-guard hooks (`_guardWpEdit`) for creating brand-new notes/
  responses are wired defensively (`typeof _guardWpEdit === 'function'`)
  since the workpaper-review-lock feature itself hasn't been built yet —
  they'll activate automatically once it is, with no further changes
  needed to this file.
- `reviewNotes` remains front-end-only (in-memory), matching its
  pre-existing behavior — it was never persisted to the backend before
  this change either; persisting it is a separate, not-yet-scoped piece
  of work.
Verified via synthetic data injection against the dev server: title/
subtitle, real-username stamping (fixing the `jdavis` bug), threaded
indented responses from a different user, the tightened author-or-admin
clear permission (a non-author/non-admin is blocked with an alert; the
author succeeds; an admin can also reopen a note they didn't author),
and file attachment linking with View/Download actions rendered per-note.


The per-section notes window (`reviewNotes[ref][sectionId]`,
`openNotesWindow`/`closeNotesWindow`/`addNoteEntry`,
`public/index.html:12059-12312`) is the mechanism carve-out #1 above
refers to. Its current implementation is much thinner than what this
design now needs it to do, and has a couple of real, pre-existing bugs
worth fixing in the same pass:

**Bugs in the current implementation, confirmed by reading the code:**
- `makeNoteHeader()` (`public/index.html:12103-12108`) hardcodes the
  literal username `jdavis` into every new note's header text, instead
  of calling the existing shared `_admCurrentUserName()` helper used
  everywhere else in the app. Must be fixed as part of this redesign
  regardless of the rest of the scope below.
- Each note's "cleared" status lives only in a DOM attribute
  (`clearBtn.dataset.cleared`) set at click-time — `closeNotesWindow`'s
  save path never persists it into `reviewNotes[ref][sectionId]`, so a
  note's cleared/open status is silently lost on close/reopen. This is
  fixed by the structured data model below, which makes status a real,
  persisted field.
- Entries today are raw strings with the "author · date/time" header
  baked directly into the text itself (`makeNoteHeader()`'s return
  value is literally prepended to the textarea's content) rather than
  stored as separate structured fields — this makes threaded responses,
  a real status field, and attachments impossible to add cleanly. The
  redesign below replaces this with one structured object per note.

### Modal title

Per explicit instruction, the modal's title is always the literal
**"Review Notes"** — never the section name. `openNotesWindow(sectionId)`
currently sets `title.textContent` to `SECTION_NAMES[sectionId]`
uppercased (`public/index.html:12264`); change the title element itself
to a fixed "Review Notes" and move the section name to a small
secondary subtitle line underneath (so the user still knows which
section's notes they're looking at — the app has 9+ sections in the
`SECTION_NAMES` registry, and dropping that context entirely would be a
regression, not just a rename).

### Data model

Replace the array-of-strings shape with one structured object per
top-level review note, still keyed the same way
(`reviewNotes[ref][sectionId]`, an array):

```js
{
  id: '<uuid or timestamp-based id>',
  authorId:   '<user_id of the person who wrote it>',
  author:     '<display name at time of writing — snapshot, not a live lookup>',
  ts:         '<created timestamp, same format as elsewhere: nowStamp()/existing date+time convention>',
  text:       '<the note body text the author typed>',
  status:     'open' | 'cleared',
  clearedBy:  '<user_id, only when status === "cleared">',
  clearedByName: '<display name, snapshot>',
  clearedAt:  '<timestamp, only when status === "cleared">',
  attachments: [
    { name: '<file name>', source: 'sample' | 'reference' | 'uploaded', fileKey: '<lookup key into the existing in-memory file store, or a new upload id>' }
  ],
  responses: [
    {
      id: '<uuid>',
      authorId: '<user_id>',
      author:   '<display name snapshot>',
      ts:       '<timestamp>',
      text:     '<response body>',
      attachments: [ /* same shape as above */ ],
    },
    // ...as many as needed, same author or different authors, always
    // appended in chronological order
  ],
}
```

`author`/`clearedByName` are deliberately **snapshots taken at write
time**, not live lookups against the current user list — matching how
every other stamped field in this app already behaves (`_admCurrentUserName()`
is called once, at the moment of the action, everywhere else it's used)
so a note's history doesn't retroactively change if the author is later
renamed or removed.

### Rendering

Each top-level review note renders as one block:

1. **Header row**: author name + timestamp (via `_admCurrentUserName()`
   at write time — fixing the `jdavis` bug above) on the left, and an
   explicit **status marker** on the right — a two-state pill/toggle
   reading "Open" or "Cleared" (both states visibly rendered with
   distinct styling — e.g. Open in a neutral/amber pill, Cleared in the
   existing blue-filled style the current `clearBtn` already uses —
   rather than one state being a bare unstyled default and the other
   the only "real" visual state, so it's unambiguous which one a note
   is in at a glance). Clicking the marker toggles it, subject to the
   permission rule below.
2. **Body**: the note's own text (read-only after creation — editing an
   existing note's own text is out of scope here; only new responses
   and status changes are supported post-creation, matching the "add a
   response" model requested rather than in-place editing).
3. **Attachments row** (only rendered when non-empty): every file
   linked or uploaded to this note, each shown as a clickable link — a
   view/open action and a separate download action — per the
   Attachments section below.
4. **Responses**, each rendered **indented** under the parent note (a
   left margin/border, visually subordinate to the note the way a
   threaded reply looks), in chronological order, each with its own
   author + timestamp header (same `_admCurrentUserName()`-stamped
   pattern), its own body text, and its own attachments row at the
   bottom of that specific response (not merged into the parent note's
   attachment list — each response's files are listed under that
   response, per explicit instruction "shown... where they were
   added").
5. **"Add response" control** at the bottom of each note's thread (below
   its last response, still indented at the response level) — a small
   inline textarea + "Add response" button, available to **any** user
   (not just the note's author), consistent with the request that
   responses are open to anyone.

### Status: Open / Cleared

- Every new top-level review note starts `status: 'open'`.
- **Only the note's own author (`authorId` match) or an admin/superadmin**
  may toggle it to `cleared` (or back to `open`) — this is a real
  **tightening** from the current implementation, where any user can
  click any note's "Cleared" button today. Per explicit instruction,
  this permission narrows to the author + admin only. Anyone else sees
  the status pill in a clearly non-interactive (no hover/cursor
  affordance) state.
- Toggling records `clearedBy`/`clearedByName`/`clearedAt` (cleared) or
  clears those three fields back out (reopened) — this is itself a
  content-neutral status change, not a "new note," so it stays allowed
  under the existing carve-out #1 even while the workpaper is locked
  (matching this design's earlier "review comments should be able to be
  cleared while reviewed" instruction) — but only for the author/admin
  permission above; a non-author, non-admin user gets the hard-warning
  modal if they somehow attempt it (shouldn't be reachable via the UI at
  all per the previous bullet, but the guard belongs at the data-mutation
  level too, not only hidden in the UI).
- Responses do **not** carry their own status — only the top-level note
  has an open/cleared state. A response is just additional content
  attached to the thread.

### Adding a NEW top-level note, or a NEW response, while locked

Per the earlier lock design ("no new review comments entered" while
reviewed), both of these are **new content**, not a status toggle, and
are therefore blocked while the workpaper is locked, gated the same way
as every other blocked mutation (hard-warning modal, exempting the
active reviewer/admin/superadmin per the standing Permission rule). Only
the open/cleared toggle on an existing note is exempt via carve-out #1 —
adding a brand-new response underneath an existing note is content
creation and is not part of that carve-out, even though it visually
lives "under" an already-existing, possibly-cleared note.

### Attachments (link existing files, or upload new)

Both a top-level review note and any individual response may carry
file attachments, added via the same small control (an "Attach file"
action shown at the bottom of the note/response's composer, before it's
submitted, or alongside an already-posted note if the app's attachment
model allows post-hoc attaching — recommend keeping attachments
submitted together with the note/response text in one action, to avoid
a separate edit-after-post permission question). Two sources:

1. **Link an existing file** — a small picker (reuse the existing
   sample/reference file list UI already used elsewhere, e.g. the
   attachment pickers used by Exceptions/Findings/Recommendations'
   `linkedFiles`) letting the user choose from the workpaper's own
   sample files and reference/workpaper files. Linking does not copy
   the file — it stores a reference (`fileKey`) into the existing
   in-memory/DB-backed file store, exactly like `linkedFiles` on an
   Exception already does.
2. **Upload a new file** — a plain file-input attach action; the
   uploaded file is stored the same way any other workpaper file upload
   is stored today (reuse the existing upload endpoint/in-memory bucket
   mechanism — this does not need a new upload pathway, just a new
   attachment-point that records the resulting `fileKey` against this
   note/response).

**Rendering of attachments**: listed at the bottom of whichever
note/response they were added to (not hoisted to one combined list for
the whole thread), each as a link with two explicit actions — **view**
(open the file the same way the app already previews other linked
files, e.g. reusing whatever viewer the Attached Sample Files section or
Exceptions' `linkedFiles` already use) and **download** (a real file
download of that exact file). Both actions reuse existing file-serving
plumbing — no new file-serving endpoint should be needed, only a new
place (this note/response object) that stores which existing file a
link points to.

### Files touched (Review Notes redesign)

All in `public/index.html`:
- `reviewNotes` data shape (array of strings → array of structured
  objects per above) — touches `openNotesWindow`, `closeNotesWindow`,
  `addNoteEntry` (becomes the top-level-note renderer), plus a new
  response-renderer and a new attachment-picker/list renderer.
- `makeNoteHeader()` — removed entirely; replaced by the structured
  `author`/`ts` fields rendered directly, fixing the hardcoded `jdavis`
  bug as a side effect of the data-model change.
- `notes-window-title` — fixed "Review Notes" text plus a new subtitle
  element for the section name.
- New: response composer UI, attachment picker (reusing the existing
  file-link picker pattern from Exceptions' `linkedFiles`), attachment
  list renderer with view/download actions.
- Lock-guard wiring: new top-level note / new response creation routed
  through `_guardWpEdit(ref)`; open/cleared toggle routed through its
  own author-or-admin check (independent of lock state, per carve-out
  #1).

### Verification (Review Notes redesign)

1. Open the notes window from any section; confirm the title reads
   "Review Notes" (not the section name) with the section name shown as
   a subtitle.
2. Add a note as User A; confirm the header shows User A's real logged-
   in name (not "jdavis") and a correct timestamp.
3. As User B, add a response under User A's note; confirm it renders
   indented beneath the note, with User B's own name/timestamp, and that
   multiple responses (including more than one from User B) stack in
   order, each indented the same way.
4. Confirm User B cannot toggle User A's note to Cleared (control is
   non-interactive for them); confirm User A can, and that toggling
   persists correctly across a close/reopen of the notes window (fixing
   the current persistence bug).
5. Confirm an admin/superadmin can clear/reopen any note regardless of
   author.
6. Attach an existing sample file to a note and upload a new file to a
   response; confirm both show as links at the bottom of the correct
   note/response (not merged together), and that both View and Download
   work on each.
7. With the workpaper locked: confirm toggling an existing note's
   open/cleared status still works for its author/admin (carve-out #1);
   confirm attempting to add a brand-new note OR a brand-new response
   is blocked with the hard-warning modal for a non-reviewer/non-admin
   user.

## History of reviewer-assignment and reviewed-state changes (permanent, unaffected by Clear)

`wpReviewLog[ref]` is a **working set**, not a history — clearing an
entry from it (per the section above) genuinely deletes it, which is
correct for that field's job (it drives "who is the current active
reviewer / is this locked right now") but is wrong as the only record
of what happened, since a cleared sign-off would otherwise leave no
trace at all. The app already has exactly the right place for a
permanent, append-only record: `wpChangeLog[ref]` (via `logChange`/
`logEvent`, `public/index.html:12392-12416`), which already renders as
the workpaper's own history/audit tab and is never pruned. Every change
in scope for this design gets its own explicit entry there, in addition
to (never instead of) whatever it does to the working-set fields above.

**1. Designated-reviewer changes** — on every change to the `wpd-reviewer`
dropdown (and its Testwork-page/other-page counterparts, e.g.
`mt-final-reviewer`, if they all write the same `w.reviewer` field —
confirm at build time whether there is truly one shared field or several
independent ones, and log each that's independently changeable), call:
```js
logChange(ref, 'Assigned reviewer', oldReviewerValue, newReviewerValue);
```
using the dropdown's *previous* value (captured before applying the
change) and its new value, exactly as `logChange` already expects
(`oldVal`/`newVal`). **Blank is a valid value on either side** —
`logChange` already renders an empty string as empty, not as "unchanged"
or omitted, since the `oldVal === newVal` guard only skips genuinely
no-op changes; going from "Jane Doe" to "" (unassigning) or "" to "Jane
Doe" (assigning for the first time) both produce a real logged entry.
This needs a small addition to whichever handler currently fires on
`wpd-reviewer`'s `onchange` (today just `logWPDropdownChange`, which
should be checked to confirm it already captures old-vs-new — if it's
currently a generic dropdown logger that already does this for every
tracked dropdown including this one, no new code is needed here beyond
confirming it fires correctly; if it's only cosmetic, extend it).

**2. Reviewed-state changes** — every transition, in both directions,
gets one explicit entry, always including the reviewer's identity as
part of the recorded state (never just "reviewed"/"not reviewed" with
the name implied or omitted):
- **Not-reviewed → Reviewed** (`addWPReview`): already calls `logEvent`
  today (`REVIEWED - <wp name> · <reviewer> <date> <time>`) — keep this,
  it already captures the new state (who + when) correctly. No change
  needed here beyond confirming it still fires exactly once per press,
  including for a re-review after a prior clear (Multiple sign-offs
  case above).
- **Reviewed → Not-reviewed, or Reviewed(A) → Reviewed(B)**
  (`clearWPReviewEntry`, clearing the *active* index-0 entry): already
  calls `logChange(ref, 'Review sign-off', ..., 'Review is cleared')`
  today, but that line's `newVal` is a fixed, uninformative literal
  string rather than the actual resulting state. Change it to record
  the real before/after per this design's requirement:
  ```js
  function clearWPReviewEntry(idx) {
    const ref = getWPRef();
    if (!ref || !wpReviewLog[ref]) return;
    if (idx === 0 && !_canEditLockedWp(ref)) { _showLockedToast(ref); return; } // active entry: gated
    if (idx > 0 && !(_currentDisplayUser?.role === 'admin' || _currentDisplayUser?.is_superadmin)) return; // historical: admin-only
    const removed = wpReviewLog[ref].splice(idx, 1)[0];
    if (removed) {
      const wpName = WORKPAPERS[currentWPIndex]?.name || ref;
      const beforeState = `Reviewed by ${removed.reviewer} (${removed.ts})`;
      const afterEntry  = wpReviewLog[ref][0]; // only meaningful when idx === 0
      const afterState  = (idx === 0)
        ? (afterEntry ? `Reviewed by ${afterEntry.reviewer} (${afterEntry.ts})` : 'Not reviewed')
        : beforeState; // clearing a non-active historical entry doesn't change the current state at all
      if (idx === 0) {
        logChange(ref, 'Review sign-off', beforeState, afterState);
      } else {
        logEvent(ref, `Removed historical review sign-off — ${removed.reviewer} (${removed.ts})`);
      }
    }
    renderWPReviewLog(ref);
    resetWPReviewBtn();
    updateWPDateReviewed(ref);
  }
  ```
  This makes the log entry itself self-describing for every case: a
  straightforward unlock (`"Reviewed by Jane Doe (Sep 3, 2026 2:47 PM)"`
  → `"Not reviewed"`), a fall-through to an older reviewer (`"Reviewed
  by Jane Doe..."` → `"Reviewed by John Smith..."`), and pruning a
  non-active historical entry (a plain event note, since it doesn't
  change the workpaper's actual current state).

**3. Who performed the change** — `logChange`/`logEvent` already stamp
`user` via `_admCurrentUserName()` by default, which is exactly right
here: the entry always records *who clicked Clear / changed the
dropdown*, which per the Permission rule is always either the active
reviewer themselves or an admin/superadmin — never silently attributed
to the reviewer being removed.

**4. Where this history is visible** — no new surface needed; it
appears automatically in whatever existing view renders `wpChangeLog[ref]`
(the workpaper's history/audit tab, already used for every other
tracked-field change and event in the app), interleaved chronologically
with everything else, and is exportable via the existing
`exportHistoryCSV()` (`public/index.html:12418`) with no changes to that
function required, since it already just walks `wpChangeLog[ref]`
generically by field name.

## Implementation sketch

All in `public/index.html` (no schema change needed beyond adding
`reviewerId` to the JSON already stored in `wpReviewLog`'s existing
persisted column — confirm at build time whether `wpReviewLog` is
already persisted server-side or is currently front-end-only; if the
latter, this whole feature needs its persistence wired up first, since
a lock that resets on page reload isn't a real lock).

1. **`addWPReview()`** — add `reviewerId: _currentDisplayUser?.user_id`
   to the pushed entry.
2. **New shared guard**, called at the top of every mutation entry point
   listed above:
   ```js
   function _isWpLocked(ref) {
     return (wpReviewLog[ref] || []).length > 0;
   }
   function _canEditLockedWp(ref) {
     if (!_isWpLocked(ref)) return true;
     const active = wpReviewLog[ref][0];
     const isActiveReviewer = active.reviewerId
       ? active.reviewerId === _currentDisplayUser?.user_id
       : active.reviewer === _admCurrentUserName();
     return isActiveReviewer || _currentDisplayUser?.role === 'admin' || !!_currentDisplayUser?.is_superadmin;
   }
   function _guardWpEdit(ref) {
     if (_canEditLockedWp(ref)) return true;
     _showLockedToast(ref); // new small helper, rate-limited
     return false;
   }
   ```
   `_guardWpEdit` shows the hard-warning modal (not a toast) on
   rejection, per the Hard warning subsection above. Each mutation
   function starts with `if (!_guardWpEdit(ref)) return;`. Because there
   are many call sites, do this as its own dedicated pass — grep for
   every function listed under "What locked blocks" and add the
   one-line guard; low risk per site, but there are enough of them that
   this should be built and verified as one deliberate step rather than
   folded into an unrelated change.
3. **`clearWPReviewEntry(idx)`** — gate the *active* entry (`idx === 0`)
   behind the same `_canEditLockedWp` check; older entries (`idx > 0`)
   stay admin-only-clearable (add a simpler `is_superadmin ||
   role==='admin'` check there, since a non-active historical entry has
   no "reviewer of record" role to defer to).
4. **Designated-reviewer dropdown (`wpd-reviewer` onchange)** — per the
   explicit instruction above, this now **is** guarded by
   `_guardWpEdit(ref)` like any other mutation (revised from the
   earlier draft, which had left it open); a superadmin, the active
   reviewer, or a tenant admin can still change it while locked, per the
   Permission rule and Superadmin override sections.
5. **Review-comment clear toggle (`reviewNotes` "cleared" buttons,
   `public/index.html:12135, 12223, 12304`)** — explicitly **not**
   guarded; stays fully open regardless of lock state (carve-out #1).
   `closeNotesWindow(save)`, however, DOES need a guard on its save
   path, but a narrower one than `_guardWpEdit`: it must allow the save
   when the only difference between the previous and new entry set is
   which entries are marked cleared (compare entry text arrays
   ignoring the cleared-state, plus the cleared-state bitmap separately)
   and block it (hard warning) when any entry's actual text changed or
   the count of entries changed (a genuine add/edit). This needs a small
   dedicated diff in `closeNotesWindow`, not a blanket guard at its top,
   since the whole point of carve-out #1 is that saving *is* still
   allowed for the cleared-only case.
6. **Per-item personal "Reviewed" buttons (`markFileReviewed`)** —
   explicitly **not** guarded; stays fully open regardless of lock state
   (carve-out #2).
7. **Locked indicator** — small addition to the header render path next
   to the "Reviewed" pill, driven by `_isWpLocked(ref)`.
8. **Hard-warning modal helper** — new small OK-only modal reusing the
   `rcmConfirmDelete` shell (or a trimmed variant of it with the Cancel
   button removed, since there's nothing to confirm), per the Hard
   warning subsection above.
9. **Locking confirmation bubble** — new small helper (e.g.
   `_showLockConfirmBubble(reviewerName)`), a lightweight auto-dismissing
   tooltip/popover anchored to `wp-review-btn` (not the hard-warning
   modal helper — this one requires no dismissal and is purely
   informational), called once at the end of `addWPReview()` right after
   the button is switched to its green "Reviewed ✓" state, reading
   *"Workpaper locked. Only {reviewerName} or an admin can make further
   changes."*

## Server-side note

If any of the mutation entry points above also go through a direct
`/api/...` write independent of the client guard (e.g. autosave timers,
another browser tab), the client-side guard alone is not sufficient to
actually prevent the write — it only prevents the *user-initiated*
attempt from this page. Confirm at build time whether workpaper mutation
endpoints are guarded only by tenant/session auth today (no per-
workpaper-state check) — if so, note honestly that this is a UI-level
lock (prevents accidental/normal-flow edits) rather than a hard
server-enforced one, unless a matching check is added server-side too
(recommended follow-up, likely a small addition to whichever endpoints
already resolve `req.currentUser` and the workpaper's `ref`, checking
that workpaper's stored `review_log`/reviewer-of-record the same way).

## Verification

1. Sign a workpaper off as User A (press "Reviewed"); confirm the
   locked indicator appears and an edit attempt as User B (via the
   in-session user switcher) shows the hard-warning modal and makes no
   change.
2. Confirm User A can still edit after signing off, and can clear their
   own sign-off via the log's "Clear" link.
3. Confirm an admin/superadmin can edit and can clear User A's sign-off
   even though they weren't the reviewer.
4. Confirm User B, while locked, CANNOT change the designated-reviewer
   dropdown (hard warning shown) — but User A (active reviewer) or an
   admin/superadmin CAN.
5. Confirm User B, while locked, CAN mark an existing review comment
   cleared/un-cleared (carve-out #1), but adding a brand-new comment in
   the same notes window is blocked with a hard warning.
6. Confirm the per-item personal "Reviewed" file/testwork buttons remain
   completely unaffected by lock state for every user (carve-out #2).
7. Confirm re-review after unlock: User B (or A again) presses
   "Reviewed" again, a new log entry appears at the top, and the
   workpaper re-locks under the new active reviewer.
