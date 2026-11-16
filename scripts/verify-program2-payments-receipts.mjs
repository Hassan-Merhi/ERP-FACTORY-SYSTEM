import fs from "node:fs";

const requiredFiles = [
  "server/services/accounting/paymentReceiptPosting.ts",
  "server/services/accounting/paymentReceiptDeletionPolicy.ts",
  "server/services/accounting/employeeBalancePosting.ts",
  "server/routes/vouchers/centralPaymentReceiptCreateRoute.ts",
  "server/routes/vouchers/centralPaymentReceiptLifecycleRoute.ts",
  "server/routes/vouchers/centralPaymentReceiptDeleteRoute.ts",
  "server/routes/voucherRoutes.ts",
  "tests/payment-receipt-posting.test.ts",
  "tests/payment-receipt-deletion-policy.test.ts",
  "docs/archive/program-2-phase-2b.md",
  "docs/archive/program-2-phase-3-payments-receipts.md",
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) throw new Error(`Program 2 Phase 3 missing required file: ${file}`);
}

const read = (file) => fs.readFileSync(file, "utf8");
const builder = read("server/services/accounting/paymentReceiptPosting.ts");
const policy = read("server/services/accounting/paymentReceiptDeletionPolicy.ts");
const employee = read("server/services/accounting/employeeBalancePosting.ts");
const create = read("server/routes/vouchers/centralPaymentReceiptCreateRoute.ts");
const lifecycle = read("server/routes/vouchers/centralPaymentReceiptLifecycleRoute.ts");
const deletion = read("server/routes/vouchers/centralPaymentReceiptDeleteRoute.ts");
const registry = read("server/routes/voucherRoutes.ts");
const doc = read("docs/archive/program-2-phase-3-payments-receipts.md");

const registrationIndex = (name) => registry.indexOf(`${name}(app`);
const before = (a, b) => registrationIndex(a) >= 0 && registrationIndex(a) < registrationIndex(b);
const checks = [
  [builder.includes("buildPaymentReceiptPostingRequest"), "Payment/Receipt builder must remain available"],
  [builder.includes("clientRequestId"), "creation must preserve stable request identity"],
  [builder.includes("Payment") && builder.includes("Receipt"), "both voucher directions must remain supported"],
  [create.includes('"/api/vouchers/payment-receipt"'), "protected creation route must remain mounted"],
  [create.includes("supportsCentralPaymentReceipt"), "creation compatibility boundary must remain explicit"],
  [create.includes("input.optional === true") && create.includes("next()"), "optional creation must remain legacy passthrough"],
  [create.includes("postBalancedVoucherTx") && create.includes("db.transaction"), "creation must remain centrally posted in one transaction"],
  [create.includes("resolvePaymentReceiptTargetTx"), "creation target resolution must remain company-aware"],
  [create.includes("customerId") && create.includes("ledgerAccountId"), "creation must preserve linked customer/ledger representation"],
  [create.includes("if (!posted.replayed)"), "creation employee and compatibility effects must remain replay-safe"],
  [create.includes("writeFactoryDaybookCompatibility"), "Factory daybook compatibility must remain present"],
  [lifecycle.includes("FOR UPDATE"), "active edit must lock the voucher row"],
  [lifecycle.includes("buildLegacyPaymentReceiptEditTarget"), "edit must preserve legacy single-target representation"],
  [lifecycle.includes('direction: "reverse"') && lifecycle.includes('direction: "apply"'), "edit must reverse old and apply new employee effects"],
  [lifecycle.includes("voucherMutationBlockReason(existing)"), "migrated vouchers must remain read-only"],
  [lifecycle.includes("existing.optional") && lifecycle.includes("body.optional === true") && lifecycle.includes("next()"), "optional edit transitions must remain legacy passthrough"],
  [lifecycle.includes("voucher currency/exchangeRate are not"), "edit currency preservation boundary must remain documented in source"],
  [policy.includes("shouldUseCentralPaymentReceiptDeletion"), "deletion eligibility policy must remain centralized"],
  [deletion.includes('requireRole("Admin")'), "protected deletion must remain Admin-only"],
  [deletion.includes("FOR UPDATE"), "deletion must lock the voucher row"],
  [deletion.includes("replayed: true"), "repeated deletion must return replay status"],
  [deletion.includes('direction: "reverse"'), "deletion must reverse employee effects"],
  [deletion.includes("propertyPayments") && deletion.includes("property_monthly_ledger"), "property payment cleanup must remain transaction-owned"],
  [deletion.includes("interCompanyTransfers") && deletion.includes("intercompanyPaymentRequests"), "intercompany cleanup must remain present"],
  [deletion.includes("salesItemCount") && deletion.includes("next()"), "POS sale Receipts must remain on specialized deletion"],
  [policy.includes("SAL-"), "payroll voucher deletion must remain specialized"],
  [before("registerCentralPaymentReceiptCreateRoute", "registerVoucherPaymentRoutes"), "central creation must register before legacy Payment/Receipt routes"],
  [before("registerCentralPaymentReceiptLifecycleRoutes", "registerVoucherPaymentRoutes"), "central edit must register before legacy Payment/Receipt routes"],
  [before("registerCentralPaymentReceiptDeleteRoute", "registerVoucherPaymentRoutes"), "central deletion must register before legacy Payment/Receipt routes"],
  [employee.includes("applyEmployeeBalanceDeltasTx") && employee.includes("reverse"), "employee effects must retain exact reversal support"],
  [doc.includes("Status: complete"), "Phase 3 documentation must remain complete"],
  [doc.includes("No database schema, historical record, accounting formula"), "Phase 3 safety boundary must remain documented"],
];

for (const [passed, message] of checks) {
  if (!passed) throw new Error(`Program 2 Phase 3 verification failed: ${message}`);
}

console.log("Program 2 Phase 3 Payments and Receipts contract verified.");