// server.js - the "origin" server: your Cache-Control config, plus small demo helpers
const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.ORIGIN_PORT || 3000;

// OPTIONAL, for testing with a real reverse proxy (which has no virtual clock):
// TTL_DIVISOR=30 shrinks every lifetime 30x (3600s -> 120s, 60s -> 2s, 300s -> 10s).
// Leave it unset and the headers are exactly the ones in your config.
const DIVISOR = Number(process.env.TTL_DIVISOR) || 1;
const T = (seconds) => Math.max(1, Math.round(seconds / DIVISOR));

// ---------------------------------------------------------------------------
// DEMO HELPERS (not part of the caching config; they only make it observable)
// ---------------------------------------------------------------------------
let hitCounter = 0; // how many /api requests really reached this server
let statusFailing = false; // flipped by POST /admin/fail/on|off to fake an outage
const inventoryData = { widget: 10, gadget: 5 };

// Log every /api request that reaches the origin. If a cache answers instead,
// you will NOT see a log line here. That is the whole point of caching.
// The same information is kept in memory (recent) so the browser page at /demo
// can show "what the origin server actually saw" next to "what the browser got".
const recent = [];
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  req.hitNo = ++hitCounter;
  const time = new Date().toISOString().slice(11, 19);
  const entry = {
    no: req.hitNo,
    time,
    method: req.method,
    url: req.originalUrl,
    status: null, // filled in when the response is sent
    ifNoneMatch: Boolean(req.get("if-none-match")),
    requestCacheControl: req.get("cache-control") || null,
    pragma: req.get("pragma") || null,
  };
  recent.push(entry);
  if (recent.length > 60) recent.shift();
  res.on("finish", () => {
    entry.status = res.statusCode;
    const cond = entry.ifNoneMatch ? "  If-None-Match sent" : "";
    const rcc = entry.requestCacheControl
      ? `  request Cache-Control: ${entry.requestCacheControl}`
      : "";
    console.log(
      `[ORIGIN #${req.hitNo}] ${time} ${req.method} ${req.originalUrl} -> ${res.statusCode}${cond}${rcc}`,
    );
  });
  next();
});

// Every payload carries originHit + generatedAt so you can tell a fresh
// response from a cached one just by looking at the JSON.
const payload = (req, data) => ({
  data,
  originHit: req.hitNo,
  generatedAt: new Date().toISOString(),
});

// Stand-ins for your real data layer
const getProducts = () => [
  { id: 1, name: "Keyboard" },
  { id: 2, name: "Mouse" },
];
const getUserProfile = (userId) => ({ id: userId, name: `User ${userId}` });
const getInventory = () => ({ ...inventoryData }); // no timestamp on purpose: body (and ETag) only change when stock changes
const getPaymentMethods = (userId) => [
  { owner: userId, brand: "VISA", last4: "4242" },
];
const getTrending = () => ["cats", "express", "caching"];
const getSystemStatus = () => ({ status: "ok" });

// Stand-in for real authentication: reads an "x-user-id" header (default user-1)
const authenticate = (req, res, next) => {
  req.userId = req.get("x-user-id") || "user-1";
  next();
};

// Strong ETag = quoted hash of the data
const generateETag = (data) =>
  '"' +
  crypto
    .createHash("sha1")
    .update(JSON.stringify(data))
    .digest("hex")
    .slice(0, 16) +
  '"';

// ---------------------------------------------------------------------------
// YOUR CACHING CONFIG (unchanged apart from payload() so the output is visible)
// ---------------------------------------------------------------------------

// Public cacheable response (can be cached by CDN, proxy, browser)
app.get("/api/products", (req, res) => {
  console.log("gad deym");
  res.set({
    // Cache for 1 hour, allow CDN/proxy caching
    // "Cache-Control": `public, max-age=${T(60)}`,
    "Cache-Control": `public, max-age=${T(60)}`,
    // Fallback for HTTP/1.0
    Expires: new Date(Date.now() + T(3600) * 1000).toUTCString(),
  });

  res.json(payload(req, getProducts()));
});

// Private cacheable response (browser only, not CDN/proxy)
app.get("/api/user/profile", authenticate, (req, res) => {
  res.set({
    // Cache for 5 minutes, browser only
    "Cache-Control": `private, max-age=${T(300)}`,
  });

  res.json(payload(req, getUserProfile(req.userId)));
});

// Revalidation required (check freshness before serving cached copy)
app.get("/api/inventory", (req, res) => {
  res.set({
    // Cache but always check with server first
    "Cache-Control": "public, max-age=0, must-revalidate",
    // ETag for conditional requests
    ETag: generateETag(inventoryData),
  });

  // Express compares If-None-Match with this ETag and turns the reply into a
  // 304 (empty body) automatically when they match.
  res.json(getInventory());
});

// No caching (sensitive data)
app.get("/api/user/payment-methods", authenticate, (req, res) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });

  res.json(payload(req, getPaymentMethods(req.userId)));
});

// Stale-while-revalidate (serve stale, update in background)
app.get("/api/trending", async (req, res) => {
  console.log(
    `[${new Date().toISOString()}] Request received for /api/trending`,
  );

  // Wait for 10 seconds to finish
  await new Promise((resolve) => {
    setTimeout(() => {
      console.log(`[${new Date().toISOString()}] Executed after 10 seconds`);
      resolve();
    }, 20000);
  });
  res.set({
    // Fresh for 60s, then serve stale for up to 1 hour while revalidating
    "Cache-Control": `public, max-age=${T(0)},s-maxage=5, stale-while-revalidate=${T(3600)}`,
  });

  res.json(payload(req, getTrending()));
});

// Stale-if-error (serve stale if origin fails)
app.get("/api/status", (req, res) => {
  // DEMO ONLY: simulate an outage so you can watch stale-if-error work
  if (statusFailing) {
    return res
      .status(503)
      .json({ error: "Service Unavailable (simulated outage)" });
  }

  res.set({
    // Fresh for 5 min, serve stale for 1 day if server errors
    "Cache-Control": `public, max-age=${T(300)}, stale-if-error=${T(86400)}`,
  });

  res.json(payload(req, getSystemStatus()));
});

// ---------------------------------------------------------------------------
// BROWSER TEST PAGE (talks to THIS server directly, no proxy in between)
// ---------------------------------------------------------------------------
app.get("/demo", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "origin-demo.html"));
});

// What the origin has seen so far. The page compares "total" before and after each
// click: if it did not move, the browser answered from its own cache.
app.get("/admin/requests", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ total: hitCounter, ttlDivisor: DIVISOR, statusFailing, recent });
});

// ---------------------------------------------------------------------------
// DEMO CONTROLS (POST, so nothing ever caches them)
// ---------------------------------------------------------------------------
app.post("/admin/fail/:state", (req, res) => {
  statusFailing = req.params.state === "on";
  console.log(
    `[ORIGIN] /api/status outage simulation: ${statusFailing ? "ON" : "OFF"}`,
  );
  res.json({ statusFailing });
});

app.post("/admin/sell", (req, res) => {
  inventoryData.widget = Math.max(0, inventoryData.widget - 1);
  console.log(`[ORIGIN] sold one widget, stock is now ${inventoryData.widget}`);
  res.json(inventoryData);
});

app.listen(PORT, () =>
  console.log(`[ORIGIN] listening on http://localhost:${PORT}`),
);
