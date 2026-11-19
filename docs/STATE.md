# Current state (as of 2026-11-19)

## Code status
- Verified 2026-11-19 against this repo (HEAD `0e60819`, Oct 8, no uncommitted code): present — `TEMPORARY DIAGNOSTIC` / `STEP1_ONLY` block, `field.enableMultiline() failed for`, `_analysisInProgress`, `aopt-ann-*` checkboxes, `annotation-type-prefs` endpoint, `GET /api/admin/file-inventory`, `IDLE_TIMEOUT_MS` = 8h, `_ensurePrimaryKey`, `ensureAnnotationTypePrefsColumn`; absent — `_analysisStatusWindow`, `_mirrorAnalysisStatus`. Since HEAD is the deployed commit, the form-field fix strings should already be in the deployed build; confirm in View Page Source.
- This repo (`wavefire_audit2`, branch `claude/auto-updates`) is ahead of the copies used in the long claude.ai session. It contains `override_rationale` and `workpaper_exceptions` features the session never saw.
- A comparison on 2026-11-19 found the session's work already present here (annotation redesign and type selection, admin file inventory, 8-hour idle timeout, DB migration fixes, concurrent-run guard `_analysisInProgress`, column-width reset tool, non-PDF reference extraction). **One difference:** the separate Analyze status window (`_analysisStatusWindow`, `_mirrorAnalysisStatus`) exists only in the session copy, not in this repo. Decide whether it should be re-added.
- Deployed Railway build: Oct 8, 2026 commit, redeployed several times on 2026-11-19 only to apply variable changes.

## Open issues
1. **Hybrid annotated PDF (`_annotated_mn.pdf`) is "damaged" in Adobe Acrobat.** `useObjectStreams:false` did not fix it. A `TEMPORARY DIAGNOSTIC` download (`*_STEP1_ONLY_DIAGNOSTIC.pdf`) was added to isolate whether Step 1 output already opens. Awaiting D's result: if the Step-1 file opens in Acrobat, the corruption is introduced in the sticky-note step; if not, it is in the first step. Remove the diagnostic afterward.
2. **Form-field annotation error (`No /DA entry` on `wf_mark_0`).** `placeField` was reordered and new granular error strings added (`field.enableMultiline() failed for ...`). Unconfirmed: D suspected a stale deploy. Verify the deployed build contains the new strings before debugging.
3. **Sample-file upload failing with HTTP 500** ("request signature we calculated does not match") — caused by stale storage credentials after Railway rolled bucket credentials. Credentials were regenerated 2026-11-19 and the variables updated. **Needs confirmation:** upload a sample file; the dot beside it should be green after a page reload.
4. **BurnPDF skips ticks** when the model's reported `sourceFile` (e.g. `Jira_Sample1.pdf`) does not match the file's name (e.g. `Jira_Sample5_copy.pdf`). The repo already compares after trim/lowercase (`[BurnPDF] Skipping mark for ...`, `public/index.html` ~line 9779), but a renamed copy still will not match. Not yet investigated.
5. **Seed error:** `bulk seed error: there is no unique or exclusion constraint matching the ON CONFLICT specification` (appears at startup/seed). The seed upserts use `ON CONFLICT (tenant_id,id)` on `risks`, `assessment_entities`, `fs_accounts`, `control_objectives`. Each declares that PK in `CREATE TABLE IF NOT EXISTS`, but only `company_context` and `controls` get `_ensurePrimaryKey`. Fix in `server.js` (not yet deployed): `initDB()` now calls `_ensurePrimaryKey` for those four after the tenant_id scaffolding. `_ensurePrimaryKey` now checks for duplicate/NULL key rows first, logs them and leaves the table untouched, and swaps the PK in one transaction. **Verify after deploy:** look for `DB: <table> primary key corrected to (tenant_id, id)` or `DB: cannot add primary key ...` in the deploy logs, then rerun the seed.
6. Startup warnings still open: SMTP not configured (password-setup emails cannot be sent), Node 18.20.8 / AWS SDK deprecation (needs Node 22 before Jan 2027).
7. Offline-save UX: when the app detects the user is offline, go straight to the login modal and give an honest message (proposed, not built; idle timeout was raised to 8 hours).

## Designed but not built
- Pass/fail override table, AI schema changes, multi-mark schema, annotation/override sync (`design-documents/pass-fail-override-and-sync-plan.md`). The repo already has parts (`override_rationale`, `workpaper_exceptions`) — check what is done before building.
- Data Analysis (anomaly detection) design decisions: D said "come back to data analysis later". See `design-documents/data-analysis-anomaly-detection-plan.md`.
- Railway `_3UUq` asset-rewriting investigation (404s are harmless).

## Security rotation status (see docs/RAILWAY_AND_SECURITY.md)
Done 2026-11-19: Anthropic key, Voyage key, storage credentials, database password, `CREDENTIAL_ENCRYPTION_KEY` (first time set), `ML_SERVICE_TOKEN`, public Postgres proxy removed, GitHub app access reviewed.
Still open: delete/disable the OLD Anthropic key in the Anthropic console and review its usage since Oct 20; check repo Actions, deploy keys and webhooks; decide on `charismatic-truth`; optional SMTP.

## Suggested next steps
1. Confirm the sample-file upload works (item 3).
2. Get D's result on the Step-1 diagnostic PDF, then fix the hybrid PDF and remove the diagnostic.
3. Confirm the form-field fix is in the deployed build.
4. Deploy and verify the `ON CONFLICT` seed constraint fix (item 5).
5. Reconcile the status-window feature with this repo.
