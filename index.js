// ==== Gavdash Backend (Adversus webhook + DB + API) ====
// Node 18+ (Render), Express 4

import express from "express";
import morgan from "morgan";
import { Pool } from "pg";

// ==== Miljø-variabler ====
const PORT = process.env.PORT || 10000;
const WEBHOOK_SECRET = process.env.ADVERSUS_WEBHOOK_SECRET || ""; // fx "testsecret123"
const ADVERSUS_API_USER = process.env.ADVERSUS_API_USER || "";
const ADVERSUS_API_PASS = process.env.ADVERSUS_API_PASS || "";
const ADVERSUS_BASE_URL = process.env.ADVERSUS_BASE_URL || "https://api.adversus.io";
const DATABASE_URL = process.env.DATABASE_URL || "";

// ==== App + middleware ====
const app = express();
app.use(morgan("dev"));
app.use(express.json({ type: ["application/json", "text/plain"] }));
app.use(express.urlencoded({ extended: false }));

// ==== Hjælpere ====
function readSecrets(req) {
  const headerSecret = req.headers["x-adversus-secret"]?.toString() || "";
  const querySecret = req.query.secret?.toString() || req.query["adversus-secret"]?.toString() || "";
  const queryKey = req.query.key?.toString() || req.query["adversus-key"]?.toString() || "";
  const envSecret = WEBHOOK_SECRET || "";

  let usedSource = null;
  if (headerSecret && envSecret && headerSecret === envSecret) usedSource = "header:secret";
  else if (querySecret && envSecret && querySecret === envSecret) usedSource = "query:secret";
  else if (queryKey && envSecret && queryKey === envSecret) usedSource = "query:key";

  const ok = Boolean(usedSource);
  return { ok, usedSource };
}

function requireSecret(req, res, next) {
  const info = readSecrets(req);
  if (!info.ok) return res.status(401).json({ ok: false, error: "Unauthorized: invalid secret" });
  next();
}

function adversusAuthHeader() {
  const token = Buffer.from(`${ADVERSUS_API_USER}:${ADVERSUS_API_PASS}`).toString("base64");
  return `Basic ${token}`;
}

// ==== In-memory buffer (debug) ====
const lastEvents = [];
const MAX_EVENTS = 200;

// ==== Postgres pool ====
let pgPool = null;
if (DATABASE_URL) {
  pgPool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  pgPool.on("error", (err) => console.error("PG pool error:", err));
}

// ==== Init DB ====
async function initDb() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS adversus_events (
      id BIGSERIAL PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      event_type TEXT,
      payload JSONB NOT NULL
    );
  `);
  console.log("DB ready: adversus_events table");
}
initDb().catch(err => console.error("DB init error:", err));

// ==== Basisspor / health ====
app.get("/health", (_req, res) =>
  res.json({ status: "ok", uptime: process.uptime(), time: new Date().toISOString() })
);

// ==== Debug: secret ====
app.get("/_show-secret", (req, res) => res.json(readSecrets(req)));

// ==== Debug: memory events ====
app.get("/_debug/events", requireSecret, (req, res) => res.json(lastEvents.slice(0, 100)));
app.get("/debug/events", requireSecret, (req, res) => res.json(lastEvents.slice(0, 100)));

// ==== Debug: DB status ====
app.get("/_debug/db", requireSecret, async (_req, res) => {
  if (!pgPool) return res.json({ ok: true, connected: false, note: "No DB" });
  try {
    const r = await pgPool.query("select now() as now, count(*) from adversus_events");
    res.json({ ok: true, connected: true, now: r.rows[0].now, total_events: r.rows[0].count });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ==== Debug: DB events (seneste 50) ====
app.get("/_debug/events/db", requireSecret, async (_req, res) => {
  if (!pgPool) return res.json([]);
  try {
    const r = await pgPool.query(
      "SELECT id, received_at, event_type FROM adversus_events ORDER BY received_at DESC LIMIT 50"
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ==== Webhook fra Adversus ====
app.post("/webhook/adversus", requireSecret, async (req, res) => {
  const payload = req.body || {};
  const eventType = payload?.event || payload?.type || null;

  // Gem i memory
  lastEvents.unshift({ receivedAt: new Date().toISOString(), eventType, payload });
  if (lastEvents.length > MAX_EVENTS) lastEvents.pop();

  // Gem i DB
  if (pgPool) {
    try {
      await pgPool.query(
        "INSERT INTO adversus_events (event_type, payload) VALUES ($1, $2)",
        [eventType, payload]
      );
    } catch (e) {
      console.error("DB insert failed:", e);
    }
  }

  return res.status(200).json({ ok: true });
});

// ==== Adversus REST helper ====
async function adversusGet(pathWithQuery) {
  const url = `${ADVERSUS_BASE_URL}${pathWithQuery}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000); // 15s timeout

  const r = await fetch(url, {
    headers: { Authorization: adversusAuthHeader(), Accept: "application/json" },
    signal: controller.signal,
  }).catch(err => {
    throw new Error(`Fetch failed: ${err?.name || ""} ${err?.message || err}`);
  });
  clearTimeout(t);

  let body;
  try { body = await r.json(); } catch { body = await r.text(); }

  return { ok: r.ok, status: r.status, body, url };
}

// ==== Kampagner ====
app.get("/adversus/campaigns", requireSecret, async (_req, res) => {
  try {
    const r = await adversusGet("/v1/campaigns");
    if (!r.ok) {
      return res.status(r.status || 500).json({
        ok: false, status: r.status, url: r.url,
        error: typeof r.body === "string" ? r.body.slice(0, 2000) : r.body,
      });
    }
    const raw = r.body;
    const totalCount = Array.isArray(raw) ? raw.length : undefined;
    const data = Array.isArray(raw) ? raw.slice(0, 50) : raw;
    res.json({ ok: true, url: r.url, total_count: totalCount, returned: Array.isArray(data) ? data.length : undefined, truncated: typeof totalCount === "number" ? totalCount > 50 : undefined, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ==== NYT: Leads (passthrough af query) ====
app.get("/adversus/leads", requireSecret, async (req, res) => {
  try {
    // Behold alle query-parametre (fx ?limit=50&campaignId=123&from=2025-10-01&to=2025-10-03)
    const search = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const r = await adversusGet(`/v1/leads${search}`);
    if (!r.ok) {
      return res.status(r.status || 500).json({
        ok: false, status: r.status, url: r.url,
        error: typeof r.body === "string" ? r.body.slice(0, 2000) : r.body,
      });
    }

    // Hvis svar er en kæmpe liste, så begræns debug-output for ikke at overvælde browseren
    let data = r.body;
    let totalCount, returned, truncated;
    if (Array.isArray(data)) {
      totalCount = data.length;
      returned = Math.min(totalCount, 50);
      truncated = totalCount > 50;
      data = data.slice(0, 50);
    }

    res.json({ ok: true, url: r.url, total_count: totalCount, returned, truncated, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ==== (findes i forvejen) Test Webhooks endpoint-list ====
app.get("/adversus/test", requireSecret, async (_req, res) => {
  try {
    const url = `${ADVERSUS_BASE_URL}/v1/webhooks`;
    const r = await fetch(url, { headers: { Authorization: adversusAuthHeader(), Accept: "application/json" } });
    let body; try { body = await r.json(); } catch { body = await r.text(); }
    res.status(r.ok ? 200 : r.status).json({ ok: r.ok, status: r.status, body, url });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ==== Start server ====
app.listen(PORT, () => console.log(`Gavdash API listening on ${PORT}`));
