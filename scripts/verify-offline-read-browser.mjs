import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer";

/**
 * A real Chromium/IndexedDB smoke test without a production ERP login.
 * It tests the storage layer and user-scope enforcement; server-side session
 * verification is covered separately and must remain mandatory in the app.
 */
const bundled = await build({
  entryPoints: [resolve("client/src/lib/offline/offlineReadCache.ts")],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  write: false,
  logLevel: "warning",
});
const js = bundled.outputFiles[0]?.text;
if (!js) throw new Error("OFFLINE_BROWSER_BUNDLE_MISSING");

const server = createServer((request, response) => {
  if (request.url === "/offline.mjs") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end(js);
  } else {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><html><body>Offline IndexedDB acceptance</body></html>");
  }
});
await new Promise((yes) => server.listen(0, "127.0.0.1", yes));
const address = server.address();
if (!address || typeof address === "string") throw new Error("OFFLINE_BROWSER_SERVER_UNAVAILABLE");

const browserPath = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
].find((candidate) => candidate && existsSync(candidate));
let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    executablePath: browserPath || puppeteer.executablePath(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load" });

  const initial = await page.evaluate(async () => {
    const cache = await import("/offline.mjs");
    const actor = { companyId: 8, userId: "operator-one" };
    cache.activateVerifiedOfflineReadScope(actor);
    await cache.saveVerifiedOfflineReadBatch({
      ...actor,
      total: 1,
      snapshots: [{ url: "/api/inventory", body: JSON.stringify([{ inventoryId: 17, quantity: "9" }]) }],
    });
    const hit = await cache.readPreparedOfflineResponse("GET", "/api/inventory");
    const miss = await cache.readPreparedOfflineResponse("GET", "/api/auth/me");
    return { payload: hit ? await hit.json() : null, mark: hit?.headers.get("X-ERP-Offline-Snapshot"), miss: miss === null };
  });
  assert.deepEqual(initial.payload, [{ inventoryId: 17, quantity: "9" }]);
  assert.equal(initial.mark, "1");
  assert.equal(initial.miss, true);

  await page.setOfflineMode(true);
  const offline = await page.evaluate(async () => {
    const cache = await import("/offline.mjs");
    const res = await cache.readPreparedOfflineResponse("GET", "/api/inventory");
    return res ? await res.json() : null;
  });
  assert.deepEqual(offline, initial.payload, "Offline IndexedDB read must work with the network disabled");
  await page.setOfflineMode(false);

  await page.reload({ waitUntil: "load" });
  const identity = await page.evaluate(async () => {
    const cache = await import("/offline.mjs");
    const before = await cache.readPreparedOfflineResponse("GET", "/api/inventory");
    cache.activateVerifiedOfflineReadScope({ companyId: 8, userId: "operator-two" });
    const otherUser = await cache.readPreparedOfflineResponse("GET", "/api/inventory");
    cache.activateVerifiedOfflineReadScope({ companyId: 9, userId: "operator-one" });
    const otherCompany = await cache.readPreparedOfflineResponse("GET", "/api/inventory");
    cache.activateVerifiedOfflineReadScope({ companyId: 8, userId: "operator-one" });
    const restored = await cache.readPreparedOfflineResponse("GET", "/api/inventory");
    cache.revokeOfflineReadScope();
    const revoked = await cache.readPreparedOfflineResponse("GET", "/api/inventory");
    return {
      before: before === null,
      otherUser: otherUser === null,
      otherCompany: otherCompany === null,
      restored: restored !== null,
      revoked: revoked === null,
    };
  });
  assert.deepEqual(identity, { before: true, otherUser: true, otherCompany: true, restored: true, revoked: true });
  console.log("Real Chromium/IndexedDB offline read acceptance passed.");
} finally {
  await browser?.close();
  await new Promise((yes, no) => server.close((error) => (error ? no(error) : yes())));
}
