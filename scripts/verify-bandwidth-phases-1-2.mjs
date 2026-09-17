#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const failures = [];
const requireText = (source, text, message) => {
  if (!source.includes(text)) failures.push(message);
};
const rejectText = (source, text, message) => {
  if (source.includes(text)) failures.push(message);
};

const serviceWorker = read("client/public/sw.js");
const main = read("client/src/main.tsx");
const app = read("client/src/App.tsx");
const screenFeed = read("client/src/hooks/use-screen-feed.ts");
const screenFeedCaptureEngine = read("client/src/hooks/screen-feed-capture-engine.ts");
const presence = read("client/src/hooks/use-presence.ts");
const lazyImports = read("build/viteLazyHeavyImportsPlugin.ts");
const labelAssetPlugin = read("build/viteLabelAssetExtractionPlugin.ts");
const viteConfig = read("vite.config.ts");
const bandwidthDebug = read("server/middleware/bandwidthDebug.ts");
const operationalEvents = read("server/lib/operationalEvents.ts");
const hotspotGuard = read("client/src/lib/bandwidthPhase1HotspotGuard.ts");
const payloadGuard = read("client/src/lib/bandwidthPhase2PayloadGuard.ts");
const accountingGuard = read("client/src/lib/accountingRequestFetchGuard.ts");
const apiBridge = read("server/apiPaginationBridge.mjs");
const inventoryRoutes = [
  read("server/routes/inventoryRoutes.ts"),
  read("server/routes/inventory/inventoryQueryService.ts"),
].join("\n");
const readMicrocache = read("server/routes/performance/readMicrocache.ts");
const supplierBatcher = read("server/routes/performance/supplierVoucherEntryBatcher.ts");
const supplierBalanceHelpers = read("server/routes/helpers/supplierBalanceHelpers.ts");

requireText(serviceWorker, "HASHED_ASSET_RE", "Hashed production assets must be identified.");
requireText(serviceWorker, "cacheFirstHashedAsset(request)", "Hashed assets must use cache-first loading.");
requireText(serviceWorker, "if (cached) return cached;", "Cached hashed assets must be returned before network access.");
rejectText(main, 'url.searchParams.set("_sw"', "Service-worker activation must not auto-reload every tab.");
requireText(
  main,
  'new CustomEvent("erp:service-worker-updated"',
  "Service-worker activation must notify the update banner."
);
requireText(
  app,
  'window.addEventListener("erp:service-worker-updated"',
  "The update banner must handle service-worker updates."
);

rejectText(
  screenFeedCaptureEngine,
  'import html2canvas from "html2canvas"',
  "html2canvas must not be statically imported."
);
requireText(
  screenFeedCaptureEngine,
  'import("html2canvas")',
  "html2canvas must load only when capture starts."
);
requireText(
  screenFeedCaptureEngine,
  "return await fn();",
  "The canvas guard must remain active across async capture."
);
requireText(
  screenFeed,
  "captureAndUploadScreenFrame",
  "The screen-feed scheduler must delegate heavy rendering to the capture engine."
);
requireText(lazyImports, 'await import("@/lib/excelHelper")', "ExcelJS must load only after an export request.");
requireText(lazyImports, "StockInSalesReport.tsx", "The main Stock In and Sales report must be covered.");
requireText(lazyImports, "StockInSalesReportDetail.tsx", "The detail report must be covered.");
requireText(viteConfig, "lazyHeavyImportsPlugin()", "The lazy-heavy-import Vite plugin must remain enabled.");

requireText(presence, 'document.visibilityState === "visible"', "Presence heartbeats must pause in hidden tabs.");
requireText(bandwidthDebug, "totalApiResponseBytes", "Bandwidth snapshots must report total API bytes.");
requireText(
  bandwidthDebug,
  "totalStaticAssetResponseBytes",
  "Bandwidth snapshots must report total static-asset bytes."
);
requireText(bandwidthDebug, "isApiPath", "API rankings must exclude non-API paths.");
requireText(
  bandwidthDebug,
  "calculateRankScore",
  "The Program 6A ranking regression helper must remain available."
);
requireText(
  operationalEvents,
  "ranked: event.ranked",
  "Ranked endpoint rows must reach structured production logs."
);
requireText(
  operationalEvents,
  'else logger.info(event.message, context)',
  "Informational bandwidth snapshots must log at info level."
);

requireText(
  accountingGuard,
  'import "./bandwidthPhase1HotspotGuard";',
  "The Phase 1 hotspot guard must be installed before accounting fetch protection."
);
requireText(
  accountingGuard,
  'import "./bandwidthPhase2PayloadGuard";',
  "The Phase 2 payload guard must be installed before accounting fetch protection."
);
requireText(hotspotGuard, "/api\\/containers\\/otw-items", "OTW container items must be request-contained.");
requireText(hotspotGuard, "/api\\/factory\\/containers", "Factory containers must be request-contained.");
requireText(hotspotGuard, "/api\\/ledger-accounts", "Ledger accounts must be request-contained.");
requireText(hotspotGuard, "/api\\/factory\\/bale-products", "Bale products must be request-contained.");
requireText(hotspotGuard, "/api\\/factory\\/workers", "Factory workers must be request-contained.");
requireText(hotspotGuard, "/api\\/factory\\/mix-batches", "Mix batches must be request-contained.");
requireText(hotspotGuard, "/api\\/factory\\/raw-stock", "Raw-stock reads must be request-contained.");
requireText(hotspotGuard, "/api\\/accounts\\/all", "Accounts reads must be request-contained.");
requireText(hotspotGuard, "inFlightRequests", "Identical hotspot GETs must share one in-flight request.");
requireText(
  hotspotGuard,
  "generationAtStart !== generationForScope(rule.scope)",
  "Writes must prevent raced GETs from caching stale data."
);
requireText(hotspotGuard, "liveWriteGeneration += 1", "Every write boundary must advance the live cache generation.");
requireText(
  hotspotGuard,
  'if (scope === "all") referenceWriteGeneration += 1',
  "Reference-data writes must advance the reference cache generation."
);
requireText(hotspotGuard, "clearCache(scope);", "Writes must clear the affected short-lived hotspot snapshots.");
// Asserted on behavior rather than on the exact argument expression: the abort signal handed to
// waitUntilVisible is the shared request lifetime's, not the per-caller one, so that a single
// cancelled caller cannot abort a request other callers are still waiting on.
requireText(hotspotGuard, "await waitUntilVisible(", "Heavy hotspot reads must pause in hidden tabs.");
requireText(
  hotspotGuard,
  'document.visibilityState !== "hidden"',
  "The hidden-tab pause must key off document visibility."
);
requireText(
  hotspotGuard,
  'document.addEventListener("visibilitychange"',
  "Paused hotspot reads must resume when the tab becomes visible again."
);
requireText(
  hotspotGuard,
  "x-bypass-request-storm-guard",
  "Operators must be able to bypass request snapshots explicitly."
);
requireText(
  hotspotGuard,
  "maxResponseBytes: 4_000_000",
  "The OTW response must use a bounded large-response allowance."
);
requireText(hotspotGuard, "MAX_CACHE_ENTRIES = 32", "The hotspot response cache must remain memory-bounded.");

requireText(payloadGuard, 'url.pathname === "/inventory"', "Phase 2 profiles must be limited to Inventory Hub.");
requireText(
  payloadGuard,
  'url.searchParams.get("tab") === "on-the-way"',
  "Phase 2 profiles must be limited to the OTW tab."
);
requireText(payloadGuard, 'return "otw-summary";', "The OTW tab must request compact container summaries.");
requireText(payloadGuard, 'return "stock-otw";', "The OTW tab must request grouped stock rows.");
requireText(payloadGuard, 'return "combined";', "Combined Inventory must request aggregated inventory rows.");
requireText(
  payloadGuard,
  'return "combined-detail";',
  "Combined Inventory must request compact container details."
);
requireText(
  payloadGuard,
  'url.searchParams.set("profile", profile);',
  "Payload profiles must be explicit query parameters."
);
requireText(payloadGuard, "removeQueries", "Compact query data must be removed at OTW navigation boundaries.");
requireText(payloadGuard, "window.history.pushState =", "Push navigation must isolate compact query caches.");
requireText(payloadGuard, "window.history.replaceState =", "Replace navigation must isolate compact query caches.");
requireText(
  payloadGuard,
  'addEventListener("popstate"',
  "Back and forward navigation must isolate compact query caches."
);
requireText(
  payloadGuard,
  'first === "/api/containers"',
  "Full container list query keys must be cleared outside OTW."
);
requireText(
  payloadGuard,
  '/^\\/api\\/containers\\/\\d+$/.test(first)',
  "Container detail query keys must be cleared outside OTW."
);

requireText(apiBridge, "compactOtwContainerSummary", "The server must compact OTW container summaries.");
requireText(apiBridge, "compactStockOtwItems", "The server must aggregate Stock OTW line items.");
requireText(
  apiBridge,
  "compactCombinedContainerDetail",
  "The server must compact Combined Inventory container details."
);
requireText(apiBridge, 'profile === "otw-summary"', "The OTW summary profile must remain opt-in.");
requireText(apiBridge, 'profile === "stock-otw"', "The grouped Stock OTW profile must remain opt-in.");
requireText(apiBridge, 'profile === "combined-detail"', "The compact detail profile must remain opt-in.");

requireText(inventoryRoutes, 'profile === "combined"', "Inventory must expose an opt-in combined summary profile.");
requireText(
  inventoryRoutes,
  "SUM(${inventory.quantity}::numeric)",
  "Combined inventory quantities must aggregate in SQL."
);
requireText(
  inventoryRoutes,
  "SUM(${inventory.totalValue}::numeric)",
  "Combined inventory values must aggregate in SQL."
);
requireText(inventoryRoutes, ".groupBy(", "Combined inventory must group by stock item rather than location row.");
requireText(inventoryRoutes, "pageSize: data.length", "Combined inventory must return its complete aggregated result.");

requireText(
  readMicrocache,
  '"/api/factory/suppliers/with-balances", 15_000',
  "Supplier balance summaries must use the Phase 3 server microcache."
);
requireText(
  readMicrocache,
  '"/api/factory/raw-stock", 10_000',
  "Raw-stock reads must use the Phase 3 server microcache."
);
requireText(
  readMicrocache,
  '"/api/factory/mix-batches", 10_000',
  "Mix-batch reads must use the Phase 3 server microcache."
);
requireText(
  readMicrocache,
  '"/api/factory/bale-ledger", 10_000',
  "Bale-ledger reads must use the Phase 3 server microcache."
);
requireText(
  readMicrocache,
  '"/api/factory/production-value-report", 10_000',
  "Production-value reads must use the Phase 3 server microcache."
);
requireText(readMicrocache, "const inFlight = new Map", "Simultaneous expensive server reads must be coalesced.");
requireText(readMicrocache, "writeGeneration", "Server read caching must reject responses raced by writes.");
requireText(readMicrocache, "clearForWrite();", "State-changing requests must invalidate server read caches.");
requireText(readMicrocache, '"X-ERP-Read-Cache"', "Server cache hit and coalescing state must be observable.");
requireText(readMicrocache, "maxBodyBytes ?? 5_000_000", "Server read caching must remain body-size bounded.");
requireText(readMicrocache, "maxEntries ?? 128", "Server read caching must remain entry-count bounded.");
requireText(
  readMicrocache,
  'req.headers["x-bypass-request-storm-guard"]',
  "Explicit cache bypass must work consistently on client and server."
);

requireText(
  supplierBatcher,
  "ve.supplier_id = ANY($1::int[])",
  "Supplier voucher entries must load through one bounded SQL query."
);
requireText(supplierBatcher, "queueMicrotask", "Concurrent supplier balance reads must batch in the same turn.");
requireText(
  supplierBatcher,
  "pendingByCompany",
  "Supplier entry batches must remain isolated by company context."
);
requireText(
  supplierBalanceHelpers,
  "getVoucherEntriesBySupplierBatched",
  "Canonical supplier balances must use the Phase 3 batch loader."
);
rejectText(
  supplierBalanceHelpers,
  "storage.getVoucherEntriesBySupplier(supplier.id",
  "Canonical supplier balances must not restore one query per supplier."
);

// Phase 4: static assets, image extraction, and production build budgets.
requireText(viteConfig, "labelAssetExtractionPlugin()", "The label asset extraction plugin must remain enabled.");
requireText(viteConfig, "cssColorMixPlugin()", "CSS color-mix() must be resolved at build time so capture can skip the style walk.");
requireText(viteConfig, 'return "label-printing";', "Label printing code must remain isolated from core bundles.");
requireText(labelAssetPlugin, "EMBEDDED_LABEL_LOGO_RE", "The embedded label logo must be replaced during builds.");
requireText(labelAssetPlugin, "createHash", "The extracted label logo must use a content-derived filename.");
requireText(labelAssetPlugin, "this.emitFile", "The extracted label logo must be emitted as a build asset.");
requireText(labelAssetPlugin, 'Cache-Control", "public, max-age=31536000, immutable"', "The dev label asset must mirror immutable production caching.");
requireText(serviceWorker, "networkOnlyApi(request)", "The service worker must not persist large API payloads.");
rejectText(serviceWorker, "async function networkFirstApi", "The service worker must not restore API Cache Storage writes.");
requireText(serviceWorker, "MAX_STATIC_CACHE_ENTRIES = 200", "Static Cache Storage must remain entry-bounded.");
requireText(serviceWorker, "putBounded", "Every service-worker static write must enforce the cache bound.");
requireText(serviceWorker, "isVersionedLabelAsset(url)", "Versioned label images must use cache-first delivery.");
requireText(serviceWorker, 'url.searchParams.has("t")', "Custom label images must be keyed by their update timestamp.");

const distAssets = path.join(root, "dist", "public", "assets");
if (fs.existsSync(distAssets)) {
  const assetFiles = fs.readdirSync(distAssets);
  const jsFiles = assetFiles.filter((name) => name.endsWith(".js"));
  const labelChunks = jsFiles.filter((name) => /^label-printing-[A-Za-z0-9_-]+\.js$/.test(name));
  const labelLogos = assetFiles.filter((name) => /^hmd-label-logo-[a-f0-9]{12}\.jpg$/.test(name));

  if (labelChunks.length !== 1) {
    failures.push(`Expected exactly one label-printing chunk, found ${labelChunks.length}.`);
  }
  if (labelLogos.length !== 1) {
    failures.push(`Expected exactly one hashed HMD label logo, found ${labelLogos.length}.`);
  }

  const embeddedLogoSignature = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABQAAAANV";
  for (const name of jsFiles) {
    const filePath = path.join(distAssets, name);
    const size = fs.statSync(filePath).size;
    const source = fs.readFileSync(filePath, "utf8");
    if (source.includes(embeddedLogoSignature)) {
      failures.push(`${name} still contains the full embedded HMD label PNG.`);
    }
    if (/^index-[A-Za-z0-9_-]+\.js$/.test(name) && size > 1_500_000) {
      failures.push(`${name} exceeds the 1.5 MB core entry budget (${size} bytes).`);
    }
  }

  for (const name of labelChunks) {
    const size = fs.statSync(path.join(distAssets, name)).size;
    if (size > 200_000) {
      failures.push(`${name} exceeds the 200 KB label-printing budget (${size} bytes).`);
    }
  }
} else {
  console.log("Build artifact checks skipped because dist/public/assets does not exist.");
}

if (failures.length > 0) {
  console.error("Bandwidth phase verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Bandwidth phases 1-4 request, payload, query-pressure, and asset invariants verified.");