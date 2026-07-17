/**
 * Wavefire Audit App — Backend API Proxy
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Postgres ────────────────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL
  || process.env.database_url
  || process.env.POSTGRES_URL
  || process.env.DATABASE_PRIVATE_URL
  || process.env.DATABASE_PUBLIC_URL;
const pool = dbUrl ? new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } }) : null;
if (!dbUrl) console.warn('[DB] No database URL found — checked DATABASE_URL, database_url, POSTGRES_URL, DATABASE_PRIVATE_URL, DATABASE_PUBLIC_URL');
else console.log('[DB] Connecting to:', dbUrl.replace(/:\/\/[^@]+@/, '://***@'));
// ── Tenant scaffolding ────────────────────────────────────────────────────────
// DEFAULT_TENANT is the placeholder tenant used while the app is single-tenant.
// When multi-tenancy is added, replace every reference to DEFAULT_TENANT_ID with
// the tenant_id resolved from the authenticated session.
const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || 'default';

// Lightweight AES-256-GCM encryption for per-tenant AI credentials
const crypto = require('crypto');
// AES-256-GCM requires a 32-byte key. A missing env var previously fell back to
// 32 zero bytes — a publicly known constant, so ciphertext would be trivially
// decryptable by anyone. Refuse to encrypt rather than provide false assurance.
const _rawEncKey = process.env.CREDENTIAL_ENCRYPTION_KEY || '';
const ENC_KEY_OK = Buffer.byteLength(_rawEncKey, 'utf8') >= 32;
const ENC_KEY = ENC_KEY_OK ? Buffer.from(_rawEncKey, 'utf8').subarray(0, 32) : null;
if (!ENC_KEY_OK) {
  console.error('[SECURITY] CREDENTIAL_ENCRYPTION_KEY is unset or under 32 bytes. ' +
    'Per-tenant AI credentials cannot be encrypted and will be rejected. ' +
    'Set a random 32+ character value in the environment.');
}
function encryptKey(plaintext) {
  if (!plaintext) return '';
  if (!ENC_KEY) throw new Error('CREDENTIAL_ENCRYPTION_KEY not configured');
  try {
    const iv   = crypto.randomBytes(12);
    const ciph = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
    const enc  = Buffer.concat([ciph.update(plaintext, 'utf8'), ciph.final()]);
    const tag  = ciph.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  } catch(e) { console.error('[enc] error:', e.message); return ''; }
}
function decryptKey(ciphertext) {
  if (!ciphertext) return '';
  if (!ENC_KEY) return '';
  try {
    const buf  = Buffer.from(ciphertext, 'base64');
    const iv   = buf.slice(0, 12);
    const tag  = buf.slice(12, 28);
    const enc  = buf.slice(28);
    const dec  = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    dec.setAuthTag(tag);
    return Buffer.concat([dec.update(enc), dec.final()]).toString('utf8');
  } catch(e) { return ''; }
}

// ── Security helpers ─────────────────────────────────────────────────────────
// The Azure endpoint is operator-supplied but is used to build an outbound URL
// that carries the API key in a header. An attacker-controlled value would
// exfiltrate that key (SSRF + credential leak). Validate on write AND on read,
// so values persisted before this check was added can never be used.
function isSafeAzureEndpoint(raw) {
  if (!raw) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;          // https://key@evil.com
  const host = u.hostname.toLowerCase();
  // Azure OpenAI resources always live under these suffixes.
  const ALLOWED_SUFFIXES = ['.openai.azure.com', '.cognitiveservices.azure.com'];
  if (!ALLOWED_SUFFIXES.some(s => host.endsWith(s))) return false;
  // Reject the bare suffix itself and any embedded credentials/traversal.
  if (ALLOWED_SUFFIXES.includes('.' + host)) return false;
  return true;
}

// Azure deployment names are path segments — keep them to a safe charset so they
// cannot escape the path (e.g. "../../" or a full URL).
function isSafeDeploymentName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(name);
}

// Error bodies currently echo err.message, which leaks schema and driver detail.
// Log the real error server-side; return something generic to the client.
function fail(res, err, context, status = 500) {
  console.error(`[${context}]`, err && err.message ? err.message : err);
  return res.status(status).json({ error: 'Internal server error' });
}

async function initDB() {
  if (!pool) { console.log('No DATABASE_URL — running without database'); return; }
  try {
    await pool.query(`
      -- ── Tenants (scaffold for future multi-tenancy) ────────────────────────
      CREATE TABLE IF NOT EXISTS tenants (
        id          TEXT PRIMARY KEY DEFAULT 'default',
        name        TEXT NOT NULL DEFAULT 'Default Organisation',
        domain      TEXT DEFAULT '',
        plan        TEXT DEFAULT 'trial',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO tenants (id, name) VALUES ('default','Default Organisation')
        ON CONFLICT (id) DO NOTHING;

      -- ── Per-tenant AI credential store ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS tenant_ai_configs (
        tenant_id        TEXT NOT NULL DEFAULT 'default',
        provider         TEXT NOT NULL DEFAULT 'anthropic',
        model            TEXT DEFAULT 'claude-sonnet-4-6',
        endpoint         TEXT DEFAULT '',
        deployment       TEXT DEFAULT '',
        encrypted_key    TEXT DEFAULT '',
        key_hint         TEXT DEFAULT '',
        azure_tenant_id  TEXT DEFAULT '',
        use_managed_id   BOOLEAN DEFAULT FALSE,
        updated_at       TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, provider),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS entity_types (
        name    TEXT PRIMARY KEY,
        bg      TEXT NOT NULL DEFAULT '#f1f5f9',
        color   TEXT NOT NULL DEFAULT '#475569',
        border  TEXT NOT NULL DEFAULT '#cbd5e1',
        icon    TEXT NOT NULL DEFAULT 'ti-tag',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workpaper_annotations (
        ref         TEXT NOT NULL,
        filename    TEXT NOT NULL,
        annotations JSONB DEFAULT '[]',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY (tenant_id, ref, filename)
      );
      CREATE TABLE IF NOT EXISTS audits (
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        name        TEXT NOT NULL DEFAULT '',
        period      TEXT DEFAULT '',
        owner       TEXT DEFAULT '',
        type        TEXT DEFAULT '',
        status      TEXT DEFAULT 'planned',
        description TEXT DEFAULT '',
        year        INTEGER,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, name)
      );
      CREATE TABLE IF NOT EXISTS workpapers (
        id                     UUID UNIQUE DEFAULT gen_random_uuid(),
        tenant_id              TEXT NOT NULL DEFAULT 'default',
        ref                    TEXT NOT NULL DEFAULT '',
        audit_name             TEXT NOT NULL DEFAULT '',
        name                   TEXT DEFAULT '',
        type                   TEXT DEFAULT '',
        status                 TEXT DEFAULT 'draft',
        results                TEXT DEFAULT '',
        preparer               TEXT DEFAULT '',
        reviewer               TEXT DEFAULT '',
        secondary_reviewer     TEXT DEFAULT '',
        date_started           DATE,
        review_date            DATE,
        date_submitted         DATE,
        secondary_review_date  DATE,
        population             TEXT DEFAULT '',
        sample_method          TEXT DEFAULT '',
        sample_size            INTEGER,
        narrative              TEXT DEFAULT '',
        description            TEXT DEFAULT '',
        test_desc              TEXT DEFAULT '',
        linked_controls        JSONB DEFAULT '[]',
        linked_risks           JSONB DEFAULT '[]',
        linked_entities        JSONB DEFAULT '[]',
        fs_accounts            JSONB DEFAULT '[]',
        scope_entities         JSONB DEFAULT '[]',
        scope_fs_accounts      JSONB DEFAULT '[]',
        test_attributes        JSONB DEFAULT '[]',
        sample_fields          JSONB DEFAULT '[]',
        sample_data            JSONB DEFAULT '{"columns":[],"rows":[]}',
        exceptions             JSONB DEFAULT '[]',
        created_at             TIMESTAMPTZ DEFAULT NOW(),
        updated_at             TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, ref)
      );

      CREATE TABLE IF NOT EXISTS company_context (
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        id          INTEGER DEFAULT 1,
        notes       TEXT DEFAULT '',
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS fs_accounts (
        tenant_id       TEXT NOT NULL DEFAULT 'default',
        id              TEXT NOT NULL DEFAULT '',
        code            TEXT DEFAULT '',
        description     TEXT DEFAULT '',
        section         TEXT DEFAULT '',
        cur_balance     NUMERIC,
        py_balance      NUMERIC,
        materiality     TEXT DEFAULT '',
        txn_volume      TEXT DEFAULT '',
        inherent_risk   TEXT DEFAULT '',
        key_account     BOOLEAN DEFAULT FALSE,
        assertions      JSONB DEFAULT '[]',
        audit_approach  TEXT DEFAULT '',
        notes           TEXT DEFAULT '',
        fn_text         TEXT DEFAULT '',
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS control_categories (
        name       TEXT PRIMARY KEY,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      -- Seed defaults if empty
      INSERT INTO control_categories (name, sort_order) VALUES
        ('Access',1),('Change Management',2),('Operations',3),
        ('Financial Reporting',4),('Compliance',5),('IT General Controls',6),
        ('Payroll',7),('Vendor Due Diligence',8),('Other',9)
      ON CONFLICT (name) DO NOTHING;
      CREATE TABLE IF NOT EXISTS entity_types (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL DEFAULT '',
        description TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS controls (
        tenant_id    TEXT NOT NULL DEFAULT 'default',
        id           TEXT NOT NULL DEFAULT '',
        name         TEXT NOT NULL DEFAULT '',
        category     TEXT DEFAULT '',
        objective    TEXT DEFAULT '',
        objective_id TEXT DEFAULT '',
        description  TEXT DEFAULT '',
        ctrl_owner   TEXT DEFAULT '',
        proc_owner   TEXT DEFAULT '',
        extra_ctrl_owners JSONB DEFAULT '[]',
        extra_proc_owners JSONB DEFAULT '[]',
        frequency    TEXT DEFAULT '',
        control_type TEXT DEFAULT '',
        additional_info TEXT DEFAULT '',
        linked_risks     JSONB DEFAULT '[]',
        linked_entities  JSONB DEFAULT '[]',
        linked_accounts  JSONB DEFAULT '[]',
        analyst_notes    TEXT DEFAULT '',
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS risks (
        tenant_id    TEXT NOT NULL DEFAULT 'default',
        id           TEXT NOT NULL DEFAULT '',
        name         TEXT NOT NULL DEFAULT '',
        category     TEXT DEFAULT '',
        description  TEXT DEFAULT '',
        analyst_notes TEXT DEFAULT '',
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS control_objectives (
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        id          TEXT NOT NULL DEFAULT '',
        title       TEXT NOT NULL DEFAULT '',
        description TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS company_settings (
        tenant_id     TEXT NOT NULL DEFAULT 'default' PRIMARY KEY,
        name          TEXT DEFAULT '',
        industry      TEXT DEFAULT '',
        fiscal_year_end TEXT DEFAULT '',
        address       TEXT DEFAULT '',
        city          TEXT DEFAULT '',
        state         TEXT DEFAULT '',
        zip           TEXT DEFAULT '',
        website       TEXT DEFAULT '',
        ein           TEXT DEFAULT '',
        ai_provider   TEXT DEFAULT 'anthropic',
        ai_model      TEXT DEFAULT 'claude-sonnet-4-6',
        azure_endpoint TEXT DEFAULT '',
        azure_deployment TEXT DEFAULT '',
        azure_api_key TEXT DEFAULT '',
        openai_api_key TEXT DEFAULT '',
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );

      -- ── Data Analysis tables ──────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS da_datasets (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        name        TEXT NOT NULL DEFAULT '',
        filename    TEXT NOT NULL DEFAULT '',
        file_hash   TEXT NOT NULL DEFAULT '',
        row_count   INTEGER DEFAULT 0,
        col_count   INTEGER DEFAULT 0,
        notes       TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        last_used   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS da_columns (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dataset_id  UUID NOT NULL REFERENCES da_datasets(id) ON DELETE CASCADE,
        col_index   INTEGER NOT NULL,
        col_name    TEXT NOT NULL DEFAULT '',
        label       TEXT DEFAULT '',
        col_type    TEXT DEFAULT 'auto',
        include_in_model BOOLEAN DEFAULT TRUE,
        encoding    TEXT DEFAULT 'auto',
        notes       TEXT DEFAULT '',
        UNIQUE (dataset_id, col_index)
      );

      CREATE TABLE IF NOT EXISTS da_labels (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dataset_id  UUID NOT NULL REFERENCES da_datasets(id) ON DELETE CASCADE,
        row_index   INTEGER NOT NULL,
        label       TEXT NOT NULL DEFAULT 'uncertain',
        labeled_by  TEXT DEFAULT '',
        notes       TEXT DEFAULT '',
        labeled_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (dataset_id, row_index)
      );

      CREATE TABLE IF NOT EXISTS da_model_runs (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dataset_id  UUID NOT NULL REFERENCES da_datasets(id) ON DELETE CASCADE,
        model_type  TEXT NOT NULL DEFAULT '',
        params      JSONB DEFAULT '{}',
        scores      JSONB DEFAULT '[]',
        thresholds  JSONB DEFAULT '{}',
        weights     JSONB DEFAULT '{}',
        label_count INTEGER DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('DB: risks + controls tables ready');

    // ── Indexes ───────────────────────────────────────────────────────────────
    // Every list/read query filters on one of these columns; without indexes each
    // is a full table scan. IF NOT EXISTS makes this safe to run on every boot.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_audits_tenant           ON audits(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_workpapers_tenant       ON workpapers(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_workpapers_audit        ON workpapers(tenant_id, audit_name);
      CREATE INDEX IF NOT EXISTS idx_controls_tenant         ON controls(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_risks_tenant            ON risks(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_entities_tenant         ON assessment_entities(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_fs_accounts_tenant      ON fs_accounts(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_control_obj_tenant      ON control_objectives(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_da_datasets_tenant      ON da_datasets(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_da_datasets_hash        ON da_datasets(tenant_id, file_hash);
      CREATE INDEX IF NOT EXISTS idx_da_columns_dataset      ON da_columns(dataset_id);
      CREATE INDEX IF NOT EXISTS idx_da_labels_dataset       ON da_labels(dataset_id);
      CREATE INDEX IF NOT EXISTS idx_da_runs_dataset         ON da_model_runs(dataset_id);
    `);
    console.log('DB: indexes ready');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS assessment_entities (
        tenant_id            TEXT NOT NULL DEFAULT 'default',
        id                   TEXT NOT NULL DEFAULT '',
        name                 TEXT NOT NULL DEFAULT '',
        type                 TEXT NOT NULL DEFAULT 'Facility',
        category             TEXT NOT NULL DEFAULT 'facility',
        address              TEXT DEFAULT '',
        city                 TEXT DEFAULT '',
        state                TEXT DEFAULT '',
        poc                  TEXT DEFAULT '',
        sub                  TEXT DEFAULT '',
        description          TEXT DEFAULT '',
        app_purpose          TEXT DEFAULT '',
        user_count           TEXT DEFAULT '',
        txn_volume           TEXT DEFAULT '',
        txn_dollar           TEXT DEFAULT '',
        change_volume        TEXT DEFAULT '',
        change_complexity    TEXT DEFAULT '',
        admin_users          TEXT DEFAULT '',
        key_integrations     TEXT DEFAULT '',
        external_integrations TEXT DEFAULT '',
        custom_fields         JSONB DEFAULT '[]',
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id)
      );
    `);
    console.log('DB: assessment_entities table ready');

    // ── Auto-migrations for pre-existing tables ──────────────────────────────
    try {
      // Tenant scaffolding — add tenant_id to all existing tables
      const tenantTables = [
        'audits','workpapers','workpaper_annotations','controls','risks',
        'assessment_entities','fs_accounts','company_context',
        'control_objectives','control_categories'
      ];
      for (const tbl of tenantTables) {
        await pool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      // company_settings uses tenant_id as PK — handle separately
      await pool.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`).catch(()=>{});
      console.log('DB: tenant_id columns added to all tables');

      await pool.query(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS description    TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE controls          ADD COLUMN IF NOT EXISTS objective_id  TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE controls          ADD COLUMN IF NOT EXISTS analyst_notes TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE risks             ADD COLUMN IF NOT EXISTS analyst_notes TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE risks             ADD COLUMN IF NOT EXISTS category TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE risks             ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`);
      await pool.query(`ALTER TABLE workpapers         ADD COLUMN IF NOT EXISTS sample_data JSONB DEFAULT '{"columns":[],"rows":[]}'`);
      // Stable per-workpaper id, used to link sample_data_columns/rows and
      // extracted_data back to their workpaper — ref stays the
      // primary key and the human-readable/editable identifier used
      // everywhere else in this codebase, but ref could theoretically be
      // renamed or (across a future multi-tenant world) collide, so the new
      // linking tables use this instead. gen_random_uuid() is a VOLATILE
      // default, which means this ALTER TABLE physically computes and
      // stores a real, unique id for every existing row (not a shared
      // static value, not NULL) rather than the fast metadata-only path
      // Postgres uses for constant defaults — the right tradeoff here since
      // this table is small enough that the one-time rewrite cost is
      // negligible, and every workpaper needs a genuinely distinct id.
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid()`);
      await pool.query(`UPDATE workpapers SET id = gen_random_uuid() WHERE id IS NULL`);
      await pool.query(`ALTER TABLE workpapers ALTER COLUMN id SET NOT NULL`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workpapers_id ON workpapers(id)`);
      console.log('DB: workpapers.id backfilled and constrained');

      // ── User Provided Sample Data + Extracted Data tables — created HERE,
      // after workpapers.id is guaranteed to exist and be unique (a foreign
      // key target needs that), not up in the initial CREATE TABLE block.
      // On a fresh install workpapers.id already exists from its own CREATE
      // TABLE with UNIQUE inline, so this is a no-op there; on an existing
      // deployment being migrated, this is the first point at which
      // workpapers.id is actually usable as a FK target.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sample_data_columns (
          id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          workpaper_id   UUID NOT NULL REFERENCES workpapers(id) ON DELETE CASCADE,
          col_index      INTEGER NOT NULL DEFAULT 0,
          title          TEXT DEFAULT '',
          width          INTEGER DEFAULT 180,
          system_added   BOOLEAN DEFAULT FALSE,
          created_at     TIMESTAMPTZ DEFAULT NOW(),
          updated_at     TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS sample_data_rows (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workpaper_id  UUID NOT NULL REFERENCES workpapers(id) ON DELETE CASCADE,
          row_index     INTEGER NOT NULL DEFAULT 0,
          cells         JSONB DEFAULT '{}',
          row_height    INTEGER,
          created_at    TIMESTAMPTZ DEFAULT NOW(),
          updated_at    TIMESTAMPTZ DEFAULT NOW()
        );
        -- Extracted Data field DEFINITIONS: what to search for (Title,
        -- Description, Guidance). Same list drives both extraction modes
        -- below; it never stores per-record extracted values itself.
        CREATE TABLE IF NOT EXISTS extracted_data (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workpaper_id  UUID NOT NULL REFERENCES workpapers(id) ON DELETE CASCADE,
          field_index   INTEGER NOT NULL DEFAULT 0,
          title         TEXT DEFAULT '',
          description   TEXT DEFAULT '',
          guidance      TEXT DEFAULT '',
          created_at    TIMESTAMPTZ DEFAULT NOW(),
          updated_at    TIMESTAMPTZ DEFAULT NOW()
        );
        -- Extraction RESULTS for "independent" mode (the Extract Sample Data
        -- checkbox unchecked): one row per sample record the AI found in the
        -- attached files, values keyed by extracted_data.id, with zero
        -- awareness of or link to sample_data_rows/sample_data_columns —
        -- this table exists specifically so that mode can run with no
        -- interaction with the User Provided Sample Data grid at all, even
        -- when that grid already has data. "Append to grid" mode (checkbox
        -- checked) does NOT write here — it writes directly into new
        -- sample_data_columns/sample_data_rows cells instead, marked
        -- system_added so the UI can show them as visually distinct.
        CREATE TABLE IF NOT EXISTS extracted_data_records (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workpaper_id  UUID NOT NULL REFERENCES workpapers(id) ON DELETE CASCADE,
          row_index     INTEGER NOT NULL DEFAULT 0,
          cells         JSONB DEFAULT '{}',
          source_file   TEXT DEFAULT '',
          created_at    TIMESTAMPTZ DEFAULT NOW(),
          updated_at    TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_sdcols_wp     ON sample_data_columns(workpaper_id);
        CREATE INDEX IF NOT EXISTS idx_sdrows_wp     ON sample_data_rows(workpaper_id);
        CREATE INDEX IF NOT EXISTS idx_extdata_wp    ON extracted_data(workpaper_id);
        CREATE INDEX IF NOT EXISTS idx_extrecords_wp ON extracted_data_records(workpaper_id);
      `);
      console.log('DB: sample_data_columns, sample_data_rows, extracted_data, extracted_data_records ready');
      // Copy any data from a legacy "desc" column if it still exists
      const col = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='audits' AND column_name='desc'`);
      if (col.rows.length) {
        await pool.query(`UPDATE audits SET description = "desc" WHERE (description IS NULL OR description='') AND "desc" IS NOT NULL`);
        console.log('DB: migrated audits.desc → audits.description');
      }
      console.log('DB: all migrations applied');
    } catch(mErr) { console.warn('DB: migration skipped:', mErr.message); }
  } catch(err) {
    console.error('DB init error:', err.message);
  }
}
initDB();

// Behind Railway's reverse proxy the client IP arrives in X-Forwarded-For.
// Without this, req.ip is the proxy's address and the per-IP rate limiter would
// lump every user into one bucket. 1 = trust the first proxy hop.
app.set('trust proxy', 1);

// ── Middleware ──────────────────────────────────────────────────────────────
// CORS: `cors()` with no options reflects any Origin, letting any website on the
// internet drive this API from a visitor's browser. Restrict to known origins.
// Set ALLOWED_ORIGINS as a comma-separated list in Railway.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // Same-origin / curl / server-to-server requests send no Origin header.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true); // dev default
    return ALLOWED_ORIGINS.includes(origin)
      ? cb(null, true)
      : cb(new Error('Origin not allowed by CORS'));
  },
  credentials: false,
}));

// Baseline security headers (equivalent to the parts of helmet that matter here,
// without adding a dependency).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.removeHeader('X-Powered-By');           // stop advertising Express
  next();
});

// 50mb of JSON per request is a cheap memory-exhaustion DoS. Uploads are parsed
// in the browser and never POSTed as JSON, so this can be far smaller.
//
// /api/ai/analyze is deliberately excluded here: it carries a base64-encoded
// PDF/image in its JSON body for document extraction, which needs a larger
// limit than every other route (see AI_ANALYZE_BODY_LIMIT below). Express
// runs body-parsing middleware in registration order and only once per
// request — if this global parser ran for that route too, it would already
// have enforced the 2mb cap (and populated req.body) before the route's own,
// larger-limit parser ever got a chance to run, silently defeating it. This
// skip is what makes the route-level override in that handler actually work.
app.use(function(req, res, next) {
  if (req.path === '/api/ai/analyze') return next();
  express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' })(req, res, next);
});

// The AI proxy spends real money per call and is unauthenticated. Until auth
// lands, cap request volume per IP so a single caller cannot drain the budget.
const _aiHits = new Map(); // ip -> number[] (timestamps)
const AI_WINDOW_MS = 60_000;
const AI_MAX_PER_WINDOW = Number(process.env.AI_RATE_LIMIT || 20);
function aiRateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const hits = (_aiHits.get(ip) || []).filter(t => now - t < AI_WINDOW_MS);
  if (hits.length >= AI_MAX_PER_WINDOW) {
    res.setHeader('Retry-After', Math.ceil(AI_WINDOW_MS / 1000));
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }
  hits.push(now);
  _aiHits.set(ip, hits);
  next();
}
// Bound the map so it cannot grow without limit.
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of _aiHits) {
    const live = hits.filter(t => now - t < AI_WINDOW_MS);
    if (live.length) _aiHits.set(ip, live); else _aiHits.delete(ip);
  }
}, AI_WINDOW_MS).unref();

// ── Control Categories API ────────────────────────────────────────────────────
app.get('/api/control-categories', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT name FROM control_categories ORDER BY sort_order, name'); res.json(rows.map(r=>r.name)); }
  catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/control-categories', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM control_categories');
    await pool.query('INSERT INTO control_categories (name, sort_order) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, rows[0].n]);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'api'); }
});

// ── Risks API ───────────────────────────────────────────────────────────────
app.get('/api/risks', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM risks WHERE tenant_id=$1 ORDER BY id', [DEFAULT_TENANT_ID]); res.json(rows); }
  catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/risks', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id, name, category, description } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(`INSERT INTO risks (tenant_id,id,name,category,description,updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (tenant_id,id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, description=EXCLUDED.description, updated_at=NOW()`,
      [DEFAULT_TENANT_ID, id, name||'', category||'', description||'']);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'api'); }
});

app.delete('/api/risks/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM risks WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch(err) { return fail(res, err, 'api'); }
});

// ── Controls API ─────────────────────────────────────────────────────────────
app.get('/api/controls', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM controls WHERE tenant_id=$1 ORDER BY category, id', [DEFAULT_TENANT_ID]); res.json(rows); }
  catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/controls', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id, name, category, objective, objective_id, description, additional_info,
          ctrl_owner, proc_owner, extra_ctrl_owners, extra_proc_owners,
          frequency, control_type, linked_risks, linked_entities, linked_accounts,
          analyst_notes } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(`INSERT INTO controls
        (id,name,category,objective,objective_id,description,additional_info,ctrl_owner,proc_owner,extra_ctrl_owners,extra_proc_owners,frequency,control_type,linked_risks,linked_entities,linked_accounts,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name, category=EXCLUDED.category, objective=EXCLUDED.objective,
        objective_id=EXCLUDED.objective_id,
        description=EXCLUDED.description, additional_info=EXCLUDED.additional_info,
        ctrl_owner=EXCLUDED.ctrl_owner, proc_owner=EXCLUDED.proc_owner,
        extra_ctrl_owners=EXCLUDED.extra_ctrl_owners, extra_proc_owners=EXCLUDED.extra_proc_owners,
        frequency=EXCLUDED.frequency, control_type=EXCLUDED.control_type,
        linked_risks=EXCLUDED.linked_risks, linked_entities=EXCLUDED.linked_entities,
        linked_accounts=EXCLUDED.linked_accounts, updated_at=NOW()`,
      [id, name||'', category||'', objective||'', objective_id||'', description||'', additional_info||'',
       ctrl_owner||'', proc_owner||'',
       JSON.stringify(extra_ctrl_owners||[]),
       JSON.stringify(extra_proc_owners||[]),
       frequency||'', control_type||'',
       JSON.stringify(linked_risks||[]),
       JSON.stringify(linked_entities||[]),
       JSON.stringify(linked_accounts||[])]);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'api'); }
});

app.delete('/api/controls/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM controls WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch(err) { return fail(res, err, 'api'); }
});

// ── Entity Types API ────────────────────────────────────────────────────────
app.get('/api/entity-types', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query('SELECT * FROM entity_types ORDER BY name');
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/entity-types:'); }
});

app.post('/api/entity-types', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  const { name, bg, color, border, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    await pool.query(`
      INSERT INTO entity_types (name, bg, color, border, icon)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (name) DO UPDATE SET bg=EXCLUDED.bg, color=EXCLUDED.color, border=EXCLUDED.border, icon=EXCLUDED.icon
    `, [name, bg||'#f1f5f9', color||'#475569', border||'#cbd5e1', icon||'ti-tag']);
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'POST /api/entity-types:'); }
});

// ── Assessment Entities API ─────────────────────────────────────────────────
app.get('/api/entities', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query('SELECT * FROM assessment_entities WHERE tenant_id=$1 ORDER BY type, name', [DEFAULT_TENANT_ID]);
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/entities:'); }
});

app.post('/api/entities', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  const { id, name, type, category, address, city, state, poc, sub, description,
          app_purpose, user_count, txn_volume, txn_dollar, change_volume,
          change_complexity, admin_users, key_integrations, external_integrations,
          custom_fields } = req.body;
  try {
    await pool.query(`
      INSERT INTO assessment_entities
        (id,name,type,category,address,city,state,poc,sub,description,
         app_purpose,user_count,txn_volume,txn_dollar,change_volume,
         change_complexity,admin_users,key_integrations,external_integrations,
         custom_fields,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name, type=EXCLUDED.type, category=EXCLUDED.category,
        address=EXCLUDED.address, city=EXCLUDED.city, state=EXCLUDED.state,
        poc=EXCLUDED.poc, sub=EXCLUDED.sub, description=EXCLUDED.description,
        app_purpose=EXCLUDED.app_purpose, user_count=EXCLUDED.user_count,
        txn_volume=EXCLUDED.txn_volume, txn_dollar=EXCLUDED.txn_dollar,
        change_volume=EXCLUDED.change_volume, change_complexity=EXCLUDED.change_complexity,
        admin_users=EXCLUDED.admin_users, key_integrations=EXCLUDED.key_integrations,
        external_integrations=EXCLUDED.external_integrations,
        custom_fields=EXCLUDED.custom_fields, updated_at=NOW()
    `, [id, name||'', type||'Facility', category||'facility',
        address||'', city||'', state||'', poc||'', sub||'', description||'',
        app_purpose||'', user_count||'', txn_volume||'', txn_dollar||'',
        change_volume||'', change_complexity||'', admin_users||'',
        key_integrations||'', external_integrations||'',
        JSON.stringify(custom_fields||[])]);
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'POST /api/entities:'); }
});

app.delete('/api/entities/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  try {
    await pool.query('DELETE FROM assessment_entities WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'DELETE /api/entities:'); }
});



// ── PDF.js — served from npm package (no CDN needed) ───────────────────────
app.get('/pdfjs/pdf.min.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(require.resolve('pdfjs-dist/build/pdf.min.js'));
});

app.get('/pdfjs/pdf.worker.min.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(require.resolve('pdfjs-dist/build/pdf.worker.min.js'));
});

// ── pdf-lib — served from npm package (no CDN needed) ──────────────────────
app.get('/pdflib/pdf-lib.min.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(require.resolve('pdf-lib/dist/pdf-lib.min.js'));
});

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── API key + Claude connectivity test ──────────────────────────────────────
app.get('/api/test', aiRateLimit, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set on the server.' });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages:   [{ role: 'user', content: 'Reply with just the word OK.' }],
      }),
    });
    const data = await response.json();
    if (data.error) {
      return res.status(response.status).json({
        ok:     false,
        status: response.status,
        error:  data.error.message,
        type:   data.error.type
      });
    }
    const reply = data.content?.[0]?.text || '(no text)';
    res.json({ ok: true, claude_replied: reply, model: data.model });
  } catch (err) {
    console.error('[api/test]', err.message); res.status(502).json({ ok: false, error: 'Upstream request failed' });
  }
});

// ── Claude API proxy ────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY is not set on the server.' } });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Claude API error:', err.message);
    res.status(502).json({ error: { message: `Proxy error: ${err.message}` } });
  }
});


// ── Audits API ────────────────────────────────────────────────────────────────
app.get('/api/audits', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM audits WHERE tenant_id=$1 ORDER BY created_at', [DEFAULT_TENANT_ID]); res.json(rows); }
  catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/audits', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { name, period, owner, type, status, description, desc, year } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const descVal = description != null ? description : (desc || '');
  console.log('[API] POST /api/audits name=', name, 'desc length=', descVal.length);
  try {
    await pool.query(`INSERT INTO audits (tenant_id,name,period,owner,type,status,description,year,updated_at)
      VALUES ($8,$1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (tenant_id,name) DO UPDATE SET period=EXCLUDED.period, owner=EXCLUDED.owner,
        type=EXCLUDED.type, status=EXCLUDED.status, description=EXCLUDED.description, year=EXCLUDED.year, updated_at=NOW()`,
      [name, period||'', owner||'', type||'', status||'planned', descVal, year||null, DEFAULT_TENANT_ID]);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, '[API] audit save error:'); }
});

app.patch('/api/audits/:oldName', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const oldName = req.params.oldName;
  const { name, period, owner, type, status, description, year } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    // Rename = insert new row + delete old (if name changed), else just update
    if (name !== oldName) {
      await pool.query(`INSERT INTO audits (tenant_id,name,period,owner,type,status,description,year,updated_at)
        VALUES ($8,$1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (tenant_id,name) DO UPDATE SET period=EXCLUDED.period, owner=EXCLUDED.owner,
          type=EXCLUDED.type, status=EXCLUDED.status, description=EXCLUDED.description,
          year=EXCLUDED.year, updated_at=NOW()`,
        [name, period||'', owner||'', type||'', status||'planned', description||'', year||null, DEFAULT_TENANT_ID]);
      // Update workpapers that referenced the old audit name
      await pool.query(`UPDATE workpapers SET audit_name=$1 WHERE tenant_id=$2 AND audit_name=$3`,
        [name, DEFAULT_TENANT_ID, oldName]);
      await pool.query(`DELETE FROM audits WHERE tenant_id=$1 AND name=$2`, [DEFAULT_TENANT_ID, oldName]);
    } else {
      await pool.query(`INSERT INTO audits (tenant_id,name,period,owner,type,status,description,year,updated_at)
        VALUES ($8,$1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (tenant_id,name) DO UPDATE SET period=EXCLUDED.period, owner=EXCLUDED.owner,
          type=EXCLUDED.type, status=EXCLUDED.status, description=EXCLUDED.description,
          year=EXCLUDED.year, updated_at=NOW()`,
        [name, period||'', owner||'', type||'', status||'planned', description||'', year||null, DEFAULT_TENANT_ID]);
    }
    res.json({ ok:true });
  } catch(err) { return fail(res, err, '[API] audit rename error:'); }
});


app.get('/api/workpapers', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM workpapers WHERE tenant_id=$1 ORDER BY audit_name, ref', [DEFAULT_TENANT_ID]); res.json(rows); }
  catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/workpapers', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const {
    ref, audit_name, name, type, status, results,
    preparer, reviewer, secondary_reviewer,
    date_started, review_date, date_submitted, secondary_review_date,
    population, sample_method, sample_size,
    narrative, description, test_desc,
    linked_controls, linked_risks, linked_entities, fs_accounts,
    scope_entities, scope_fs_accounts,
    test_attributes, sample_fields, sample_data, exceptions
  } = req.body;
  if (!ref) return res.status(400).json({ error: 'ref required' });
  try {
    await pool.query(`INSERT INTO workpapers
        (ref,audit_name,name,type,status,results,preparer,reviewer,secondary_reviewer,
         date_started,review_date,date_submitted,secondary_review_date,
         population,sample_method,sample_size,narrative,description,test_desc,
         linked_controls,linked_risks,linked_entities,fs_accounts,
         scope_entities,scope_fs_accounts,test_attributes,sample_fields,sample_data,exceptions,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
              $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,NOW())
      ON CONFLICT (ref) DO UPDATE SET
        audit_name=EXCLUDED.audit_name, name=EXCLUDED.name, type=EXCLUDED.type,
        status=EXCLUDED.status, results=EXCLUDED.results,
        preparer=EXCLUDED.preparer, reviewer=EXCLUDED.reviewer,
        secondary_reviewer=EXCLUDED.secondary_reviewer,
        date_started=EXCLUDED.date_started, review_date=EXCLUDED.review_date,
        date_submitted=EXCLUDED.date_submitted,
        secondary_review_date=EXCLUDED.secondary_review_date,
        population=EXCLUDED.population, sample_method=EXCLUDED.sample_method,
        sample_size=EXCLUDED.sample_size, narrative=EXCLUDED.narrative,
        description=EXCLUDED.description, test_desc=EXCLUDED.test_desc,
        linked_controls=EXCLUDED.linked_controls, linked_risks=EXCLUDED.linked_risks,
        linked_entities=EXCLUDED.linked_entities, fs_accounts=EXCLUDED.fs_accounts,
        scope_entities=EXCLUDED.scope_entities, scope_fs_accounts=EXCLUDED.scope_fs_accounts,
        test_attributes=EXCLUDED.test_attributes, sample_fields=EXCLUDED.sample_fields,
        sample_data=EXCLUDED.sample_data,
        exceptions=EXCLUDED.exceptions, updated_at=NOW()`,
      [ref, audit_name||'', name||'', type||'', status||'draft', results||'',
       preparer||'', reviewer||'', secondary_reviewer||'',
       date_started||null, review_date||null, date_submitted||null, secondary_review_date||null,
       population||'', sample_method||'', sample_size||null,
       narrative||'', description||'', test_desc||'',
       JSON.stringify(linked_controls||[]), JSON.stringify(linked_risks||[]),
       JSON.stringify(linked_entities||[]), JSON.stringify(fs_accounts||[]),
       JSON.stringify(scope_entities||[]), JSON.stringify(scope_fs_accounts||[]),
       JSON.stringify(test_attributes||[]), JSON.stringify(sample_fields||[]),
       JSON.stringify(sample_data||{columns:[],rows:[]}),
       JSON.stringify(exceptions||[])
      ]);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'api'); }
});

app.delete('/api/workpapers/:ref', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM workpapers WHERE ref=$1', [req.params.ref]); res.json({ ok:true }); }
  catch(err) { return fail(res, err, 'api'); }
});

// ── User Provided Sample Data (columns + rows, real Postgres tables) ─────────
// Replaces the old workpapers.sample_data JSONB blob. GET returns both
// columns and rows together for one workpaper, since the client always
// needs the full grid at once. POST replaces the ENTIRE set for that
// workpaper in one transaction (delete-then-reinsert) — this correctly
// handles every kind of edit (added/removed/reordered columns or rows,
// value edits) uniformly, rather than trying to upsert by an index that can
// shift or leaving orphaned rows behind when the count shrinks.
//
// Routes are still addressed by :ref in the URL (that's what the client has
// — the ref shown in the page/URL), but every query underneath operates on
// workpapers.id, resolved from that ref first. This keeps the human-facing
// API shape the same while the actual linking key is the stable surrogate.
async function _resolveWorkpaperId(ref) {
  const { rows } = await pool.query('SELECT id FROM workpapers WHERE tenant_id=$1 AND ref=$2', [DEFAULT_TENANT_ID, ref]);
  return rows.length ? rows[0].id : null;
}

app.get('/api/sample-data/:ref', async (req, res) => {
  if (!pool) return res.json({ columns: [], rows: [] });
  try {
    const wpId = await _resolveWorkpaperId(req.params.ref);
    if (!wpId) return res.json({ columns: [], rows: [] }); // unknown workpaper -> empty, not an error
    const [cols, rows] = await Promise.all([
      pool.query('SELECT * FROM sample_data_columns WHERE workpaper_id=$1 ORDER BY col_index', [wpId]),
      pool.query('SELECT * FROM sample_data_rows WHERE workpaper_id=$1 ORDER BY row_index', [wpId]),
    ]);
    res.json({ columns: cols.rows, rows: rows.rows });
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/sample-data/:ref', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const columns = Array.isArray(req.body.columns) ? req.body.columns : [];
  const rows    = Array.isArray(req.body.rows)    ? req.body.rows    : [];
  try {
    const wpId = await _resolveWorkpaperId(req.params.ref);
    if (!wpId) return res.status(404).json({ error: 'Workpaper not found: ' + req.params.ref });

    await pool.query('BEGIN');
    await pool.query('DELETE FROM sample_data_columns WHERE workpaper_id=$1', [wpId]);
    await pool.query('DELETE FROM sample_data_rows    WHERE workpaper_id=$1', [wpId]);

    // Every column ALWAYS gets an explicit id here — either the one the
    // client already had (so row cells, keyed by column id, keep matching
    // after this save) or a freshly generated one for a column that's never
    // been saved before. Never rely on the table's own DEFAULT firing here:
    // that only helps if a row is inserted with no id at all, but we always
    // want a KNOWN id back in the response either way, so generating it in
    // JS and inserting it explicitly is simpler than reading it back out
    // after an implicit default.
    const savedColumns = [];
    for (let i = 0; i < columns.length; i++) {
      const c = columns[i];
      const colId = (c.id && String(c.id).trim()) ? String(c.id).trim() : crypto.randomUUID();
      await pool.query(
        `INSERT INTO sample_data_columns (id,workpaper_id,col_index,title,width,system_added,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [colId, wpId, i, c.title||'', c.width||180, !!c.systemAdded]
      );
      savedColumns.push({ id: colId, title: c.title||'', width: c.width||180, systemAdded: !!c.systemAdded });
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await pool.query(
        `INSERT INTO sample_data_rows (workpaper_id,row_index,cells,row_height,updated_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [wpId, i, JSON.stringify(r.cells||{}), r.height!=null?r.height:null]
      );
    }
    await pool.query('COMMIT');
    res.json({ ok: true, columns: savedColumns, rowCount: rows.length });
  } catch(err) {
    await pool.query('ROLLBACK');
    return fail(res, err, 'api');
  }
});

// ── Extracted Data field list (Title / Description / Guidance) ───────────────
// Same replace-entire-set pattern as sample-data above, for the same reason.
// This is what the Extract Sample Data button populates — it no longer
// writes to sample_data_rows at all (see the client-side change).
app.get('/api/extracted-data/:ref', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const wpId = await _resolveWorkpaperId(req.params.ref);
    if (!wpId) return res.json([]);
    const { rows } = await pool.query(
      'SELECT * FROM extracted_data WHERE workpaper_id=$1 ORDER BY field_index',
      [wpId]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/extracted-data/:ref', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const fields = Array.isArray(req.body.fields) ? req.body.fields : [];
  try {
    const wpId = await _resolveWorkpaperId(req.params.ref);
    if (!wpId) return res.status(404).json({ error: 'Workpaper not found: ' + req.params.ref });

    await pool.query('BEGIN');
    await pool.query('DELETE FROM extracted_data WHERE workpaper_id=$1', [wpId]);
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      await pool.query(
        `INSERT INTO extracted_data (workpaper_id,field_index,title,description,guidance,updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [wpId, i, f.title||'', f.description||'', f.guidance||'']
      );
    }
    await pool.query('COMMIT');
    res.json({ ok: true, saved: fields.length });
  } catch(err) {
    await pool.query('ROLLBACK');
    return fail(res, err, 'api');
  }
});

// ── Extracted Data RECORDS — independent-mode results (checkbox unchecked).
// One row per sample record found, values keyed by extracted_data.id. Same
// replace-entire-set pattern as the tables above. This never touches
// sample_data_columns/sample_data_rows — that's the whole point of this
// table existing separately, so independent-mode extraction has zero
// interaction with the User Provided Sample Data grid even when that grid
// already has data.
app.get('/api/extracted-data-records/:ref', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const wpId = await _resolveWorkpaperId(req.params.ref);
    if (!wpId) return res.json([]);
    const { rows } = await pool.query(
      'SELECT * FROM extracted_data_records WHERE workpaper_id=$1 ORDER BY row_index',
      [wpId]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/extracted-data-records/:ref', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const records = Array.isArray(req.body.records) ? req.body.records : [];
  try {
    const wpId = await _resolveWorkpaperId(req.params.ref);
    if (!wpId) return res.status(404).json({ error: 'Workpaper not found: ' + req.params.ref });

    await pool.query('BEGIN');
    await pool.query('DELETE FROM extracted_data_records WHERE workpaper_id=$1', [wpId]);
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      await pool.query(
        `INSERT INTO extracted_data_records (workpaper_id,row_index,cells,source_file,updated_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [wpId, i, JSON.stringify(r.cells||{}), r.sourceFile||'']
      );
    }
    await pool.query('COMMIT');
    res.json({ ok: true, saved: records.length });
  } catch(err) {
    await pool.query('ROLLBACK');
    return fail(res, err, 'api');
  }
});


// ── Workpaper Annotations API ─────────────────────────────────────────────────
app.get('/api/annotations/:ref', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT filename, annotations FROM workpaper_annotations WHERE ref=$1 ORDER BY updated_at',
      [req.params.ref]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/annotations', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { ref, filename, annotations } = req.body;
  if (!ref || !filename) return res.status(400).json({ error: 'ref and filename required' });
  try {
    await pool.query(
      `INSERT INTO workpaper_annotations (ref, filename, annotations, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (ref, filename) DO UPDATE
         SET annotations=EXCLUDED.annotations, updated_at=NOW()`,
      [ref, filename, JSON.stringify(annotations || [])]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

app.delete('/api/annotations/:ref/:filename', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query(
      'DELETE FROM workpaper_annotations WHERE ref=$1 AND filename=$2',
      [req.params.ref, decodeURIComponent(req.params.filename)]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});


// ── Company Settings API ──────────────────────────────────────────────────────
app.get('/api/company-settings', async (req, res) => {
  if (!pool) return res.json({});
  try {
    await pool.query(`INSERT INTO company_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [DEFAULT_TENANT_ID]);
    // Select columns explicitly. `SELECT *` + delete would leak any future
    // secret column that someone forgets to strip.
    const { rows } = await pool.query(
      `SELECT tenant_id,name,industry,fiscal_year_end,address,city,state,zip,
              website,ein,ai_provider,ai_model,azure_endpoint,azure_deployment,updated_at
       FROM company_settings WHERE tenant_id=$1`,
      [DEFAULT_TENANT_ID]
    );
    res.json(rows[0] || {});
  } catch(err) { return fail(res, err, 'company-settings:get'); }
});
app.post('/api/company-settings', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { name, industry, fiscal_year_end, address, city, state, zip, website, ein,
          ai_provider, ai_model, azure_endpoint, azure_deployment,
          azure_api_key, openai_api_key } = req.body;

  // Reject an unsafe Azure endpoint before it is ever persisted.
  if (azure_endpoint && !isSafeAzureEndpoint(azure_endpoint))
    return res.status(400).json({ error: 'Azure endpoint must be an https URL on *.openai.azure.com or *.cognitiveservices.azure.com' });
  if (azure_deployment && !isSafeDeploymentName(azure_deployment))
    return res.status(400).json({ error: 'Azure deployment name may contain only letters, numbers, dot, dash and underscore' });

  try {
    const q = `INSERT INTO company_settings
      (tenant_id,name,industry,fiscal_year_end,address,city,state,zip,website,ein,ai_provider,ai_model,azure_endpoint,azure_deployment,updated_at)
      VALUES ($14,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
      ON CONFLICT (tenant_id) DO UPDATE SET
        name=EXCLUDED.name, industry=EXCLUDED.industry, fiscal_year_end=EXCLUDED.fiscal_year_end,
        address=EXCLUDED.address, city=EXCLUDED.city, state=EXCLUDED.state, zip=EXCLUDED.zip,
        website=EXCLUDED.website, ein=EXCLUDED.ein, ai_provider=EXCLUDED.ai_provider,
        ai_model=EXCLUDED.ai_model, azure_endpoint=EXCLUDED.azure_endpoint,
        azure_deployment=EXCLUDED.azure_deployment, updated_at=NOW()`;
    await pool.query(q, [name||'', industry||'', fiscal_year_end||'', address||'',
      city||'', state||'', zip||'', website||'', ein||'',
      ai_provider||'anthropic', ai_model||'claude-sonnet-4-6',
      azure_endpoint||'', azure_deployment||'', DEFAULT_TENANT_ID]);
    // Update API keys separately if provided
    if (azure_api_key)  await pool.query('UPDATE company_settings SET azure_api_key=$1  WHERE tenant_id=$2', [azure_api_key,  DEFAULT_TENANT_ID]);
    if (openai_api_key) await pool.query('UPDATE company_settings SET openai_api_key=$1 WHERE tenant_id=$2', [openai_api_key, DEFAULT_TENANT_ID]);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'company-settings'); }
});

// ── Tenant AI Config API ──────────────────────────────────────────────────────
app.get('/api/tenant-ai-config', async (req, res) => {
  if (!pool) return res.json({});
  try {
    const { rows } = await pool.query(
      'SELECT provider,model,endpoint,deployment,key_hint,use_managed_id FROM tenant_ai_configs WHERE tenant_id=$1',
      [DEFAULT_TENANT_ID]
    );
    res.json(rows); // never return encrypted_key
  } catch(err) { return fail(res, err, 'api'); }
});
app.post('/api/tenant-ai-config', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { provider, model, endpoint, deployment, api_key, azure_tenant_id, use_managed_id } = req.body;
  if (!provider) return res.status(400).json({ error: 'provider required' });
  if (!ENC_KEY) return res.status(503).json({ error: 'Server is not configured to store credentials securely (CREDENTIAL_ENCRYPTION_KEY missing).' });
  const enc = api_key ? encryptKey(api_key) : null;
  const hint = api_key ? api_key.slice(-4) : null;
  try {
    await pool.query(`
      INSERT INTO tenant_ai_configs (tenant_id,provider,model,endpoint,deployment,encrypted_key,key_hint,azure_tenant_id,use_managed_id,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (tenant_id,provider) DO UPDATE SET
        model=EXCLUDED.model, endpoint=EXCLUDED.endpoint, deployment=EXCLUDED.deployment,
        encrypted_key=COALESCE(NULLIF(EXCLUDED.encrypted_key,''),tenant_ai_configs.encrypted_key),
        key_hint=COALESCE(NULLIF(EXCLUDED.key_hint,''),tenant_ai_configs.key_hint),
        azure_tenant_id=EXCLUDED.azure_tenant_id, use_managed_id=EXCLUDED.use_managed_id,
        updated_at=NOW()`,
      [DEFAULT_TENANT_ID, provider, model||'', endpoint||'', deployment||'',
       enc||'', hint||'', azure_tenant_id||'', use_managed_id||false]);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'api'); }
});

// ── AI Proxy — routes analysis requests to the configured provider ─────────────
// This route carries a base64-encoded PDF/image in its JSON body (document
// extraction — see _sdExtractFromOneFile client-side), which the global 2mb
// limit (tightened for security elsewhere) is too small for: base64 inflates
// a file to ~1.37x its size, so a real-world scanned PDF over ~1.4MB would be
// silently rejected by Express with a 413 before ever reaching the AI call —
// the exact failure this override fixes. A dedicated, larger limit here is
// safe: it's the same 2mb-vs-larger tradeoff, just scoped to the one route
// that legitimately needs it instead of loosened globally.
const AI_ANALYZE_BODY_LIMIT = process.env.AI_ANALYZE_BODY_LIMIT || '15mb';
app.post('/api/ai/analyze', express.json({ limit: AI_ANALYZE_BODY_LIMIT }), aiRateLimit, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { messages, max_tokens, system } = req.body;

  // ── Resolve credentials: prefer tenant_ai_configs, fall back to company_settings ──
  let provider = 'anthropic', model = 'claude-sonnet-4-6';
  let azureEndpoint='', azureDeployment='', azureApiKey='', openaiApiKey='';

  try {
    // First try the new per-tenant credential store
    const { rows: cfgRows } = await pool.query(
      'SELECT * FROM company_settings WHERE tenant_id=$1', [DEFAULT_TENANT_ID]
    );
    const cs = cfgRows[0] || {};
    provider = cs.ai_provider || 'anthropic';
    model    = cs.ai_model    || 'claude-sonnet-4-6';

    // Look for an encrypted key in tenant_ai_configs
    const { rows: tacRows } = await pool.query(
      'SELECT * FROM tenant_ai_configs WHERE tenant_id=$1 AND provider=$2',
      [DEFAULT_TENANT_ID, provider]
    );
    const tac = tacRows[0];
    if (tac) {
      model          = tac.model          || model;
      azureEndpoint  = tac.endpoint       || cs.azure_endpoint  || '';
      azureDeployment= tac.deployment     || cs.azure_deployment|| '';
      azureApiKey    = decryptKey(tac.encrypted_key) || cs.azure_api_key || '';
      openaiApiKey   = decryptKey(tac.encrypted_key) || cs.openai_api_key|| '';
    } else {
      // Fall back to company_settings plain-text keys
      azureEndpoint  = cs.azure_endpoint  || '';
      azureDeployment= cs.azure_deployment|| '';
      azureApiKey    = cs.azure_api_key   || '';
      openaiApiKey   = cs.openai_api_key  || '';
    }
  } catch(e) { /* fall through to anthropic default */ }

  try {
    if (provider === 'azure') {
      // Azure OpenAI
      const endpoint = azureEndpoint;
      const deployment = azureDeployment;
      const apiKey = azureApiKey;
      if (!endpoint || !deployment || !apiKey) return res.status(400).json({ error: 'Azure OpenAI not fully configured. Set endpoint, deployment, and API key in Settings.' });
      // Re-validate at point of use: a row persisted before validation existed, or
      // written directly to the DB, must not be able to exfiltrate the API key.
      if (!isSafeAzureEndpoint(endpoint) || !isSafeDeploymentName(deployment)) {
        console.error('[ai/analyze] Refusing unsafe Azure endpoint/deployment');
        return res.status(400).json({ error: 'Stored Azure endpoint is not a valid Azure OpenAI URL. Re-save it in Settings.' });
      }
      const url = new URL(`/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`, endpoint);
      url.searchParams.set('api-version', '2024-02-01');
      const msgs = system ? [{ role:'system', content:system }, ...messages] : messages;
      const azRes = await fetch(url, {
        method:'POST',
        redirect: 'error',   // never follow a redirect that could carry the key off-host
        headers: { 'Content-Type':'application/json', 'api-key': apiKey },
        body: JSON.stringify({ messages: msgs, max_tokens: max_tokens||4000 })
      });
      const azData = await azRes.json();
      if (!azRes.ok) return res.status(azRes.status).json({ error: azData.error?.message || 'Azure API error' });
      // Normalize to Anthropic-style response
      return res.json({ content: [{ type:'text', text: azData.choices?.[0]?.message?.content || '' }], model: deployment, provider:'azure' });

    } else if (provider === 'openai') {
      // Direct OpenAI
      const apiKey = openaiApiKey;
      // model already resolved above
      if (!apiKey) return res.status(400).json({ error: 'OpenAI API key not configured. Add it in Settings.' });
      const msgs = system ? [{ role:'system', content:system }, ...messages] : messages;
      const oaRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method:'POST',
        headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model||'gpt-4o', messages: msgs, max_tokens: max_tokens||4000 })
      });
      const oaData = await oaRes.json();
      if (!oaRes.ok) return res.status(oaRes.status).json({ error: oaData.error?.message || 'OpenAI API error' });
      return res.json({ content: [{ type:'text', text: oaData.choices?.[0]?.message?.content || '' }], model: model||'gpt-4o', provider:'openai' });

    } else {
      // Anthropic (default) — use existing proxy path
      const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
      if (!anthropicKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set on server.' });
      // model already resolved above
      const body = { model, max_tokens: max_tokens||4000, messages };
      if (system) body.system = system;
      const antRes = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers: { 'Content-Type':'application/json', 'x-api-key': anthropicKey, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify(body)
      });
      const antData = await antRes.json();
      if (!antRes.ok) return res.status(antRes.status).json({ error: antData.error?.message || 'Anthropic API error' });
      return res.json({ ...antData, provider:'anthropic' });
    }
  } catch(err) { return fail(res, err, 'api'); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  DATA ANALYSIS API
// ══════════════════════════════════════════════════════════════════════════════

// ── Datasets ──────────────────────────────────────────────────────────────────
app.get('/api/da/datasets', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT d.*, 
        (SELECT COUNT(*) FROM da_columns  WHERE dataset_id=d.id) AS col_count_actual,
        (SELECT COUNT(*) FROM da_labels   WHERE dataset_id=d.id) AS label_count,
        (SELECT COUNT(*) FROM da_model_runs WHERE dataset_id=d.id) AS run_count
       FROM da_datasets d
       WHERE d.tenant_id=$1
       ORDER BY d.last_used DESC`,
      [DEFAULT_TENANT_ID]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/da/datasets', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { name, filename, file_hash, row_count, col_count, notes } = req.body;
  if (!filename || !file_hash) return res.status(400).json({ error: 'filename and file_hash required' });
  try {
    // Check if this file hash already exists for this tenant
    const existing = await pool.query(
      'SELECT id FROM da_datasets WHERE tenant_id=$1 AND file_hash=$2',
      [DEFAULT_TENANT_ID, file_hash]
    );
    if (existing.rows.length) {
      // Update last_used and return existing id
      await pool.query(
        'UPDATE da_datasets SET last_used=NOW(), name=$1, row_count=$2, col_count=$3 WHERE id=$4',
        [name||filename, row_count||0, col_count||0, existing.rows[0].id]
      );
      return res.json({ id: existing.rows[0].id, existing: true });
    }
    const { rows } = await pool.query(
      `INSERT INTO da_datasets (tenant_id,name,filename,file_hash,row_count,col_count,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [DEFAULT_TENANT_ID, name||filename, filename, file_hash, row_count||0, col_count||0, notes||'']
    );
    res.json({ id: rows[0].id, existing: false });
  } catch(err) { return fail(res, err, 'api'); }
});

app.patch('/api/da/datasets/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { name, notes } = req.body;
  try {
    await pool.query(
      'UPDATE da_datasets SET name=COALESCE($1,name), notes=COALESCE($2,notes), last_used=NOW() WHERE id=$3 AND tenant_id=$4',
      [name, notes, req.params.id, DEFAULT_TENANT_ID]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

app.delete('/api/da/datasets/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    // CASCADE on da_columns, da_labels, da_model_runs handles cleanup
    const r = await pool.query(
      'DELETE FROM da_datasets WHERE id=$1 AND tenant_id=$2 RETURNING id',
      [req.params.id, DEFAULT_TENANT_ID]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Dataset not found' });
    res.json({ ok: true, purged: req.params.id });
  } catch(err) { return fail(res, err, 'api'); }
});

// ── Columns ───────────────────────────────────────────────────────────────────
app.get('/api/da/datasets/:id/columns', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM da_columns WHERE dataset_id=$1 ORDER BY col_index',
      [req.params.id]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/da/datasets/:id/columns', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const cols = req.body.columns; // array of column definitions
  if (!Array.isArray(cols)) return res.status(400).json({ error: 'columns array required' });
  try {
    // Upsert all columns in one transaction
    await pool.query('BEGIN');
    for (const c of cols) {
      await pool.query(
        `INSERT INTO da_columns (dataset_id,col_index,col_name,label,col_type,include_in_model,encoding,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (dataset_id,col_index) DO UPDATE SET
           label=EXCLUDED.label, col_type=EXCLUDED.col_type,
           include_in_model=EXCLUDED.include_in_model,
           encoding=EXCLUDED.encoding, notes=EXCLUDED.notes`,
        [req.params.id, c.col_index, c.col_name||'', c.label||'',
         c.col_type||'auto', c.include_in_model!==false,
         c.encoding||'auto', c.notes||'']
      );
    }
    await pool.query('COMMIT');
    res.json({ ok: true, saved: cols.length });
  } catch(err) {
    await pool.query('ROLLBACK');
    return fail(res, err, 'api');
  }
});

// ── Labels ────────────────────────────────────────────────────────────────────
app.get('/api/da/datasets/:id/labels', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM da_labels WHERE dataset_id=$1 ORDER BY row_index',
      [req.params.id]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/da/datasets/:id/labels', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { row_index, label, labeled_by, notes } = req.body;
  if (row_index == null || !label) return res.status(400).json({ error: 'row_index and label required' });
  if (!['anomaly','normal','uncertain'].includes(label))
    return res.status(400).json({ error: 'label must be anomaly|normal|uncertain' });
  try {
    await pool.query(
      `INSERT INTO da_labels (dataset_id,row_index,label,labeled_by,notes,labeled_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (dataset_id,row_index) DO UPDATE SET
         label=EXCLUDED.label, labeled_by=EXCLUDED.labeled_by,
         notes=EXCLUDED.notes, labeled_at=NOW()`,
      [req.params.id, row_index, label, labeled_by||'', notes||'']
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/da/datasets/:id/labels/bulk', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const labels = req.body.labels; // [{row_index, label, labeled_by, notes}]
  if (!Array.isArray(labels)) return res.status(400).json({ error: 'labels array required' });
  try {
    await pool.query('BEGIN');
    for (const l of labels) {
      if (l.row_index == null || !l.label) continue;
      await pool.query(
        `INSERT INTO da_labels (dataset_id,row_index,label,labeled_by,notes,labeled_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (dataset_id,row_index) DO UPDATE SET
           label=EXCLUDED.label, labeled_by=EXCLUDED.labeled_by,
           notes=EXCLUDED.notes, labeled_at=NOW()`,
        [req.params.id, l.row_index, l.label, l.labeled_by||'', l.notes||'']
      );
    }
    await pool.query('COMMIT');
    res.json({ ok: true, saved: labels.length });
  } catch(err) {
    await pool.query('ROLLBACK');
    return fail(res, err, 'api');
  }
});

app.delete('/api/da/datasets/:id/labels/:rowIndex', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query(
      'DELETE FROM da_labels WHERE dataset_id=$1 AND row_index=$2',
      [req.params.id, parseInt(req.params.rowIndex)]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

// ── Model Runs ────────────────────────────────────────────────────────────────
app.get('/api/da/datasets/:id/runs', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT id, dataset_id, model_type, params, thresholds, weights,
              label_count, created_at
       FROM da_model_runs WHERE dataset_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    // Omit scores from list view — scores can be large
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

app.get('/api/da/runs/:runId', async (req, res) => {
  if (!pool) return res.json(null);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM da_model_runs WHERE id=$1',
      [req.params.runId]
    );
    res.json(rows[0] || null);
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/da/datasets/:id/runs', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { model_type, params, scores, thresholds, weights, label_count } = req.body;
  if (!model_type) return res.status(400).json({ error: 'model_type required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO da_model_runs (dataset_id,model_type,params,scores,thresholds,weights,label_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.params.id, model_type,
       JSON.stringify(params||{}),
       JSON.stringify(scores||[]),
       JSON.stringify(thresholds||{}),
       JSON.stringify(weights||{}),
       label_count||0]
    );
    // Update dataset last_used
    await pool.query('UPDATE da_datasets SET last_used=NOW() WHERE id=$1', [req.params.id]);
    res.json({ id: rows[0].id });
  } catch(err) { return fail(res, err, 'api'); }
});

app.patch('/api/da/runs/:runId', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { thresholds, weights } = req.body;
  try {
    await pool.query(
      `UPDATE da_model_runs SET
         thresholds=COALESCE($1::jsonb, thresholds),
         weights=COALESCE($2::jsonb, weights)
       WHERE id=$3`,
      [thresholds ? JSON.stringify(thresholds) : null,
       weights    ? JSON.stringify(weights)    : null,
       req.params.runId]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

app.delete('/api/da/runs/:runId', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query('DELETE FROM da_model_runs WHERE id=$1', [req.params.runId]);
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

// ── Dataset lookup by file hash (used to restore saved column defs on re-upload)
app.get('/api/da/datasets/by-hash/:hash', async (req, res) => {
  if (!pool) return res.json(null);
  try {
    const { rows } = await pool.query(
      `SELECT d.*, array_agg(c.* ORDER BY c.col_index) AS columns
       FROM da_datasets d
       LEFT JOIN da_columns c ON c.dataset_id=d.id
       WHERE d.tenant_id=$1 AND d.file_hash=$2
       GROUP BY d.id
       ORDER BY d.last_used DESC LIMIT 1`,
      [DEFAULT_TENANT_ID, req.params.hash]
    );
    if (!rows.length) return res.json(null);
    await pool.query('UPDATE da_datasets SET last_used=NOW() WHERE id=$1', [rows[0].id]);
    res.json(rows[0]);
  } catch(err) { return fail(res, err, 'api'); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  ML SERVICE PROXY (Option B) — routes multivariate/ML + supervised requests to
//  the Python microservice when configured. The Node app never talks scikit-learn
//  itself; it just forwards the request and returns the result, so the shared
//  secret (ML_SERVICE_TOKEN) never reaches the browser.
// ══════════════════════════════════════════════════════════════════════════════
const ML_SERVICE_URL   = process.env.ML_SERVICE_URL   || '';
const ML_SERVICE_TOKEN = process.env.ML_SERVICE_TOKEN || '';
const ML_SERVICE_CONFIGURED = !!(ML_SERVICE_URL && ML_SERVICE_TOKEN);

if (ML_SERVICE_URL && !ML_SERVICE_TOKEN) {
  console.error('[SECURITY] ML_SERVICE_URL is set but ML_SERVICE_TOKEN is not. ' +
    'The ML service proxy will refuse to call it. Set both or neither.');
}

// Lets the client know at load time whether to prefer the Python engine.
app.get('/api/ml/status', (req, res) => {
  res.json({ configured: ML_SERVICE_CONFIGURED, engine: ML_SERVICE_CONFIGURED ? 'python-sklearn' : 'js-fallback' });
});

app.post('/api/ml/unsupervised', aiRateLimit, async (req, res) => {
  if (!ML_SERVICE_CONFIGURED) return res.status(503).json({ error: 'ML service not configured', fallback: 'js' });
  try {
    const upstream = await fetch(new URL('/api/ml/unsupervised', ML_SERVICE_URL), {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, token: ML_SERVICE_TOKEN }), // token injected server-side only
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return res.status(upstream.status).json({ error: data.detail || 'ML service error' });
    res.json(data);
  } catch(err) {
    console.error('[ml/unsupervised]', err.message);
    res.status(502).json({ error: 'ML service unreachable', fallback: 'js' });
  }
});

app.post('/api/ml/train', aiRateLimit, async (req, res) => {
  if (!ML_SERVICE_CONFIGURED) return res.status(503).json({ error: 'ML service not configured', fallback: 'js' });
  try {
    const upstream = await fetch(new URL('/api/ml/train', ML_SERVICE_URL), {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, token: ML_SERVICE_TOKEN }),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return res.status(upstream.status).json({ error: data.detail || 'ML service error' });
    res.json(data);
  } catch(err) {
    console.error('[ml/train]', err.message);
    res.status(502).json({ error: 'ML service unreachable', fallback: 'js' });
  }
});

// ── Bulk Seed API ─────────────────────────────────────────────────────────────
// Called from client startup to write all static data to DB using
// INSERT ... ON CONFLICT DO NOTHING — safe to run on every deploy.
// Audits + workpapers are excluded here because their PK is the user-editable name.
app.post('/api/seed/bulk', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { controls=[], risks=[], entities=[], fs_accounts=[], objectives=[] } = req.body;
  const results = {};
  const tid = DEFAULT_TENANT_ID;
  try {
    // Controls
    if (controls.length) {
      let n = 0;
      for (const c of controls) {
        if (!c.id) continue;
        const r = await pool.query(
          `INSERT INTO controls (tenant_id,id,name,category,objective,objective_id,description,additional_info,
            ctrl_owner,proc_owner,extra_ctrl_owners,extra_proc_owners,frequency,control_type,
            linked_risks,linked_entities,linked_accounts,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
           ON CONFLICT (tenant_id,id) DO NOTHING`,
          [tid, c.id, c.name||c.title||'', c.category||'', c.objective||'', c.objective_id||'',
           c.description||'', c.additional_info||'', c.ctrl_owner||'', c.proc_owner||'',
           JSON.stringify(c.extra_ctrl_owners||[]), JSON.stringify(c.extra_proc_owners||[]),
           c.frequency||'', c.control_type||'',
           JSON.stringify(c.linked_risks||[]), JSON.stringify(c.linked_entities||[]),
           JSON.stringify(c.linked_accounts||[])]);
        if (r.rowCount > 0) n++;
      }
      results.controls = n;
    }
    // Risks
    if (risks.length) {
      let n = 0;
      for (const r of risks) {
        if (!r.id) continue;
        const res2 = await pool.query(
          `INSERT INTO risks (tenant_id,id,name,category,description,updated_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (tenant_id,id) DO NOTHING`,
          [tid, r.id, r.name||r.title||'', r.category||'', r.description||'']);
        if (res2.rowCount > 0) n++;
      }
      results.risks = n;
    }
    // Entities
    if (entities.length) {
      let n = 0;
      for (const e of entities) {
        if (!e.id) continue;
        const res2 = await pool.query(
          `INSERT INTO assessment_entities (tenant_id,id,name,type,category,address,city,state,zip,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
           ON CONFLICT (tenant_id,id) DO NOTHING`,
          [tid, e.id, e.name||'', e.type||'Facility', e.category||'facility',
           e.address||'', e.city||'', e.state||'', e.zip||'']);
        if (res2.rowCount > 0) n++;
      }
      results.entities = n;
    }
    // FS Accounts
    if (fs_accounts.length) {
      let n = 0;
      for (const f of fs_accounts) {
        if (!f.id) continue;
        const res2 = await pool.query(
          `INSERT INTO fs_accounts (tenant_id,id,code,description,section,cur_balance,py_balance,
            materiality,txn_volume,inherent_risk,key_account,assertions,audit_approach,notes,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
           ON CONFLICT (tenant_id,id) DO NOTHING`,
          [tid, f.id, f.code||f.id||'', f.description||f.label||f.desc||'',
           f.section||f.category||f.statement||'',
           f.cur_balance!=null?f.cur_balance:(f.cur!=null?f.cur:null),
           f.py_balance!=null?f.py_balance:(f.py!=null?f.py:null),
           f.materiality||'', f.txn_volume||f.transactionVolume||'',
           f.inherent_risk||f.riskLevel||'', !!f.key_account,
           JSON.stringify(Array.isArray(f.assertions)?f.assertions:(f.assertion?[f.assertion]:[])),
           f.audit_approach||f.auditApproach||'', f.notes||'']);
        if (res2.rowCount > 0) n++;
      }
      results.fs_accounts = n;
    }
    // Control Objectives
    if (objectives.length) {
      let n = 0;
      for (const o of objectives) {
        if (!o.id) continue;
        const res2 = await pool.query(
          `INSERT INTO control_objectives (tenant_id,id,title,description,updated_at)
           VALUES ($1,$2,$3,$4,NOW())
           ON CONFLICT (tenant_id,id) DO NOTHING`,
          [tid, o.id, o.title||'', o.description||'']);
        if (res2.rowCount > 0) n++;
      }
      results.objectives = n;
    }
    console.log('[Seed] Bulk seed complete:', results);
    res.json({ ok:true, inserted: results });
  } catch(err) { return fail(res, err, '[Seed] bulk seed error:'); }
});

// ── Control Objectives API ─────────────────────────────────────────────────────
app.get('/api/control-objectives', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM control_objectives WHERE tenant_id=$1 ORDER BY id', [DEFAULT_TENANT_ID]); res.json(rows); }
  catch(err) { return fail(res, err, 'api'); }
});
app.post('/api/control-objectives', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id, title, description } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(`INSERT INTO control_objectives (id,title,description,updated_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, updated_at=NOW()`,
      [id, title||'', description||'']);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'api'); }
});
app.delete('/api/control-objectives/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM control_objectives WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch(err) { return fail(res, err, 'api'); }
});

// ── FS Accounts API ───────────────────────────────────────────────────────────
app.get('/api/fs-accounts', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM fs_accounts WHERE tenant_id=$1 ORDER BY section, code, id', [DEFAULT_TENANT_ID]); res.json(rows); }
  catch(err) { return fail(res, err, 'api'); }
});
app.post('/api/fs-accounts', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id, code, description, section, cur_balance, py_balance,
          materiality, txn_volume, inherent_risk, key_account,
          assertions, audit_approach, notes, fn_text } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(`INSERT INTO fs_accounts
        (id,code,description,section,cur_balance,py_balance,materiality,txn_volume,inherent_risk,key_account,assertions,audit_approach,notes,fn_text,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      ON CONFLICT (id) DO UPDATE SET
        code=EXCLUDED.code, description=EXCLUDED.description, section=EXCLUDED.section,
        cur_balance=EXCLUDED.cur_balance, py_balance=EXCLUDED.py_balance,
        materiality=EXCLUDED.materiality, txn_volume=EXCLUDED.txn_volume,
        inherent_risk=EXCLUDED.inherent_risk, key_account=EXCLUDED.key_account,
        assertions=EXCLUDED.assertions, audit_approach=EXCLUDED.audit_approach,
        notes=EXCLUDED.notes, fn_text=EXCLUDED.fn_text, updated_at=NOW()`,
      [id, code||'', description||'', section||'',
       cur_balance!=null ? cur_balance : null,
       py_balance!=null  ? py_balance  : null,
       materiality||'', txn_volume||'', inherent_risk||'',
       key_account ? true : false,
       JSON.stringify(assertions||[]),
       audit_approach||'', notes||'', fn_text||'']);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'api'); }
});
app.delete('/api/fs-accounts/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM fs_accounts WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch(err) { return fail(res, err, 'api'); }
});

// ── Company Context API ──────────────────────────────────────────────────────
app.get('/api/company-context', async (req, res) => {
  if (!pool) return res.json({ notes: '' });
  try {
    await pool.query(`INSERT INTO company_context (tenant_id,id,notes) VALUES ($1,1,$2) ON CONFLICT (tenant_id,id) DO NOTHING`, [DEFAULT_TENANT_ID,'']);
    const { rows } = await pool.query('SELECT notes FROM company_context WHERE tenant_id=$1 AND id=1', [DEFAULT_TENANT_ID]);
    res.json({ notes: rows[0]?.notes || '' });
  } catch(err) { return fail(res, err, 'api'); }
});
app.post('/api/company-context', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { notes } = req.body;
  try {
    await pool.query('INSERT INTO company_context (tenant_id,id,notes,updated_at) VALUES ($1,1,$2,NOW()) ON CONFLICT (tenant_id,id) DO UPDATE SET notes=EXCLUDED.notes, updated_at=NOW()', [DEFAULT_TENANT_ID, notes||'']);
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

// ── Analysis Notes API (generic: audits, controls, risks, entities) ───────────
app.post('/api/analysis-notes/:type/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { notes } = req.body;
  // Strict allowlist — identifiers are NEVER taken from user input.
  // Object.hasOwn guards against prototype-chain keys like 'constructor'.
  const ROUTES = {
    control: { sql: 'UPDATE controls SET analyst_notes=$1 WHERE tenant_id=$2 AND id=$3' },
    risk:    { sql: 'UPDATE risks    SET analyst_notes=$1 WHERE tenant_id=$2 AND id=$3' },
  };
  if (!Object.hasOwn(ROUTES, req.params.type))
    return res.status(400).json({ error: 'Unknown type' });
  try {
    await pool.query(ROUTES[req.params.type].sql, [notes||'', DEFAULT_TENANT_ID, req.params.id]);
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

// ── Serve the frontend HTML (after all /api routes) ──────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Catch-all: log any unmatched requests (helps diagnose 404s) ──────────────
app.use(function(req, res) {
  console.warn('[404] Unmatched route:', req.method, req.path);
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Wavefire backend running at http://localhost:${PORT}`);
  console.log(`    API key set: ${process.env.ANTHROPIC_API_KEY ? 'YES' : 'NO — set ANTHROPIC_API_KEY in .env'}`);
  console.log(`    Frontend:    http://localhost:${PORT}/\n`);
});
