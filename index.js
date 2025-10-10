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

// CORS – så din lokale HTML kan kalde Render
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-adversus-secret");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ type: ["application/json", "text/plain"] }));
app.use(express.urlencoded({ extended: false }));

// ==== Hjælpere ====
function readSecrets(req) {
  const headerSecret = req.headers["x-adversus-secret"]?.toString() || "";
  const querySecret =
    req.query.secret?.toString() || req.query["adversus-secret"]?.toString() || "";
  const queryKey =
    req.query.key?.toString() || req.query["adversus-key"]?.toString() || "";
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
  if (!info.ok) {
    return res
      .status(401)
      .json({ ok: false, error: "Unauthorized: missing/invalid secret. Brug header 'x-adversus-secret' eller ?secret=..." });
  }
  next();
}
function adversusAuthHeader() {
  const token = Buffer.from(`${ADVERSUS_API_USER}:${ADVERSUS_API_PASS}`).toString("base64");
  return `Basic ${token}`;
}

// ==== In-memory (debug) ====
const lastEvents = [];
const MAX_EVENTS = 200;

// ==== Postgres pool ====
let pgPool = null;
if (DATABASE_URL) {
  pgPool = new Pool({ connectionString: DATABASE_URL, max: 3, idleTimeoutMillis: 30000 });
  pgPool.on("error", (err) => console.error("PG pool error:", err));
} else {
  console.warn("DATABASE_URL is not set — DB disabled");
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
initDb().catch((err) => console.error("DB init error:", err));

// ==== Health / Debug ====
app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime(), time: new Date().toISOString() }));
app.get("/_show-secret", (req, res) => res.json(readSecrets(req)));
app.get("/_debug/events", requireSecret, (_req, res) => res.json(lastEvents.slice(0, 100)));
app.get("/debug/events", requireSecret, (_req, res) => res.json(lastEvents.slice(0, 100)));
app.get("/_debug/db", requireSecret, async (_req, res) => {
  if (!pgPool) return res.json({ ok: true, connected: false, note: "No DB" });
  try {
    const r = await pgPool.query("select now() as now, count(*) from adversus_events");
    res.json({ ok: true, connected: true, now: r.rows[0].now, total_events: r.rows[0].count });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
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

// ==== Webhook ====
app.post("/webhook/adversus", requireSecret, async (req, res) => {
  const payload = req.body || {};
  const eventType = payload?.event || payload?.type || null;

  lastEvents.unshift({ receivedAt: new Date().toISOString(), eventType, payload });
  if (lastEvents.length > MAX_EVENTS) lastEvents.pop();

  if (pgPool) {
    try {
      await pgPool.query("INSERT INTO adversus_events (event_type, payload) VALUES ($1, $2)", [eventType, payload]);
    } catch (e) {
      console.error("DB insert failed:", e);
    }
  }
  return res.status(200).json({ ok: true });
});

// ==== REST helper ====
async function adversusGet(pathWithQuery) {
  const url = `${ADVERSUS_BASE_URL}${pathWithQuery}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  const r = await fetch(url, {
    headers: { Authorization: adversusAuthHeader(), Accept: "application/json" },
    signal: controller.signal,
  }).catch((err) => { throw new Error(`Fetch failed: ${err?.name || ""} ${err?.message || err}`); });
  clearTimeout(t);
  let body; try { body = await r.json(); } catch { body = await r.text(); }
  return { ok: r.ok, status: r.status, body, url };
}

// ==== Kampagner ====
app.get("/adversus/campaigns", requireSecret, async (_req, res) => {
  try {
    const r = await adversusGet("/v1/campaigns");
    if (!r.ok) return res.status(r.status || 500).json({ ok: false, status: r.status, url: r.url, error: typeof r.body === "string" ? r.body.slice(0, 2000) : r.body });
    const raw = r.body;
    const totalCount = Array.isArray(raw) ? raw.length : undefined;
    const data = Array.isArray(raw) ? raw.slice(0, 200) : raw;
    res.json({ ok: true, url: r.url, total_count: totalCount, returned: Array.isArray(data) ? data.length : undefined, truncated: typeof totalCount === "number" ? totalCount > 200 : undefined, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ==== Leads (normaliseret liste) ====
app.get("/adversus/leads", requireSecret, async (req, res) => {
  try {
    const search = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const r = await adversusGet(`/v1/leads${search}`);
    if (!r.ok) return res.status(r.status || 500).json({ ok: false, status: r.status, url: r.url, error: typeof r.body === "string" ? r.body.slice(0, 2000) : r.body });

    const payload = r.body;
    let items = [];
    if (Array.isArray(payload)) items = payload;
    else if (payload && typeof payload === "object") {
      for (const k of ["items", "data", "rows", "results", "list", "leads"]) {
        if (Array.isArray(payload[k])) { items = payload[k]; break; }
      }
      if (!items.length) {
        const firstArrayKey = Object.keys(payload).find((k) => Array.isArray(payload[k]));
        if (firstArrayKey) items = payload[firstArrayKey];
      }
    }

    const limitQ = parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(limitQ) && limitQ > 0 ? limitQ : null;
    let truncated = false;
    if (limit && items.length > limit) { items = items.slice(0, limit); truncated = true; }

    const totalCount =
      (typeof payload?.total === "number" && payload.total) ||
      (typeof payload?.count === "number" && payload.count) ||
      (typeof payload?.totalCount === "number" && payload.totalCount) ||
      (Array.isArray(r.body) ? r.body.length : undefined) ||
      items.length;

    res.json({ ok: true, url: r.url, total_count: totalCount, returned: items.length, truncated, data: items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ==== Inspect NON-PII felter (nu også resultFields) ====
app.get("/adversus/leads/inspect_nonpii", requireSecret, async (req, res) => {
  try {
    const search = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const r = await adversusGet(`/v1/leads${search}`);
    if (!r.ok) {
      return res.status(r.status || 500).json({
        ok: false, status: r.status, url: r.url,
        error: typeof r.body === "string" ? r.body.slice(0, 2000) : r.body,
      });
    }
    const payload = r.body;

    // normalisér liste
    let rows = [];
    if (Array.isArray(payload)) rows = payload;
    else if (payload && typeof payload === "object") {
      for (const k of ["items","data","rows","results","list","leads"]) {
        if (Array.isArray(payload[k])) { rows = payload[k]; break; }
      }
      if (!rows.length) {
        const firstArrayKey = Object.keys(payload).find(k => Array.isArray(payload[k]));
        if (firstArrayKey) rows = payload[firstArrayKey];
      }
    }

    const DIRECT_KEYS = [
      "id","campaignId","created","updated","importedTime",
      "lastUpdatedTime","lastModifiedTime","nextContactTime",
      "contactAttempts","contactAttemptsInvalid",
      "lastContactedBy","status","active","vip","common_redial","externalId","import_id"
    ];

    function fromDataArray(arr) {
      const out = [];
      if (!Array.isArray(arr)) return out;
      for (const it of arr) {
        const label = String(it?.label ?? it?.name ?? it?.title ?? it?.key ?? "").trim();
        const value =
          it?.value ?? it?.val ?? it?.data ?? it?.text ?? it?.content ??
          (Array.isArray(it?.values) ? it.values.join(", ") : null);
        if (!label) continue;
        if (value == null || String(value).trim() === "") continue;
        out.push({ label, value });
      }
      return out;
    }
    function fromDataObject(obj) {
      const out = [];
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
      for (const [k,v] of Object.entries(obj)) {
        const label = String(k).trim();
        let value = v;
        if (value && typeof value === "object") {
          value = value.value ?? value.val ?? value.text ?? (Array.isArray(value.values) ? value.values.join(", ") : undefined);
        }
        if (!label) continue;
        if (value == null || String(value).trim?.() === "") continue;
        out.push({ label, value });
      }
      return out;
    }

    const seen = {}; // fieldId -> {count, example}
    function hit(fieldId, val) {
      if (val === undefined || val === null || (typeof val.trim === "function" && val.trim() === "")) return;
      if (!seen[fieldId]) seen[fieldId] = { count: 0, example: val };
      seen[fieldId].count++;
      if (seen[fieldId].example == null || seen[fieldId].example === "") seen[fieldId].example = val;
    }

    rows.forEach(row => {
      // direkte felter
      DIRECT_KEYS.forEach(k => hit(k, row?.[k]));

      // master/result arrays/objekter
      fromDataArray(row?.masterData).forEach(({label,value}) => hit(`masterData.${label}`, value));
      fromDataArray(row?.resultData).forEach(({label,value}) => hit(`resultData.${label}`, value));
      fromDataObject(row?.masterData).forEach(({label,value}) => hit(`masterData.${label}`, value));
      fromDataObject(row?.resultData).forEach(({label,value}) => hit(`resultData.${label}`, value));

      // deep under data.*
      fromDataArray(row?.data?.masterData).forEach(({label,value}) => hit(`masterData.${label}`, value));
      fromDataArray(row?.data?.resultData).forEach(({label,value}) => hit(`resultData.${label}`, value));
      fromDataObject(row?.data?.masterData).forEach(({label,value}) => hit(`masterData.${label}`, value));
      fromDataObject(row?.data?.resultData).forEach(({label,value}) => hit(`resultData.${label}`, value));

      // >>> NYT: resultFields (array OG objekt) + almindelige “last result” placeringer
      const rfPlaces = [
        row?.resultFields,
        row?.data?.resultFields,
        row?.lastResult?.resultFields,
        row?.lastCall?.resultFields,
        row?.callResult?.resultFields,
        row?.result?.fields,          // nogle modeller
        row?.lastResult?.fields,
      ];
      rfPlaces.forEach(p => {
        fromDataArray(p).forEach(({label,value}) => hit(`resultFields.${label}`, value));
        fromDataObject(p).forEach(({label,value}) => hit(`resultFields.${label}`, value));
      });
    });

    const total = rows.length || 1;
    const summary = Object.entries(seen)
      .map(([field, info]) => ({
        field,
        coverage_pct: Math.round((info.count / total) * 100),
        count: info.count,
        example: info.example
      }))
      .sort((a,b) => (b.coverage_pct - a.coverage_pct) || a.field.localeCompare(b.field));

    res.json({ ok: true, total_rows: rows.length, fields: summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ==== Start server ====
app.listen(PORT, () => console.log(`Gavdash API listening on ${PORT}`));
