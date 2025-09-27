// index.js
// === Simpel backend til Adversus-integration på Render ===

const express = require('express');
const morgan = require('morgan');
const fetch = require('node-fetch');

// === Miljø-variabler ===
const PORT = process.env.PORT || 10000;
const WEBHOOK_SECRET = process.env.ADVERSUS_WEBHOOK_SECRET || '';
const ADVERSUS_API_USER = process.env.ADVERSUS_API_USER || '';
const ADVERSUS_API_PASS = process.env.ADVERSUS_API_PASS || '';
const ADVERSUS_BASE_URL = process.env.ADVERSUS_BASE_URL || 'https://api.adversus.io';

// === App & middleware ===
const app = express();
app.use(morgan('tiny'));
app.use(express.json({ type: ['application/json', 'text/plain'] }));
app.use(express.urlencoded({ extended: false }));

// === Hjælpere ===
const lastEvents = [];
const MAX_EVENTS = 200;

function adversusAuthHeader() {
  const token = Buffer.from(`${ADVERSUS_API_USER}:${ADVERSUS_API_PASS}`).toString('base64');
  return `Basic ${token}`;
}

function requireSecret(req, res) {
  const headerSecret = req.headers['x-adversus-secret'];
  const querySecret = req.query.secret;
  const ok = (WEBHOOK_SECRET &&
    (headerSecret === WEBHOOK_SECRET || querySecret === WEBHOOK_SECRET));
  if (!ok) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

// === Routes ===
app.get('/', (req, res) => {
  res.json({ message: '🚀 Velkommen til Gavadsh API!' });
});

// Debug: vis server health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Webhook endpoint fra Adversus
app.post('/webhook/adversus', (req, res) => {
  if (!requireSecret(req, res)) return;

  const payload = req.body || {};
  lastEvents.unshift({ receivedAt: new Date().toISOString(), payload });
  if (lastEvents.length > MAX_EVENTS) lastEvents.pop();

  console.log('Adversus webhook received:', JSON.stringify(payload));
  res.status(200).json({ ok: true });
});

// Debug: se seneste events
app.get('/_debug/events', (req, res) => {
  if (!requireSecret(req, res)) return;
  res.json(lastEvents);
});

// Test Adversus API login
app.get('/adversus/test', async (req, res) => {
  try {
    if (!requireSecret(req, res)) return;

    const url = `${ADVERSUS_BASE_URL}/v1/webhooks`;
    const r = await fetch(url, {
      headers: {
        'Authorization': adversusAuthHeader(),
        'Accept': 'application/json'
      }
    });

    const body = await r.json().catch(() => ({}));
    res.status(r.ok ? 200 : r.status).json({
      ok: r.ok,
      status: r.status,
      url,
      body
    });
  } catch (err) {
    console.error('
