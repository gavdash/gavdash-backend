// ==== Gavdash Backend (Adversus webhook + DB + API + probes) ====
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

// CORS – så lokale HTML-filer/localhost kan kalde Render-API’et
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
app.get("/health", (_req, res) =>
  res.json({ status: "ok", uptime: process.uptime(), time: new Date().toISOString() })
);
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
      await pgPool.query("INSERT INTO adversus_events (event_type, payload) VALUES ($1, $2)", [
        eventType,
        payload,
      ]);
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
  const t = setTimeout(() => controller.abort(), 20000);
  const r = await fetch(url, {
    headers: { Authorization: adversusAuthHeader(), Accept: "application/json" },
    signal: controller.signal,
  }).catch((err) => {
    throw new Error(`Fetch failed: ${err?.name || ""} ${err?.message || err}`);
  });
  clearTimeout(t);
  let body;
  try {
    body = await r.json();
  } catch {
    body = await r.text();
  }
  return { ok: r.ok, status: r.status, body, url };
}

// ==== Kampagner ====
app.get("/adversus/campaigns", requireSecret, async (_req, res) => {
  try {
    const r = await adversusGet("/v1/campaigns");
    if (!r.ok)
      return res
        .status(r.status || 500)
        .json({ ok: false, status: r.status, url: r.url, error: typeof r.body === "string" ? r.body.slice(0, 2000) : r.body });
    const raw = r.body;
    const totalCount = Array.isArray(raw) ? raw.length : undefined;
    const data = Array.isArray(raw) ? raw.slice(0, 200) : raw;
    res.json({
      ok: true,
      url: r.url,
      total_count: totalCount,
      returned: Array.isArray(data) ? data.length : undefined,
      truncated: typeof totalCount === "number" ? totalCount > 200 : undefined,
      data,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ==== Leads (normaliseret liste) ====
app.get("/adversus/leads", requireSecret, async (req, res) => {
  try {
    const search = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const r = await adversusGet(`/v1/leads${search}`);
    if (!r.ok)
      return res
        .status(r.status || 500)
        .json({ ok: false, status: r.status, url: r.url, error: typeof r.body === "string" ? r.body.slice(0, 2000) : r.body });

    const payload = r.body;
    let items = [];
    if (Array.isArray(payload)) items = payload;
    else if (payload && typeof payload === "object") {
      for (const k of ["items", "data", "rows", "results", "list", "leads"]) {
        if (Array.isArray(payload[k])) {
          items = payload[k];
          break;
        }
      }
      if (!items.length) {
        const firstArrayKey = Object.keys(payload).find((k) => Array.isArray(payload[k]));
        if (firstArrayKey) items = payload[firstArrayKey];
      }
    }

    const limitQ = parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(limitQ) && limitQ > 0 ? limitQ : null;
    let truncated = false;
    if (limit && items.length > limit) {
      items = items.slice(0, limit);
      truncated = true;
    }

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

// ==== Inspect NON-PII (masterData/resultData) ====
app.get("/adversus/leads/inspect_nonpii", requireSecret, async (req, res) => {
  try {
    const search = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const r = await adversusGet(`/v1/leads${search}`);
    if (!r.ok) {
      return res.status(r.status || 500).json({
        ok: false,
        status: r.status,
        url: r.url,
        error: typeof r.body === "string" ? r.body.slice(0, 2000) : r.body,
      });
    }
    const payload = r.body;

    // normaliser liste
    let rows = [];
    if (Array.isArray(payload)) rows = payload;
    else if (payload && typeof payload === "object") {
      for (const k of ["items", "data", "rows", "results", "list", "leads"]) {
        if (Array.isArray(payload[k])) { rows = payload[k]; break; }
      }
      if (!rows.length) {
        const firstArrayKey = Object.keys(payload).find(k => Array.isArray(payload[k]));
        if (firstArrayKey) rows = payload[firstArrayKey];
      }
    }

    const DIRECT_KEYS = [
      "id","campaignId","created","updated","importedTime","lastUpdatedTime","lastModifiedTime",
      "nextContactTime","contactAttempts","contactAttemptsInvalid","lastContactedBy",
      "status","active","vip","common_redial","externalId","import_id"
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

    const seen = {};
    function hit(fieldId, val) {
      if (val == null || (typeof val === "string" && val.trim() === "")) return;
      if (!seen[fieldId]) seen[fieldId] = { count: 0, example: val };
      seen[fieldId].count++;
      if (seen[fieldId].example == null || seen[fieldId].example === "") seen[fieldId].example = val;
    }

    rows.forEach(row => {
      DIRECT_KEYS.forEach(k => hit(k, row?.[k]));
      fromDataArray(row?.masterData).forEach(({label,value}) => hit(`masterData.${label}`, value));
      fromDataArray(row?.resultData).forEach(({label,value}) => hit(`resultData.${label}`, value));
      fromDataObject(row?.masterData).forEach(({label,value}) => hit(`masterData.${label}`, value));
      fromDataObject(row?.resultData).forEach(({label,value}) => hit(`resultData.${label}`, value));
      fromDataArray(row?.data?.masterData).forEach(({label,value}) => hit(`masterData.${label}`, value));
      fromDataArray(row?.data?.resultData).forEach(({label,value}) => hit(`resultData.${label}`, value));
      fromDataObject(row?.data?.masterData).forEach(({label,value}) => hit(`masterData.${label}`, value));
      fromDataObject(row?.data?.resultData).forEach(({label,value}) => hit(`resultData.${label}`, value));
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

// ==== Inspect RESULT FIELDS – DEEP (forsøg flere endpoints pr. lead) ====
app.get("/adversus/leads/inspect_resultfields_deep", requireSecret, async (req, res) => {
  try {
    const search = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const listResp = await adversusGet(`/v1/leads${search}`);
    if (!listResp.ok) {
      return res.status(listResp.status || 500).json({
        ok: false, status: listResp.status, url: listResp.url,
        error: typeof listResp.body === "string" ? listResp.body.slice(0,2000) : listResp.body
      });
    }

    // normaliser liste
    const payload = listResp.body;
    let leads = [];
    if (Array.isArray(payload)) leads = payload;
    else if (payload && typeof payload === "object") {
      for (const k of ["items","data","rows","results","list","leads"]) {
        if (Array.isArray(payload[k])) { leads = payload[k]; break; }
      }
      if (!leads.length) {
        const firstArrayKey = Object.keys(payload).find(k => Array.isArray(payload[k]));
        if (firstArrayKey) leads = payload[firstArrayKey];
      }
    }

    const sample = Math.max(1, Math.min(20, parseInt(String(req.query.sample || "10"),10) || 10));
    const toScan = leads.slice(0, sample);

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
    const seen = {};
    const tryLog = [];

    function hit(fieldId, val) {
      if (val == null || (typeof val === "string" && val.trim() === "")) return;
      if (!seen[fieldId]) seen[fieldId] = { count: 0, example: val };
      seen[fieldId].count++;
      if (seen[fieldId].example == null || seen[fieldId].example === "") seen[fieldId].example = val;
    }

    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    for (const lead of toScan) {
      const id = lead?.id ?? lead?.leadId ?? lead?.leadID;
      if (!id) continue;

      let resultCandidates = [];
      const p1 = await adversusGet(`/v1/leads/${id}/results`).catch(() => null);
      if (p1?.ok && Array.isArray(p1.body)) {
        tryLog.push({ id, endpoint: "leads/{id}/results", count: p1.body.length });
        resultCandidates = p1.body;
      }

      if (!resultCandidates.length) {
        const p2 = await adversusGet(`/v1/results?leadId=${encodeURIComponent(id)}`).catch(() => null);
        if (p2?.ok && Array.isArray(p2.body)) {
          tryLog.push({ id, endpoint: "results?leadId", count: p2.body.length });
          resultCandidates = p2.body;
        }
      }

      if (!resultCandidates.length) {
        const p3 = await adversusGet(`/v1/leads/${id}?expand=results`).catch(() => null);
        const p3b = (!p3?.ok) ? await adversusGet(`/v1/leads/${id}?include=results`).catch(() => null) : null;
        const src = p3?.ok ? p3 : p3b;
        const srcName = p3?.ok ? "leads/{id}?expand=results" : (p3b?.ok ? "leads/{id}?include=results" : null);
        if (src?.ok && src?.body && typeof src.body === "object") {
          const arr = Array.isArray(src.body.results) ? src.body.results : Array.isArray(src.body?.data?.results) ? src.body.data.results : null;
          if (arr) {
            tryLog.push({ id, endpoint: srcName, count: arr.length });
            resultCandidates = arr;
          }
        }
      }

      if (Array.isArray(resultCandidates) && resultCandidates.length) {
        resultCandidates.sort((a,b) => new Date(b?.created||b?.updated||0) - new Date(a?.created||a?.updated||0));
        const latest = resultCandidates[0];
        const places = [ latest?.resultFields, latest?.fields ];
        for (const p of places) {
          fromDataArray(p).forEach(({label,value}) => hit(`resultFields.${label}`, value));
          fromDataObject(p).forEach(({label,value}) => hit(`resultFields.${label}`, value));
        }
      }

      await delay(900); // ~60/min, langt under burst limit
    }

    const fields = Object.entries(seen)
      .map(([field, info]) => ({ field, count: info.count, example: info.example }))
      .sort((a,b) => b.count - a.count || a.field.localeCompare(b.field));

    res.json({
      ok: true,
      total_returned: leads.length,
      scanned: toScan.length,
      fields,
      diag: tryLog
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ==== NYT: SHAPE PROBE (PII-safe – returnerer kun paths/keys) ====
app.get("/adversus/leads/shape_probe", requireSecret, async (req, res) => {
  try {
    const search = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const listResp = await adversusGet(`/v1/leads${search}`);
    if (!listResp.ok) {
      return res.status(listResp.status || 500).json({
        ok: false, status: listResp.status, url: listResp.url,
        error: typeof listResp.body === "string" ? listResp.body.slice(0,2000) : listResp.body
      });
    }

    const payload = listResp.body;
    let leads = [];
    if (Array.isArray(payload)) leads = payload;
    else if (payload && typeof payload === "object") {
      for (const k of ["items","data","rows","results","list","leads"]) {
        if (Array.isArray(payload[k])) { leads = payload[k]; break; }
      }
      if (!leads.length) {
        const firstArrayKey = Object.keys(payload).find(k => Array.isArray(payload[k]));
        if (firstArrayKey) leads = payload[firstArrayKey];
      }
    }

    const sample = Math.max(1, Math.min(5, parseInt(String(req.query.sample || "3"),10) || 3));
    const toScan = leads.slice(0, sample);

    // rekursiv key-walk — SAMLER KUN PATHS (ingen værdier)
    const maxDepth = 6;
    const interesting = new Set();
    function walk(obj, path = [], depth = 0) {
      if (!obj || typeof obj !== "object" || depth >= maxDepth) return;
      const keys = Array.isArray(obj) ? Object.keys(obj) : Object.keys(obj);
      for (const k of keys) {
        const next = Array.isArray(obj) ? obj[Number(k)] : obj[k];
        const p = [...path, Array.isArray(obj) ? `[${k}]` : k];
        const ps = p.join(".");
        // marker interessante stier
        if (/(result|results|disposition|fields)/i.test(k)) interesting.add(ps);
        if (next && typeof next === "object") walk(next, p, depth + 1);
      }
    }

    const diag = [];
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    for (const lead of toScan) {
      walk(lead, ["lead"]);
      const id = lead?.id ?? lead?.leadId ?? lead?.leadID;
      if (!id) continue;

      const p1 = await adversusGet(`/v1/leads/${id}/results`).catch(() => null);
      if (p1?.ok) { walk(p1.body, ["leads_id_results"]); diag.push({ id, endpoint: "leads/{id}/results", ok: true }); }

      const p2 = await adversusGet(`/v1/results?leadId=${encodeURIComponent(id)}`).catch(() => null);
      if (p2?.ok) { walk(p2.body, ["results_q_leadId"]); diag.push({ id, endpoint: "results?leadId", ok: true }); }

      const p3 = await adversusGet(`/v1/leads/${id}?expand=results`).catch(() => null);
      if (p3?.ok) { walk(p3.body, ["lead_expand_results"]); diag.push({ id, endpoint: "leads/{id}?expand=results", ok: true }); }

      if (!p3?.ok) {
        const p3b = await adversusGet(`/v1/leads/${id}?include=results`).catch(() => null);
        if (p3b?.ok) { walk(p3b.body, ["lead_include_results"]); diag.push({ id, endpoint: "leads/{id}?include=results", ok: true }); }
      }

      await delay(600);
    }

    res.json({
      ok: true,
      total_returned: leads.length,
      scanned: toScan.length,
      interesting_paths: Array.from(interesting).sort(),
      diag
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ==== Start server ====
app.listen(PORT, () => console.log(`Gavdash API listening on ${PORT}`));
