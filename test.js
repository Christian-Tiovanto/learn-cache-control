// test.js - boots the origin + proxy on spare ports and checks every scenario.
// Run with:  npm test
const { spawn } = require('child_process');

const ORIGIN_PORT = 3100;
const PROXY_PORT = 4100;
const ORIGIN = `http://localhost:${ORIGIN_PORT}`;
const PROXY = `http://localhost:${PROXY_PORT}`;

const env = { ...process.env, ORIGIN_PORT, PROXY_PORT, ORIGIN_URL: ORIGIN };
const children = [
  spawn('node', ['server.js'], { env, stdio: 'ignore' }),
  spawn('node', ['cache-proxy.js'], { env, stdio: 'ignore' }),
];
const stop = () => children.forEach((c) => c.kill());
process.on('exit', stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

async function viaProxy(path, requestCC) {
  const r = await fetch(PROXY + path, requestCC ? { headers: { 'cache-control': requestCC } } : undefined);
  let body = null;
  try { body = await r.json(); } catch (e) { /* no body */ }
  return { status: r.status, xcache: r.headers.get('x-cache') || '', body };
}
const advance = (s) => fetch(`${PROXY}/__advance?seconds=${s}`);
const reset = () => fetch(`${PROXY}/__reset`);
const post = (path) => fetch(ORIGIN + path, { method: 'POST' });

async function waitUntilUp() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${ORIGIN}/api/status`);
      await fetch(`${PROXY}/__store`);
      return;
    } catch (e) {
      await sleep(100);
    }
  }
  throw new Error('servers did not start');
}

async function main() {
  await waitUntilUp();

  console.log('\n1) Headers sent by the origin');
  const headerOf = async (p) => (await fetch(ORIGIN + p)).headers;
  let h = await headerOf('/api/products');
  check('products: public, max-age=3600', h.get('cache-control') === 'public, max-age=3600');
  check('products: has Expires fallback', Boolean(h.get('expires')));
  h = await headerOf('/api/user/profile');
  check('profile: private, max-age=300', h.get('cache-control') === 'private, max-age=300');
  h = await headerOf('/api/inventory');
  check('inventory: public, max-age=0, must-revalidate', h.get('cache-control') === 'public, max-age=0, must-revalidate');
  check('inventory: has ETag', Boolean(h.get('etag')));
  h = await headerOf('/api/user/payment-methods');
  check('payment-methods: starts with no-store', h.get('cache-control').startsWith('no-store'));
  check('payment-methods: Pragma no-cache + Expires 0', h.get('pragma') === 'no-cache' && h.get('expires') === '0');
  h = await headerOf('/api/trending');
  check('trending: max-age=60 + stale-while-revalidate=3600', h.get('cache-control') === 'public, max-age=60, stale-while-revalidate=3600');
  h = await headerOf('/api/status');
  check('status: max-age=300 + stale-if-error=86400', h.get('cache-control') === 'public, max-age=300, stale-if-error=86400');

  console.log('\n2) ETag and 304 (talking to the origin directly, like a browser revalidating)');
  const r1 = await fetch(`${ORIGIN}/api/inventory`);
  const etag1 = r1.headers.get('etag');
  // (max-age=0 = a normal revalidation; Node's fetch would add "no-cache", which forces a full 200)
  const cond = (etag) => ({ headers: { 'if-none-match': etag, 'cache-control': 'max-age=0' } });
  const r2 = await fetch(`${ORIGIN}/api/inventory`, cond(etag1));
  check('same ETag sent back -> 304 Not Modified', r2.status === 304);
  check('304 has an empty body', (await r2.text()) === '');
  await post('/admin/sell');
  const r3 = await fetch(`${ORIGIN}/api/inventory`, cond(etag1));
  check('after stock changes, old ETag -> 200 with new data', r3.status === 200);
  check('new ETag differs from old one', r3.headers.get('etag') !== etag1);

  console.log('\n3) /api/products through the shared cache (max-age=3600)');
  await reset();
  let a = await viaProxy('/api/products');
  check('1st request is a MISS', a.xcache.startsWith('MISS'));
  let b = await viaProxy('/api/products');
  check('2nd request is a HIT with identical data (origin not contacted)', b.xcache === 'HIT' && b.body.originHit === a.body.originHit);
  await advance(3599);
  let c = await viaProxy('/api/products');
  check('at +3599s still a HIT', c.xcache === 'HIT');
  await advance(2);
  let d = await viaProxy('/api/products');
  check('at +3601s expired -> revalidated, new data from origin', d.xcache.startsWith('REVALIDATED') && d.body.originHit > a.body.originHit);

  console.log('\n4) private and no-store responses are never stored by a shared cache');
  await reset();
  a = await viaProxy('/api/user/profile');
  b = await viaProxy('/api/user/profile');
  check('profile (private): BYPASS both times, origin hit twice', a.xcache.startsWith('BYPASS') && b.xcache.startsWith('BYPASS') && b.body.originHit > a.body.originHit);
  a = await viaProxy('/api/user/payment-methods');
  b = await viaProxy('/api/user/payment-methods');
  check('payment-methods (no-store): BYPASS both times, origin hit twice', a.xcache.startsWith('BYPASS') && b.xcache.startsWith('BYPASS') && b.body.originHit > a.body.originHit);

  console.log('\n5) /api/inventory (max-age=0, must-revalidate + ETag)');
  await reset();
  a = await viaProxy('/api/inventory');
  check('1st request is a MISS', a.xcache.startsWith('MISS'));
  b = await viaProxy('/api/inventory');
  check('2nd request asks the origin and gets 304, copy reused', b.xcache.includes('304'));
  await post('/admin/sell');
  c = await viaProxy('/api/inventory');
  check('after a sale: revalidated with NEW data', c.xcache.includes('new content') && c.body.widget === b.body.widget - 1);

  console.log('\n6) /api/trending (max-age=60, stale-while-revalidate=3600)');
  await reset();
  a = await viaProxy('/api/trending');
  check('1st request is a MISS', a.xcache.startsWith('MISS'));
  await advance(30);
  b = await viaProxy('/api/trending');
  check('at +30s fresh HIT, same data', b.xcache === 'HIT' && b.body.originHit === a.body.originHit);
  await advance(60); // now +90s: stale but inside the 3600s window
  c = await viaProxy('/api/trending');
  check('at +90s: old copy served instantly (STALE)', c.xcache.startsWith('STALE') && c.body.originHit === a.body.originHit);
  await sleep(300); // let the background refresh finish
  d = await viaProxy('/api/trending');
  check('next request: the refreshed copy REPLACED the old one (fresh HIT, newer data)', d.xcache === 'HIT' && d.body.originHit > a.body.originHit);
  await advance(4000); // far beyond max-age + stale window
  const e = await viaProxy('/api/trending');
  check('after 4000 more seconds: too old, must wait for origin (REVALIDATED)', e.xcache.startsWith('REVALIDATED'));

  console.log('\n7) /api/status (max-age=300, stale-if-error=86400)');
  await reset();
  a = await viaProxy('/api/status');
  check('1st request is a MISS', a.xcache.startsWith('MISS'));
  await advance(301);
  await post('/admin/fail/on');
  b = await viaProxy('/api/status');
  check('stale + origin down (503): old copy served (STALE-IF-ERROR), user sees 200', b.xcache.startsWith('STALE-IF-ERROR') && b.status === 200 && b.body.originHit === a.body.originHit);
  await advance(86500);
  c = await viaProxy('/api/status');
  check('after the 1-day allowance: the 503 error reaches the user', c.status === 503);
  await post('/admin/fail/off');
  d = await viaProxy('/api/status');
  check('origin recovered: revalidated with new data', d.status === 200 && d.xcache.startsWith('REVALIDATED'));


  console.log('\n8) REQUEST directives: the client changes the decision for its own request');
  // Setup: /api/products stored with max-age=3600, now 1200s old (still fresh for the server)
  await reset();
  a = await viaProxy('/api/products');
  await advance(1200);
  b = await viaProxy('/api/products');
  check('no request directive: HIT (1200s < 3600s)', b.xcache === 'HIT' && b.body.originHit === a.body.originHit);
  c = await viaProxy('/api/products', 'max-age=1800');
  check('request max-age=1800: copy is 1200s old, accepted -> HIT', c.xcache === 'HIT');
  d = await viaProxy('/api/products', 'max-age=600');
  check('request max-age=600: copy too old for this client -> checked with origin', d.xcache.startsWith('REVALIDATED') && d.xcache.includes('max-age=600'));
  let f = await viaProxy('/api/products');
  check('next normal request: HIT on the copy refreshed by the max-age=600 request', f.xcache === 'HIT' && f.body.originHit === d.body.originHit);
  let g = await viaProxy('/api/products', 'no-cache');
  check('request no-cache: fresh copy exists but origin is contacted anyway', g.xcache.startsWith('REVALIDATED') && g.xcache.includes('no-cache'));
  let k = await viaProxy('/api/products');
  check('other users unaffected: next normal request is a HIT', k.xcache === 'HIT');
  await advance(3000); // copy now 3000s old -> 600s freshness left
  let m = await viaProxy('/api/products', 'min-fresh=900');
  check('request min-fresh=900: only 600s freshness left -> checked with origin', m.xcache.startsWith('REVALIDATED') && m.xcache.includes('min-fresh'));

  console.log('\n9) max-stale, only-if-cached, no-store (request side)');
  await reset();
  a = await viaProxy('/api/products');
  await advance(3700); // 100s past max-age
  b = await viaProxy('/api/products', 'max-stale=600');
  check('request max-stale=600: 100s-stale copy accepted, origin NOT contacted', b.xcache.startsWith('STALE (client allowed') && b.body.originHit === a.body.originHit);
  c = await viaProxy('/api/products', 'max-stale=50');
  check('request max-stale=50: 100s stale is too much -> checked with origin', c.xcache.startsWith('REVALIDATED'));
  await reset();
  a = await viaProxy('/api/inventory');
  b = await viaProxy('/api/inventory', 'max-stale');
  check('max-stale is refused when the SERVER said must-revalidate (inventory)', b.xcache.startsWith('REVALIDATED'));
  await reset();
  c = await viaProxy('/api/products', 'only-if-cached');
  check('only-if-cached with nothing stored -> 504, origin not contacted', c.status === 504);
  a = await viaProxy('/api/products');
  await advance(99999);
  d = await viaProxy('/api/products', 'only-if-cached');
  check('only-if-cached returns even a very stale copy', d.status === 200 && d.body.originHit === a.body.originHit);
  await reset();
  a = await viaProxy('/api/products', 'no-store');
  check('request no-store: fetched from origin but NOT stored', a.xcache.startsWith('BYPASS (request no-store'));
  b = await viaProxy('/api/products');
  check('so the next request is still a MISS', b.xcache.startsWith('MISS'));

  console.log('\n10) A cache that IGNORES request directives (CDN-style origin protection)');
  await reset();
  a = await viaProxy('/api/products');
  await fetch(`${PROXY}/__config?ignoreRequest=1`);
  b = await viaProxy('/api/products', 'no-cache');
  check('request no-cache ignored -> HIT, origin not contacted', b.xcache === 'HIT' && b.body.originHit === a.body.originHit);
  await reset();

  console.log('\n11) Express itself: no-cache vs max-age=0 on a conditional request');
  const et = (await fetch(`${ORIGIN}/api/inventory`)).headers.get('etag');
  const withMaxAge0 = await fetch(`${ORIGIN}/api/inventory`, { headers: { 'if-none-match': et, 'cache-control': 'max-age=0' } });
  check('If-None-Match + max-age=0 -> 304 (cheap)', withMaxAge0.status === 304);
  const withNoCache = await fetch(`${ORIGIN}/api/inventory`, { headers: { 'if-none-match': et, 'cache-control': 'no-cache' } });
  check('If-None-Match + no-cache -> full 200 (Express treats no-cache as "send everything")', withNoCache.status === 200);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  stop();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  stop();
  process.exit(1);
});
