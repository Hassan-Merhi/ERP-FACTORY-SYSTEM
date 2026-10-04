#!/usr/bin/env node
import fs from "node:fs";

const failures = [];

const read = (path) => fs.readFileSync(path, "utf8");
const activeEnvLines = (source) =>
  source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

const rootProduction = read(".env.production");
const clientProduction = read("client/.env.production");
const capacitorEnv = read("client/.env.capacitor");
const gitignore = read(".gitignore");
const pkg = JSON.parse(read("package.json"));
const serviceWorker = read("client/public/sw.js");
const serviceWorkerRegistration = read("client/src/registerServiceWorker.ts");
const main = read("client/src/main.tsx");
const app = read("client/src/App.tsx");
const indexHtml = read("client/index.html");
const browserSmoke = read("scripts/run-responsive-browser-smoke.mjs");
const regressionGuide = read("docs/mobile-tablet-web-regression.md");

for (const [label, source] of [
  ["root production env", rootProduction],
  ["client production env", clientProduction],
]) {
  const active = activeEnvLines(source);
  for (const key of ["VITE_API_BASE_URL=", "VITE_WS_URL="]) {
    if (active.some((line) => line.startsWith(key))) {
      failures.push(`${label} must not define ${key.slice(0, -1)}; browser production must stay same-origin`);
    }
  }
}

const capacitorLines = activeEnvLines(capacitorEnv);
for (const expected of [
  "VITE_API_BASE_URL=https://www.hmdinternationalgroup.com",
  "VITE_WS_URL=wss://www.hmdinternationalgroup.com/ws",
]) {
  if (!capacitorLines.includes(expected)) failures.push(`Capacitor env missing: ${expected}`);
}

if (pkg.scripts?.["build:cap"] !== "vite build --mode capacitor") {
  failures.push("build:cap must use Vite capacitor mode");
}

if (pkg.scripts?.build?.includes("--mode capacitor")) {
  failures.push("standard web build must not use Capacitor mode");
}

for (const token of ["!client/.env.capacitor", "artifacts/responsive-smoke/"]) {
  if (!gitignore.includes(token)) failures.push(`Gitignore contract missing: ${token}`);
}

if (!/const CACHE_VERSION = "erp-v\d+"/.test(serviceWorker)) {
  failures.push('Service-worker recovery contract missing: versioned CACHE_VERSION (for example "erp-v11")');
}

for (const token of [
  'const CACHE_PREFIX = "erp-"',
  'type: "SW_UPDATED", version: CACHE_VERSION',
  'event.data?.type === "CLEAR_APP_CACHES"',
  'type: "APP_CACHES_CLEARED"',
  'key.startsWith(CACHE_PREFIX)',
  'fetch(request.clone(), { cache: "no-store" })',
  'await cache.put("/", response.clone())',
  'contentType.includes("text/html")',
  'const IOS_FORCE_UPDATE_CAMPAIGN = "ios-pwa-2026-09-30-v1"',
  "IOS_FORCE_UPDATE_MARKER_CACHE",
  "runOneTimeIosForceUpdate(clients)",
  'url.searchParams.set("_pwa_update", IOS_FORCE_UPDATE_CAMPAIGN)',
]) {
  if (!serviceWorker.includes(token)) failures.push(`Service-worker recovery contract missing: ${token}`);
}

for (const token of [
  'const ASSET_RECOVERY_PREFIX = "assetRecovery:"',
  'const LEGACY_RECOVERY_PREFIXES = ["swReload:", "chunkReload:", "chunkRetry:"]',
  "const RECOVERY_STABLE_MS = 10_000",
  "event.preventDefault()",
  'type: "CLEAR_APP_CACHES"',
  'currentUrl.searchParams.set("_asset_recovery"',
  'url.searchParams.delete("_sw")',
  'url.searchParams.delete("_pwa_update")',
  "showStaleAssetRecoveryMessage()",
  "removeRecoveryMarkersAfterStableLoad()",
]) {
  if (!main.includes(token)) failures.push(`Client stale-asset recovery contract missing: ${token}`);
}

for (const token of ['"assetRecovery:"', '"swReload:"', '"chunkReload:"', '"chunkRetry:"']) {
  if (!app.includes(token)) failures.push(`Manual update refresh guard missing: ${token}`);
}

if (!indexHtml.includes('<script type="module" src="/src/registerServiceWorker.ts"></script>')) {
  failures.push("Service-worker registration module must be loaded by the app shell");
}

for (const token of [
  'register("/sw.js", { updateViaCache: "none" })',
  'return await navigator.serviceWorker.register("/sw.js")',
  "activeRegistration.update()",
  '"controllerchange"',
  '"visibilitychange"',
  "UPDATE_CHECK_INTERVAL_MS",
]) {
  if (!serviceWorkerRegistration.includes(token)) {
    failures.push(`Service-worker registration contract missing: ${token}`);
  }
}

for (const token of [
  'import puppeteer from "puppeteer"',
  '{ name: "phone-portrait", width: 390, height: 844',
  '{ name: "phone-landscape", width: 844, height: 390',
  '{ name: "tablet-portrait", width: 768, height: 1024',
  '{ name: "tablet-landscape", width: 1024, height: 768',
  '{ name: "desktop", width: 1440, height: 900',
  '{ name: "wide-desktop", width: 1920, height: 1080',
  'process.env.ERP_SMOKE_USERNAME',
  'process.env.ERP_SMOKE_PASSWORD',
  'process.env.ERP_SMOKE_ROUTES',
  'process.env.ERP_SMOKE_REQUIRE_EXACT_ROUTES === "1"',
  "horizontalOverflow:",
  'document.getElementById("main-content")',
  'document.querySelector(\'[data-slot="sidebar-wrapper"]\')',
  'page.on("pageerror"',
  'page.on("requestfailed"',
  'errorText === "net::ERR_ABORTED"',
  '"artifacts/responsive-smoke"',
  '"report.json"',
]) {
  if (!browserSmoke.includes(token)) failures.push(`Responsive browser smoke contract missing: ${token}`);
}

for (const token of [
  "Phone portrait: 390 × 844",
  "Tablet portrait: 768 × 1024",
  "Desktop: 1440 × 900",
  "ERP_SMOKE_BASE_URL",
  "ERP_SMOKE_USERNAME",
  "ERP_SMOKE_REQUIRE_EXACT_ROUTES=1",
  "The target URL must serve a build of the pull-request branch.",
  "A real rendered pass cannot be claimed from repository inspection alone.",
  "Service-worker deployment check",
  "Desktop non-regression checks",
  "The pull request remains conflict-free with `main` at merge time.",
]) {
  if (!regressionGuide.includes(token)) failures.push(`Responsive regression guide missing: ${token}`);
}

if (failures.length) {
  console.error("Mobile/web compatibility verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Mobile/web routing, cache recovery, and responsive regression contracts verified.");
