// swr-test.js - calls nginx once a second and prints what the cache did.
// Node's built-in fetch has no HTTP cache, so this shows ONLY nginx (no browser in the way).
//
//   node swr-test.js                      -> 60 requests to http://localhost:4000/api/trending
//   node swr-test.js <url> <count>        -> your own url / number of requests
//
// Needs Node 18+.

const URL_TO_TEST = process.argv[2] || "http://localhost:4000/api/trending";
const COUNT = Number(process.argv[3]) || 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const start = Date.now();
  console.log(`GET ${URL_TO_TEST}  (${COUNT} requests, one per second)\n`);
  console.log(
    "time   X-Cache-Status   answered in   data from origin request   data age",
  );

  for (let i = 0; i < COUNT; i++) {
    const t0 = Date.now();
    let line;
    try {
      const res = await fetch(URL_TO_TEST);
      const body = await res.json();
      const ms = Date.now() - t0;
      const age = Math.round(
        (Date.now() - Date.parse(body.generatedAt)) / 1000,
      );
      line =
        `${String(Math.round((t0 - start) / 1000)).padStart(3)}s   ` +
        `${(res.headers.get("x-cache-status") || "?").padEnd(14)}   ` +
        `${String(ms).padStart(7)} ms   ` +
        `#${String(body.originHit).padEnd(24)}   ${age} s`;
    } catch (e) {
      line = `${String(Math.round((t0 - start) / 1000)).padStart(3)}s   request failed: ${e.message}`;
    }
    console.log(line);
    await sleep(1000);
  }
})();
