#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function assert(condition, message) {
  if (!condition) {
    console.error(`Wave 3 verification failed: ${message}`);
    process.exitCode = 1;
  }
}

function requireText(source, text, message) {
  assert(source.includes(text), message);
}

function forbidText(source, text, message) {
  assert(!source.includes(text), message);
}

const workers = read("server/routes/factory-workers/lists.ts");
const ledger = read("server/routes/ledger/reads.ts");
const ledgerPage = read("server/routes/ledgerAccountPaginationRoutes.ts");
const products = read("server/routes/factory/products/productReadRoutes.ts");
const mixBatches = read("server/routes/factory/mix-batches/reads.ts");
const accounts = read("server/routes/accounts/all.ts");
const microcache = read("server/routes/performance/readMicrocache.ts");
const bandwidth = read("server/middleware/bandwidthDebug.ts");
const phase4 = read("client/src/lib/phase4BandwidthFetch.ts");
const phase4Test = read("client/src/lib/phase4BandwidthFetch.test.ts");
const baleHistory = read("client/src/pages/factory/baleshistory/useBalesHistoryModel.tsx");
const analytics = read("client/src/pages/analytics/useAnalyticsReportQueries.ts");
const gitClient = read("client/src/pages/git-containers/usePaginatedGITContainers.ts");
const gitServer = read("server/routes/git/gitReportRoutes.ts");

requireText(workers, 'req.query.profile === "picker"', "Factory workers must expose a native picker profile.");
for (const field of ["factoryWorkers.id", "factoryWorkers.employeeCode", "factoryWorkers.fullName", "factoryWorkers.active"]) {
  requireText(workers, field, `Worker picker projection is missing ${field}.`);
}
const workerPicker = workers.slice(workers.indexOf('req.query.profile === "picker"'), workers.indexOf('req.query.profile !== "full"'));
for (const forbidden of ["baseSalary:", "perBaleRate:", "perKgRate:", "pendingAdvanceBalance:"]) {
  forbidText(workerPicker, forbidden, `Worker picker must not select payroll field ${forbidden}`);
}

requireText(ledger, 'req.query.profile === "picker"', "Ledger accounts must expose a native picker profile.");
for (const field of [
  "ledgerAccounts.id",
  "ledgerAccounts.code",
  "ledgerAccounts.name",
  "ledgerAccounts.accountType",
  "ledgerAccounts.subType",
  "ledgerAccounts.parentId",
  "ledgerAccounts.active",
  "ledgerAccounts.isHidden",
]) {
  requireText(ledger, field, `Ledger picker projection is missing ${field}.`);
}
requireText(ledgerPage, 'req.query.profile === "picker"', "Paginated ledger reads must preserve the picker projection.");

requireText(products, 'req.query.profile === "picker"', "Bale products must expose a native picker profile.");
for (const field of [
  "factoryBaleProducts.id",
  "factoryBaleProducts.articleCode",
  "factoryBaleProducts.name",
  "factoryBaleProducts.weightPerBaleKg",
  "factoryBaleProducts.categoryId",
  "factoryBaleProducts.active",
]) {
  requireText(products, field, `Bale-product picker projection is missing ${field}.`);
}
const productPicker = products.slice(products.indexOf('req.query.profile === "picker"'), products.indexOf("const results = await db.select()"));
for (const forbidden of ["description:", "descriptionAr:", "descriptionFr:", "sellingPrice:", "productionPrice:", "createdAt:", "updatedAt:"]) {
  forbidText(productPicker, forbidden, `Bale-product picker must not select ${forbidden}`);
}

requireText(mixBatches, 'req.query.profile === "summary"', "Mix batches must expose a compact summary profile.");
const mixSummary = mixBatches.slice(mixBatches.indexOf('req.query.profile === "summary"'), mixBatches.indexOf("const results = await db.select()"));
forbidText(mixSummary, "factoryMixBatchSources", "Mix-batch summary must not load source rows.");
forbidText(mixSummary, "getLockedSupplierRatesReadOnlyBulk", "Mix-batch summary must not recompute supplier rates.");

requireText(accounts, 'const analyticsProfile = req.query.profile === "analytics"', "Accounts must recognize the analytics profile natively.");
requireText(accounts, "analyticsProfile ? Promise.resolve([]) : storage.getAllEmployees(companyId)", "Analytics must skip employee account loading.");
requireText(accounts, "analyticsProfile ? Promise.resolve([]) : storage.getAllSuppliers()", "Analytics must skip supplier account loading.");
requireText(analytics, 'new URLSearchParams({ profile: "analytics" })', "Modern Analytics must request the compact account profile.");

forbidText(phase4, "linkedProformaIds", "Loading pages must not maintain eager proforma-detail prefetch state.");
forbidText(phase4, "patchProformaSummaryQueries", "Loading summaries must not be enriched with full proforma lines.");
requireText(phase4Test, "never prefetches detail rows", "Proforma lazy-detail behavior must have regression coverage.");

requireText(microcache, "/inventory\\/light", "Compact location inventory must participate in read microcache/ETag handling.");
requireText(microcache, "customer-proformas\\/\\d+", "Explicit proforma details must participate in read microcache/ETag handling.");
requireText(microcache, "inventory(?:\\/light)?", "POS location authorization must be rechecked for full and light inventory cache hits.");

requireText(bandwidth, 'if (routePath.startsWith("/api/")) return routePath;', "Bandwidth ranking must not double-prefix absolute API routes.");
forbidText(baleHistory, "data: _mixBatches", "Bale History must not download an unused full mix-batch list.");

requireText(gitClient, 'profile: "compact"', "GIT list UI must request compact rows.");
requireText(gitClient, "useInfiniteQuery", "GIT list UI must use bounded continuous chunks.");
requireText(gitClient, "loadContainerDetail", "GIT list must fetch full container detail only on demand.");
requireText(gitServer, "createGitContinuousSnapshot", "GIT server must snapshot the expensive initial list once.");
requireText(gitServer, "readGitContinuousSnapshot", "GIT later chunks must read the snapshot instead of rerunning enrichment.");

const migratedPickerFiles = [
  "client/src/pages/factory/ProductionComparison.tsx",
  "client/src/pages/factory/ProductionPlannerDialog.tsx",
  "client/src/pages/factory/FactoryWorkerBonusesTab.tsx",
];
for (const file of migratedPickerFiles) {
  requireText(read(file), "/api/factory/workers?profile=picker", `${file} must use the worker picker contract.`);
}

for (const file of [
  "client/src/pages/factory/ProductionComparison.tsx",
  "client/src/pages/factory/ProformaAddLine.tsx",
  "client/src/pages/factory/FactoryMixOptimizer.tsx",
]) {
  requireText(read(file), "/api/factory/bale-products?profile=picker", `${file} must use the bale-product picker contract.`);
}

const stockEntryHistory = read("client/src/pages/StockEntryHistory.tsx");
requireText(
  stockEntryHistory,
  "/api/factory/bales/stock-entry-history",
  "Stock Entry History must use the bounded stock-entry history endpoint."
);
requireText(
  stockEntryHistory,
  'data-testid="input-stock-entry-date"',
  "Stock Entry History must preserve its single-date compact filter."
);
forbidText(
  stockEntryHistory,
  "/api/factory/workers?profile=picker",
  "Simplified Stock Entry History must not restore the removed worker picker payload."
);
forbidText(
  stockEntryHistory,
  "/api/factory/bale-products?profile=picker",
  "Simplified Stock Entry History must not restore the removed bale-product picker payload."
);

for (const file of [
  "client/src/components/OffloadDialog.tsx",
  "client/src/pages/PurchaseOrderEdit.tsx",
  "client/src/pages/AccountTransfer.tsx",
  "client/src/pages/factory/FactoryInvoiceCreate.tsx",
]) {
  requireText(read(file), "profile=picker", `${file} must use a compact ledger picker contract.`);
}

requireText(read("client/src/pages/ProductionBales.tsx"), "/api/factory/mix-batches?profile=summary", "Production Bales must use compact mix batches.");
requireText(read("client/src/pages/factory/ProductionSummary.tsx"), "/api/factory/mix-batches?profile=summary", "Production Summary must use compact mix batches.");

if (!process.exitCode) {
  console.log("Wave 3 API payload and bandwidth verification passed.");
}
