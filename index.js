// index.js
const express = require('express');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 10000;
const WEBHOOK_SECRET = process.env.ADVERUS_WEBHOOK_SECRET || '';

// Body-parsing (nogle systemer leverer text/plain)
app.use(express.json({ type: ['application/json', 'text/plain'] }));
app.use(morgan('tiny'));

// Simpel "root" og healthcheck
app.get('/', (req, res) => res.json({ message: '🚀 Velkommen til Gavdash API' }));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Lille in-memory buffer til debug (ikke til produktion)
const lastEvents = [];

/**
 * Webhook fra Adversus
 * Sender du headeren: x-adversus-secret: <din-secret>
 * eller ?secret=<din-secret>, så tjekker vi den.
 */
app.post('/webhook/adversus', (req, res) => {
  const headerSecret = req.headers['x-adversus-secret'] || req.query.secret;
  if (WEBHOOK_SECRET && headerSecret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body || {};
  lastEvents.unshift({ receivedAt: new Date().toISOString(), payload });
  if (lastEvents.length > 50) lastEvents.pop();

  console.log('Adversus webhook received:', JSON.stringify(payload));
  // Svar hurtigt 200, så Adversus ikke retryer
  return res.status(200).json({ ok: true });
});

/**
 * Debug: se seneste modtagne events
 * Brug: /_debug/events?key=<din-secret>
 */
app.get('/_debug/events', (req, res) => {
  if (!WEBHOOK_SECRET || req.query.key !== WEBHOOK_SECRET) {
    return res.status(401).end();
  }
  res.json(lastEvents);
});

app.listen(PORT, () => {
  console.log(`Gavdash API listening on :${PORT}`);
});
