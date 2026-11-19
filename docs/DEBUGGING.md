# Debugging journal

Each entry: symptom → investigation → root cause → fix → status.

## Fixed / confirmed
1. **Bookmark panel crash** when a document has no bookmarks. Replaced with a clear message ("No bookmarks found" bubble / panel closes). Confirmed.
2. **`URL.createObjectURL` TypeError on backend-loaded files.** Cause: passing a non-Blob. Fix: build a real Blob from the arrayBuffer at four call sites. A side effect — the `renderDocxPanel` call was accidentally deleted during the edit; caught on review and restored.
3. **Analyze rejected entire request for non-PDF reference file** (`messages.0.content.5.document.source.base64.media_type: Input should be 'application/pdf'`). Fix: extract DOCX→text, XLSX→CSV; skip others.
4. **`.sort/.join is not a function`** on arrays from Postgres. Cause: `array_agg(name)` yields `name[]`, which `pg` leaves as a string. Fix: `::text` cast plus `Array.isArray` guards (six sites).
5. **Missing primary keys** on `company_context` and `controls`. Fix: `_ensurePrimaryKey()` early in `initDB()`.
6. **Missing `assessment_entities.zip` column** (`column "zip" ... does not exist`). Fix: base table definition plus ALTER migration. Confirmed in logs ("assessment_entities.zip column confirmed ready").
7. **Sticky-note and hybrid files never produced.** Cause: broken lookup (`fi`) through a joined file name. Fix: iterate results and match by `sourceFile`. Confirmed working by D.
8. **Silent library-load failures** for pdfAnnotateLib mechanisms → visible alerts.
9. **Hover-contained checkboxes ignored clicks** → always-visible checkboxes with hover as info only.
10. **Admin inventory filter left user on a later page** → reload from page 1 on filter change.
11. **Storage "request signature we calculated does not match" / HTTP 500 on `POST /api/sample-files/:ref`.** Cause: bucket credentials changed (Railway rolled all bucket credentials in the Oct incident), so `STORAGE_SECRET_KEY` no longer matched. Fix: regenerate bucket credentials, update `STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY`, deploy. **Verify** with a sample upload.

## Open
12. **Hybrid (`_annotated_mn.pdf`) opens as "The file is damaged and could not be repaired" in Acrobat.** SN, BI and FF open fine. Tried `pdfDoc.save({useObjectStreams:false})` — no change. Added `TEMPORARY DIAGNOSTIC` Step-1-only download to determine which step produces the damage. Awaiting result.
13. **Form-field annotation error** `No /DA entry` for `wf_mark_0`; reported as "5 form-field annotated files could not be saved to the server" while the analysis itself succeeded. `placeField` reordered; granular error messages added. Unconfirmed — D suspected a stale deploy; check the build contains `field.enableMultiline() failed for`.
14. **BurnPDF tick skipped:** `Skipping tick for "Ticket Exists" on file "Jira_Sample5_copy.pdf" — model reported sourceFile "Jira_Sample1.pdf"`. The model's `sourceFile` names do not match a renamed/copied file. That log text is from an older build: this repo's `public/index.html` (~line 9779) logs `[BurnPDF] Skipping mark for ... which does not match even after normalizing` and skips only after a trim/lowercase comparison fails. A renamed copy (`_copy`) still will not match. Not investigated further.
15. **Seed error** `there is no unique or exclusion constraint matching the ON CONFLICT specification` and `duplicate key value violates unique constraint "sample_data_columns_pkey"` in logs. The seed endpoint (`server.js` ~lines 8930–8991, `[Seed] bulk seed error:`) uses `ON CONFLICT (tenant_id,id)` on `risks`, `assessment_entities`, `fs_accounts` and `control_objectives`. All four declare `PRIMARY KEY (tenant_id, id)` in `CREATE TABLE IF NOT EXISTS`, but `_ensurePrimaryKey` retrofits only `company_context` and `controls`. Likely cause: one of the four predates its PK in production. Fix: `_ensurePrimaryKey` calls for all four after tenant scaffolding, with a duplicate/NULL pre-check and a transactional PK swap. Not yet deployed or confirmed.

## Noise, not bugs
- `[404] Unmatched route: GET /Wavefire_files/*_3UUq.js|css` and `/favicon.ico`: assets referenced from a saved-page copy (`Wavefire.htm`/`index_3_.html`); deployment infrastructure, not app code.
- `[SMTP] Not fully configured` and Node 18 / AWS SDK deprecation warnings.

## Methodology lessons
- Test scripts that override `console` or ignore async timing produced false conclusions; run against real flows.
- A too-narrow grep once suggested tenant scoping was missing when it was present. Search broadly before claiming absence.
- "Still getting this error" after a fix was usually a stale cached/deployed page; refresh and confirm the new strings are present first.
