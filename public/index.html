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
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// Create tables on startup if they don't exist
async function initDB() {
  if (!pool) { console.log('No DATABASE_URL — running without database'); return; }
  try {
    await pool.query(`
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
        PRIMARY KEY (ref, filename)
      );
      CREATE TABLE IF NOT EXISTS audits (
        name        TEXT PRIMARY KEY,
        period      TEXT DEFAULT '',
        owner       TEXT DEFAULT '',
        type        TEXT DEFAULT '',
        status      TEXT DEFAULT 'planned',
        description TEXT DEFAULT '',
        year        INTEGER,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS workpapers (
        ref                    TEXT PRIMARY KEY,
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
        updated_at             TIMESTAMPTZ DEFAULT NOW()
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
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL DEFAULT '',
        category     TEXT DEFAULT '',
        objective    TEXT DEFAULT '',
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
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('DB: risks + controls tables ready');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS assessment_entities (
        id                   TEXT PRIMARY KEY,
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
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('DB: assessment_entities table ready');

    // ── Auto-migrations for pre-existing tables ──────────────────────────────
    // If an older 'audits' table exists with a reserved-word 'desc' column,
    // ensure a usable 'description' column exists and migrate data.
    try {
      await pool.query(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''`);
      // Copy any data from a legacy "desc" column if it still exists
      const col = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='audits' AND column_name='desc'`);
      if (col.rows.length) {
        await pool.query(`UPDATE audits SET description = "desc" WHERE (description IS NULL OR description='') AND "desc" IS NOT NULL`);
        console.log('DB: migrated audits.desc → audits.description');
      }
    } catch(mErr) { console.warn('DB: audits description migration skipped:', mErr.message); }
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
  try { const { rows } = await pool.query('SELECT * FROM risks ORDER BY id'); res.json(rows); }
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
  try { const { rows } = await pool.query('SELECT * FROM controls ORDER BY category, id'); res.json(rows); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/controls', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id, name, category, objective, description, additional_info,
          ctrl_owner, proc_owner, extra_ctrl_owners, extra_proc_owners,
          frequency, control_type, linked_risks, linked_entities, linked_accounts } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(`INSERT INTO controls
        (id,name,category,objective,description,additional_info,ctrl_owner,proc_owner,extra_ctrl_owners,extra_proc_owners,frequency,control_type,linked_risks,linked_entities,linked_accounts,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name, category=EXCLUDED.category, objective=EXCLUDED.objective,
        description=EXCLUDED.description, additional_info=EXCLUDED.additional_info,
        ctrl_owner=EXCLUDED.ctrl_owner, proc_owner=EXCLUDED.proc_owner,
        extra_ctrl_owners=EXCLUDED.extra_ctrl_owners, extra_proc_owners=EXCLUDED.extra_proc_owners,
        frequency=EXCLUDED.frequency, control_type=EXCLUDED.control_type,
        linked_risks=EXCLUDED.linked_risks, linked_entities=EXCLUDED.linked_entities,
        linked_accounts=EXCLUDED.linked_accounts, updated_at=NOW()`,
      [id, name||'', category||'', objective||'', description||'', additional_info||'',
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
    const { rows } = await pool.query('SELECT * FROM assessment_entities ORDER BY type, name');
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


// ── Serve the frontend HTML ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

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
  try { const { rows } = await pool.query('SELECT * FROM audits ORDER BY created_at'); res.json(rows); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/audits', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { name, period, owner, type, status, description, desc, year } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const descVal = description != null ? description : (desc || '');
  try {
    await pool.query(`INSERT INTO audits (name,period,owner,type,status,description,year,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (name) DO UPDATE SET period=EXCLUDED.period, owner=EXCLUDED.owner,
        type=EXCLUDED.type, status=EXCLUDED.status, description=EXCLUDED.description, year=EXCLUDED.year, updated_at=NOW()`,
      [name, period||'', owner||'', type||'', status||'planned', descVal, year||null]);
    res.json({ ok:true });
  } catch(err) {
    console.error('[API] audit save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Workpapers API ────────────────────────────────────────────────────────────
app.get('/api/workpapers', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM workpapers ORDER BY audit_name, ref'); res.json(rows); }
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

// ── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Wavefire backend running at http://localhost:${PORT}`);
  console.log(`    API key set: ${process.env.ANTHROPIC_API_KEY ? 'YES' : 'NO — set ANTHROPIC_API_KEY in .env'}`);
  console.log(`    Frontend:    http://localhost:${PORT}/\n`);
});
