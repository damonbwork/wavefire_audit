# Dedicated table for Exceptions, Findings and Recommendations — plan

Status: step 1 built (see "What was built" at the end); steps 2-4 not started.

## Why

Today every Exception, Finding and Recommendation for a workpaper lives in one
JSONB array, `workpapers.exceptions` (`server.js`, workpapers table). Each item
carries its own `type` field. Consequences:

- **No cross-audit querying.** The Audit Results page has to load every
  workpaper into the browser and unpack each one's JSON. Filtering, counting
  and reporting cannot be done in SQL.
- **Last-writer-wins.** The whole list is saved as a single value
  (`POST /api/workpapers`), so two people editing different items on the same
  workpaper can silently overwrite each other.
- **Every edit rewrites the whole workpaper row**, including large unrelated
  columns, and the Audit Results table now edits items from many workpapers.
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
  disposition_status)` for Audit Results filtering and reporting.

## API

New routes, tenant-scoped like the rest:

- `GET /api/workpapers/:ref/exceptions` — list for one workpaper.
- `GET /api/exceptions?audit=<name>` — list for every non-archived workpaper
  in an audit (this is what Audit Results should call instead of loading all
  workpapers).
- `PUT /api/workpapers/:ref/exceptions/:id` — update one item (partial fields).
- `POST /api/workpapers/:ref/exceptions` — add; server assigns `num`,
  `type_num` and `ref` inside a transaction so concurrent adds cannot collide.
- `DELETE /api/workpapers/:ref/exceptions/:id`.
- `POST /api/workpapers/:ref/exceptions/bulk` — used by Analyze auto-populate
  and Audit Results import.
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
   auto-populate block, and the Audit Results edit/import handlers
   (`_audResEdit`, `_audResApplyImport`), which currently call
   `_saveWorkpaperToDB` for the whole workpaper.
3. **Audit Results:** call `GET /api/exceptions?audit=` for the selected
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
3. Audit Results reads by audit from the new endpoint.
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
`GET /api/exceptions?audit=` and switching Audit Results to it, copying
rows in `duplicate-from`, a production verification period, then dropping the
JSONB column.
