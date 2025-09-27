// index.js
// Simpel backend til Adversus-integration på Render

const express = require('express');
const morgan = require('morgan');

// ==== Miljø-variabler (Render) ====
const PORT = process.env.PORT || 10000;
const WEBHOOK_SECRET = process.env.ADVERSUS_WEBHOOK_SECRET || '';      // beskytter vores endpoints
const ADVERSUS_API_USER = process.env.ADVERSUS_API_USER || '';
const ADVERSUS_API_PASS = process.env.ADVERSUS_API_PASS || '';
const ADVERSUS_BASE_URL = process.env.ADVERSUS_BASE_URL || 'https://api.adversus.io';

// ==== App & middleware ====
const app = express();
app.use(morgan('tiny'));

// Accepter JSON (Adversus webhook sender JSON)
app.use(express.json({ type: ['application/json', 'text/*'] }));
app.use(express.urlencoded({ extended: false }));

// ==== Hjælpere ====

// Lidt lille in-memory buffer til debug (ikke til produktion)
const lastEvents = [];
const MAX_EVENTS = 200;

// Basic-Auth header til Adversus REST
function adversusAuthHeader() {
  const token = Buffer.from(`${ADVERSUS_API_USER}:${ADVERSUS_API_PASS}`).toString('base64');
  return `Basic ${token}`;
}

// Sikkerhed: fælles middleware til hemmelig nøgle (query eller header)
function requireSecret(req, res, next) {
  // Tillad både header og query parameter
  const headerSecret = req.headers['x-adversus-secret'];
  const querySecret = req.query.secret || req.query.key;
  const ok = WEBHOOK_SECRET && (headerSecret === WEBHOOK_SECRET || querySecret === WEBHOOK_SECRET);
  if (!ok) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ==== Basisruter ====

// Health/velkomst
app.get('/', (req, res) => {
  res.json({ message: '🚀 Velkommen til Gavdash API' });
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ==== Webhook fra Adversus ====
// Adversus kan kalde: POST /webhook/adversus?secret=<din-hemmelige-kode>
// eller med header: x-adversus-secret: <din-hemmelige-kode>
app.post('/webhook/adversus', requireSecret, (req, res) => {
  const body = req.body || {};

  // gem i debug-buffer (øverst)
  lastEvents.unshift({
    receivedAt: new Date().toISOString(),
    body,
  });
  if (lastEvents.length > MAX_EVENTS) lastEvents.pop();

  console.log('Adversus webhook received:', JSON.stringify(body));
  // svar hurtigt 200, så Adversus ikke retry’er
  return res.status(200).json({ ok: true });
});

// ==== Debug: se seneste events ====
// GET /_debug/events?key=<din-secret>  (eller ?secret=...)
app.get('/_debug/events', requireSecret, (req, res) => {
  res.json(lastEvents);
});

// ==== Test Adversus-forbindelse ====
// Henter liste over webhooks fra Adversus API for at bekræfte Basic Auth.
// GET /adversus/test?key=<din-secret>
app.get('/adversus/test', requireSecret, async (req, res) => {
  try {
    const url = `${ADVERSUS_BASE_URL}/v1/webhooks`;
    const r = await fetch(url, {
      headers: {
        'Authorization': adversusAuthHeader(),
        'Accept': 'application/json',
      },
    });

    const body = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json({
      ok: r.ok,
      status: r.status,
      url,
      body,
    });
  } catch (err) {
    console.error('Adversus test error:', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ==== Start server ====
app.listen(PORT, () => {
  console.log(`Gavdash API listening on ${PORT}`);
});
