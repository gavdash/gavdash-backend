// index.js
// Simpel backend til Adversus-integration på Render

const express = require('express');
const morgan  = require('morgan');

// === Miljø-variabler ===
const PORT               = process.env.PORT || 10000;
const WEBHOOK_SECRET     = process.env.ADVERSUS_WEBHOOK_SECRET || '';  // beskytter vores endpoints
const ADVERSUS_API_USER  = process.env.ADVERSUS_API_USER || '';
const ADVERSUS_API_PASS  = process.env.ADVERSUS_API_PASS || '';
const ADVERSUS_BASE_URL  = process.env.ADVERSUS_BASE_URL || 'https://api.adversus.io';

// === App & middleware ===
const app = express();
app.use(morgan('tiny'));

// Body-parsing (Adversus sender JSON)
app.use(express.json({ type: ['application/json', 'text/plain'] }));
app.use(express.urlencoded({ extended: false }));

// === Hjælpere ===

// Simple in-memory buffer til debug (ikke til produktion)
const lastEvents = [];
const MAX_EVENTS = 200;

// Basic-Auth header til Adversus REST
function adversusAuthHeader() {
  const token = Buffer.from(`${ADVERSUS_API_USER}:${ADVERSUS_API_PASS}`).toString('base64');
  return `Basic ${token}`;
}

// Sikkerhedstjek til endpoints beskyttet af vores hemmelige nøgle
function requireSecret(req, res) {
  // Tillad både header og query parameter
  const headerSecret = req.headers['x-adversus-secret'];
  const querySecret  = req.query.secret || req.query.key;
  const ok = (WEBHOOK_SECRET && (headerSecret === WEBHOOK_SECRET || querySecret === WEBHOOK_SECRET));
  if (!ok) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

// === Basisruter ===

app.get('/', (req, res) => {
  res.json({ message: '🚀 Velkommen til Gavdash API' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// === Webhook fra Adversus ===
// Adversus kalder denne, når der sker et event (fx lead_saved)
// Send "x-adversus-secret: <WEBHOOK_SECRET>" i headeren (eller ?secret=... i URL) for at autorisere.
app.post('/webhook/adversus', (req, res) => {
  if (!requireSecret(req, res)) return;

  const payload = req.body || {};
  // Gem en kort log af eventet til debug
  lastEvents.unshift({
    receivedAt: new Date().toISOString(),
    headers: {
      'user-agent': req.headers['user-agent'],
      'content-type': req.headers['content-type'],
    },
    body: payload
  });
  if (lastEvents.length > MAX_EVENTS) lastEvents.pop();

  // Svar hurtigt 200 så Adversus ikke retryer
  res.status(200).json({ ok: true });
});

// === Debug: læs seneste events ===
// GET /_debug/events?key=<WEBHOOK_SECRET>
app.get('/_debug/events', (req, res) => {
  const key = req.query.key;
  if (!WEBHOOK_SECRET || key !== WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  res.json(lastEvents);
});

// === Test Adversus-forbindelse ===
// Henter liste over webhooks fra Adversus API for at bekræfte Basic Auth.
app.get('/adversus/test', async (req, res) => {
  try {
    if (!WEBHOOK_SECRET || req.query.key !== WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const url = `${ADVERSUS_BASE_URL}/v1/webhooks`;
    const r = await fetch(url, {
      headers: {
        'Authorization': adversusAuthHeader(),
        'Accept': 'application/json'
      }
    });

    const body = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json({
      ok: r.ok,
      status: r.status,
      url,
      body
    });
  } catch (err) {
    console.error('Adversus test error:', err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// === Start server ===
app.listen(PORT, () => {
  console.log(`Gavdash API listening on :${PORT}`);
});
