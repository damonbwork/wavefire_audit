# Dedicated table for Exceptions, Findings and Recommendations — plan

Status: steps 1 and 2 built (see "What was built" at the end); steps 3-4 not started.

## Why

Today every Exception, Finding and Recommendation for a workpaper lives in one
JSONB array, `workpapers.exceptions` (`server.js`, workpapers table). Each item
carries its own `type` field. Consequences:

- **No cross-audit querying.** The Audit Findings page has to load every
  workpaper into the browser and unpack each one's JSON. Filtering, counting
  and reporting cannot be done in SQL.
- **Last-writer-wins.** The whole list is saved as a single value
  (`POST /api/workpapers`), so two people editing different items on the same
  workpaper can silently overwrite each other.
- **Every edit rewrites the whole workpaper row**, including large unrelated
  columns, and the Audit Findings table now edits items from many workpapers.
- **No per-item history, constraints or indexes.**

Precedent already exists: sample data and extracted data were moved out of
JSONB into `sample_data_columns`, `sample_data_rows`, `extracted_data` and
`extracted_data_records`, each keyed by `workpaper_id UUID REFERENCES
workpapers(id) ON DELETE CASCADE`. This plan follows that pattern.

## Proposed table

`workpaper_exceptions` (one row per item):

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK, default `gen_random_uuid()` | stable identity |
| `tenant_id` | TEXT NOT NULL | same tenant scoping as every other table |
| `workpaper_id` | UUID NOT NULL → `workpapers(id)` ON DELETE CASCADE | **not** the ref: refs can be renamed from the workpaper header |
| `num` | INTEGER NOT NULL | shared "#" sequence across all three types |
| `type` | TEXT NOT NULL CHECK in (`exception`,`finding`,`recommendation`) | |
| `type_num` | INTEGER NOT NULL | per-type sequence; `ref` is derived (E/F/R + `type_num`) |
| `ref` | TEXT NOT NULL | stored for display and import, kept in step with `type`/`type_num` |
| `attr_ref`, `attribute_index`, `sample_row_index` | TEXT / INT / INT NULL | link to the test attribute and sample, when any |
| `name`, `description` | TEXT | |
| `linked_files` | JSONB (array of file names) | stays JSONB: always read with the row, never queried alone |
| `owner`, `mgmt_response` | TEXT | |
| `resolution_date` | DATE NULL | currently an unvalidated string |
| `retested` | BOOLEAN; `retested_by` TEXT; `retested_date` TEXT | |
| `disposition`, `disposition_type`, `disposition_status` | TEXT | |
| `source_file`, `page`, `paragraph` | TEXT / INT / INT NULL | evidence location used by annotation re-burns |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

Constraints and indexes:
- `UNIQUE (workpaper_id, ref)` and `UNIQUE (workpaper_id, num)` — makes the
  numbering rules enforceable instead of conventional.
- Index on `(tenant_id, workpaper_id)`; index on `(tenant_id, type,
  disposition_status)` for Audit Findings filtering and reporting.

## API

New routes, tenant-scoped like the rest:

- `GET /api/workpapers/:ref/exceptions` — list for one workpaper.
- `GET /api/exceptions?audit=<name>` — list for every non-archived workpaper
  in an audit (this is what Audit Findings should call instead of loading all
  workpapers).
- `PUT /api/workpapers/:ref/exceptions/:id` — update one item (partial fields).
- `POST /api/workpapers/:ref/exceptions` — add; server assigns `num`,
  `type_num` and `ref` inside a transaction so concurrent adds cannot collide.
- `DELETE /api/workpapers/:ref/exceptions/:id`.
- `POST /api/workpapers/:ref/exceptions/bulk` — used by Analyze auto-populate
  and Audit Findings import.
- Reclassify (type change) becomes one server operation that re-numbers
  `type_num`/`ref` atomically.

`POST /api/workpapers` stops accepting or writing `exceptions`.

## Client changes

`wpExceptions[ref]` stays as the in-memory cache, so the ~67 existing
references keep working. Changes are confined to the load and save edges:

1. **Load:** `_loadWorkpapersFromDB` builds `wpExceptions` from the new list
   endpoint instead of `row.exceptions`.
2. **Save:** replace the whole-array save with per-item calls. Candidate
   hooks: `saveException`, `addGridItem`, `_reclassifyGridItem`,
   `onExceptionRetested`, the delete-selected path, the Analyze
   auto-populate block, and the Audit Findings edit/import handlers
   (`_audResEdit`, `_audResApplyImport`), which currently call
   `_saveWorkpaperToDB` for the whole workpaper.
3. **Audit Findings:** call `GET /api/exceptions?audit=` for the selected
   audit rather than depending on all workpapers being loaded.
4. **Duplicate workpaper:** `duplicate-from` currently copies the JSONB
   implicitly with the row; it needs an explicit copy of the new table's rows.

## Migration

1. Create the table (idempotent `CREATE TABLE IF NOT EXISTS`, matching the
   existing startup checks).
2. One-time backfill at startup: for each workpaper with a non-empty
   `exceptions` array and **no rows yet** in the new table, insert one row per
   array element (skip silently if rows already exist, so it is re-runnable).
   Normalise `resolutionDate` strings to DATE where they parse; keep them NULL
   otherwise and log the count. Repair duplicate `num`/`ref` values found in
   old data before the unique constraints apply, and log what changed.
3. **Dual-read period:** the app reads the new table; the old JSONB column is
   left untouched and not written. Nothing is dropped in this release.
4. After a verification period (compare row counts and a checksum of fields
   per workpaper against the retained JSONB), a later release removes the
   column.

## Risks and open questions

- **Numbering uniqueness on legacy data.** Any workpaper whose JSON has a
  duplicate `num` or `ref` will fail the unique constraint; the backfill must
  detect and renumber these rather than abort.
- **Annotation re-burns and the sync check** read items by `ref`,
  `attributeIndex`/`sampleRowIndex` and `sourceFile`; those fields are all
  kept, but the exception-ref lookup functions (`_lookupExceptionRefMap`,
  `_lookupFindingsAndRecommendationsForFile`) should be re-tested after the
  load change.
- **Edit lock and change log:** per-item saves must go through the same
  workpaper edit-lock check that `_saveWorkpaperToDB` effectively enforces
  today, and keep writing to the change log.
- **Concurrent edits to the same item** still last-writer-wins at field
  level; optimistic concurrency (compare `updated_at`) is an optional
  follow-up, not part of this plan.
- **Review-note and sync design docs** mention `workpapers.exceptions`;
  update them when this ships.

## Suggested order of work

1. Table + backfill + read endpoints; switch the client load; leave saves
   as-is writing the JSONB (dual-write) to keep the change small and safe.
2. Per-item write endpoints; switch the client save paths; stop writing JSONB.
3. Audit Findings reads by audit from the new endpoint.
4. Verification period, then drop the JSONB column.

## What was built (step 1)

- `workpaper_exceptions` table created at startup (after `workpapers.id` is
  guaranteed), with the one-time re-runnable backfill from the old JSONB.
- `POST /api/workpapers` still writes the old `exceptions` JSONB column
  **and** replaces that workpaper's rows in the new table in one transaction.
  A failed sync fails the save (the read path would otherwise keep serving
  the previous rows over the newer JSONB).
- `GET /api/workpapers` fills each workpaper's `exceptions` from the table;
  a workpaper with no rows there falls back to its JSONB value.
- The client is unchanged: it still reads and writes `exceptions` on the
  workpaper, so nothing in the browser needed to move.

Deviations from the design above, and why:
- `ref` and `num` are indexed, **not unique**. Until saves are per-item the
  client can still send a duplicate, and a unique constraint would turn that
  into a failed workpaper save. Revisit with step 2.
- `resolution_date` is TEXT, not DATE, so values round-trip exactly.
- `source_file`, `page`, `paragraph` (and any other field not given its own
  column) are stored in a JSONB `extra` column, so nothing a client put on
  an item is lost. Promote them to columns if they need querying.
- A `position` column preserves the array order.

Still to do: per-item write endpoints (the concurrent-overwrite fix),
`GET /api/exceptions?audit=` and switching Audit Findings to it, copying
rows in `duplicate-from`, a production verification period, then dropping the
JSONB column.

## What was built (step 2: per-item saves)

Server (`server.js`), all tenant-scoped; items are addressed by ref (E1/F1/R1):
- `PUT /api/workpapers/:ref/exceptions/:itemRef` — body `{ fields: {...} }`;
  merges only the fields sent into that item, so two people editing different
  fields of one item no longer overwrite each other. Also used for reclassify
  (sending the new `type`, `typeNum`, `ref`).
- `POST /api/workpapers/:ref/exceptions` — body `{ item: {...} }`; the server
  assigns `num`, `typeNum` and `ref`, so simultaneous adds cannot collide.
- `DELETE /api/workpapers/:ref/exceptions/:itemRef`.
- Each operation runs in a transaction that locks the workpaper row first,
  and rebuilds the old `workpapers.exceptions` JSONB column from the table at
  the end (still dual-written).

Client (`public/index.html`):
- Cell edits in the workpaper grid, Retested, add, delete, reclassify, and
  every edit on the Audit Findings page now go through these endpoints.
  Typing is debounced (~0.5s per item, fields merged into one request) and
  flushed when the tab is hidden or closed.
- If a per-item call fails, the whole workpaper is saved instead, so an edit
  is never silently lost; adding without a backend numbers the item locally.

Known limitation: ordinary workpaper saves (`POST /api/workpapers`) still
send and replace the whole items list, and the Analyze auto-populate, link-files
dialog and Audit Findings import still rely on that path. A stale whole-list
save (for example someone saving a header change from an old page) can
therefore still overwrite another person's newer item edits. Closing this
needs the generic save to stop sending `exceptions` once every item-mutating
path is on the per-item endpoints (an audit of all the places that change
`wpExceptions`), plus optional optimistic concurrency.

Not verified against a real database: the row lock that serialises concurrent
adds/edits (the in-memory test database has no real locking). The logic was
verified sequentially: numbering, field merge, reclassify, delete, and that the
JSONB mirror matches the table.

## What was built (master item, origin, uploaded items with no workpaper)

New columns on `workpaper_exceptions` (added by a re-runnable startup migration):

- `master_item` — a per-tenant running number, 1, 2, 3 ..., across every
  exception, finding and recommendation regardless of workpaper. Numbers come
  from a counter table (`exception_master_counter`), so they only go up and are
  never reused, even after the highest item is deleted. Existing rows were
  numbered by the migration in creation order. A unique index on
  `(tenant_id, master_item)` enforces it.
- `origin` — `uploaded` (Audit Findings template), `analyze` (created by
  Analyze) or `entered` (added by a person). Existing rows could not be known
  exactly, so the migration **infers** it: an item tied to a test attribute or
  an evidence file is `analyze`, anything else `entered`. Treat that inference
  as approximate for pre-existing data.
- `workpaper_id` is now nullable, plus `audit_name`, `wp_name`, `wp_ref` — used
  only by an uploaded item that belongs to no workpaper, holding what the
  template said or `<blank>` where it was empty.

Behaviour:
- Items created in the browser are numbered by the server (per-item add) or on
  the next whole-workpaper save, which now returns each item's master item and
  origin so the browser can show them. A whole-workpaper save matches existing
  rows one-to-one by ref then by `#`, so items keep their master item and
  origin; a master item is only honoured if no other workpaper holds it.
- The master item shows in the workpaper grid and Audit Findings, followed by
  `*` for uploaded items. It is also in both Excel exports.
- Audit Findings import: blank Audit / Workpaper name / Workpaper cells (or the
  text `<blank>`) are accepted. A row with a Workpaper attaches to it as
  before; a row without one is stored as its own item. Such items appear under
  their audit, or under `<blank>` in the audit and workpaper dropdowns, and can
  be updated on re-import by entering their Master item number.
- New endpoints: `GET /api/exceptions/unassigned`,
  `POST /api/exceptions/unassigned/bulk`, `PUT /api/exceptions/unassigned/:id`.

Verified against a real Postgres: the migration over pre-existing rows
(numbering, origin inference, idempotent re-run), six concurrent adds getting
distinct master items, whole-workpaper saves preserving master item and origin
(including duplicate refs), uploaded items with no workpaper surviving a
workpaper save, and the unique index.

## Follow-up: master_item first, and import validation

- `master_item` is now the **first column** of `workpaper_exceptions` (then
  `id`), and is `NOT NULL`. Postgres cannot move a column in an existing table,
  so a table created earlier is rebuilt at startup: a new table with the right
  column order is created under an exclusive lock, every row copied across, the
  old table dropped and the new one renamed in its place, in one transaction
  (rolled back untouched on any failure, and skipped once master_item is column
  1). Verified on a real Postgres over pre-existing rows: data copied exactly,
  numbering, indexes, cascade delete and concurrent adds all still work, and a
  second startup changes nothing. Cosmetic: the table's NOT NULL constraints keep
  `workpaper_exceptions_new_...` names after the rename.
- Audit Findings import now checks any Audit, Workpaper name and Workpaper value
  against the application (non-archived audits and workpapers; a given
  workpaper's own audit and name must match). Values that don't exist do not
  block the import: a dialog lists each field, the value in the file, why it
  failed, how many rows, and sample items. **Ok** strips those values and
  imports the items without them (shown as `<blank>` / not linked to a
  workpaper; a Ref that depended on a stripped Workpaper is stripped too);
  **Cancel** applies nothing. Other problems (missing Type, unknown Ref, bad
  dropdown values) still block the whole import.

## Follow-up: Status field

Each item now has a `status`: Unassigned, Assigned, In Progress or Completed
(`workpaper_exceptions.status`, default Unassigned; anything else is stored as
Unassigned). When the column was first added, existing items that already had an
owner were set to Assigned, once; the migration will not redo that. It is
editable in both grids, sits between Type and Owner/Attribute (Owner now
immediately follows Status), is in both Excel exports and in the Audit Findings
import template (optional column; blank means Unassigned). A whole-workpaper
save from a browser that omits status keeps the row's stored status. Status is
independent of Owner: setting or clearing an owner does not change it.

## Follow-up: import ignores Wavefire-assigned numbers (supersedes earlier notes)

Master item, `#` and Ref are numbers Wavefire assigns itself, so the Audit
Findings import ignores whatever the file has in those three columns (row 1 of
the template says so). **Every uploaded row is now added as a new item** with
freshly assigned numbers: importing no longer updates an existing item by its
Ref or master item number, and a Ref or master item that doesn't exist is no
longer an error. If rows have these columns filled in (for example a file that
was exported and re-imported), the confirmation dialog says they are ignored
and that the rows will be added as new items, so duplicates are not a surprise.
Existing items are edited in the grid. Earlier sections of this document that
describe updating by Ref or master item on import no longer apply.

## Follow-up: Attribute, Attribute name and Linked files are validated on import

The Audit Findings import now checks these three fields against what exists in
Wavefire and reports problems in the same Cancel / Ok prompt as Audit,
Workpaper name and Workpaper:

- **Attribute** (reference, e.g. A) and **Attribute name** (new template and
  grid column, after Attribute) must exist among the test attributes of the
  item's workpaper, and must refer to the same attribute if both are given. A
  valid one of the two links the item to that attribute (`attrRef` and
  `attributeIndex`, not a sample row, so it does not affect any pass/fail).
- **Linked files**: each file name must be a current sample file of the
  item's workpaper (checked against the server's list for that workpaper, plus
  anything attached in the session; workpaper-category files do not count).
- An item with no valid Workpaper cannot have any of these checked, so they
  are not uploaded and the prompt says so.
- The prompt lists each field, the value in the file, the reason, how many rows
  and sample items. **Ok** uploads the items without the values that did not
  validate (they are simply not uploaded); **Cancel** applies nothing.

## Follow-up: bulk update on the Audit Findings page

A checkbox column (with select-all for the rows shown) and an action bar let a
person apply one value to many items: **Status, Owner, Resolution date,
Disposition, Disposition type, Disposition status, Retested and Type**. Name,
Description, Management response and the numbers are deliberately not bulk
editable. A confirmation states how many items and workpapers are affected.

- Selection always stays within the rows currently shown (changing the audit,
  workpaper, type or search drops anything no longer visible).
- Items on a workpaper that is locked for editing are skipped and listed.
- "Only where it is blank" (text, date and disposition fields) skips items that
  already have a value. Items that already hold the value are skipped.
- Retested = Yes stamps the person and date; No clears them.
- Server: `POST /api/exceptions/bulk-update` applies the same fields to many
  items, one transaction per workpaper (processed in a fixed order so two bulk
  updates cannot deadlock) plus one for items with no workpaper; it refuses any
  field outside the allowed list and works only inside the caller's tenant.
  If it fails, the browser falls back to saving each affected item.
- Type is changed item by item through the same reclassify code as the single
  dropdown (renumbering refs, re-marking annotated files), with no per-item
  prompts; an item not tied to an attribute and sample cannot become an
  Exception and is reported as not changed.

## Follow-up: when an uploaded item attaches to a workpaper; export prompt

- **Attach rule (supersedes the earlier rule that a valid Workpaper Ref alone
  was enough).** An uploaded item is attached to a workpaper, and so appears
  under it, only when Audit, Workpaper name and Workpaper Ref are all given and
  all validate. Every other uploaded item is kept without a workpaper and is
  visible only in the Audit Findings grid, filed under its Audit (or `<blank>`).
  A Workpaper Ref that did validate is still recorded as text on such an item
  (`wp_ref`). Attribute, Attribute name and Linked files cannot be checked
  without an attached workpaper, so on those items they are listed in the
  prompt (reason: not attached) and not uploaded.
- **Export Findings** asks whether to export the *selected* items (ticked in
  the grid; disabled when none are) or *all* findings shown in the grid. "All"
  means all rows currently shown, so it follows the audit / workpaper / type /
  search selection. Export Template is unchanged.
