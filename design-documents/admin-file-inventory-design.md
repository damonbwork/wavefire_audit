# Design: Admin file inventory — views and reports across a tenant

Scoped to workpaper files and sample files only. Reference files are
already accessible through Foundations and don't need a second, redundant
view here.

## The storage reality, traced directly

Worth answering precisely rather than assuming: workpaper files and sample
files — regardless of which of those two categories a given file is — are
both stored under the exact same `sample-files/{tenant}/{workpaper
ref}/...` prefix in object storage. The distinction between "this is a
sample file" and "this is a workpaper file" exists only as a database
column (`file_category`), not as a separate physical location. So there is
genuinely only one physical storage folder in scope here, not two — the
split into two separate views described below is a deliberate choice based
on what's actually useful to look at, not a reflection of two different
physical locations.

## What's genuinely available as metadata today

Both categories live in the same table, `sample_files`, distinguished by
`file_category`. Available metadata: filename, content type, size in
bytes, who uploaded it, when it was created and last updated, whether it's
archived, and — for a derived/annotated copy specifically — which original
file it was generated from. Each row already carries its own workpaper
reference directly (the `ref` column), so the workpaper link is a simple,
direct one, and the related audit is one join away through the workpapers
table itself.

## A single, combined view

**Confirmed:** one view covering both sample files and workpaper files
together, rather than two separate ones. Given both categories already
live in the exact same table with the exact same schema, splitting them
into two separate pages would have been organizational duplication, not
something the underlying data actually required. `file_category` becomes
one column shown in the table, and one of the available filters — the same
way uploader or date already are — rather than a hard split requiring two
separate pages to see the complete picture for one workpaper. Narrowing to
just one category when that's genuinely wanted is one filter click away;
nothing is lost by combining them, and no logic needs to be built twice.

The view shows, at minimum: filename, size, content type, category
(sample or workpaper), uploader, date created, date last updated, the
related audit, and the related workpaper — all directly available today
with no missing links to account for.

## Filters for the online view

- **By audit and by workpaper** — already directly available, since every
  row already carries its own workpaper reference.
- **By uploader** — useful for tracking down everything one specific
  person has added.
- **By date range** — created or last updated.
- **By file category** — sample vs. workpaper, given both now live in
  one combined view rather than two separate pages.
- **By archived status** — a real, existing field already available to
  filter on directly.
- **A plain text search** across filename.

## The download icon

**Confirmed:** a compact download icon next to each row, not a separate
shortened-URL system. This is genuinely close to free to build — the
existing download route (`/api/sample-files/:ref/:fileId/download`)
already works; this just needs a small icon rendered next to each row,
linking straight to that route for the specific file. No new backend work
and no new table needed.

## Open questions worth deciding before building

- **Should this respect the same tenant isolation as everywhere else in
  the app** — an admin at one tenant should presumably never see another
  tenant's files, even in an "admin" view? This seems like an obvious yes,
  but is worth stating explicitly given the sensitivity of a
  cross-workpaper, all-files view.
- **Should archived files show by default, or only when a filter is
  explicitly turned on?** Given the view's purpose is administrative
  oversight, showing everything by default with a filter to *hide*
  archived items might be more useful than the reverse — an admin
  auditing storage usage likely wants to see everything that actually
  exists, not just what's currently active.
- **Does this need to scale to genuinely large tenants?** If a tenant has
  thousands of files, the online view needs real pagination and
  server-side filtering rather than loading every row into the browser at
  once — worth deciding this before building the query layer, since it
  shapes the API design from the start rather than being a later
  retrofit.
