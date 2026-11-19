# WaveFire Audit — project guide for Claude Code

Read this first, then the files in `docs/`. Design plans are in `design-documents/`.

## What this is
WaveFire Audit is a multi-tenant audit/testwork SaaS (owner: D, damonbwork). Users upload audit sample files (PDF, DOCX, XLSX), define attributes to test, run AI analysis (Anthropic API) that fills a testwork grid, then produce annotated sample files and Excel workpapers.

## Stack
- Backend: Node.js / Express, single file `server.js` (~9,100 lines). PostgreSQL (pgvector extension in use). S3-compatible object storage (Railway bucket) for files; Postgres holds metadata.
- Frontend: single-file HTML app, `public/index.html` (~2.8 MB, ~43,800 lines). Libraries: pdf-lib, pdf.js, annotpdf (unmaintained since 2022), SheetJS, mammoth.
- Optional ML service: `ml-service/` (Python FastAPI + scikit-learn) for the Data Analysis tab. Node proxies `/api/ml/*` and injects `ML_SERVICE_TOKEN` server-side. When unconfigured the browser falls back to a JS engine (LOF capped by `DA_LOF_MAX_ROWS`).
- Embeddings: Voyage AI (`VOYAGE_API_KEY`).

## Repo and branches
- Local clone: `C:\Users\damon.work\Documents\GitHub\wavefire_audit2` (the older `wavefire_audit` clone in the same folder is stale — ignore it).
- Remote: `https://github.com/damonbwork/wavefire_audit`. Work happens on `claude/auto-updates`; Railway deploys appear as "Merge branch 'claude/auto-updates'" (merged into `main`).
- Last commit on main as of 2026-11-19: Oct 8, 2026.

## Hosting (Railway) — three projects exist
1. **just-simplicity — PRODUCTION.** Services: `wavefire_audit` (Node app, public domain `wavefireaudit-production.up.railway.app`), `Postgres` (with `postgres-volume`), and storage bucket `modular-safe`. App reaches Postgres on the private address `postgres.railway.internal`. Public TCP proxy on Postgres was removed 2026-11-19; keep it off.
2. **just-love — the ML service** (Python), public domain `wavefireaudit-production-3546.up.railway.app`. Only needs `ML_SERVICE_TOKEN`. `GET /health` returns `{"status":"ok","auth_configured":true}`.
3. **charismatic-truth** — no public domain, still connected to the same repo. Believed unused; candidate for deletion (confirm first).

Env vars the app reads (names only — never commit values): `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `DATABASE_URL` (set to the reference `${{Postgres.DATABASE_URL}}`), `POSTGRES_URL` (also a reference), `STORAGE_ENDPOINT`, `STORAGE_REGION` (defaults to `auto`), `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `CREDENTIAL_ENCRYPTION_KEY` (32+ chars, set 2026-11-19, do not change casually: it encrypts per-tenant AI credentials), `ML_SERVICE_URL`, `ML_SERVICE_TOKEN`, `SMTP_HOST/PORT/USER/PASS/FROM`, `APP_BASE_URL` (SMTP not configured yet), `ALLOWED_ORIGINS`, `AI_RATE_LIMIT`, `JSON_BODY_LIMIT`, `CLAUDE_PROXY_BODY_LIMIT`, `AI_ANALYZE_BODY_LIMIT`, `DEFAULT_TENANT_ID`, `PORT`, `NODE_ENV`.

## How D wants you to work
- Direct, content-dense answers; precise technical rigor. D will correct inaccuracies — do not make blanket claims; verify before asserting.
- Never tell D to "check the console" for failures. Surface the failure reason in a visible alert or UI message instead.
- Verify claims against the code. Several earlier mistakes came from too-narrow greps; search broadly.
- Check that a deployed build actually contains a change before debugging its behavior (see "stale deploy" in docs/DEBUGGING.md).
- Do not rewrite D's newer code from an older copy. This repo is the source of truth.

## Known pitfalls (details in docs/DEBUGGING.md)
- Postgres `array_agg(name)` returns `name[]`, which the `pg` driver leaves unparsed: always cast `::text`.
- `CREATE TABLE IF NOT EXISTS` does not retrofit columns/constraints on existing tables: add standalone `ALTER` migrations (see `_ensurePrimaryKey`, `ensureAnnotationTypePrefsColumn`).
- Module-level `analysisResults` is shared state: the concurrent-run guard `_analysisInProgress` protects it.
- `/Wavefire_files/*_3UUq.*` 404s in logs are a saved-page asset-path artifact, not an app bug.
- A `TEMPORARY DIAGNOSTIC` block in `public/index.html` downloads a Step-1-only PDF; remove it once the hybrid PDF issue is resolved.

## Where to look next
- `docs/STATE.md` — current status, open issues, next steps.
- `docs/DECISIONS.md` — decisions and reversals with reasoning.
- `docs/DEBUGGING.md` — incident journal.
- `docs/ARCHITECTURE.md` — architecture detail.
- `docs/RAILWAY_AND_SECURITY.md` — hosting layout and the Nov 2026 credential rotation.
- `design-documents/` — feature plans (annotation types, admin file inventory, pass/fail override and sync, exceptions table, data analysis, continuous auditing, and more).
