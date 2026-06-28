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
      CREATE TABLE IF NOT EXISTS risks (
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
  } catch(err) {
    console.error('DB init error:', err.message);
  }
}
initDB();

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));

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

// ── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Wavefire backend running at http://localhost:${PORT}`);
  console.log(`    API key set: ${process.env.ANTHROPIC_API_KEY ? 'YES' : 'NO — set ANTHROPIC_API_KEY in .env'}`);
  console.log(`    Frontend:    http://localhost:${PORT}/\n`);
});
