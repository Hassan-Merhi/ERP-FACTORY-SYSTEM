#!/usr/bin/env node
/**
 * Runs the Capacitor (Android / iOS) web payload the way the native shell does.
 *
 *   node --import tsx tests/e2e/mobile-shell/run.mjs
 *
 * The native apps are the React bundle built with `--mode capacitor`, served
 * from https://localhost inside a WebView and talking to the production API
 * cross-origin with cookies. Nothing in the browser suites exercises that
 * arrangement: they are same-origin. This script builds that bundle and opens
 * it in a real Chromium at the Android WebView origin, with:
 *
 *   https://localhost                      -> the freshly built bundle
 *   https://www.hmdinternationalgroup.com  -> a local API running the server's
 *                                             real capacitorCors middleware
 *   every other host                       -> not resolvable
 *
 * so Chromium enforces the same cross-origin rules a device would, against the
 * same middleware production runs, and nothing leaves the machine.
 *
 * Set MOBILE_SHELL_BUNDLE_DIR to reuse an existing capacitor-mode build.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import puppeteer from "puppeteer";
import { capacitorCors } from "../../../server/middleware/capacitorCors.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

const WEBVIEW_ORIGIN = "https://localhost";
const API_ORIGIN = "https://www.hmdinternationalgroup.com";
const API_HOST = new URL(API_ORIGIN).host;
const SESSION_COOKIE = "mobile_shell_session";
const USER = { id: "mobile-shell-user", username: "operator", role: "Admin", fullName: "Mobile Shell" };
const CREDENTIALS = { username: "operator", password: "correct horse battery staple" };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
};

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function buildBundle(outDir) {
  const build = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=4096",
      path.join(root, "node_modules/vite/bin/vite.js"),
      "build",
      "--mode",
      "capacitor",
      "--outDir",
      outDir,
      "--emptyOutDir",
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } }
  );
  if (build.status !== 0) {
    throw new Error(
      `vite build --mode capacitor failed:\n${(build.stdout + build.stderr).split("\n").slice(-30).join("\n")}`
    );
  }
}

/** Serves the bundle as the WebView does: files, and index.html for client routes. */
function bundleServer(bundleDir, tls) {
  const missing = [];
  const server = https.createServer(tls, (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, WEBVIEW_ORIGIN).pathname);
    const candidate = path.join(bundleDir, pathname);
    const insideBundle = candidate === bundleDir || candidate.startsWith(bundleDir + path.sep);
    const isFile = insideBundle && existsSync(candidate) && statSync(candidate).isFile();
    if (!isFile && path.extname(pathname)) {
      missing.push(pathname);
      res.writeHead(404).end();
      return;
    }
    const file = isFile ? candidate : path.join(bundleDir, "index.html");
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return { server, missing };
}

/** A stand-in API behind the server's real CORS middleware. */
function apiServer(tls) {
  const requests = [];
  const sessions = new Set();
  const app = express();
  app.disable("x-powered-by");
  app.use((req, _res, next) => {
    requests.push({
      method: req.method,
      path: req.path,
      origin: req.headers.origin ?? null,
      cookie: req.headers.cookie ?? "",
      requestedHeaders: req.headers["access-control-request-headers"] ?? null,
      contentType: req.headers["content-type"] ?? null,
    });
    next();
  });
  app.use(capacitorCors);
  app.use(express.json());

  const signedIn = (req) =>
    (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .some((part) => part.startsWith(`${SESSION_COOKIE}=`) && sessions.has(part.slice(SESSION_COOKIE.length + 1)));

  app.get("/api/csrf-token", (_req, res) => res.json({ csrfToken: "mobile-shell-csrf" }));
  app.get("/api/auth/me", (req, res) =>
    signedIn(req) ? res.json(USER) : res.status(401).json({ message: "Not authenticated" })
  );
  app.post("/api/auth/login", (req, res) => {
    requests[requests.length - 1].body = req.body;
    if (req.body?.username !== CREDENTIALS.username || req.body?.password !== CREDENTIALS.password) {
      res.status(401).json({ message: "Invalid username or password" });
      return;
    }
    const id = `s${sessions.size + 1}`;
    sessions.add(id);
    // Cross-site from the WebView origin, so the cookie must be SameSite=None; Secure.
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=None`);
    res.json(USER);
  });
  app.use("/api", (req, res) =>
    signedIn(req) ? res.json([]) : res.status(401).json({ message: "Not authenticated" })
  );
  app.use((_req, res) => res.status(404).end());

  return { server: https.createServer(tls, app), requests };
}

function chromePath() {
  for (const candidate of [process.env.MOBILE_SHELL_CHROME_PATH, process.env.CHROME_BIN]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined; // puppeteer's own download
}

const workDir = mkdtempSync(path.join(tmpdir(), "mobile-shell-"));
const diagnostics = { url: null, text: null, consoleErrors: [], failedRequests: [], apiRequests: [] };
let browser;
let page;
const servers = [];
let failure = null;

try {
  const keyPath = path.join(workDir, "key.pem");
  const certPath = path.join(workDir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" }
  );
  const tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };

  let bundleDir = process.env.MOBILE_SHELL_BUNDLE_DIR;
  if (!bundleDir) {
    bundleDir = path.join(workDir, "bundle");
    console.log("Building the capacitor-mode bundle…");
    buildBundle(bundleDir);
  }
  bundleDir = path.resolve(bundleDir);
  check("the capacitor-mode build produces index.html", existsSync(path.join(bundleDir, "index.html")), bundleDir);

  const bundle = bundleServer(bundleDir, tls);
  const api = apiServer(tls);
  servers.push(bundle.server, api.server);
  const bundlePort = await listen(bundle.server);
  const apiPort = await listen(api.server);

  browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath(),
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?|all|no)_proxy$/i.test(name))),
    args: [
      "--no-sandbox",
      // A proxy from the environment would bypass the resolver rules below.
      "--no-proxy-server",
      "--proxy-server=direct://",
      "--proxy-bypass-list=*",
      "--ignore-certificate-errors",
      `--host-resolver-rules=MAP localhost 127.0.0.1:${bundlePort}, MAP ${API_HOST} 127.0.0.1:${apiPort}, MAP * ~NOTFOUND`,
    ],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

  const { consoleErrors, failedRequests } = diagnostics;
  const failedApiRequests = [];
  diagnostics.apiRequests = api.requests;
  const otherHosts = new Set();
  const sameOriginApiCalls = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "wss:" && url.protocol !== "ws:")
      return;
    if (url.origin === WEBVIEW_ORIGIN) {
      if (url.pathname.startsWith("/api/")) sameOriginApiCalls.push(url.pathname);
    } else if (url.host !== API_HOST) {
      otherHosts.add(url.host);
    }
  });
  page.on("requestfailed", (request) => {
    const description = `${request.method()} ${request.url()} (${request.failure()?.errorText})`;
    failedRequests.push(description);
    // Compare the parsed origin: a substring match would also count look-alike hosts.
    if (new URL(request.url()).origin === API_ORIGIN) failedApiRequests.push(description);
  });

  // ── Cold start: the sign-in screen ──────────────────────────────────────
  await page.goto(`${WEBVIEW_ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="input-username"]', { timeout: 60000 });

  check("the sign-in screen renders from the bundled files", true);
  check("no bundled asset is missing", bundle.missing.length === 0, bundle.missing);
  check(
    "the sign-in screen fits a phone without sideways scrolling",
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))
  );

  await page.waitForFunction(() => true, { timeout: 1000 }).catch(() => {});
  const beforeLogin = api.requests.slice();
  check(
    "the session check goes to the production API, not the WebView origin",
    beforeLogin.some((request) => request.method === "GET" && request.path === "/api/auth/me"),
    beforeLogin.map((request) => `${request.method} ${request.path}`)
  );
  check("no API call is sent to the WebView's own origin", sameOriginApiCalls.length === 0, sameOriginApiCalls);

  // ── Sign in ─────────────────────────────────────────────────────────────
  await page.type('[data-testid="input-username"]', CREDENTIALS.username);
  await page.type('[data-testid="input-password"]', CREDENTIALS.password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }),
    page.click('[data-testid="button-login"]'),
  ]);
  await page.waitForFunction(() => window.location.pathname !== "/login", { timeout: 60000 });

  const login = api.requests.find((request) => request.method === "POST" && request.path === "/api/auth/login");
  check(
    "sign-in posts the credentials as JSON to the production API",
    login && login.body?.username === CREDENTIALS.username && login.body?.password === CREDENTIALS.password,
    login ? { contentType: login.contentType } : null
  );
  check("sign-in is sent from the Android WebView origin", login?.origin === WEBVIEW_ORIGIN, login?.origin);

  const afterLogin = api.requests.slice(api.requests.indexOf(login) + 1);
  const sessionCheck = afterLogin.find((request) => request.method === "GET" && request.path === "/api/auth/me");
  check(
    "the session cookie is sent on the next cross-origin request",
    Boolean(sessionCheck?.cookie.includes(`${SESSION_COOKIE}=`)),
    sessionCheck ? { cookie: sessionCheck.cookie } : "no /api/auth/me after sign-in"
  );
  check("signing in leaves the sign-in screen", new URL(page.url()).pathname !== "/login", page.url());

  // Give the signed-in shell a moment to issue its first round of requests.
  await new Promise((resolve) => setTimeout(resolve, 4000));

  // ── Cross-origin rules, as enforced by Chromium against the real middleware ──
  const preflights = api.requests.filter((request) => request.method === "OPTIONS");
  const corsErrors = consoleErrors.filter((text) => /CORS|Access-Control|preflight/i.test(text));
  check("Chromium reports no cross-origin (CORS) refusal", corsErrors.length === 0, corsErrors.slice(0, 5));
  check("no request to the production API fails", failedApiRequests.length === 0, failedApiRequests.slice(0, 10));
  check(
    "every API request comes from the WebView origin",
    api.requests.every((request) => request.origin === null || request.origin === WEBVIEW_ORIGIN),
    [...new Set(api.requests.map((request) => request.origin))]
  );
  check("the bundle contacts no host other than the API", otherHosts.size === 0, [...otherHosts]);

  console.log(`\nAPI requests: ${api.requests.length} (${preflights.length} preflight).`);
  const headers = [
    ...new Set(
      preflights.flatMap((request) =>
        (request.requestedHeaders ?? "")
          .split(",")
          .map((h) => h.trim())
          .filter(Boolean)
      )
    ),
  ].sort();
  console.log(`Custom request headers the bundle asked permission for: ${headers.join(", ") || "none"}`);
} catch (error) {
  failure = error;
  if (page) {
    diagnostics.url = page.url();
    diagnostics.text = await page.evaluate(() => document.body?.innerText.slice(0, 600) ?? null).catch(() => null);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const server of servers) server.close();
  rmSync(workDir, { recursive: true, force: true });
}

console.log("");
for (const entry of checks) {
  console.log(`  ${entry.ok ? "ok  " : "FAIL"} ${entry.name}${entry.ok ? "" : ` -> ${JSON.stringify(entry.detail)}`}`);
}
if (failure) {
  console.error(`\n  ERROR ${failure.stack || failure}`);
  console.error(`\n  Page: ${diagnostics.url}\n  Text: ${JSON.stringify(diagnostics.text)}`);
  console.error(`  Console errors:\n    ${diagnostics.consoleErrors.slice(0, 15).join("\n    ") || "none"}`);
  console.error(`  Failed requests:\n    ${diagnostics.failedRequests.slice(0, 15).join("\n    ") || "none"}`);
  console.error(
    `  API requests:\n    ${
      diagnostics.apiRequests
        .slice(0, 30)
        .map((request) => `${request.method} ${request.path}`)
        .join("\n    ") || "none"
    }`
  );
}

if (failure || checks.some((entry) => !entry.ok)) {
  console.error("\nMobile shell verification FAILED.");
  process.exit(1);
}
console.log("\nMobile shell verification passed.");
