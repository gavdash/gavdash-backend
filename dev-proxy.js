// dev-proxy.js — lokal udviklingsproxy, så din UI kan kalde backend uden at kende secret
// Kræver Node 18+ (har global fetch + AbortController)

import http from "node:http";
import { URL } from "node:url";

const PORT = process.env.PORT || 8080;
const BACKEND_BASE = process.env.BACKEND_BASE || "https://gavdash-backend.onrender.com";
const DEV_SECRET = process.env.DEV_SECRET || "testsecret123";

const server = http.createServer(async (req, res) => {
  // CORS for lokal udvikling (tillad alt)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  // Byg target-URL til din Render-backend (samme path + query)
  const target = new URL(req.url, BACKEND_BASE);

  // Kopiér indgående headers, men sæt vores secret-header på
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([k]) => k.toLowerCase() !== "host")
  );
  headers["x-adversus-secret"] = DEV_SECRET;

  const init = { method: req.method, headers };

  // Læs body hvis ikke GET/HEAD
  if (!["GET", "HEAD"].includes(req.method || "GET")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    init.body = Buffer.concat(chunks);
  }

  // Valgfrit: lille timeout så proxy ikke hænger
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  (init).signal = controller.signal;

  try {
    const r = await fetch(target, init);
    clearTimeout(t);

    // Viderefør content-type (CORS er sat ovenfor)
    const ct = r.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    res.statusCode = r.status;

    const buf = Buffer.from(await r.arrayBuffer());
    res.end(buf);
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Proxy error: " + (e?.message || e));
  }
});

server.listen(PORT, () => {
  console.log(`Dev proxy on http://localhost:${PORT} -> ${BACKEND_BASE}`);
});
