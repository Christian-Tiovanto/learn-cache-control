# Cache-Control demo (Express)

Reproduce and watch every caching behavior from both sides of `Cache-Control`:

- **Response directives** (set by your server): `public/private`, `max-age`, `no-store`,
  `must-revalidate + ETag (304)`, `stale-while-revalidate`, `stale-if-error`.
- **Request directives** (set by the client): `no-cache`, `max-age`, `min-fresh`, `max-stale`,
  `only-if-cached`, `no-store`, plus what a real browser sends for each `fetch()` cache mode.

## Files

| File | What it is |
|---|---|
| `server.js` | The **origin**: your 6 endpoints, unchanged, plus a request log and two demo controls |
| `cache-proxy.js` | A tiny **shared cache** (a CDN in miniature) with a **virtual clock**. Follows response AND request directives |
| `docker-compose.yml`, `Dockerfile`, `nginx.docker.conf` | Run the origin + a **real nginx** reverse proxy in Docker (Part 3) |
| `nginx.conf` | The same nginx setup for nginx installed directly on your machine |
| `demo.html` | Browser page (served at `http://localhost:4000/demo`) that sends request directives from a real browser |
| `test.js` | Automated check of every scenario (`npm test`, 48 checks) |

Why the proxy? Browsers don't reliably support `stale-while-revalidate` / `stale-if-error`,
and nobody wants to wait 3,600 seconds. The proxy follows the same rules as a CDN and lets
you jump time forward. It is a teaching tool, not a real CDN.

## Setup

```bash
npm install
npm test          # optional: boots everything on spare ports, runs 48 checks
```

Then use **two terminals**:

```bash
# Terminal 1 - the origin (watch this log: a line appears ONLY when a request reaches the server)
npm run origin

# Terminal 2 - the cache proxy (logs HIT / MISS / STALE / ...)
npm run proxy
```

Origin = `http://localhost:3000`. Through the cache = `http://localhost:4000`.
The origin log now also prints the **request** `Cache-Control` it received, so you can see what
arrived at the server. Always reset between experiments:

```bash
curl -s localhost:4000/__reset
```

Handy: `-i` shows headers. This shows only the interesting ones:

```bash
show() { curl -si "$@" | tr -d '\r' | grep -iE '^(HTTP|cache-control|etag|x-cache|age)|originHit|widget'; }
```

## 1. `/api/products`: `public, max-age=3600`

```bash
curl -s localhost:4000/__reset
show localhost:4000/api/products      # X-Cache: MISS   (origin log: 1 line)
show localhost:4000/api/products      # X-Cache: HIT    (origin log: NO new line, same originHit)
curl -s "localhost:4000/__advance?seconds=3700"    # fast-forward 61 min
show localhost:4000/api/products      # REVALIDATED, new originHit
```

## 2. `/api/user/profile` and `/api/user/payment-methods`: never stored by a shared cache

```bash
curl -s localhost:4000/__reset
show localhost:4000/api/user/profile            # X-Cache: BYPASS (private)
show localhost:4000/api/user/profile            # BYPASS again, originHit goes up
show localhost:4000/api/user/payment-methods    # BYPASS (no-store)
```

`private, max-age=300` only lets the **browser** keep it. Try it in a browser (see the last section).

## 3. `/api/inventory`: `max-age=0, must-revalidate` + ETag

Directly against the origin (what a browser does when revalidating):

```bash
ET=$(curl -si localhost:3000/api/inventory | grep -i '^etag' | awk '{print $2}' | tr -d '\r')
curl -si -H "If-None-Match: $ET" localhost:3000/api/inventory   # 304 Not Modified, empty body
curl -s -X POST localhost:3000/admin/sell                        # stock changes
curl -si -H "If-None-Match: $ET" localhost:3000/api/inventory   # 200 + new data + new ETag
```

Through the cache:

```bash
curl -s localhost:4000/__reset
show localhost:4000/api/inventory   # MISS
show localhost:4000/api/inventory   # REVALIDATED (origin said 304, stored copy reused)
curl -s -X POST localhost:3000/admin/sell
show localhost:4000/api/inventory   # REVALIDATED (origin sent new content), widget is 1 lower
```

Note the origin log: every request reaches it, but unchanged ones answer `304` with no body.

## 4. `/api/trending`: `max-age=60, stale-while-revalidate=3600`

```bash
curl -s localhost:4000/__reset
show localhost:4000/api/trending                    # MISS (note originHit, e.g. 1)
curl -s "localhost:4000/__advance?seconds=30"
show localhost:4000/api/trending                    # HIT, same originHit
curl -s "localhost:4000/__advance?seconds=60"       # now +90s: stale, but inside the 3600s window
show localhost:4000/api/trending                    # STALE: OLD copy (same originHit), served instantly
sleep 1
show localhost:4000/api/trending                    # HIT: the refreshed copy replaced the old one (higher originHit)
curl -s "localhost:4000/__advance?seconds=4000"     # way past 60 + 3600
show localhost:4000/api/trending                    # REVALIDATED: this request had to wait for the origin
```

The proxy log prints `STALE ... serve old copy, refresh in background` and then
`BG ... new copy REPLACED the old one`. There is only ever **one** stored copy.

## 5. `/api/status`: `max-age=300, stale-if-error=86400`

```bash
curl -s localhost:4000/__reset
show localhost:4000/api/status                      # MISS
curl -s "localhost:4000/__advance?seconds=301"      # now stale
curl -s -X POST localhost:3000/admin/fail/on        # simulate an outage (origin now returns 503)
show localhost:4000/api/status                      # STALE-IF-ERROR: user still gets 200 + the old "ok"
curl -s "localhost:4000/__advance?seconds=86500"    # past the 1-day allowance
show localhost:4000/api/status                      # the 503 finally reaches the user
curl -s -X POST localhost:3000/admin/fail/off       # recover
show localhost:4000/api/status                      # REVALIDATED, fresh data
```

This also shows the risk: for up to a day, users saw "ok" while the system was down.

---

# Part 2: Request directives (the client's side)

Part 1 was about **your server's rules** (response directives). Part 2 is about the **client's wishes**
(request directives). Rule of thumb: the server decides what may be stored and for how long; the client
can only make it **stricter for its own request**, except `max-stale` / `only-if-cached`, which accept older data.

All examples use `/api/products` (response: `public, max-age=3600`). The `-H` flag plays the role of the browser.

> Note: `/api/products` puts `originHit` and `generatedAt` in the body, so every trip to the origin
> returns new content (200). That's deliberate: it makes each origin visit visible.

## 6. Request `max-age=N`: "only give me a copy at most N seconds old"

```bash
curl -s localhost:4000/__reset
show localhost:4000/api/products                              # MISS, stored
curl -s "localhost:4000/__advance?seconds=1200"               # copy is now 20 min old (still fresh for the server)
show localhost:4000/api/products                              # HIT  (no request directive)
show -H "Cache-Control: max-age=1800" localhost:4000/api/products   # HIT  (1200s <= 1800s, client is fine)
show -H "Cache-Control: max-age=600"  localhost:4000/api/products   # REVALIDATED (client wants <= 600s)
show localhost:4000/api/products                              # HIT on the copy that request refreshed
```

X-Cache shows the reason, e.g. `REVALIDATED (...; reason: request max-age=600 but copy is 1200s old)`.

## 7. Request `no-cache`: "check with the server before giving me anything"

```bash
curl -s localhost:4000/__reset
show localhost:4000/api/products                               # MISS
show -H "Cache-Control: no-cache" localhost:4000/api/products  # REVALIDATED (reason: request no-cache), origin log +1
show localhost:4000/api/products                               # HIT: other users are not affected
```

The fresh copy existed, but this client refused it without a check. The response it got is stored as
usual (your response directives still decide storing), so the next normal request is a HIT.

## 8. Request `min-fresh=N`: "the copy must stay fresh for at least N more seconds"

```bash
curl -s localhost:4000/__reset
show localhost:4000/api/products
curl -s "localhost:4000/__advance?seconds=3000"                # 600s of freshness left
show -H "Cache-Control: min-fresh=300" localhost:4000/api/products   # HIT (600 >= 300)
show -H "Cache-Control: min-fresh=900" localhost:4000/api/products   # REVALIDATED (600 < 900)
```

## 9. Request `max-stale=N`: "I accept a copy up to N seconds past its expiry"

```bash
curl -s localhost:4000/__reset
show localhost:4000/api/products
curl -s "localhost:4000/__advance?seconds=3700"                # 100s past max-age: stale
show -H "Cache-Control: max-stale=50"  localhost:4000/api/products   # REVALIDATED (100 > 50)
curl -s localhost:4000/__reset; show localhost:4000/api/products; curl -s "localhost:4000/__advance?seconds=3700"
show -H "Cache-Control: max-stale=600" localhost:4000/api/products   # STALE (client allowed it), origin NOT contacted
```

The server can overrule this: `/api/inventory` says `must-revalidate`, so `max-stale` is refused there:

```bash
curl -s localhost:4000/__reset
show localhost:4000/api/inventory
show -H "Cache-Control: max-stale" localhost:4000/api/inventory      # REVALIDATED anyway
```

## 10. Request `only-if-cached`: "don't contact the server at all"

```bash
curl -s localhost:4000/__reset
show -H "Cache-Control: only-if-cached" localhost:4000/api/products  # 504: nothing stored
show localhost:4000/api/products                                     # MISS, stored
curl -s "localhost:4000/__advance?seconds=99999"
show -H "Cache-Control: only-if-cached" localhost:4000/api/products  # 200: the very stale copy, origin untouched
```

## 11. Request `no-store`: "don't store what you get me"

```bash
curl -s localhost:4000/__reset
show -H "Cache-Control: no-store" localhost:4000/api/products   # BYPASS (request no-store: fetched, not stored)
show localhost:4000/api/products                                # MISS: nothing was stored
```

(The spec only forbids *storing*. This demo also skips any stored copy, to keep the result obvious.)

## 12. A cache that ignores request directives

A CDN can be configured to ignore client request directives to protect the origin. Simulate that:

```bash
curl -s localhost:4000/__reset
show localhost:4000/api/products
curl -s "localhost:4000/__config?ignoreRequest=1"
show -H "Cache-Control: no-cache" localhost:4000/api/products   # HIT: the client's wish is ignored
curl -s localhost:4000/__reset                                  # reset also turns this back off
```

## 13. Express: `no-cache` vs `max-age=0` on a conditional request

```bash
ET=$(curl -si localhost:3000/api/inventory | grep -i '^etag' | awk '{print $2}' | tr -d '\r')
curl -si -H "If-None-Match: $ET" -H "Cache-Control: max-age=0" localhost:3000/api/inventory | head -1   # 304
curl -si -H "If-None-Match: $ET" -H "Cache-Control: no-cache"  localhost:3000/api/inventory | head -1   # 200
```

Same ETag, different request directive, different answer. A normal reload sends `max-age=0` (cheap 304);
a force reload sends `no-cache` (full 200 from Express).

## 14. From a real browser: `http://localhost:4000/demo`

Open the page (served by the proxy, so browser + proxy + origin are all in the path). Each button makes
one `fetch()`. The table says which layer answered: **browser cache**, **proxy**, or **origin**, and
which request `Cache-Control` the proxy actually received.

The fetch `cache` option makes the browser write the request directive for you (Fetch spec):

| fetch option | Request header the browser sends | Browser's own cache |
|---|---|---|
| `cache: "default"` | none | used normally |
| `cache: "no-cache"` | `Cache-Control: max-age=0` | must check with server first |
| `cache: "reload"` | `Cache-Control: no-cache` (+ `Pragma: no-cache`) | skipped, response stored |
| `cache: "no-store"` | `Cache-Control: no-cache` (+ `Pragma: no-cache`) | skipped, nothing stored |
| `cache: "force-cache"` | none | any stored copy used, even stale |

Try this sequence on `/api/products`:

1. `default` → Origin (MISS).
2. `default` again → **Browser cache**: the request never left the browser, the proxy log shows nothing.
3. `no-cache` → proxy saw `max-age=0` → answered by the proxy or origin, not the browser.
4. `reload` → proxy saw `no-cache` → origin contacted.
5. Custom header `max-age=600`, then "+1 h", then `default` → watch the layers change.

The same Fetch rule explains the surprise from earlier: when you add `If-None-Match` yourself with
cache mode `default`, fetch switches to `no-store` mode and adds `Cache-Control: no-cache`. That's why
Node's fetch got a 200 instead of a 304 until the demo set `max-age=0` explicitly.

---

# Part 3: Use a REAL reverse proxy (nginx in Docker) instead of `cache-proxy.js`

`cache-proxy.js` exists only because it has a **virtual clock** and explains every decision in
`X-Cache`. For anything real, use a real reverse proxy. Docker runs the origin **and** nginx for you,
so you don't install nginx or Node.

```
Browser / curl  -->  nginx (localhost:4000)  -->  origin (server.js, inside the Docker network)
```

## Run it

You need Docker with Compose (Docker Desktop on Windows/macOS, or Docker Engine on Linux). From this folder:

```bash
docker compose up --build
```

Both containers log into this terminal: lines starting with `origin-1` are your Express server
(it only logs when a request reaches it), and lines starting with `nginx-1` show what the cache did:
`GET /api/products ... cache=HIT`.

Stop with Ctrl+C, then `docker compose down`.

Nginx has no virtual clock, so the compose file shrinks every lifetime 30x
(`TTL_DIVISOR=30`): products 120 s, trending 2 s + a 120 s stale window, status 10 s + 96 min.
For your real values: `TTL_DIVISOR=1 docker compose up --build` (Windows PowerShell: `$env:TTL_DIVISOR=1; docker compose up --build`).

## Experiments (a second terminal)

```bash
show() { curl -si "$@" | tr -d '\r' | grep -iE '^(HTTP|x-cache-status)|originHit'; }

show localhost:4000/api/products     # X-Cache-Status: MISS
show localhost:4000/api/products     # HIT (no new "origin-1" log line)

show localhost:4000/api/trending     # MISS
show localhost:4000/api/trending     # HIT
sleep 3
show localhost:4000/api/trending     # STALE: old copy, refreshed in the background
show localhost:4000/api/trending     # HIT with a newer originHit
```

Port 3000 is published only so you can use the demo switches and hit the origin directly:

```bash
curl -X POST localhost:3000/admin/fail/on     # origin now answers /api/status with 503
curl -X POST localhost:3000/admin/fail/off
curl -X POST localhost:3000/admin/sell        # change inventory
```

To test `stale-if-error` with an **unreachable** origin:

```bash
show localhost:4000/api/status       # MISS
sleep 11                             # past max-age (10 s)
docker compose stop origin
show localhost:4000/api/status       # STALE: old copy served, the origin is down
docker compose start origin
docker compose restart nginx         # nginx looks up "origin" only at startup, so refresh it after the container restarts
```

## Files

- `docker-compose.yml`: the two services (`origin` built from `Dockerfile`, `nginx` from the official `nginx:1.27-alpine` image).
- `nginx.docker.conf`: mounted read-only as `/etc/nginx/nginx.conf`. It reaches the origin as `http://origin:3000` (the compose service name).
- `nginx.conf`: the same setup for nginx installed directly on your machine (`nginx -p "$(pwd)" -c nginx.conf`, with `TTL_DIVISOR=30 npm run origin`).

## What was tested with nginx 1.24 (and how it differs from the demo proxy)

| Behavior | Real nginx |
|---|---|
| `public, max-age=N` | Stored, HIT until N seconds pass |
| `private`, `no-store` | Not stored (every request reaches the origin) |
| `max-age=0` (`/api/inventory`) | Not stored, so no 304 revalidation either |
| `stale-while-revalidate` | Works (STALE, then a background refresh) with `proxy_cache_background_update on` |
| `stale-if-error`, origin unreachable | Works, and the time window is respected |
| `stale-if-error`, origin answers 503 | **Not applied.** Needs `proxy_cache_use_stale ... http_503`, which ignores the time window |
| Client `no-cache` / `max-age=0` request | **Ignored** (HIT anyway) |

So: the headers work on a real cache, but real caches have their own switches and limits, and
reading the documentation of your specific cache matters.

## Peek inside the cache

```bash
curl -s localhost:4000/__store      # what is stored, how old, with which Cache-Control
```

## Testing the browser cache (private cache)

(Or use the page from section 14.) Open `http://localhost:3000` (a 404 page is fine), open DevTools, and run this in the **Console**:

```js
const t = () => fetch('/api/products').then(r => r.json()).then(j => console.log(j.originHit, j.generatedAt));
t(); setTimeout(t, 1000);
```

Both lines print the **same** `originHit` (the second came from the browser cache), and the origin
log shows one request. Do the same with `/api/trending`, `/api/user/profile` (cached for 5 min by the
browser) and `/api/user/payment-methods` (a new request every time).

Gotchas:
- **Hard reload** (Ctrl+Shift+R) makes the browser send `Cache-Control: no-cache`, which forces a full
  response and bypasses everything above. Use the console snippet or normal navigation to test.
- In DevTools > Network, untick **Disable cache**, or you'll never see a cache hit.

## Real CDN later

The same headers work unchanged on CloudFront, Fastly, etc. Point the frontend at the CDN domain instead
of the proxy. Only the cache policy (TTL limits, cache key) is configured on the CDN side.
#   l e a r n - c a c h e - c o n t r o l  
 