// index.js
// Enkel backend m. Adversus-integration på Render

import express from "express";
import morgan from "morgan";

const app = express();

// === Miljø-variabler ===
const PORT = process.env.PORT || 10000;
const WEBHOOK_SECRET = (process.env.ADVERSUS_WEBHOOK_SECRET || "").toString();
const ADVERSUS_API_USER = (process.env.ADVERSUS_API_USER || "").toString();
const ADVERSUS_API_PASS = (process.env.ADVERSUS_API_PASS || "").toString();
const ADVERSUS_BASE_URL = "https://api.adversus.io";

// === Middleware ===
app.use(express.json({ type: ["application/json", "text/plain"] }));
app.use(express.urlencoded({ extended: false }));
app.use(morgan("dev"));

// === Hjælpere ===
function getProvidedSecret(req) {
  // Acceptér header, ?secret eller ?key — trim altid
  const headerSecret = (req.headers["x-adversus-secret"] || "").toString().trim();
  const querySecret = (req.query.secret || req.query.key || "").toString().trim();

  // Prioritér header, ellers query
  return headerSecret || querySecret;
}

function requireSecret(req, res) {
  const provided = getProvidedSecret(req);
  const expected = WEBHOOK_SECRET.toString().trim();
  return provided && expected && provided === expected;
}

function adversusAuthHeader() {
  const token = Buffer.from(`${ADVERSUS_API_USER}:${ADVERSUS_API_PASS}`).toString("base64");
  return `Basic ${token}`;
}

// === Basis ruter ===
app.get("/", (req, res) => {
  res.json({ message: "🚀 Velkommen til Gavdash API!" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// === Debug: vis seneste events (ikke følsomt indhold) ===
let lastEvents = [];
const MAX_EVENTS = 200;

// Modtag webhook fra Adversus
app.post("/webhook/adversus", (req, res) => {
  if (!requireSecret(req, res)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const payload = req.body || {};
  lastEvents.unshift({ receivedAt: new Date().toISOString(), payload });
  if (lastEvents.length > MAX_EVENTS) lastEvents.pop();
  res.status(200).json({ ok: true });
});

// Debug-listing (kræver secret)
app.get("/_debug/events", (req, res) => {
  if (!requireSecret(req, res)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  res.json({ ok: true, count: lastEvents.length, data: lastEvents.slice(0, 20) });
});

// Test forbindelse til Adversus
app.get("/adversus/test", async (req, res) => {
  if (!requireSecret(req, res)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  try {
    const url = `${ADVERSUS_BASE_URL}/v1/webhooks`;
    const r = await fetch(url, {
      headers: {
        Authorization: adversusAuthHeader(),
        Accept: "application/json",
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
    console.error("Adversus test error:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// 🔎 Diagnostics (viser ikke hemmeligheder, kun længder og hvilken input der blev brugt)
app.get("/__diag", (req, res) => {
  const headerSecret = (req.headers["x-adversus-secret"] || "").toString();
  const querySecret = (req.query.secret || "").toString();
  const queryKey = (req.query.key || "").toString();
  const envSecret = WEBHOOK_SECRET || "";

  // hvilken kilde bliver valgt?
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
      envSecret: envSecret.trim().length,
      headerSecret: headerSecret.trim().length,
      querySecret: querySecret.trim().length,
      queryKey: queryKey.trim().length,
    },
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Gavdash API listening on ${PORT}`);
});
