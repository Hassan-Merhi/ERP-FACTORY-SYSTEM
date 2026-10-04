#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const read = (file) => fs.readFile(path.join(ROOT, file), "utf8");

const performance = await read("client/src/lib/mobilePerformance.ts");
const lifecycle = await read("client/src/hooks/use-mobile-performance-lifecycle.ts");
const app = await read("client/src/app/AuthenticatedApp.tsx");
const connectivity = await read("client/src/contexts/ConnectivityContext.tsx");
const serviceWorker = await read("client/public/sw.js");
const css = await read("client/src/styles/mobile-performance.css");
const failures = [];

for (const token of [
  "getBrowserConnectionProfile",
  "getConnectivityPollDelay",
  "getQueueRefreshDelay",
  "isDocumentVisible",
  "runWhenIdle",
  'effectiveType === "slow-2g"',
  'effectiveType === "2g"',
]) {
  if (!performance.includes(token)) failures.push(`Mobile performance helper missing: ${token}`);
}

for (const token of [
  "focusManager",
  "onlineManager",
  "visibilitychange",
  "erp:app-visible",
  "erp:app-hidden",
  "root.dataset.saveData",
  "root.dataset.slowConnection",
  "mobile-performance.css",
]) {
  if (!lifecycle.includes(token)) failures.push(`Lifecycle contract missing: ${token}`);
}

if (!app.includes("useMobilePerformanceLifecycle();")) {
  failures.push("Authenticated app does not activate the mobile performance lifecycle");
}

for (const token of [
  "getConnectivityPollDelay",
  "getQueueRefreshDelay",
  "schedulePoll",
  "scheduleCounts",
  "isDocumentVisible",
  'queryClient.invalidateQueries({ refetchType: "active" }, { cancelRefetch: false })',
]) {
  if (!connectivity.includes(token)) failures.push(`Adaptive connectivity contract missing: ${token}`);
}

if (connectivity.includes("setInterval(async () =>") || connectivity.includes("15_000")) {
  failures.push("Legacy fixed connectivity polling is still present");
}

// The cache version is bumped with every service-worker change; the contract
// is that it is versioned, not which version it is.
if (!/CACHE_VERSION = "erp-v\d+"/.test(serviceWorker)) {
  failures.push('Service worker performance contract missing: versioned CACHE_VERSION = "erp-vN"');
}

for (const token of [
  "navigationPreload",
  "event.preloadResponse",
  "networkOnlyApi(request)",
  'url.pathname.startsWith("/api/")',
  'cache: "no-store"',
]) {
  if (!serviceWorker.includes(token)) failures.push(`Service worker performance contract missing: ${token}`);
}

for (const token of [
  'data-app-visibility="hidden"',
  "animation-play-state: paused",
  'data-save-data="true"',
  'data-slow-connection="true"',
]) {
  if (!css.includes(token)) failures.push(`Mobile performance CSS contract missing: ${token}`);
}

if (failures.length) {
  console.error("Mobile responsiveness Phase 10 verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      phase: 10,
      status: "implemented",
      protectedContracts: 35,
      sqlRequired: false,
    },
    null,
    2
  )
);