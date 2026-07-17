/**
 * Wavefire Audit App — Backend API Proxy
 * ──────────────────────────────────────
 * This server sits between the browser and Anthropic's API.
 * The API key lives here (on the server) and is never exposed to the browser.
 *
 * WHAT THIS FILE DOES:
 *   - Serves the frontend HTML file at the root URL  (GET /)
 *   - Proxies Claude API calls                       (POST /api/claude)
 *   - Proxies Claude analysis of PDF files           (POST /api/analyze)
 *
 * HOW TO RUN LOCALLY:
 *   1. npm install
 *   2. Create a .env file with:  ANTHROPIC_API_KEY=sk-ant-...
 *   3. node server.js
 *   4. Open http://localhost:3000
 *
 * HOW TO DEPLOY TO RAILWAY:
 *   See README.md for full deployment instructions.
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' })); // PDFs can be large when base64-encoded

// ── Serve the frontend HTML ─────────────────────────────────────────────────
// Place auditflow_artifact.html in the same folder as this file,
// rename it to index.html, and it will be served at http://localhost:3000
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Claude API proxy ────────────────────────────────────────────────────────
// The frontend calls POST /api/claude instead of calling Anthropic directly.
// This keeps the API key safe on the server side.
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

    // Pass through the status code and body unchanged
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
