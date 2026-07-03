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
const ENC_KEY = (process.env.CREDENTIAL_ENCRYPTION_KEY || '').padEnd(32, '0').slice(0, 32);
function encryptKey(plaintext) {
  if (!plaintext) return '';
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
    `);
    console.log('DB: risks + controls tables ready');
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

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── Control Categories API ────────────────────────────────────────────────────
app.get('/api/control-categories', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT name FROM control_categories ORDER BY sort_order, name'); res.json(rows.map(r=>r.name)); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/control-categories', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM control_categories');
    await pool.query('INSERT INTO control_categories (name, sort_order) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, rows[0].n]);
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Risks API ───────────────────────────────────────────────────────────────
app.get('/api/risks', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM risks WHERE tenant_id=$1 ORDER BY id', [DEFAULT_TENANT_ID]); res.json(rows); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/risks', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id, name, description } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(`INSERT INTO risks (id,name,description,updated_at) VALUES ($1,$2,$3,NOW())
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, updated_at=NOW()`,
      [id, name||'', description||'']);
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/risks/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM risks WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Controls API ─────────────────────────────────────────────────────────────
app.get('/api/controls', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM controls WHERE tenant_id=$1 ORDER BY category, id', [DEFAULT_TENANT_ID]); res.json(rows); }
  catch(err) { res.status(500).json({ error: err.message }); }
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
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/controls/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM controls WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Entity Types API ────────────────────────────────────────────────────────
app.get('/api/entity-types', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query('SELECT * FROM entity_types ORDER BY name');
    res.json(rows);
  } catch(err) { console.error('GET /api/entity-types:', err.message); res.status(500).json({ error: err.message }); }
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
  } catch(err) { console.error('POST /api/entity-types:', err.message); res.status(500).json({ error: err.message }); }
});

// ── Assessment Entities API ─────────────────────────────────────────────────
app.get('/api/entities', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query('SELECT * FROM assessment_entities WHERE tenant_id=$1 ORDER BY type, name', [DEFAULT_TENANT_ID]);
    res.json(rows);
  } catch(err) {
    console.error('GET /api/entities:', err.message);
    res.status(500).json({ error: err.message });
  }
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
  } catch(err) {
    console.error('POST /api/entities:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/entities/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  try {
    await pool.query('DELETE FROM assessment_entities WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(err) {
    console.error('DELETE /api/entities:', err.message);
    res.status(500).json({ error: err.message });
  }
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
app.get('/api/test', async (req, res) => {
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
    res.status(502).json({ ok: false, error: err.message });
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
  catch(err) { res.status(500).json({ error: err.message }); }
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
  } catch(err) {
    console.error('[API] audit save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Workpapers API ────────────────────────────────────────────────────────────
app.get('/api/workpapers', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM workpapers WHERE tenant_id=$1 ORDER BY audit_name, ref', [DEFAULT_TENANT_ID]); res.json(rows); }
  catch(err) { res.status(500).json({ error: err.message }); }
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
    test_attributes, sample_fields, exceptions
  } = req.body;
  if (!ref) return res.status(400).json({ error: 'ref required' });
  try {
    await pool.query(`INSERT INTO workpapers
        (ref,audit_name,name,type,status,results,preparer,reviewer,secondary_reviewer,
         date_started,review_date,date_submitted,secondary_review_date,
         population,sample_method,sample_size,narrative,description,test_desc,
         linked_controls,linked_risks,linked_entities,fs_accounts,
         scope_entities,scope_fs_accounts,test_attributes,sample_fields,exceptions,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
              $20,$21,$22,$23,$24,$25,$26,$27,$28,NOW())
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
       JSON.stringify(exceptions||[])
      ]);
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/workpapers/:ref', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM workpapers WHERE ref=$1', [req.params.ref]); res.json({ ok:true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
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
  } catch(err) { res.status(500).json({ error: err.message }); }
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
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/annotations/:ref/:filename', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query(
      'DELETE FROM workpaper_annotations WHERE ref=$1 AND filename=$2',
      [req.params.ref, decodeURIComponent(req.params.filename)]
    );
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// ── Company Settings API ──────────────────────────────────────────────────────
app.get('/api/company-settings', async (req, res) => {
  if (!pool) return res.json({});
  try {
    await pool.query(`INSERT INTO company_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [DEFAULT_TENANT_ID]);
    const { rows } = await pool.query('SELECT * FROM company_settings WHERE tenant_id=$1', [DEFAULT_TENANT_ID]);
    // Never expose API keys to client
    const row = rows[0] || {};
    delete row.azure_api_key; delete row.openai_api_key;
    res.json(row);
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/company-settings', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { name, industry, fiscal_year_end, address, city, state, zip, website, ein,
          ai_provider, ai_model, azure_endpoint, azure_deployment,
          azure_api_key, openai_api_key } = req.body;
  try {
    // Build dynamic update — only update api keys if explicitly provided (non-empty string)
    let q = `INSERT INTO company_settings
      (id,name,industry,fiscal_year_end,address,city,state,zip,website,ein,ai_provider,ai_model,azure_endpoint,azure_deployment,updated_at)
      VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name, industry=EXCLUDED.industry, fiscal_year_end=EXCLUDED.fiscal_year_end,
        address=EXCLUDED.address, city=EXCLUDED.city, state=EXCLUDED.state, zip=EXCLUDED.zip,
        website=EXCLUDED.website, ein=EXCLUDED.ein, ai_provider=EXCLUDED.ai_provider,
        ai_model=EXCLUDED.ai_model, azure_endpoint=EXCLUDED.azure_endpoint,
        azure_deployment=EXCLUDED.azure_deployment, updated_at=NOW()`;
    await pool.query(q, [name||'', industry||'', fiscal_year_end||'', address||'',
      city||'', state||'', zip||'', website||'', ein||'',
      ai_provider||'anthropic', ai_model||'claude-sonnet-4-6',
      azure_endpoint||'', azure_deployment||'']);
    // Update API keys separately if provided
    if (azure_api_key) await pool.query('UPDATE company_settings SET azure_api_key=$1 WHERE id=1', [azure_api_key]);
    if (openai_api_key) await pool.query('UPDATE company_settings SET openai_api_key=$1 WHERE id=1', [openai_api_key]);
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
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
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/tenant-ai-config', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { provider, model, endpoint, deployment, api_key, azure_tenant_id, use_managed_id } = req.body;
  if (!provider) return res.status(400).json({ error: 'provider required' });
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
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── AI Proxy — routes analysis requests to the configured provider ─────────────
app.post('/api/ai/analyze', async (req, res) => {
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
      const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-01`;
      const msgs = system ? [{ role:'system', content:system }, ...messages] : messages;
      const azRes = await fetch(url, {
        method:'POST',
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
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Control Objectives API ─────────────────────────────────────────────────────
app.get('/api/control-objectives', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM control_objectives WHERE tenant_id=$1 ORDER BY id', [DEFAULT_TENANT_ID]); res.json(rows); }
  catch(err) { res.status(500).json({ error: err.message }); }
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
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/control-objectives/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM control_objectives WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

// ── FS Accounts API ───────────────────────────────────────────────────────────
app.get('/api/fs-accounts', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM fs_accounts WHERE tenant_id=$1 ORDER BY section, code, id', [DEFAULT_TENANT_ID]); res.json(rows); }
  catch(err) { res.status(500).json({ error: err.message }); }
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
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/fs-accounts/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM fs_accounts WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Company Context API ──────────────────────────────────────────────────────
app.get('/api/company-context', async (req, res) => {
  if (!pool) return res.json({ notes: '' });
  try {
    await pool.query(`INSERT INTO company_context (tenant_id,id,notes) VALUES ($1,1,$2) ON CONFLICT (tenant_id,id) DO NOTHING`, [DEFAULT_TENANT_ID,'']);
    const { rows } = await pool.query('SELECT notes FROM company_context WHERE tenant_id=$1 AND id=1', [DEFAULT_TENANT_ID]);
    res.json({ notes: rows[0]?.notes || '' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/company-context', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { notes } = req.body;
  try {
    await pool.query('INSERT INTO company_context (tenant_id,id,notes,updated_at) VALUES ($2,1,$1,NOW()) ON CONFLICT (tenant_id,id) DO UPDATE SET notes=EXCLUDED.notes, updated_at=NOW()', [notes||'']);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Analysis Notes API (generic: audits, controls, risks, entities) ───────────
app.post('/api/analysis-notes/:type/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { notes } = req.body;
  const tableMap = { control:'controls', risk:'risks' };
  const colMap   = { control:'analyst_notes', risk:'analyst_notes' };
  const pkMap    = { control:'id', risk:'id' };
  const tbl = tableMap[req.params.type], col = colMap[req.params.type], pk = pkMap[req.params.type];
  if (!tbl) return res.status(400).json({ error: 'Unknown type' });
  try {
    await pool.query(`UPDATE ${tbl} SET ${col}=$1 WHERE ${pk}=$2`, [notes||'', req.params.id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
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
