import fs from "node:fs";

const requiredFiles = [
  "server/routes/factory/factoryRawStockRoutes.ts",
  "server/routes/factory/raw-stock/rawStockContainerRoutes.ts",
  "server/routes/factory/raw-stock/rawStockOffloadRoutes.ts",
  "server/routes/factory/suppliers/crud/suppliers.ts",
  "server/routes/factory/suppliers/broker/_helpers.ts",
  "server/routes/factory/suppliers/balance/with-balances.ts",
  "server/routes/factory/employee-pos/netPositionSupplierBalances.ts",
  "server/services/factory/currencyConversion.ts",
  "server/services/factory/post-offload-charge/apply.ts",
  "server/services/security/postOffloadLedgerOwnershipGuard.ts",
  "docs/archive/program-2-accounting-convergence.md",
  "docs/archive/program-2-phase-5-containers-freight.md",
];
for (const file of requiredFiles) if (!fs.existsSync(file)) throw new Error(`Program 2 Phase 5 missing required file: ${file}`);
const read = (file) => fs.readFileSync(file, "utf8");
const registry = read(requiredFiles[0]);
const container = read(requiredFiles[1]);
const offload = read(requiredFiles[2]);
const supplierCrud = read(requiredFiles[3]);
const broker = read(requiredFiles[4]);
const supplierBalance = read(requiredFiles[5]);
const netPositionSupplierBalances = read(requiredFiles[6]);
const currency = read(requiredFiles[7]);
const mutation = read(requiredFiles[8]);
const ownershipGuard = read(requiredFiles[9]);
const phaseDoc = read(requiredFiles[11]);
const combined = [container, offload, supplierCrud, broker, supplierBalance, netPositionSupplierBalances, mutation].join("\n");

const checks = [
  [phaseDoc.includes("Status: complete"), "Phase 5 documentation must remain complete"],
  [phaseDoc.includes("own-account freight must not be added"), "own-account freight exclusion must remain documented"],
  [phaseDoc.includes("No database schema or historical record changed"), "historical-data safety boundary must remain documented"],
  [registry.includes('app.use("/api/factory/containers", requirePostOffloadLedgerOwnership)'), "post-offload ownership guard must register before container routes"],
  [registry.indexOf("requirePostOffloadLedgerOwnership") < registry.indexOf("registerRawStockContainerRoutes(app);"), "ownership guard must execute before post-offload handlers"],
  [ownershipGuard.includes("inArray(ledgerAccounts.id, ledgerIds)"), "ownership guard must validate every requested ledger"],
  [ownershipGuard.includes("eq(ledgerAccounts.companyId, companyId)"), "ownership guard must require selected-company ownership"],
  [ownershipGuard.includes("eq(ledgerAccounts.active, true)"), "ownership guard must reject inactive ledgers"],
  [ownershipGuard.includes("isNull(ledgerAccounts.deletedAt)"), "ownership guard must reject deleted ledgers"],
  [ownershipGuard.includes("POST_OFFLOAD_LEDGER_COMPANY_MISMATCH"), "ownership mismatch must remain explicit"],
  [ownershipGuard.includes('req.method === "POST"') && ownershipGuard.includes('req.method === "PATCH"'), "POST and PATCH charge paths must both be guarded"],
  [mutation.includes("companyId") && mutation.includes("voucherCompanyId"), "post-offload mutation must retain explicit source and voucher company context"],
  [combined.includes("freight"), "freight handling must remain present"],
  [combined.includes("commission"), "commission handling must remain present"],
  [combined.includes("voucher") || combined.includes("Voucher"), "container accounting voucher linkage must remain present"],
  [combined.includes("supplier"), "supplier accounting linkage must remain present"],
  [combined.includes("currency") || combined.includes("Currency"), "container currency handling must remain present"],
  [currency.includes("resolveStoredFxRate") || currency.includes("exchangeRate"), "stored FX handling must remain explicit"],
  [broker.includes("isSupplierPaidFreight") && broker.includes("freightPaidBy"), "executable broker statement must distinguish supplier-paid from own-account freight"],
  [netPositionSupplierBalances.includes('isSupplierPaidFreight(c) ? parseFloat(c.freight || "0") : 0'), "net position must exclude own-account freight from standalone supplier liabilities"],
  [offload.includes("transaction") || offload.includes("db.transaction"), "offload writes must retain a transaction boundary"],
  [combined.includes("recalculate") || combined.includes("recalc"), "container recalculation boundary must remain present"],
  [phaseDoc.includes("dry-run capable") && phaseDoc.includes("fail closed"), "controlled repair requirements must remain documented"],
  [phaseDoc.includes("mix-batch consumption"), "stable supplier cost-per-kilogram boundary must remain documented"],
];
for (const [passed, message] of checks) if (!passed) throw new Error(`Program 2 Phase 5 verification failed: ${message}`);
console.log("Program 2 Phase 5 container, freight, commission, and post-offload contract verified.");
