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
// VIGTIGT: korrekt Adversus base URL
const ADVERSUS_BASE_URL =
  process.env.ADVERSUS_BASE_URL || "https://solutions.adversus.io/api";
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

// ==== Hjælpere til secrets ====
function readSecrets(req) {
  const headerSecret = req.headers["x-adversus-secret"]?.toString() || "";
  const querySecret =
    req.query.secret?.toString() || req.query["adversus-secret"]?.toString() || "";
  const queryKey =
    req.query.key?.toString() || req.query["adversus-key"]?.toString() || "";
  const envSecret = WEBHOOK_SECRET || "";

  let usedSource = null;
  if (headerSecret && envSecret && headerSecret === envSecret)
    usedSource = "header:secret";
  else if (querySecret && envSecret && querySecret === envSecret)
    usedSource = "query:secret";
  else if (queryKey && envSecret && queryKey === envSecret)
    usedSource = "query:key";

  const ok = Boolean(usedSource);
  return { ok, usedSource };
}

function requireSecret(req, res, next) {
  const info = readSecrets(req);
  if (!info.ok) {
    return res.status(401).json({
      ok: false,
      error:
        "Unauthorized: missing/invalid secret. Brug header 'x-adversus-secret' eller ?secret=...",
    });
  }
  next();
}

// ==== Adversus auth + helper ====
function adversusAuthHeader() {
  const token = Buffer.from(`${ADVERSUS_API_USER}:${ADVERSUS_API_PASS}`).toString(
    "base64"
  );
  return `Basic ${token}`;
}

async function adversusGet(pathWithQuery) {
  const url = `${ADVERSUS_BASE_URL}${pathWithQuery}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);

  const r = await fetch(url, {
    headers: {
      Authorization: adversusAuthHeader(),
      Accept: "application/json",
    },
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

// ==== In-memory (debug) ====
const lastEvents = [];
const MAX_EVENTS = 200;

// ==== Postgres pool ====
let pgPool = null;
if (DATABASE_URL) {
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    max: 3,
    idleTimeoutMillis: 30000,
  });
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

app.get("/_debug/events", requireSecret, (_req, res) =>
  res.json(lastEvents.slice(0, 100))
);
app.get("/debug/events", requireSecret, (_req, res) =>
  res.json(lastEvents.slice(0, 100))
);

app.get("/_debug/db", requireSecret, async (_req, res) => {
  if (!pgPool) return res.json({ ok: true, connected: false, note: "No DB" });
  try {
    const r = await pgPool.query(
      "select now() as now, count(*) from adversus_events"
    );
    res.json({
      ok: true,
      connected: true,
      now: r.rows[0].now,
      total_events: r.rows[0].count,
    });
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

// ==== Webhook fra Adversus ====
app.post("/webhook/adversus", requireSecret, async (req, res) => {
  const payload = req.body || {};
  const eventType = payload?.event || payload?.type || null;

  lastEvents.unshift({
    receivedAt: new Date().toISOString(),
    eventType,
    payload,
  });
  if (lastEvents.length > MAX_EVENTS) lastEvents.pop();

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

// ==== Adversus kampagner ====
app.get("/adversus/campaigns", requireSecret, async (_req, res) => {
  try {
    // NB: IKKE /v1 – korrekt sti er /campaigns
    const r = await adversusGet("/campaigns");
    if (!r.ok) {
      return res.status(r.status || 500).json({
        ok: false,
        status: r.status,
        url: r.url,
        error:
          typeof r.body === "string" ? r.body.slice(0, 2000) : r.body,
      });
    }
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
    // NB: IKKE /v1
    const r = await adversusGet(`/leads${search}`);
    if (!r.ok) {
      return res.status(r.status || 500).json({
        ok: false,
        status: r.status,
        url: r.url,
        error:
          typeof r.body === "string" ? r.body.slice(0, 2000) : r.body,
      });
    }

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
        const firstArrayKey = Object.keys(payload).find((k) =>
          Array.isArray(payload[k])
        );
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

    res.json({
      ok: true,
      url: r.url,
      total_count: totalCount,
      returned: items.length,
      truncated,
      data: items,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ==== Peek et enkelt lead – PII-safe paths (til at se hvor felter bor) ====
app.get(
  "/adversus/leads/result_peek_single",
  requireSecret,
  async (req, res) => {
    try {
      const leadId = String(req.query.leadId || "").trim();
      if (!leadId) {
        return res.status(400).json({ ok: false, error: "missing leadId" });
      }

      const [expResults, expFields] = await Promise.allSettled([
        adversusGet(`/leads/${encodeURIComponent(leadId)}?expand=results`),
        adversusGet(`/leads/${encodeURIComponent(leadId)}?expand=resultFields`),
      ]);

      function toObj(p) {
        return p &&
          p.status === "fulfilled" &&
          p.value?.ok &&
          p.value?.body &&
          typeof p.value.body === "object"
          ? p.value.body
          : null;
      }

      const bodyResults = toObj(expResults);
      const bodyFields = toObj(expFields);

      function walk(obj, maxDepth = 7) {
        const out = [];
        function rec(node, path = [], depth = 0) {
          if (!node || typeof node !== "object" || depth > maxDepth) return;
          const entries = Array.isArray(node)
            ? node.map((v, i) => [String(i), v])
            : Object.entries(node);
          for (const [k, v] of entries) {
            const p = [...path, Array.isArray(node) ? `[${k}]` : k];
            const t =
              v === null
                ? "null"
                : Array.isArray(v)
                ? "array"
                : typeof v;
            out.push({ path: p.join("."), type: t });
            if (t === "object" || t === "array") rec(v, p, depth + 1);
          }
        }
        rec(obj, [], 0);
        return out;
      }

      const paths_expand = bodyResults ? walk(bodyResults) : [];
      const paths_resultFields = bodyFields ? walk(bodyFields) : [];

      res.json({
        ok: true,
        leadId,
        expand_results_ok: !!bodyResults,
        expand_resultFields_ok: !!bodyFields,
        paths_expand: paths_expand.slice(0, 500),
        paths_resultFields: paths_resultFields.slice(0, 500),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }
);

// ==== NYT: rå results for et lead – til at finde "Samlet præmie hos os" ====
app.get(
  "/adversus/results/by_lead_raw",
  requireSecret,
  async (req, res) => {
    try {
      const leadId = String(req.query.leadId || "").trim();
      if (!leadId) {
        return res.status(400).json({ ok: false, error: "missing leadId" });
      }

      // NB: korrekt sti er /results (IKKE /v1/results)
      const r = await adversusGet(
        `/results?leadId=${encodeURIComponent(leadId)}`
      );

      if (!r.ok) {
        return res.status(r.status || 500).json({
          ok: false,
          status: r.status,
          url: r.url,
          error:
            typeof r.body === "string" ? r.body.slice(0, 2000) : r.body,
        });
      }

      return res.json({
        ok: true,
        url: r.url,
        status: r.status,
        results: r.body,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }
);

// ==== Start server ====
app.listen(PORT, () =>
  console.log(`Gavdash API listening on ${PORT}`)
);
