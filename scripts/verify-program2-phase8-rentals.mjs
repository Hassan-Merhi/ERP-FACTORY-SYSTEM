import fs from "node:fs";

const files = {
  service: "server/services/rental/rentalPaymentPostingService.ts",
  deletionService: "server/services/rental/rentalPaymentDeletionService.ts",
  deletionRoute: "server/routes/rental/centralRentalPaymentDeletionRoute.ts",
  registry: "server/routes/rental/index.ts",
  routes: "server/routes/rental/rentalPaymentsAccrualRoutes.ts",
  deleteRoute: "server/routes/vouchers/centralPaymentReceiptDeleteRoute.ts",
  doc: "docs/archive/program-2-phase-8-rentals.md",
};

const read = (path) => fs.readFileSync(path, "utf8");
const assertHas = (text, marker, label) => {
  if (!text.includes(marker)) throw new Error(`Missing ${label}: ${marker}`);
};

for (const path of Object.values(files)) {
  if (!fs.existsSync(path)) throw new Error(`Required file missing: ${path}`);
}

const service = read(files.service);
const deletionService = read(files.deletionService);
const deletionRoute = read(files.deletionRoute);
const registry = read(files.registry);
const routes = read(files.routes);
const deletion = read(files.deleteRoute);
const doc = read(files.doc);

assertHas(service, "pg_advisory_xact_lock", "scheduled-posting advisory lock");
assertHas(service, "${propertyPayments.postingStatus} = 'POSTED'", "posted-payment authority");
assertHas(service, "normalizeVoucherEntryAmounts", "historical currency normalization");
assertHas(service, "...normEntry(accrualAmt.toFixed(2), \"0\")", "accrued-rent debit");
assertHas(service, "...normEntry(advanceAmt.toFixed(2), \"0\")", "advance-rent debit");
assertHas(service, "...normEntry(prepaidAmt.toFixed(2), \"0\")", "prepaid-rent debit");
assertHas(service, "...normEntry(\"0\", totalAmountStr)", "cash credit");
assertHas(service, "usedAdvanceAccount", "advance-account state");
assertHas(service, "usedPrepaidAccount", "prepaid-account state");

assertHas(deletionService, "pg_advisory_xact_lock", "deletion advisory lock");
assertHas(deletionService, '.for("update")', "payment row locks");
assertHas(deletionService, "paymentGroupId", "group-owned deletion");
assertHas(deletionService, "await tx.delete(propertyPayments)", "atomic payment deletion");
assertHas(deletionService, "SUM(pp.amount::numeric)", "authoritative paid-total recomputation");
assertHas(deletionService, "posting_status = 'POSTED'", "posted-only ledger recomputation");
assertHas(deletionRoute, "deleteRentalPaymentGroup", "central deletion service usage");

const centralIndex = registry.indexOf("registerCentralRentalPaymentDeletionRoute(app, module, urlPrefix);");
const legacyIndex = registry.indexOf("registerRentalPaymentsAccrualRoutes(app, module, urlPrefix");
if (centralIndex < 0 || legacyIndex < 0 || centralIndex >= legacyIndex) {
  throw new Error("Central rental deletion must register before the legacy fallback route");
}

assertHas(routes, "createRentalPaymentGroup", "payment creation service usage");
assertHas(routes, "postDueScheduledRentalPayments", "scheduled posting service usage");
assertHas(routes, "scheduleFuturePayment", "future scheduling boundary");
assertHas(routes, "isSharedPayment", "shared-company boundary");
assertHas(deletion, "propertyPayments", "generic deletion compatibility cleanup");
assertHas(deletion, "paid_amount = GREATEST", "generic monthly-ledger reversal compatibility");
assertHas(doc, "Scheduled payments remain non-posting", "scheduled-payment contract");
assertHas(doc, "POSTED payment rows", "authoritative paid-total contract");
assertHas(doc, "Repeated deletion or scheduled posting", "replay-safe lifecycle contract");

console.log("Program 2 Phase 8 rental accounting verifier passed.");
