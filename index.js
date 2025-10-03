/* index.js - Gavdash backend (Render) */
import express from "express";
import morgan from "morgan";

const app = express();

// ---- Env
const PORT = process.env.PORT || 10000;
const WEBHOOK_SECRET = (process.env.ADVERSUS_WEBHOOK_SECRET || "").toString().trim();
const ADVERSUS_API_USER = (process.env.ADVERSUS_API_USER || "").toString();
const ADVERSUS_API_PASS = (process.env.ADVERSUS_API_PASS || "").toString();
const ADVERSUS_BASE_URL = (process.env.ADVERSUS_BASE_URL || "https://api.adversus.io").toString();

// ---- Middleware
app.use(express.json({ type: ["application/json", "text/plain"] }));
app.use(express.urlencoded({ extended: false }));
app.use(morgan("tiny"));

// ---- Helpers
function adversusAuthHeader() {
  const token = Buffer.from(`${ADVERSUS_API_USER}:${ADVERSUS_API_PASS}`).toString("base64");
  return `Basic ${token}`;
}

function getProvidedSecret(req) {
  // accepter både header og query; trim whitespace
  const headerSecret = (req.get("x-adversus-secret") || "").trim();
  const querySecret = (req.query.secret || req.query.key || "").toString().trim();
  return headerSecret || querySecret;
}

function requireSecret(req, res, next) {
  const provided = getProvidedSecret(req);
  if (!WEBHOOK_SECRET || !provided || provided !== WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  return next();
}

// ---- In-memory debug buffer (ikke til produktion)
let lastEvents = [];
const MAX_EVENTS = 200;

// ---- Routes
app.get("/", (req, res) => {
  res.json({ message: "Welcome to Gavdash API" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Webhook modtager (Adversus -> os)
app.post("/webhook/adversus", requireSecret, (req, res) => {
  const payload = req.body || {};
  lastEvents.unshift({ receivedAt: new Date().toISOString(), payload });
  if (lastEvents.length > MAX_EVENTS) lastEvents.pop();
  return res.json({ ok: true });
});

// Debug: se seneste events (kræver secret)
app.get("/_debug/events", requireSecret, (req, res) => {
  res.json(lastEvents);
});

// Test Adversus-forbindelse (kræver secret)
app.get("/adversus/test", requireSecret, async (req, res) => {
  try {
    const url = `${ADVERSUS_BASE_URL}/v1/webhooks`;
    const r = await fetch(url, {
      headers: {
        Authorization: adversusAuthHeader(),
        Accept: "application/json"
      }
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return res.status(r.ok ? 200 : r.status).json({ ok: r.ok, status: r.status, url, body });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Diagnose: viser kun længder/kilde (ingen secrets)
app.get("/__diag", (req, res) => {
  const headerSecret = (req.get("x-adversus-secret") || "").toString();
  const querySecret = (req.query.secret || "").toString();
  const queryKey = (req.query.key || "").toString();
  const used =
    headerSecret.trim()
      ? "header:x-adversus-secret"
      : querySecret.trim()
      ? "query:secret"
      : queryKey.trim()
      ? "query:key"
      : "none";
  res.json({
    ok: true,
    usedSource: used,
    lengths: {
      envSecret: WEBHOOK_SECRET.length,
      headerSecret: headerSecret.trim().length,
      querySecret: querySecret.trim().length,
      queryKey: queryKey.trim().length
    }
  });
});

// ---- Start server
app.listen(PORT, () => {
  console.log(`Gavdash API listening on ${PORT}`);
});
