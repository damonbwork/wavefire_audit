# Architecture

## Components
- **`server.js`** (Express): auth (sessions table, 8-hour idle timeout, lockout counters), tenants, audits, workpapers, sample files (S3 object storage + Postgres metadata), reference files (pgvector embeddings via Voyage), attribute edit history, guidance, Excel export prefs, admin routes, AI proxy to Anthropic with per-tenant credentials (encrypted with `CREDENTIAL_ENCRYPTION_KEY`), rate limiting (`AI_RATE_LIMIT`), ML proxy (`/api/ml/*`).
- **`public/index.html`**: single-file SPA (~2.8 MB; ~43,800 lines). Sections include workpaper detail (testwork grid, attached sample files, Quick Links), Analyze & Create Workpaper modal, Sample Data grids, Foundations, Admin (File Inventory, Tenants), Data Analysis tab.
- **`ml-service/`** (FastAPI): `app/main.py` — `POST /api/ml/unsupervised`, `POST /api/ml/train`, `GET /health`; token via `ML_SERVICE_TOKEN`.
- **Storage**: Railway bucket `modular-safe` (S3 API; `forcePathStyle` when `STORAGE_ENDPOINT` is set; region defaults to `auto`).
- **Database**: Railway Postgres + volume; private address `postgres.railway.internal`. Startup logs list the `DB: ... confirmed ready` migration steps; each ends with `DB: all migrations applied`.

## Analyze flow (high level)
1. User uploads sample files (durably saved to the file server; green dot) and selects reference files and annotation types.
2. Analyze sends sample/reference content to the Anthropic API (PDFs as document blocks; DOCX/XLSX converted to text/CSV first) and receives per-sample, per-attribute results with `sourceFile`, pass/fail, and exceptions.
3. Results (`analysisResults`, module-level shared state, guarded by `_analysisInProgress`) populate the testwork grid.
4. Annotated copies are generated in the browser (pdf-lib / pdfAnnotateLib) per the user's selected types and saved to the server: `_annotated_bi` (burned-in), `_annotated_ff` (form field), `_annotated_sn` (sticky note), `_annotated_mn` (hybrid).
5. Failures surface as alerts with reasons; the analysis can succeed while durable saves fail.

## Annotation mechanics
- Burned-in: pdf-lib drawing (`drawTickMark`) flattened into page content. Form-field: AcroForm widgets via `placeField`. Sticky note / hybrid: annotpdf text annotations (note: Step-1 output is an intermediate PDF).
- File naming mirrors Adobe's annotation names; a persisted per-user selection controls which are produced.

## Database notes
- Tables include `workpapers` (PK `(tenant_id, ref)`), `sample_files` (with `file_category`, `annotated_from`, `workpaper_id`), `sample_data_*`, `extracted_data*`, `attribute_edit_history` (+ pgvector embeddings), `attribute_sample_results` (+ `override_rationale` and embeddings), `workpaper_exceptions`, `reference_files` (+ scopes, embedding), `risks`, `controls`, `company_context`, `assessment_entities`, `audit_fs_accounts`, `category_style_guides`, `platform_settings`, `security_settings`, `sessions`, `access_error_*`, `ai_usage_log`.
- Migrations: idempotent, run on boot in `initDB()`; add new columns with standalone `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

## Conventions
- Multi-tenant everywhere: every table carries `tenant_id` and queries filter on it.
- Never trust a "configured" assumption: check env vars via startup warnings (`[SECURITY]`, `[SMTP]`, `[Storage]`).
- Secrets only in Railway variables; never in the repo.
- Design plans live in `design-documents/` (annotation types, file inventory, pass/fail override and sync, exceptions table, data analysis, continuous auditing, workpaper chat assistant, review lock, grid interactions, inline help icons, and more).
