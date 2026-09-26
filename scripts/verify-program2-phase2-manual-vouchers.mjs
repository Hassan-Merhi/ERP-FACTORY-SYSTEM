import fs from "node:fs";

const requiredFiles = [
  "server/services/accounting/centralPostingEngine.ts",
  "server/services/accounting/databasePostingDependencies.ts",
  "server/services/accounting/manualJournalPosting.ts",
  "server/services/accounting/genericVoucherPosting.ts",
  "server/services/accounting/employeeBalancePosting.ts",
  "server/services/accounting/voucherLifecycleService.ts",
  "server/routes/vouchers/centralJournalCreateRoute.ts",
  "server/routes/vouchers/centralJournalLifecycleRoute.ts",
  "server/routes/vouchers/centralGenericVoucherCreateRoute.ts",
  "server/routes/voucherRoutes.ts",
  "tests/manual-journal-posting.test.ts",
  "tests/generic-voucher-posting.test.ts",
  "tests/employee-balance-posting.test.ts",
  "docs/archive/program-2-accounting-convergence.md",
  "docs/archive/program-2-phase-2-manual-journals-vouchers.md",
];
for (const file of requiredFiles) if (!fs.existsSync(file)) throw new Error(`Program 2 Phase 2 missing required file: ${file}`);
const read = (file) => fs.readFileSync(file, "utf8");
const engine = read(requiredFiles[0]);
const deps = read(requiredFiles[1]);
const manual = read(requiredFiles[2]);
const generic = read(requiredFiles[3]);
const employee = read(requiredFiles[4]);
const lifecycleService = read(requiredFiles[5]);
const journalCreate = read(requiredFiles[6]);
const journalLifecycle = read(requiredFiles[7]);
const genericCreate = read(requiredFiles[8]);
const routeRegistry = read(requiredFiles[9]);
const phaseDoc = read(requiredFiles[14]);
const before = (a, b) => {
  const left = routeRegistry.indexOf(a);
  const right = routeRegistry.indexOf(b);
  return left >= 0 && right >= 0 && left < right;
};
const checks = [
  [engine.includes("postBalancedVoucherTx"), "central posting entrypoint must remain available"],
  [engine.includes("replayed"), "central posting result must preserve replay status"],
  [deps.includes("createDatabasePostingDependencies"), "database ownership and idempotency adapter must remain available"],
  [manual.includes("buildManualJournalPostingRequest"), "manual journal builder must remain available"],
  [manual.includes("effectiveDate"), "manual journals must preserve effective date"],
  [generic.includes("supportsCentralGenericVoucher"), "generic voucher compatibility boundary must remain explicit"],
  [generic.includes("clientRequestId"), "generic voucher subset must require stable request identity"],
  [employee.includes("applyEmployeeBalanceDeltasTx"), "employee effects must remain transaction-owned"],
  [employee.includes("reverse"), "employee effects must support exact reversal"],
  [lifecycleService.includes("replaceVoucherTx") && lifecycleService.includes("reverseVoucherTx"), "voucher lifecycle service must preserve replace and reverse boundaries"],
  [journalCreate.includes('"/api/vouchers/journal"'), "protected manual journal route must remain mounted"],
  [journalCreate.includes("postBalancedVoucherTx") && journalCreate.includes("db.transaction"), "manual journal route must use central transaction-owned posting"],
  [journalCreate.includes("if (!posted.replayed)") && journalCreate.includes("if (!result.replayed)"), "manual journal effects must be replay-safe"],
  [journalCreate.includes("req.body?.optional === true") && journalCreate.includes("next()"), "optional journal drafts must remain on the compatibility path"],
  [genericCreate.includes('"/api/vouchers/with-entries"'), "protected generic voucher route must remain mounted"],
  [genericCreate.includes("supportsCentralGenericVoucher(req.body)") && genericCreate.includes("postBalancedVoucherTx") && genericCreate.includes("db.transaction"), "generic supported subset must use central transaction-owned posting"],
  [genericCreate.includes("if (!posted.replayed)"), "generic effects must remain replay-safe"],
  [genericCreate.includes("POSTING_LINKED_LEDGER_MISMATCH"), "customer linked-ledger mismatches must remain rejected"],
  [journalLifecycle.includes("voucherMutationBlockReason(existing)") && journalLifecycle.includes('existing.voucherType !== "Journal"'), "migrated and non-Journal lifecycle paths must remain isolated"],
  [journalLifecycle.includes("existing.optional") && journalLifecycle.includes("req.body?.optional === true"), "optional Journal transitions must remain on the legacy path"],
  [before("registerCentralJournalCreateRoute(app);", "registerVoucherJournalRoutes(app);"), "central journal route must register before legacy journal route"],
  [before("registerCentralJournalLifecycleRoutes(app);", "registerVoucherJournalRoutes(app);"), "central journal lifecycle must register before legacy journal route"],
  [before("registerCentralGenericVoucherCreateRoute(app);", "registerVoucherCreateRoutes(app);"), "central generic route must register before legacy generic creator"],
  [phaseDoc.includes("Status: complete") && phaseDoc.includes("No database schema or historical record changed"), "Phase 2 documentation and safety boundary must remain complete"],
];
for (const [passed, message] of checks) if (!passed) throw new Error(`Program 2 Phase 2 verification failed: ${message}`);
console.log("Program 2 Phase 2 manual journal and generic voucher contract verified.");