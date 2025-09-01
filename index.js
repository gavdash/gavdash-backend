import express from 'express';

const app = express();
const PORT = process.env.PORT || 10000;

// Middlewares
app.use(express.json());

// Root route
app.get('/', (_req, res) => {
  res.json({ message: '🚀 Velkommen til Gavdash API' });
});

// Health check
app.get('/api/v1/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Dummy agents endpoint (mock-data)
app.get('/api/agents', (_req, res) => {
  res.json([
    { id: 1, name: 'Simon', sales: 25, spe: 1.4 },
    { id: 2, name: 'Ulla', sales: 30, spe: 1.6 },
    { id: 3, name: 'Patrick', sales: 20, spe: 1.2 }
  ]);
});

// Fallback 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`Gavdash API kører på port ${PORT}`);
});
