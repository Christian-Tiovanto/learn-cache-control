// cache-proxy.js - a TINY shared cache (think "CloudFront in miniature") for learning.
//
// It follows BOTH sides of Cache-Control:
//   * RESPONSE directives from server.js  (public, private, max-age, no-store,
//     must-revalidate, stale-while-revalidate, stale-if-error)
//   * REQUEST directives from the client  (no-cache, no-store, max-age, min-fresh,
//     max-stale, only-if-cached)
//
// It has a VIRTUAL CLOCK so you don't have to wait:   curl "localhost:4000/__advance?seconds=90"
// It can pretend to be a CDN that IGNORES request directives: curl "localhost:4000/__config?ignoreRequest=1"
//
// Simplified teaching tool, NOT a real CDN (GET only, no Vary, no request collapsing...).

const http = require('http');
const fs = require('fs');
const path = require('path');

const ORIGIN = process.env.ORIGIN_URL || 'http://localhost:3000';
const PORT = process.env.PROXY_PORT || 4000;

// ---- state -----------------------------------------------------------------
let clockOffsetMs = 0;
const now = () => Date.now() + clockOffsetMs;
let ignoreRequestDirectives = false;
let requestNo = 0;                 // counts requests that reached THIS proxy
const store = new Map();           // url -> { status, headers, body, storedAt }
const revalidating = new Set();

const log = (msg) => console.log(`[PROXY] ${msg}`);

function parseCC(header = '') {
  const out = {};
  for (const part of String(header).split(',')) {
    const [k, v] = part.trim().toLowerCase().split('=');
    if (k) out[k] = v === undefined ? true : Number(v);
  }
  return out;
}

// Response side: may a SHARED cache store it?
const isStorable = (cc) =>
  !cc['no-store'] && !cc.private && (cc['s-maxage'] !== undefined || cc['max-age'] !== undefined);
const lifetime = (cc) => cc['s-maxage'] ?? cc['max-age'] ?? 0;
const whyNotStored = (r, cc) =>
  cc.private ? 'response private' : cc['no-store'] ? 'response no-store' : r.status !== 200 ? `status ${r.status}` : 'no lifetime given';

async function fetchOrigin(url, etag) {
  const headers = {};
  if (etag) {
    headers['if-none-match'] = etag;
    // A normal revalidation says max-age=0. Without this, Node's fetch turns a request that has
    // If-None-Match into cache mode "no-store" and adds "Cache-Control: no-cache" (Fetch spec),
    // and Express answers no-cache with a full 200 instead of 304.
    headers['cache-control'] = 'max-age=0';
  }
  const r = await fetch(ORIGIN + url, { headers });
  return { status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) };
}

function send(res, status, headers, body, xcache, ageSec, reqCCRaw) {
  const h = { ...headers };
  delete h.connection; delete h['keep-alive']; delete h['transfer-encoding'];
  h['x-cache'] = xcache;
  h['x-proxy-request-no'] = String(requestNo);                 // lets the browser page detect browser-cache hits
  h['x-proxy-saw-request-cache-control'] = reqCCRaw || '(none)'; // what request directive the proxy received
  h['access-control-expose-headers'] = 'x-cache, x-proxy-request-no, x-proxy-saw-request-cache-control, age';
  if (ageSec !== undefined) h.age = String(Math.floor(ageSec));
  res.writeHead(status, h);
  res.end(body);
}

const store200 = (url, r) => store.set(url, { status: r.status, headers: r.headers, body: r.body, storedAt: now() });

// ---- main decision ---------------------------------------------------------
async function handleGet(req, res, url) {
  const raw = req.headers['cache-control'] || (req.headers.pragma === 'no-cache' ? 'no-cache (from Pragma)' : '');
  const reqCC = ignoreRequestDirectives ? {} : parseCC(raw.replace(' (from Pragma)', ''));
  const S = (status, headers, body, xcache, age) => send(res, status, headers, body, xcache, age, raw);
  if (raw) log(`request for ${url} carries Cache-Control: ${raw}${ignoreRequestDirectives ? '  (IGNORED: ignoreRequest mode)' : ''}`);

  const entry = store.get(url);

  // REQUEST only-if-cached: never contact the origin
  if (reqCC['only-if-cached']) {
    if (entry) {
      const age = (now() - entry.storedAt) / 1000;
      log(`ONLYCACHE ${url} -> stored copy returned without contacting origin (age ${Math.floor(age)}s, even if stale)`);
      return S(entry.status, entry.headers, entry.body, 'HIT (request only-if-cached)', age);
    }
    log(`ONLYCACHE ${url} -> nothing stored -> 504`);
    return S(504, { 'content-type': 'application/json' }, JSON.stringify({ error: 'only-if-cached and nothing is stored' }), 'MISS (request only-if-cached: 504)');
  }

  // REQUEST no-store: go to origin, and do not store the answer
  if (reqCC['no-store']) {
    const r = await fetchOrigin(url);
    log(`NOSTORE ${url} -> fetched from origin, NOT stored, stored copy left untouched`);
    return S(r.status, r.headers, r.body, 'BYPASS (request no-store: fetched, not stored)');
  }

  if (!entry) return miss(url, S);

  const cc = parseCC(entry.headers['cache-control']);
  const ttl = lifetime(cc);
  const age = (now() - entry.storedAt) / 1000;
  const fresh = age < ttl;
  const serverForbidsStale = Boolean(cc['must-revalidate'] || cc['no-cache']);

  // Does the CLIENT reject the stored copy?
  const blockers = [];
  if (reqCC['no-cache']) blockers.push('request no-cache');
  if (reqCC['max-age'] !== undefined && age > reqCC['max-age']) blockers.push(`request max-age=${reqCC['max-age']} but copy is ${Math.floor(age)}s old`);
  if (reqCC['min-fresh'] !== undefined && ttl - age < reqCC['min-fresh']) blockers.push(`request min-fresh=${reqCC['min-fresh']} but copy has only ${Math.max(0, Math.floor(ttl - age))}s of freshness left`);

  if (blockers.length === 0) {
    // FRESH -> HIT
    if (fresh) {
      log(`HIT    ${url}  (age ${Math.floor(age)}s < max-age ${ttl}s${raw ? `, request ${raw} satisfied` : ''})`);
      return S(entry.status, entry.headers, entry.body, 'HIT', age);
    }
    // STALE, but client said "I accept stale" (max-stale)
    const ms = reqCC['max-stale'];
    if (ms !== undefined && !serverForbidsStale && (ms === true || age - ttl <= ms)) {
      log(`STALE  ${url}  copy is ${Math.floor(age - ttl)}s past max-age, client allows it (request max-stale${ms === true ? '' : '=' + ms}) -> served, origin not contacted`);
      return S(entry.status, entry.headers, entry.body, 'STALE (client allowed it via request max-stale)', age);
    }
    // STALE inside the server's stale-while-revalidate window
    const swr = cc['stale-while-revalidate'];
    if (!serverForbidsStale && swr !== undefined && age < ttl + swr) {
      log(`STALE  ${url}  (age ${Math.floor(age)}s, inside ${swr}s stale-while-revalidate) -> serve old copy, refresh in background`);
      S(entry.status, entry.headers, entry.body, 'STALE (old copy served, refreshing in background)', age);
      return backgroundRevalidate(url, entry);
    }
  }

  const reason = blockers.length ? blockers.join('; ') : `stale (age ${Math.floor(age)}s >= max-age ${ttl}s)`;
  return revalidate(url, entry, cc, age, reason, S);
}

async function revalidate(url, entry, cc, age, reason, S) {
  log(`CHECK  ${url}  reason: ${reason} -> asking origin${entry.headers.etag ? ' with If-None-Match' : ''}`);
  let r;
  try { r = await fetchOrigin(url, entry.headers.etag); } catch (e) { return originFailed(url, entry, cc, age, null, S); }
  if ([500, 502, 503, 504].includes(r.status)) return originFailed(url, entry, cc, age, r, S);

  if (r.status === 304) {
    entry.storedAt = now();
    if (r.headers['cache-control']) entry.headers['cache-control'] = r.headers['cache-control'];
    log(`REVAL  ${url}  origin said 304 -> reusing stored body, freshness restarted`);
    return S(entry.status, entry.headers, entry.body, `REVALIDATED (origin said 304; reason: ${reason})`, 0);
  }
  const newCC = parseCC(r.headers['cache-control']);
  if (r.status === 200 && isStorable(newCC)) {
    store200(url, r);
    log(`REVAL  ${url}  origin sent new content -> replaced stored copy`);
    return S(r.status, r.headers, r.body, `REVALIDATED (origin sent new content; reason: ${reason})`, 0);
  }
  store.delete(url);
  return S(r.status, r.headers, r.body, `BYPASS (${whyNotStored(r, newCC)})`);
}

async function miss(url, S) {
  let r;
  try { r = await fetchOrigin(url); } catch (e) {
    return S(502, { 'content-type': 'application/json' }, JSON.stringify({ error: 'origin unreachable and nothing cached' }), 'MISS (origin unreachable)');
  }
  const cc = parseCC(r.headers['cache-control']);
  if (r.status === 200 && isStorable(cc)) {
    store200(url, r);
    log(`MISS   ${url}  -> fetched from origin and stored`);
    return S(r.status, r.headers, r.body, 'MISS (fetched from origin, now stored)', 0);
  }
  log(`BYPASS ${url}  -> NOT stored (${whyNotStored(r, cc)})`);
  return S(r.status, r.headers, r.body, `BYPASS (not stored: ${whyNotStored(r, cc)})`);
}

function originFailed(url, entry, cc, age, r, S) {
  const sie = cc['stale-if-error'];
  const ttl = lifetime(cc);
  if (!cc['must-revalidate'] && sie !== undefined && age < ttl + sie) {
    log(`ERROR  ${url}  origin failed, inside ${sie}s stale-if-error window -> serve old copy`);
    return S(entry.status, entry.headers, entry.body, 'STALE-IF-ERROR (origin failed, old copy served)', age);
  }
  log(`ERROR  ${url}  origin failed, no stale-if-error allowance left -> passing the error through`);
  if (r) return S(r.status, r.headers, r.body, 'BYPASS (origin error passed through)');
  return S(502, { 'content-type': 'application/json' }, JSON.stringify({ error: 'origin unreachable' }), 'BYPASS (origin unreachable)');
}

async function backgroundRevalidate(url, entry) {
  if (revalidating.has(url)) return;
  revalidating.add(url);
  try {
    const r = await fetchOrigin(url, entry.headers.etag);
    if (r.status === 304) { entry.storedAt = now(); log(`BG     ${url}  background refresh: 304, freshness restarted`); }
    else if (r.status === 200 && isStorable(parseCC(r.headers['cache-control']))) { store200(url, r); log(`BG     ${url}  background refresh: new copy REPLACED the old one`); }
    else log(`BG     ${url}  background refresh got status ${r.status}, keeping old copy`);
  } catch (e) { log(`BG     ${url}  background refresh failed, keeping old copy`); }
  finally { revalidating.delete(url); }
}

// ---- server + control endpoints -------------------------------------------
const json = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj, null, 2)); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://proxy');

  if (u.pathname === '/demo' || u.pathname === '/demo.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(__dirname, 'demo.html')));
  }
  if (u.pathname === '/__advance') {
    clockOffsetMs += Number(u.searchParams.get('seconds') || 0) * 1000;
    log(`clock advanced; virtual time is now +${Math.round(clockOffsetMs / 1000)}s`);
    return json(res, { virtualOffsetSeconds: Math.round(clockOffsetMs / 1000) });
  }
  if (u.pathname === '/__reset') {
    store.clear(); clockOffsetMs = 0; ignoreRequestDirectives = false;
    log('cache emptied, clock reset, request directives honored again');
    return json(res, { ok: true });
  }
  if (u.pathname === '/__config') {
    if (u.searchParams.has('ignoreRequest')) ignoreRequestDirectives = u.searchParams.get('ignoreRequest') === '1';
    log(`request directives are now ${ignoreRequestDirectives ? 'IGNORED (like a CDN configured to protect the origin)' : 'honored'}`);
    return json(res, { ignoreRequestDirectives });
  }
  if (u.pathname === '/__store') {
    return json(res, [...store.entries()].map(([url, e]) => ({
      url, ageSeconds: Math.floor((now() - e.storedAt) / 1000), cacheControl: e.headers['cache-control'],
    })));
  }

  if (req.method !== 'GET') { res.writeHead(405); return res.end('this demo proxy only handles GET'); }
  requestNo++;
  try { await handleGet(req, res, req.url); } catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(PORT, () => log(`listening on http://localhost:${PORT}  ->  origin ${ORIGIN}   (browser demo: http://localhost:${PORT}/demo)`));
