#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { discoverDuoRouteInventory } from "./lib/iphone-duo-route-inventory.mjs";

const root = process.cwd();
const requirements = [
  ["client/src/pages/factory/FactoryMonthlyProductionMatrix.tsx", [
    "monthly-matrix-mobile", "monthly-matrix-mobile-total", "phone-land:hidden",
    "downloadBlob(", "openWorkerBreakdown(",
  ]],
  ["client/src/pages/factory/FactoryMonthlyProductionDrilldown.tsx", [
    "monthly-production-workers-mobile", "monthly-production-bales-mobile",
    "openBales(worker, month)", "phone-land:hidden",
  ]],
  ["client/src/pages/factory/productiontargets/ProductionBonusWeeklySheet.tsx", [
    "production-bonus-mobile-workers", "bonus-mobile-amount",
    "renderDayActions?.(worker.workerId, date)", "phone-land:hidden",
  ]],
  ["client/src/pages/factory/CreateProformaV5Drawer.tsx", [
    "<V5ProformaMobileLines", 'variant="create"', "onQuantityChange={handleQtyChange}",
  ]],
  ["client/src/pages/factory/EditProformaV5Drawer.tsx", [
    "<V5ProformaMobileLines", 'variant="edit"', "phone-land:hidden",
  ]],
  ["client/src/pages/pos/POSContainerTracking.tsx", [
    "pos-container-mobile-list", "portDateDrafts", "onDraftChange:",
    "phone-land:hidden",
  ]],
  ["client/src/components/MobileBarcodeScanner.tsx", [
    'window.addEventListener("pagehide"', 'cameraTrack.addEventListener?.("ended"',
    "button-mobile-camera-retry",
  ]],
  ["client/src/pages/factory/ContinuousPressingScanner.tsx", [
    'window.addEventListener("pagehide"', 'window.addEventListener("pageshow"',
    'videoTrack.addEventListener?.("ended"', 'gateRef.current.suspend()',
  ]],
  ["client/src/pages/factory/pressing-scanner/continuousScanGate.ts", [
    "suspend(): void", "this.recent.clear()",
  ]],
  ["client/src/lib/downloadBlob.ts", [
    "BLOB_DOWNLOAD_GRACE_MS = 60_000", "document.body.appendChild(link)",
    "window.setTimeout(() => URL.revokeObjectURL(url)",
  ]],
  ["client/src/lib/excelHelper.ts", [
    'import { downloadBlob } from "./downloadBlob"', "downloadBlob(blob, filename)",
  ]],
  ["client/src/pages/POImport.tsx", [
    'download="po-import-template.xlsx"', "e.currentTarget.value = \"\"",
  ]],
  ["client/src/pages/SpPOImport.tsx", [
    'download="po-import-template.xlsx"', 'event.currentTarget.value = ""',
  ]],
  ["server/services/security/operationalPermissionRoutePolicy.ts", [
    '"GET /api/factory/monthly-production-matrix/export-bales"',
  ]],
  ["client/src/i18n/iphoneDuoMobileTranslations.ts", [
    "export function duoMobileText(", 'en: "Available balance"',
    'ar: "الرصيد المتاح"', 'fr: "Solde disponible"',
  ]],
  [".github/workflows/ui-quality.yml", [
    "verify-iphone-duo-phase1-inventory.mjs",
    "verify-iphone-duo-phase1-browser.mjs",
    "iphone-duo-phase2-proforma.test.tsx",
    "iphone-duo-phase2-bonus.test.tsx",
    "iphone-duo-phase3-downloads.test.ts",
  ]],
];
const testFiles = [
  "tests/ui/iphone-duo-phase2-proforma.test.tsx",
  "tests/ui/iphone-duo-phase2-bonus.test.tsx",
  "tests/ui/iphone-duo-phase3-downloads.test.ts",
  "client/src/components/MobileBarcodeScanner.test.tsx",
  "client/src/pages/factory/ContinuousPressingScanner.test.tsx",
  "client/src/pages/factory/pressing-scanner/continuousScanGate.test.ts",
];
const violations = [];
for (const [relative, snippets] of requirements) {
  const source = await fs.readFile(path.join(root, relative), "utf8");
  for (const snippet of snippets) {
    if (!source.includes(snippet)) violations.push(relative + ": missing " + snippet);
  }
}
await Promise.all(testFiles.map(async (relative) => {
  try { await fs.access(path.join(root, relative)); }
  catch { violations.push(relative + ": required test file missing"); }
}));
const inventory = await discoverDuoRouteInventory();
for (const workspace of ["erp", "factory", "properties", "supplier-partner", "retail-admin", "pos", "retail-pos"]) {
  const group = inventory.groups.find((item) => item.workspace === workspace);
  if (!group?.static.length) violations.push(workspace + ": missing static route coverage");
}
const missingDetails = inventory.unresolved.length;
const report = {
  phase: 4,
  status: violations.length ? "source-contract-failed" : "source-contract-passed",
  workspaces: inventory.summary,
  parameterizedRoutesNeedingSeededBrowserEvidence: missingDetails,
  physicalSafariCertification: "NOT VERIFIED — requires user-owned device",
  fullBrowserMatrixCertification: "NOT VERIFIED by this source-only script",
  violations,
};
const output = path.resolve("artifacts/iphone-duo-phase4/release-contract.json");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
assert.deepEqual(violations, [], "iPhone Duo Phase 4 source contract failed");
