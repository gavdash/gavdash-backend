/* Gavdash backend - Adversus integration (Render) */
"use strict";

const express = require("express");
const morgan = require("morgan");

// ---- Env
const PORT = process.env.PORT || 10000;
const WEBHOOK_SECRET = process.env.ADVERSUS_WEBHOOK_SECRET || "";
const ADVERSUS_API_USER = process.env.ADVERSUS_API_USER || "";
const ADVERSUS_API_PASS = process.env.ADVERSUS_API_PASS || "";
const ADVERSUS_BASE_URL = process.env.ADVERSUS_BASE_URL || "https://api.adversus.io";

// ---- App
const app = express();
app.use(express.json({ type: ["application/json", "text/plain"] }));
app.use(express.urlencoded({ extended: false }));
app.use(morgan("tiny"));

// ---- Memory buffer (debug)
const lastEvents = [];
const MAX_EVENTS = 200;

// ---- Helpers
function adversusAuthHeader() {
  const token = Buffer.from(ADVERSUS_API_USER + ":" + ADVERSUS_API_PASS).toString("base64");
  return "Basic " + token;
}

function requireSecret(req, res, next) {
  // Accept either header or query param
  const headerSecret = req.headers["x-adversus-secret"];
  const querySecret = req.query.secret;
  const okHeader = WEBHOOK_SECRET && headerSecret && headerSecret === WEBHOOK_SECRET;
  const okQuery = WEBHOOK_SECRET && querySecret && querySecret === WEBHOOK_SECRET;

  if (okHeader || okQuery) {
    return next();
  }
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

// ---- Baseline routes
app.get("/", function (req, res) {
  res.json({ message: "Welcome to Gavdash API" });
});

app.get("/health", function (req, res) {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Simple diagnose to verify secret in env (protect with the same secret)
app.get("/_show-secret", function (req, res) {
  if ((req.query.secret || "") !== WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  res.json({ ok: true, envSecret: WEBHOOK_SECRET });
});

// ---- Webhook endpoint (Adversus -> us)
app.post("/webhook/adversus", requireSecret, function (req, res) {
  const payload = req.body || {};
  lastEvents.unshift({
    receivedAt: new Date().toISOString(),
    payload: payload
  });
  if (lastEvents.length > MAX_EVENTS) lastEvents.pop();
  // ack fast
  res.json({ ok: true });
});

// ---- Debug: see last webhook events (protected by secret)
app.get("/_debug/events", requireSecret, function (req, res) {
  res.json({ ok: true, data: lastEvents });
});

// ---- Test Adversus API connectivity (protected by secret)
app.get("/adversus/test", requireSecret, async function (req, res) {
  try {
    const url = ADVERSUS_BASE_URL + "/v1/webhooks";

    const r = await fetch(url, {
      headers: {
        Authorization: adversusAuthHeader(),
        Accept: "application/json"
      }
    });

    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (e) {
      body = { raw: text };
    }

    return res
      .status(r.ok ? 200 : r.status)
      .json({ ok: r.ok, status: r.status, url: url, body: body });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: String((err && err.message) || err) });
  }
});

// ---- Start server (Render needs us to bind to process.env.PORT)
app.listen(PORT, function () {
  console.log("Gavdash API listening on " + PORT);
});
