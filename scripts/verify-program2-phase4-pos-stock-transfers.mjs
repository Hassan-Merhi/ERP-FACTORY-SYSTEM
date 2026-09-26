import fs from "node:fs";

const requiredFiles = [
  "server/services/pos/createSaleService.ts",
  "server/services/pos/edit/updateSaleService.ts",
  "server/routes/vouchers/stockTransferLifecycleRoutes.ts",
  "server/routes/vouchers/stockTransferRevisionLifecycleRoutes.ts",
  "server/routes/vouchers/centralStockTransferDeleteRoute.ts",
  "server/services/stockTransferDeletion.ts",
  "server/routes/voucherRoutes.ts",
  "docs/archive/program-2-phase-2c.md",
  "docs/archive/program-2-phase-4-pos-stock-transfers.md",
];
for (const file of requiredFiles) {
  if (!fs.existsSync(file)) throw new Error(`Program 2 Phase 4 missing required file: ${file}`);
}
const read = (file) => fs.readFileSync(file, "utf8");
const createSale = read(requiredFiles[0]);
const editSale = read(requiredFiles[1]);
const lifecycle = read(requiredFiles[2]);
const revision = read(requiredFiles[3]);
const deletionRoute = read(requiredFiles[4]);
const deletionService = read(requiredFiles[5]);
const registry = read(requiredFiles[6]);
const phaseDoc = read(requiredFiles[8]);

const callIndex = (name) => registry.indexOf(`${name}(`);
const lifecycleCall = callIndex("registerStockTransferLifecycleRoutes");
const legacyCall = callIndex("registerVoucherTransferRoutes");

const checks = [
  [createSale.includes("clientSaleId"), "POS creation must retain clientSaleId identity"],
  [
    createSale.includes("lockAndFindExistingPosSaleTx") &&
      read("server/services/pos/posSaleIdempotency.ts").includes("pg_advisory_xact_lock"),
    "POS creation must retain transaction advisory locking",
  ],
  [createSale.includes("_idempotent"), "POS replay must remain explicit"],
  [createSale.includes("transaction"), "POS accounting and inventory must remain transaction-owned"],
  [editSale.includes('.for("update")') || editSale.includes(".for('update')") || editSale.includes("FOR UPDATE"), "POS edit must lock current persisted state"],
  [editSale.includes("voucherEntries"), "POS edit must rebuild accounting from locked state"],
  [editSale.includes("salesItems"), "POS edit must own sales-item lifecycle"],
  [lifecycle.includes("saveStockTransferLifecycle"), "Stock Transfer lifecycle service must remain authoritative"],
  [lifecycle.includes("inventoryApplied"), "Stock Transfer lifecycle must preserve applied-state ownership"],
  [revision.length > 100, "Stock Transfer revision lifecycle must remain present"],
  [deletionService.includes("FOR UPDATE") || deletionService.includes('.for("update")') || deletionService.includes("for update"), "Stock Transfer deletion must lock persisted state"],
  [deletionService.includes("replayed"), "Stock Transfer deletion must remain replay-safe"],
  [deletionService.includes("inventoryApplied"), "Stock Transfer deletion must decide reversal from persisted state"],
  [deletionRoute.includes('requireRole("Admin")') || deletionRoute.includes("requireRole('Admin')"), "Stock Transfer deletion must remain Admin-only"],
  [lifecycleCall >= 0 && legacyCall >= 0 && lifecycleCall < legacyCall, "Stock Transfer lifecycle must register before legacy transfer editor"],
  [callIndex("registerCentralStockTransferDeleteRoutes") >= 0, "Central Stock Transfer deletion must remain registered"],
  [phaseDoc.includes("Status: complete"), "Phase 4 documentation must remain complete"],
  [phaseDoc.includes("Mixed bulk deletion") || phaseDoc.includes("bulk deletion"), "Unsafe mixed bulk deletion boundary must remain documented"],
  [phaseDoc.includes("No POS accounting formula"), "Phase 4 formula-preservation boundary must remain documented"],
];
for (const [passed, message] of checks) {
  if (!passed) throw new Error(`Program 2 Phase 4 verification failed: ${message}`);
}
console.log("Program 2 Phase 4 POS and Stock Transfer contract verified.");