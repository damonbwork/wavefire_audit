# Decisions and reversals

Format: decision → why → status. Reversals are the highest-value entries. Source: the long claude.ai development session (Jun–Nov 2026), reconstructed from its transcript and summary. Items marked [UNCERTAIN] could not be fully confirmed.

## Annotation mechanisms
1. **Four annotation types, selectable per user.** Burned-in (flattened), AcroForm Widget (form field), Text annotation (Sticky Note), and Hybrid (circle + sticky note). Suffixes match Adobe's names: `_annotated_bi`, `_annotated_ff`, `_annotated_sn`, `_annotated_mn`. Superseded the old suffixes (`_annotated_comments`, `_annotated4_comments`, and similar). Why: the old comment-based copies were not being created and the names did not say what the file was.
2. **User selection is persisted per user** (`users.annotation_type_prefs`, `POST /api/auth/annotation-type-prefs`) and defaults to the last selection. Defaults on first use: ff and bi. Four always-visible checkboxes (`aopt-ann-bi/ff/sn/mn`) under a header "SAMPLE FILE ANNOTATION TYPE(S)" at the bottom of the Analyze & Create Workpaper modal.
   - **Reversal:** first built as checkboxes inside a hover bubble; clicks did not register. Rebuilt so the checkboxes are always visible and the hover is purely informational (explanatory table over the header). Order in the list and hover: Burned-in moved to last.
3. **Tick mark design:** pass/fail text removed from marks; attribute number inside the mark for all options; exception marks carry the exception number and explanation; as few boxes as possible with a white background. Pass/fail will be shown as green check / red X (see pass-fail plan).
4. **Single-field `placeField`** for form fields (one field per mark rather than several), and removal of labels.
5. **Annotation library choice:** pdf-lib for burned-in and form fields; annotpdf (`pdfAnnotateLib`, unmaintained since 2022) for sticky notes and hybrid. Library-load failures must be shown as visible alerts, not silent.
6. **Claim corrected:** I had said annotations cannot be read back from PDFs; D challenged it, and the design doc was corrected (comment/annotation fields can be read, so annotation↔override sync is feasible).

## Reference/sample file handling
7. **Non-PDF reference files:** the Anthropic API accepts only PDF for document blocks. Decision: extract text from DOCX (mammoth) and CSV from XLSX (SheetJS) in the browser and send as text; skip unsupported files rather than failing the whole request. Why: one non-PDF file made the API reject the entire request (`media_type: Input should be 'application/pdf'`).
8. **Original uploads go to the file server first** (dot beside the file goes green when durably saved). Failed durable saves show an alert with the reason and say the file is usable for the session only.

## Analyze flow
9. **"Search external sources for guidance" checkbox** moved to the Analyze & Create Workpaper modal before Analyze starts (not after); modal enlarged. **AI Reasoning Log** and **Test Notes** buttons appear only after testing completes.
10. **Separate Analyze status window** was built and mirrored status into it (`_analysisStatusWindow`, `_mirrorAnalysisStatus`). D asked whether concurrent tests are a good idea; I flagged module-level shared state (`analysisResults`) and built a **concurrent-run guard** (`_analysisInProgress`) instead of supporting parallel runs. [UNCERTAIN] The status window is absent from the repo's `index.html`; check whether it was dropped on purpose.
11. **Idle timeout 4h → 8h** (`IDLE_TIMEOUT_MS`). D also proposed: when offline-save is detected, go straight to the login modal (not built).
12. **Failures must be visible:** many silent failures became alerts with the actual reason (`Analysis failed: ${outcome.error}`, upload safety-net alert). D rejected "check the console" as an instruction.

## Admin
13. **Admin File Inventory tab:** one combined view of sample files and workpaper files with filters and short links; reference files excluded because Foundations already lists them. Endpoint `GET /api/admin/file-inventory`; filters reload from page 1 (`_adminFileInventoryReloadFromFilterChange`).

## Data analysis
14. **Architecture:** Python FastAPI/scikit-learn microservice separate from Node; Node proxies and injects `ML_SERVICE_TOKEN`; shared-secret auth only; in-browser JS fallback when unconfigured. Design: `design-documents/data-analysis-anomaly-detection-plan.md`. Deferred by D ("come back to data analysis later").

## Database
15. **Migrations rule:** `CREATE TABLE IF NOT EXISTS` never retrofits constraints/columns, so every new column or PK gets a standalone idempotent `ALTER` (`_ensurePrimaryKey`, zip column, `annotation_type_prefs`).
16. **Cast `array_agg(name)` to `::text`** (the `attname` aggregation sites in `server.js`; seven at present).

## Security
17. After the Railway breach: rotate everything stored on Railway, reference DB URL from the Postgres service, drop the public Postgres proxy, set `CREDENTIAL_ENCRYPTION_KEY`. See `docs/RAILWAY_AND_SECURITY.md`.

## Process
18. **Deploy verification:** before debugging, check the deployed build contains the change (View Page Source search for a new string). Several "still broken" reports were stale deploys.
19. **Handoff:** a repo `CLAUDE.md` plus `docs/` is the way to carry knowledge into Claude Code; Claude Code cannot search past chats.
