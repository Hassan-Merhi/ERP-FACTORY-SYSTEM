import fs from "node:fs";

const phaseDocumentPath = "docs/archive/program-2-phase-1-accounting-foundation.md";
const inventoryPath = "docs/program-2-posting-path-inventory.json";
const accountingBoundaryPath = "server/services/accounting/index.ts";
const requiredFiles = [
  phaseDocumentPath,
  inventoryPath,
  accountingBoundaryPath,
  "server/services/accounting/centralPostingEngine.ts",
  "server/services/accounting/databasePostingDependencies.ts",
  "server/services/accounting/manualJournalPosting.ts",
  "server/services/accounting/genericVoucherPosting.ts",
  "server/services/accounting/paymentReceiptPosting.ts",
  "server/services/accounting/paymentReceiptDeletionPolicy.ts",
  "server/services/accounting/customerLinkedLedgerValidation.ts",
  "server/services/accounting/employeeBalancePosting.ts",
  "server/services/accounting/voucherLifecycleService.ts",
  "server/services/accounting/partyReconciliationService.ts",
  "server/services/accounting/periodLockService.ts",
  "server/services/accounting/reconciliationRepairService.ts",
  "server/routes/voucherRoutes.ts",
  "server/services/pos/createSaleService.ts",
  "server/services/pos/edit/updateSaleService.ts",
  "server/services/stockTransferDeletion.ts",
  "server/routes/factory/raw-stock/rawStockContainerRoutes.ts",
  "server/services/factory/post-offload-charge/index.ts",
  "server/routes/factory/raw-stock/rawStockAdjRoutes.ts",
  "server/routes/factory/customer-orders/orderChargesRoutes.ts",
  "server/routes/factory/suppliers/broker/index.ts",
  "server/services/pos/postSaleAccounting.ts",
  "server/routes/sp-migration/index.ts",
  "server/routes/erp-payroll/index.ts",
  "server/services/rental/rentalPaymentPostingService.ts",
  "server/routes/rental/rentalPaymentsAccrualRoutes.ts",
  "docs/archive/program-2-accounting-convergence.md",
  "docs/archive/program-2-phase-2b.md",
  "docs/archive/program-2-phase-2c.md",
  "docs/archive/program-2d-special-workflows.md",
];
for (const file of requiredFiles) if (!fs.existsSync(file)) throw new Error(`Program 2 Phase 1 missing required file: ${file}`);

const phaseDocument = fs.readFileSync(phaseDocumentPath, "utf8");
const accountingBoundary = fs.readFileSync(accountingBoundaryPath, "utf8");
const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
const requiredDocumentMarkers = [
  "Status: complete",
  "Balanced decimal posting",
  "One transaction owner",
  "Company ownership",
  "Deterministic source identity",
  "Replay safety",
  "Historical currency preservation",
  "Exact lifecycle reversal",
  "Period-lock enforcement",
  "Read-only migrated records",
  "Explicit compatibility boundary",
  "No production repair",
  "Focused regression evidence",
  "No runtime route, database schema, posting calculation, balance, inventory, costing, permission, or UI behavior changed",
];
for (const marker of requiredDocumentMarkers) if (!phaseDocument.includes(marker)) throw new Error(`Program 2 Phase 1 contract missing marker: ${marker}`);

const exportBlocks = [...accountingBoundary.matchAll(/export\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["'];/g)].map((match) => match[1]).join("\n");
const requiredBoundaryExports = [
  "postBalancedVoucherTx",
  "createDatabasePostingDependencies",
  "buildManualJournalPostingRequest",
  "buildGenericVoucherPostingRequest",
  "buildPaymentReceiptPostingRequest",
  "assertCustomerLinkedLedgerPairs",
  "applyEmployeeBalanceDeltasTx",
  "replaceVoucherTx",
  "reverseVoucherTx",
  "reconcileTargetTx",
  "assertPeriodOpenTx",
  "generateReconciliationReportTx",
  "executeApprovedRepairsTx",
];
for (const exportedName of requiredBoundaryExports) {
  const declaration = new RegExp(`(?:^|[,\\s])${exportedName}(?:\\s+as\\s+\\w+)?(?:[,\\s]|$)`);
  if (!declaration.test(exportBlocks)) throw new Error(`Accounting public boundary no longer exports ${exportedName}`);
}

if (inventory.program !== "Program 2 — Accounting Convergence") throw new Error("Program 2 inventory has the wrong program identifier");
if (inventory.phase !== "Phase 1 — Accounting convergence foundation") throw new Error("Program 2 inventory has the wrong phase identifier");
if (inventory.status !== "complete") throw new Error("Program 2 Phase 1 inventory must remain complete");
if (inventory.authoritativeBoundary !== accountingBoundaryPath) throw new Error("Program 2 inventory must identify the accounting public boundary");

const requiredClassifications = new Map([
  ["manual-journal", "hybrid"],
  ["generic-voucher", "hybrid"],
  ["payment-receipt", "hybrid"],
  ["pos-sale", "legacy-isolated"],
  ["stock-transfer", "legacy-isolated"],
  ["container-offload-and-freight", "legacy-isolated"],
  ["raw-stock-adjustment", "legacy-isolated"],
  ["customer-order-charges", "legacy-isolated"],
  ["supplier-partner", "legacy-isolated"],
  ["payroll", "legacy-isolated"],
  ["rentals-properties", "legacy-isolated"],
  ["reconciliation-and-repair", "read-only-or-repair"],
]);
const domains = Array.isArray(inventory.domains) ? inventory.domains : [];
const seen = new Set();
for (const domain of domains) {
  if (!domain || typeof domain !== "object") throw new Error("Program 2 inventory contains an invalid domain entry");
  if (!requiredClassifications.has(domain.id)) throw new Error(`Program 2 inventory contains an unreviewed domain: ${domain.id}`);
  if (seen.has(domain.id)) throw new Error(`Program 2 inventory contains duplicate domain: ${domain.id}`);
  seen.add(domain.id);
  const requiredClassification = requiredClassifications.get(domain.id);
  if (domain.classification !== requiredClassification) throw new Error(`Program 2 domain ${domain.id} must remain ${requiredClassification}, found ${domain.classification}`);
  if (!Array.isArray(domain.entryPoints) || domain.entryPoints.length === 0) throw new Error(`Program 2 domain ${domain.id} must list entry points`);
  if (!Array.isArray(domain.evidence) || domain.evidence.length === 0) throw new Error(`Program 2 domain ${domain.id} must list evidence files`);
  for (const evidencePath of domain.evidence) if (!fs.existsSync(evidencePath)) throw new Error(`Program 2 domain ${domain.id} references missing evidence: ${evidencePath}`);
  if (domain.classification === "hybrid" && (!domain.centralizedSubset || !domain.passthrough)) throw new Error(`Hybrid Program 2 domain ${domain.id} must define centralizedSubset and passthrough`);
  if ((domain.classification === "legacy-isolated" || domain.classification === "read-only-or-repair") && !domain.reason) throw new Error(`Deferred Program 2 domain ${domain.id} must explain its isolation reason`);
}
for (const id of requiredClassifications.keys()) if (!seen.has(id)) throw new Error(`Program 2 inventory is missing domain: ${id}`);

const requiredInvariants = [
  "balanced-decimal-posting",
  "single-transaction-owner",
  "company-ownership-validation",
  "deterministic-source-identity",
  "payload-fingerprint",
  "replay-safe-side-effects",
  "historical-currency-preservation",
  "exact-edit-and-delete-reversal",
  "period-lock-before-first-write",
  "read-only-migrated-record-protection",
  "explicit-compatibility-passthrough",
  "no-silent-historical-repair",
  "focused-regression-coverage",
];
const inventoryInvariants = new Set(Array.isArray(inventory.requiredInvariants) ? inventory.requiredInvariants : []);
for (const invariant of requiredInvariants) if (!inventoryInvariants.has(invariant)) throw new Error(`Program 2 inventory is missing invariant: ${invariant}`);
console.log("Program 2 Phase 1 accounting foundation contract verified.");