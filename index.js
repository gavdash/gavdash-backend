import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 8080;

const allowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(express.json());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowed.length === 0 || allowed.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true
}));

// Healthcheck
app.get('/api/v1/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Demo agent overview (mockdata)
app.get('/api/v1/agents/me/overview', (_req, res) => {
  res.json({
    period: 'UTD',
    agent: { id: 'demo-001', name: 'M. Larsen' },
    kpis: {
      gwp: 42800,
      hitrate: 16.4,
      calls: 370,
      reach: 34.2,
      sales: 44,
      spe: 9720,
      premium_avg: 4350,
      order_pct: 12.6
    },
    deltas: {
      gwp: 2600,
      hitrate_pp: 0.5,
      reach_pp: 0.7,
      sales: 3,
      spe: 240,
      premium_avg: 110,
      order_pp: 0.6
    },
    ghost: {
      gwp: { me: 42800, best: 61500, team_avg: 49200 },
      spe: { me: 9720, best: 14100, team_avg: 12000 }
    },
    recommendation: {
      from: 'Strat 1 (hus kunder)',
      to: 'Strat 3 (FF)',
      extra_gwp: 17000,
      uplift_pct: 12
    }
  });
});

// Actions (mock)
app.post('/api/v1/agents/actions/switch-campaign', (req, res) => {
  const { from, to } = req.body || {};
  res.json({ ok: true, requested: { from, to }, at: new Date().toISOString() });
});

app.post('/api/v1/agents/actions/book-coaching', (req, res) => {
  const { slot } = req.body || {};
  res.json({ ok: true, slot, at: new Date().toISOString() });
});

// Fallback
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log('Gavdash API listening on :' + PORT);
});
