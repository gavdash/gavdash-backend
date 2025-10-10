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

// ==== Inspect RESULT (resultFields + resultData) — deep på lead-niveau OG seneste result ====
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
        const id    = it?.id ?? it?.fieldId ?? (typeof it?.key === "number" ? it.key : null);
        const value =
          it?.value ?? it?.val ?? it?.data ?? it?.text ?? it?.content ??
          (Array.isArray(it?.values) ? it.values.join(", ") : null);
        if (!label && !id) continue;
        if (value == null || String(value).trim() === "") continue;
        out.push({ label: label || null, id: id || null, value });
      }
      return out;
    }
    function fromDataObject(obj) {
      const out = [];
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;

      let structured = false;
      for (const [k,v] of Object.entries(obj)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const label = String(v.label ?? v.name ?? v.title ?? k).trim();
          const id    = v.id ?? v.fieldId ?? (/^\d+$/.test(k) ? Number(k) : null);
          let value   = v.value ?? v.val ?? v.text ?? (Array.isArray(v.values) ? v.values.join(", ") : undefined);
          if ((label || id) && value != null && String(value).trim() !== "") {
            out.push({ label: label || null, id: id || null, value });
            structured = true;
          }
        }
      }
      if (structured) return out;

      for (const [k,v] of Object.entries(obj)) {
        if (/^\d+$/.test(k)) {
          const id = Number(k);
          const value = v;
          if (value != null && String(value).trim() !== "") {
            out.push({ label: null, id, value });
          }
        }
      }
      return out;
    }

    const seen = {};
    const tryLog = [];
    function hit(prefix, label, id, val) {
      if (val == null || (typeof val === "string" && val.trim() === "")) return;
      const key = label ? `${prefix}.${label}` : (id ? `${prefix}.${id}` : null);
      if (!key) return;
      if (!seen[key]) seen[key] = { count: 0, example: val };
      seen[key].count++;
      if (seen[key].example == null || seen[key].example === "") seen[key].example = val;
    }
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    for (const lead of toScan) {
      const id = lead?.id ?? lead?.leadId ?? lead?.leadID;
      if (!id) continue;

      // A) resultFields direkte på lead
      let expanded = await adversusGet(`/v1/leads/${id}?expand=resultFields`).catch(() => null);
      if (!expanded?.ok) expanded = await adversusGet(`/v1/leads/${id}?include=resultFields`).catch(() => null);
      if (expanded?.ok && expanded.body) {
        const body = expanded.body;
        const candidates = [
          body?.resultFields,
          body?.data?.resultFields,
          Array.isArray(body?.leads) ? body.leads[0]?.resultFields : undefined,
          Array.isArray(body?.leads) ? body.leads[0]?.data?.resultFields : undefined,
        ];
        candidates.forEach(c => {
          fromDataArray(c).forEach(({label,id,value}) => hit("resultFields", label, id, value));
          fromDataObject(c).forEach(({label,id,value}) => hit("resultFields", label, id, value));
        });
        tryLog.push({ id, endpoint: "leads/{id}?expand/include=resultFields", got: true });
      } else {
        tryLog.push({ id, endpoint: "leads/{id}?expand/include=resultFields", got: false });
      }

      // B) seneste resultater – både resultFields og resultData
      const p = await adversusGet(`/v1/leads/${id}?expand=results`).catch(() => null);
      if (p?.ok && p.body && typeof p.body === "object") {
        let results = Array.isArray(p.body?.results) ? p.body.results : null;
        if (!results && Array.isArray(p.body?.leads)) {
          const first = p.body.leads[0];
          if (first && Array.isArray(first.results)) results = first.results;
          if (!results && (first?.resultData || first?.resultFields)) {
            results = [{ resultData: first.resultData, resultFields: first.resultFields }];
          }
        }
        if (Array.isArray(results) && results.length) {
          results.sort((a,b) => new Date(b?.created||b?.updated||0) - new Date(a?.created||a?.updated||0));
          const latest = results[0];
          const places = [ latest?.resultFields, latest?.fields, latest?.resultData, latest?.data?.resultData ];
          places.forEach(c => {
            fromDataArray(c).forEach(({label,id,value}) => {
              const pref = (c === latest?.resultData || c === latest?.data?.resultData) ? "resultData" : "resultFields";
              hit(pref, label, id, value);
            });
            fromDataObject(c).forEach(({label,id,value}) => {
              const pref = (c === latest?.resultData || c === latest?.data?.resultData) ? "resultData" : "resultFields";
              hit(pref, label, id, value);
            });
          });
          tryLog.push({ id, endpoint: "leads/{id}?expand=results", got: true });
        } else {
          tryLog.push({ id, endpoint: "leads/{id}?expand=results", got: false });
        }
      } else {
        tryLog.push({ id, endpoint: "leads/{id}?expand=results", got: false });
      }

      await delay(700);
    }

    const fields = Object.entries(seen)
      .map(([field, info]) => ({ field, count: info.count, example: info.example }))
      .sort((a,b) => b.count - a.count || a.field.localeCompare(b.field));

    res.json({ ok: true, total_returned: leads.length, scanned: toScan.length, fields, diag: tryLog });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ==== NY: scan efter NUMERISKE nøgler i resultData (fx 96830) ====
app.get("/adversus/leads/resultdata_ids_preview", requireSecret, async (req, res) => {
  try {
    const search = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const listResp = await adversusGet(`/v1/leads${search}`);
    if (!listResp.ok) {
      return res.status(listResp.status || 500).json({
        ok: false, status: listResp.status, url: listResp.url,
        error: typeof listResp.body === "string" ? listResp.body.slice(0,2000) : listResp.body
      });
    }

    // normaliser
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

    const sample = Math.max(1, Math.min(15, parseInt(String(req.query.sample || "10"),10) || 10));
    const toScan = leads.slice(0, sample);

    function collectNumericKeys(obj) {
      const out = [];
      if (!obj || typeof obj !== "object") return out;
      for (const [k,v] of Object.entries(obj)) {
        if (/^\d+$/.test(k)) {
          const id = Number(k);
          if (v != null && String(v).trim?.() !== "") out.push({ id, example: v });
        }
      }
      return out;
    }

    const seen = new Map(); // id -> {count, example}
    const perLead = [];
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    for (const lead of toScan) {
      const id = lead?.id ?? lead?.leadId ?? lead?.leadID;
      if (!id) continue;
      const hits = [];

      // A) resultData direkte på lead (expand/include=results for at få “resultData” som nogle konti har på leadet)
      const pA = await adversusGet(`/v1/leads/${id}?expand=results`).catch(() => null);
      if (pA?.ok && pA.body) {
        const b = pA.body;
        const candidates = [
          b?.resultData, b?.data?.resultData,
          Array.isArray(b?.leads) ? b.leads[0]?.resultData : undefined,
          Array.isArray(b?.leads) ? b.leads[0]?.data?.resultData : undefined
        ];
        for (const c of candidates) hits.push(...collectNumericKeys(c));

        // B) seneste resultater
        let results = Array.isArray(b?.results) ? b.results : null;
        if (!results && Array.isArray(b?.leads)) {
          const first = b.leads[0];
          if (first && Array.isArray(first.results)) results = first.results;
        }
        if (Array.isArray(results) && results.length) {
          results.sort((a,x) => new Date(x?.created||x?.updated||0) - new Date(a?.created||a?.updated||0));
          const latest = results[0];
          hits.push(...collectNumericKeys(latest?.resultData), ...collectNumericKeys(latest?.data?.resultData));
        }
      }

      perLead.push({ leadId: id, ids: hits });

      for (const h of hits) {
        if (!seen.has(h.id)) seen.set(h.id, { count: 0, example: h.example });
        const a = seen.get(h.id);
        a.count++;
        if (!a.example) a.example = h.example;
      }
      await delay(400);
    }

    const ids = Array.from(seen.entries()).map(([id,a]) => ({ id, count: a.count, example: a.example }))
      .sort((x,y) => y.count - x.count || (x.id - y.id));

    res.json({ ok:true, scanned: toScan.length, ids, sample: perLead.slice(0,3) });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

// ---- PREVIEW: resultFields pr. lead (label + id + eksempel) ----
app.get("/adversus/leads/resultfields_preview", requireSecret, async (req, res) => {
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

    const sample = Math.max(1, Math.min(15, parseInt(String(req.query.sample || "10"),10) || 10));
    const toScan = leads.slice(0, sample);

    function fromDataArray(arr) {
      const out = [];
      if (!Array.isArray(arr)) return out;
      for (const it of arr) {
        const label = String(it?.label ?? it?.name ?? it?.title ?? it?.key ?? "").trim();
        const id    = it?.id ?? it?.fieldId ?? (typeof it?.key === "number" ? it.key : null);
        const value =
          it?.value ?? it?.val ?? it?.data ?? it?.text ?? it?.content ??
          (Array.isArray(it?.values) ? it.values.join(", ") : null);
        if (!label && !id) continue;
        if (value == null || String(value).trim() === "") continue;
        out.push({ label: label || null, id: id || null, example: value });
      }
      return out;
    }
    function fromDataObject(obj) {
      const out = [];
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
      let pushed = false;
      for (const [k,v] of Object.entries(obj)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const label = String(v.label ?? v.name ?? v.title ?? k).trim();
          const id    = v.id ?? v.fieldId ?? (/^\d+$/.test(k) ? Number(k) : null);
          let value   = v.value ?? v.val ?? v.text ?? (Array.isArray(v.values) ? v.values.join(", ") : undefined);
          if ((label || id) && value != null && String(value).trim() !== "") {
            out.push({ label: label || null, id: id || null, example: value });
            pushed = true;
          }
        }
      }
      if (pushed) return out;
      for (const [k,v] of Object.entries(obj)) {
        if (/^\d+$/.test(k)) {
          const id = Number(k);
          const value = v;
          if (value != null && String(value).trim() !== "") {
            out.push({ label: null, id, example: value });
          }
        }
      }
      return out;
    }

    const aggById = new Map();
    const aggByLbl = new Map();
    const perLead = [];

    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    for (const lead of toScan) {
      const id = lead?.id ?? lead?.leadId ?? lead?.leadID;
      if (!id) continue;
      let hits = [];

      let expanded = await adversusGet(`/v1/leads/${id}?expand=resultFields`).catch(() => null);
      if (!expanded?.ok) expanded = await adversusGet(`/v1/leads/${id}?include=resultFields`).catch(() => null);

      if (expanded?.ok && expanded.body) {
        const body = expanded.body;
        const candidates = [
          body?.resultFields,
          body?.data?.resultFields,
          Array.isArray(body?.leads) ? body.leads[0]?.resultFields : undefined,
          Array.isArray(body?.leads) ? body.leads[0]?.data?.resultFields : undefined,
        ];
        for (const c of candidates) {
          hits.push(...fromDataArray(c), ...fromDataObject(c));
        }
      }

      perLead.push({ leadId: id, fields: hits });

      for (const f of hits) {
        if (f.id != null) {
          if (!aggById.has(f.id)) aggById.set(f.id, { count: 0, labelSamples: new Set(), example: f.example });
          const a = aggById.get(f.id);
          a.count++; if (f.label) a.labelSamples.add(f.label); if (!a.example) a.example = f.example;
        }
        if (f.label) {
          if (!aggByLbl.has(f.label)) aggByLbl.set(f.label, { count: 0, idSamples: new Set(), example: f.example });
          const a = aggByLbl.get(f.label);
          a.count++; if (f.id != null) a.idSamples.add(f.id); if (!a.example) a.example = f.example;
        }
      }

      await delay(450);
    }

    const byId = Array.from(aggById.entries()).map(([id, a]) => ({
      id, labelSamples: Array.from(a.labelSamples).slice(0,3), count: a.count, example: a.example
    })).sort((x,y) => y.count - x.count || (x.id - y.id));

    const byLabel = Array.from(aggByLbl.entries()).map(([label, a]) => ({
      label, idSamples: Array.from(a.idSamples).slice(0,3), count: a.count, example: a.example
    })).sort((x,y) => y.count - x.count || x.label.localeCompare(y.label));

    res.json({ ok: true, scanned: toScan.length, byId, byLabel, sample: perLead.slice(0,3) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ==== Start server ====
app.listen(PORT, () => console.log(`Gavdash API listening on ${PORT}`));
