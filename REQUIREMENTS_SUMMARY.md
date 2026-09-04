# WaveFire Audit SaaS — Known Requirements Summary

This is a distilled, current reference — what's confirmed and true right
now, synthesized across the entire session. For the reasoning and history
behind any of this, see `CHRONOLOGICAL_LOG.md`. For full design detail on
the two largest unbuilt/partially-built features, see the two documents in
`design-documents/`.

## 1. Application architecture (as it actually exists)

- **Frontend:** a single, large HTML file (`auditflow_artifact.html`,
  ~35,000 lines) — no build step, no framework, vanilla JS with inline
  `<script>`. Uses pdf-lib (PDF creation/editing), pdfAnnotateLib /
  `annotpdf` (PDF comment annotations — confirmed unmaintained since 2022),
  SheetJS/XLSX (spreadsheet import/export), mammoth.js (docx text/HTML
  extraction), all loaded from CDN (`cdn.jsdelivr.net`) at runtime via
  dynamically-injected `<script>` tags.
- **Backend:** a single, large Express + Postgres file (`server.js`,
  ~8,100 lines). Object storage (S3-compatible) for file bytes; Postgres
  for all metadata.
- **Storage layout:** two physical buckets only.
  `sample-files/{tenant}/{workpaper ref}/...` holds BOTH sample files and
  workpaper files together — the only distinction is the `file_category`
  database column, not physical location.
  `reference-files/{tenant}/...` is genuinely separate, and reference
  files relate to workpapers via a many-to-many `reference_file_scopes`
  table (a reference file can be tenant-wide, audit-wide,
  workpaper-specific, or attribute-specific, and can carry multiple scopes
  at once).
- **Sessions:** `SESSION_DURATION_MS` = 24 hours (absolute maximum);
  `IDLE_TIMEOUT_MS` = 8 hours (sliding inactivity window — was increased
  from 4 hours during this session, per explicit request).

## 2. Known, live infrastructure issues (not application bugs)

- **`/Wavefire_files/*_3UUq.js` 404s, recurring across every server
  restart.** Confirmed NOT a "Save Page As" browser artifact (ruled out
  because it repeats identically across separate restarts). Points at
  something in the actual deployment/hosting layer (a caching layer, an
  asset-rewriting/proxy feature, or a build step) rewriting external CDN
  script references to a local path the server can't serve. This is
  outside the application source — nothing in `auditflow_artifact.html` or
  `server.js` references any `Wavefire_files` path or `_3UUq` suffix
  anywhere. **Needs investigation at the Railway/deployment-configuration
  level, not the code level.** If real, this could explain any
  pdf-lib-dependent failure that happens to coincide with it.
- **`CREDENTIAL_ENCRYPTION_KEY is unset or under 32 bytes`** — a security
  warning seen in Railway logs. Per-tenant AI credentials cannot be
  encrypted and will be rejected until a random 32+ character value is set
  in the environment. Not yet addressed in this session; worth setting
  directly on the Railway environment.
- **Repeated version-lag pattern:** multiple times this session, an error
  message or missing feature turned out to be caused by a stale/undeployed
  version running in production, not a real code bug. The standing
  verification method used throughout: open the deployed page's "View
  Page Source" (Ctrl+U / Cmd+Option+U) and search for a specific string
  known to only exist in the latest fix. **Recommend doing this check
  before investigating any newly-reported error as a fresh bug.**

## 3. Fixed this session — confirmed, tested, and (mostly) verified working

- Bookmark-panel crash on any backend-loaded PDF/docx/xlsx file (a plain
  JS object being passed to `URL.createObjectURL`, which requires a real
  Blob) — fixed in four locations.
- Sample Data grid column width reset tool (toolbar button + function).
- Reference files that aren't PDFs (.docx, .xlsx) previously silently
  excluded from Analyze — now extracted as real text/CSV content and
  included, rather than skipped. Falls back to skip-and-warn only for
  genuinely unsupported types or extraction failures.
- "Search external sources" checkbox moved from the post-Analyze Guidance
  modal to the pre-Analyze "Analyze & Create Workpaper" modal, with a
  correctly-wired persisted preference (was a silent bug risk when moved,
  now fixed).
- Six total instances of a Postgres `array_agg`/`name[]` parsing bug (the
  pg driver sometimes returns this less-common array type unparsed as a
  raw string) causing `.sort()`/`.join()` crashes in DB consistency
  checks — all fixed with explicit `::text` casts plus JS-level
  `Array.isArray` safety nets.
- Missing primary keys on `company_context` and `controls` tables (existed
  on live DB from before the `PRIMARY KEY` clause was added to the schema;
  `CREATE TABLE IF NOT EXISTS` never retroactively applies to an existing
  table). Fixed via a new, reusable, general `_ensurePrimaryKey()`
  migration helper.
- Missing `zip` column on `assessment_entities` (same
  already-exists-before-the-schema-changed root cause) — added to both the
  base table definition and a standalone migration.
- Both comment-based annotation mechanisms (sticky-note, hybrid) were
  failing to load their shared library (`pdfAnnotateLib`) silently — now
  surface a direct, visible alert naming the real reason.
- **The single biggest root-cause bug found this session:** both the
  sticky-note and hybrid annotation mechanisms used a broken lookup
  (`wpResults.indexOf(wpResults.find(r => r.fileName === origEntry.name))`)
  that always returned `-1` because `fileName` on each `wpResults` entry
  is actually `allFileNamesJoined` (a string of every file name in the
  run, not one individual name). This meant these two mechanisms produced
  **zero output, silently, for every single Analyze run**, regardless of
  what was checked in the UI. Fixed by replacing the broken pre-lookup
  with the same correct iterate-and-match-by-`sourceFile` pattern the
  working burn-in mechanism already used. **Confirmed working by the user**
  — sticky-note and hybrid files now generate for the first time.
- A per-file error handler (used when one specific file's Analyze attempt
  fails, separate from a total run failure) was discarding the real,
  specific error and replacing it with a generic "Analysis failed."
  placeholder — fixed to include the real `outcome.error` text.
- The original per-file upload-to-server flow was deliberately designed to
  fail silently (console-only) if the save didn't succeed, pending proof
  this was reliable enough to stay quiet. Given confirmed live failures
  since then, this is now a direct, visible alert (after a 30-second retry
  window, to avoid alarming on a transient blip that self-corrects) that
  includes the real, original failure reason.
- A concurrent-Analyze-run safeguard: since `analysisResults` and related
  state are module-level and shared across the whole page (not scoped per
  run), a second Analyze run starting while one is still in progress would
  silently corrupt the first run's results. Now blocked outright with a
  clear message, via a flag (`_analysisInProgress`) correctly reset on all
  four possible ways a run can end (cancel, timeout, normal completion,
  unhandled error).
- A separate, live-updating browser window showing Analyze's own progress
  in real time, opened synchronously from the Run Analysis click (required
  for popup-blocker compliance). This is a status *mirror* only — it does
  NOT enable or support running two Analyze sessions in parallel; that
  remains actively prevented by the safeguard above.
- The "AI Reasoning Log" / "Test Notes" / "Test Analysis" buttons were
  gated on "has any data" rather than "did the process genuinely
  complete" — a real gap, since a total-failure run still writes an error
  entry per file, meaning "has data" could read true even when nothing
  useful happened. Fixed to gate on reaching the actual completion point
  in the code, which is true by construction only once every file has
  genuinely finished.

## 4. Fixed this session — NOT yet confirmed working (needs verification)

- **`[placeField] ... No /DA (default appearance) entry found for field:
  wf_mark_0`** on the form-field annotation mechanism. Hypothesis: pdf-lib's
  `setFontSize()` requires an established default-appearance entry that
  only gets created by `addToPage()`, and the code was calling
  `setFontSize()` before `addToPage()`. Fixed by reordering the calls.
  **This reorder has NOT been confirmed to resolve the actual error** — as
  of the end of this session, it's unclear whether the user has tested
  against a build that genuinely includes this fix (the error text they
  last reported still showed the OLD generic message format, not the new
  granular per-step one, strongly suggesting a stale deployment was being
  tested).
- **Hybrid (mn) mechanism produces a PDF that Adobe reports as "damaged
  and could not be repaired."** Hypothesis: pdf-lib's default `save()`
  writes compressed cross-reference object streams that pdfAnnotateLib's
  older, incremental-update parser can't handle correctly. Fixed by adding
  `{ useObjectStreams: false }` to the `save()` call in
  `_drawTickMarksOnlyForFileFromResults`. **The user reported the same
  corruption error persisting after this change was supposedly deployed.**
  A temporary diagnostic (auto-downloads Step 1's raw pdf-lib-only output,
  named `*_STEP1_ONLY_DIAGNOSTIC.pdf`) is currently live in the code to
  isolate which of the two chained libraries (pdf-lib's drawing step, or
  pdfAnnotateLib's comment-adding step) is actually producing the
  corruption. **This is the single most important open item — see the
  "STATUS AT END OF LOG" section of `CHRONOLOGICAL_LOG.md` for the exact
  next action needed, and remove the diagnostic code once resolved.**

## 5. Fully built and confirmed this session

### Annotation type redesign (design doc: `annotation-types-selection-and-naming-design.md`)
All three parts of this plan are now built:
1. **Filenames renamed** to `_annotated_bi.pdf` (burn-in/flattened),
   `_annotated_ff.pdf` (form-field/AcroForm), `_annotated_sn.pdf`
   (sticky-note/Text annotation), `_annotated_mn.pdf` (hybrid — a flattened
   circle plus a sticky note).
2. **Visual redesign across all four mechanisms** — tick marks are now a
   plain green check or red X (drawn geometrically, not a unicode glyph,
   for reliability), combined with the user-assigned attribute number as
   one unit, with the old PASS/FAIL/EXCEPTION text labels removed
   entirely. Exception marks additionally carry the exception number and
   its note, sharing the same single background box rather than needing a
   second one. Color scheme collapsed to two colors (green/red) everywhere
   — no more distinct third color for exceptions specifically.
3. **User-selectable annotation types** — four always-visible checkboxes
   on the bottom of the "Analyze & Create Workpaper" modal (NOT inside any
   hover — this was tried and explicitly reverted after a real usability
   bug where hover-hidden checkboxes could silently fail to register a
   click). A header labeled "SAMPLE FILE ANNOTATION TYPE(S)" has a
   hover-revealed *purely informational* table above the checkboxes,
   explaining what each type is in Acrobat terms — no interactive elements
   live inside that hover. The selection is persisted per-person (not per
   workpaper or session) via a new `users.annotation_type_prefs` JSONB
   column, loaded as the default the next time the modal opens; a genuine
   first-time user (nothing saved yet) sees a static default of burn-in +
   sticky-note checked.

### Admin File Inventory (design doc: `admin-file-inventory-design.md`)
Fully built: a new "File Inventory" tab in Admin showing a single combined
table of workpaper and sample files (not split into separate views —
`file_category` is a column/filter, matching the confirmed simpler design),
with all planned metadata columns, all planned filters (audit, workpaper,
uploader, date range, category, archived status, text search), a compact
download icon per row, and server-side pagination. Correctly tenant-scoped
(resolves an explicit open question from the design doc: yes, an admin at
one tenant can never see another tenant's files). Reference files were
explicitly excluded from this feature per direct instruction — they remain
accessible only through the existing Foundations page.

## 6. Explicitly NOT yet built

- **The persistent, overridable pass/fail field** (design doc:
  `pass-fail-override-and-sync-plan.md`, Part 1) — a new database table
  (`attribute_sample_results` or similar) to durably store a per-attribute,
  per-sample AI determination that a person can override, distinct from
  the current in-memory-only, regenerated-every-run `analysisResults`.
  **Nothing from this has been built. Design only.**
- **The tightened AI determination logic** (same doc, Part 2) — the
  exception-always-means-fail invariant, the "noted deviation is not
  automatically an exception" distinction, using all three of title/
  additional-info/pass-fail-criteria together, and the two new universal
  rules (sample-data-vs-sample-file inconsistency → exception;
  unlocatable sample data → exception). **Nothing from this has been
  built. Design only — this requires changing the AI prompt/schema
  itself.**
- **Multiple marks per attribute per sample** (same doc, Part 3, partial)
  — the AI's own output schema currently still returns exactly one result
  per attribute per file; supporting "more than one checkmark or X for one
  attribute in one sample" requires changing that schema to an array of
  marks. **The rendering side (Part 3's visual redesign) is built and
  described in section 5 above — the underlying schema change to support
  genuinely multiple marks per attribute per file is NOT built.**
- **The annotation-and-override sync mechanism** (same doc, Part 4) —
  detecting when a person overrides a result and offering to update the
  corresponding already-generated annotation file, with a real content
  comparison for three of the four mechanisms (form-field, both
  comment-based) and a fingerprint-based fallback specifically for the
  burned-in copy. **Nothing from this has been built. Design only, and
  depends on Part 1 (the persistent field) existing first.**

## 7. Important constraints and conventions established this session

- **This exact library, `pdfAnnotateLib`/`annotpdf`, is confirmed
  unmaintained since April 2022.** Its surface API still works per current
  documentation, but any future issue involving it should be treated with
  the same caution already applied twice this session (verify claimed API
  methods directly via web search before relying on them; the library has
  already caused two separate real, confirmed bugs this session — the
  reordering issue and the object-streams/corruption issue).
- **Drawing geometric shapes with pdf-lib (`drawLine`, `drawCircle`) is
  the established, reliable way to render simple symbols** — unicode
  glyphs (✓, ✗) are deliberately avoided because standard embedded fonts
  don't reliably support them.
- **When a migration might run against a table that predates a schema
  change, `CREATE TABLE IF NOT EXISTS` is not sufficient** — it's a
  no-op on an existing table. Any new column or constraint added to a
  `CREATE TABLE` statement must also get its own explicit, standalone
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` / constraint-check migration
  for tables that may already exist on a live database. This pattern was
  needed and applied repeatedly this session.
- **Silent failure paths are actively being eliminated across this
  codebase.** Several were found and converted to visible, specific alerts
  this session (annotation save failures, original file upload failures,
  library load failures). Any new background/fire-and-forget operation
  added to this app should default to surfacing failure directly, with the
  *specific* underlying reason included in the message shown to the
  person — not a generic "something went wrong."
- **Every one of this session's fixes was tested directly** (via extracted
  function logic run in isolated Node test scripts with mocked
  dependencies) before being presented as complete, given neither pdf-lib
  nor pdfAnnotateLib nor a live browser/database can be executed directly
  in this development environment. This is a real, load-bearing limitation
  for anyone continuing this work: **code correctness was verified
  structurally and logically, never by actually running the real
  libraries against real files.** The very first live test of any given
  fix is the user's own next real attempt.
