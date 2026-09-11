#!/usr/bin/env node
/**
 * audit-write-evidence.mjs
 *
 * Measures evidence left by stock and voucher writes. Existing backlogs are
 * ratcheted by exact file set. Voucher creation is creation-only: updating,
 * deleting or restoring an existing voucher cannot create a duplicate row.
 *
 * Phase 7 additionally freezes the reviewed direct-voucher creator inventory:
 * a brand-new `.insert(vouchers)` / `INSERT INTO vouchers` file fails even if
 * somebody attempts to hide it behind a count-only baseline.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(projectRoot, "config/write-evidence-baseline.json");
const voucherReviewPath = path.join(projectRoot, "config/voucher-write-evidence-review.json");

const EXCLUDED_PREFIXES = ["server/startup-schema/", "server/db.ts", "server/migrations/"];

function writesTable(source, table, camel) {
  const drizzle = new RegExp(String.raw`\.(?:insert|update|delete)\(\s*(?:schema\.)?(?:${table}|${camel})\s*[,)]`);
  const raw = new RegExp(String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?${table}"?\b`, "i");
  return drizzle.test(source) || raw.test(source);
}

function createsTableRow(source, table, camel) {
  const drizzle = new RegExp(String.raw`\.insert\(\s*(?:schema\.)?(?:${table}|${camel})\s*[,)]`);
  const raw = new RegExp(String.raw`\bINSERT\s+INTO\s+"?${table}"?\b`, "i");
  return drizzle.test(source) || raw.test(source);
}

const STOCK_BALANCE_HELPER = /\b(?:adjustInventory|reverseInventoryByExactValue|restoreInventoryByExactValue)\s*\(/;
const STOCK_BALANCE_HELPER_MODULES = new Set([
  "server/inventoryHelper.ts",
  "server/services/inventory/exactValueInventory.ts",
]);

function mutatesStock(file, source) {
  if (STOCK_BALANCE_HELPER_MODULES.has(file)) return false;
  return writesTable(source, "inventory", "inventory") || STOCK_BALANCE_HELPER.test(source);
}

const JOURNAL_WRITER = /\b(?:postStockMovementTx|journalStockTransferLeg)\b/;

const REQUEST_IDENTITY =
  /\b(?:clientRequestId|resolveStockDocumentRequestId|stockDocumentIdempotencyKey|postBalancedVoucherTx|insertInfrastructureVoucherTx|insertInfrastructureVoucher|withDurableFinancialOperation|resolveFinancialOperationKey|financialOperationFingerprint)\b/;

const IDENTITY_OWNING_VOUCHER_WRITERS = new Set([
  "server/services/accounting/voucherPostingService.ts",
  "server/services/accounting/infrastructureVoucherIdentity.ts",
]);

export const PHASE4_OPERATIONAL_REQUEST_BOUNDARY_WRITERS = new Set([
  "server/routes/employees/salaryAdvanceRoutes.ts",
  "server/routes/erp-payroll/bonuses.ts",
  "server/routes/erp-payroll/bulk-adjustments.ts",
  "server/routes/erp-payroll/employee-deposits.ts",
  "server/routes/erp-payroll/runs.ts",
  "server/routes/erp-payroll/withdrawals.ts",
  "server/routes/erp-payroll/worker-payments.ts",
  "server/routes/factory/employee-pos/employee-crud/bulk-payroll.ts",
  "server/routes/factory/employee-pos/employee-crud/bulk-withdraw.ts",
  "server/routes/factory/employee-pos/employee-crud/cash.ts",
  "server/routes/factory/employee-pos/employeeAdvancesBonusRoutes.ts",
  "server/routes/factory/employee-pos/pos-financial/sale-write.ts",
  "server/routes/factory/suppliers/crud/payments.ts",
  "server/routes/payroll/advance-accounting/bulk-repay.ts",
  "server/routes/payroll/advance-accounting/cash.ts",
  "server/routes/payroll/advance-accounting/repay-by-month.ts",
  "server/routes/payroll/advance-accounting/repayment-audit.ts",
  "server/routes/payroll/advance-accounting/repayments.ts",
  "server/routes/payroll/core/mark-paid.ts",
  "server/routes/vouchers/voucherCreateRoutes.ts",
  "server/routes/vouchers/voucherJournalRoutes.ts",
  "server/routes/vouchers/voucherPaymentRoutes.ts",
]);

export const PHASE5_OPERATIONAL_REQUEST_BOUNDARY_WRITERS = new Set([
  "server/routes/containers/offload/create.ts",
  "server/routes/creditNoteRoutes.ts",
  "server/routes/factory/containers/create.ts",
  "server/routes/factory/containers/delete.ts",
  "server/routes/factory/containers/other-charges.ts",
  "server/routes/factory/containers/update.ts",
  "server/routes/factory/customer-orders/orderChargesRoutes.ts",
  "server/routes/factory/factoryTransporterRoutes.ts",
  "server/routes/factory/raw-stock/rawStockAdjRoutes.ts",
  "server/routes/factory/raw-stock/rawStockOffloadRoutes.ts",
  "server/routes/factory/raw-stock/rawStockReverseOffloadRoute.ts",
  "server/routes/payroll/worker-stats-advances/advanceAdminRoutes.ts",
  "server/routes/payroll/worker-stats-advances/advancesRoutes.ts",
  "server/routes/rental/shared/accrual.ts",
  "server/routes/rental/shared/auto-transfer.ts",
  "server/routes/rental/units-contracts/contract-end.ts",
  "server/routes/rental/units-contracts/guarantees.ts",
  "server/routes/sp/spLifecycleRoutes.ts",
  "server/routes/sp/spOffloadLifecycleRoutes.ts",
  "server/routes/sp/spOffloadRoutes.ts",
  "server/routes/sp/spOpeningStockRoutes.ts",
  "server/routes/sp/spSalesRoutes.ts",
]);

export const PHASE6_SPECIAL_PURPOSE_COMPLETED_WRITERS = new Set([
  "server/routes/admin/adminPoFixRoutes.ts",
  "server/routes/creditSalesImportRoutes.ts",
  "server/routes/erp-payroll/runs-migration.ts",
  "server/routes/exchangeRateRoutes.ts",
  "server/routes/factory/docs-users/companyImportRoutes.ts",
  "server/routes/payroll/worker-statement/backfill.ts",
  "server/routes/posImportRoutes.ts",
  "server/routes/rental/rentalAccrualConfigRoutes.ts",
  "server/routes/sp-migration/spMigrationSetupRoutes.ts",
  "server/routes/stockTransferImportRoutes.ts",
  "server/services/rental/reclassifyDeferredRentService.ts",
]);

function sourceFiles(directory, collected = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(absolute, collected);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts") || entry.name.endsWith(".test.ts")) continue;
    collected.push(path.relative(projectRoot, absolute).split(path.sep).join("/"));
  }
  return collected;
}

function reviewedDirectVoucherCreators() {
  const review = JSON.parse(fs.readFileSync(voucherReviewPath, "utf8"));
  const approved = new Set();
  for (const sectionName of ["reviewed", "completed"]) {
    const section = review?.[sectionName] ?? {};
    for (const group of Object.values(section)) {
      if (!group || typeof group !== "object" || !Array.isArray(group.files)) continue;
      for (const file of group.files) approved.add(file);
    }
  }
  return approved;
}

export function auditWriteEvidence() {
  const files = sourceFiles(path.join(projectRoot, "server"))
    .filter((file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)))
    .sort();

  const approvedDirectCreators = reviewedDirectVoucherCreators();
  const unjournalledStockWrites = [];
  const voucherWritesWithoutRequestIdentity = [];
  const unapprovedDirectVoucherCreation = [];
  let journalledStockWrites = 0;
  let voucherWritesWithRequestIdentity = 0;

  for (const file of files) {
    const source = fs.readFileSync(path.join(projectRoot, file), "utf8");

    if (mutatesStock(file, source)) {
      if (JOURNAL_WRITER.test(source)) journalledStockWrites += 1;
      else unjournalledStockWrites.push(file);
    }

    if (createsTableRow(source, "vouchers", "vouchers")) {
      if (!approvedDirectCreators.has(file) && !IDENTITY_OWNING_VOUCHER_WRITERS.has(file)) {
      unapprovedDirectVoucherCreation.push(file);
    }

      if (
        IDENTITY_OWNING_VOUCHER_WRITERS.has(file) ||
        PHASE4_OPERATIONAL_REQUEST_BOUNDARY_WRITERS.has(file) ||
        PHASE5_OPERATIONAL_REQUEST_BOUNDARY_WRITERS.has(file) ||
        PHASE6_SPECIAL_PURPOSE_COMPLETED_WRITERS.has(file) ||
        REQUEST_IDENTITY.test(source)
      ) {
        voucherWritesWithRequestIdentity += 1;
      } else {
        voucherWritesWithoutRequestIdentity.push(file);
      }
    }
  }

  return {
    scannedFiles: files.length,
    unjournalledStockWrites,
    voucherWritesWithoutRequestIdentity,
    unapprovedDirectVoucherCreation,
    journalledStockWrites,
    voucherWritesWithRequestIdentity,
  };
}

function readBaseline() {
  return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
}

export function compareBacklog(label, measured, pinned) {
  const errors = [];
  const notes = [];
  const pinnedSet = new Set(pinned.files);
  const measuredSet = new Set(measured);

  const added = measured.filter((file) => !pinnedSet.has(file));
  const removed = pinned.files.filter((file) => !measuredSet.has(file));

  if (measured.length > pinned.ceiling) {
    errors.push(`${label}: ${measured.length} exceeds the ceiling of ${pinned.ceiling}.`);
  }
  for (const file of added) {
    errors.push(`${label}: ${file} joined the backlog. New write paths must carry the evidence.`);
  }
  if (removed.length > 0) {
    notes.push(
      `${label}: ${removed.length} file(s) left the backlog. Re-pin with UPDATE_WRITE_EVIDENCE_BASELINE=1 to lock the improvement in: ${removed.join(", ")}`
    );
  }
  return { errors, notes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditWriteEvidence();

  if (process.env.UPDATE_WRITE_EVIDENCE_BASELINE === "1") {
    const existing = readBaseline();
    if (result.unapprovedDirectVoucherCreation.length > 0) {
      console.error(
        `Refusing to re-pin: ${result.unapprovedDirectVoucherCreation.length} unreviewed direct voucher creator(s): ` +
          result.unapprovedDirectVoucherCreation.join(", ")
      );
      process.exit(1);
    }
    const updated = {
      ...existing,
      stockWritesWithoutJournalEvidence: {
        ...existing.stockWritesWithoutJournalEvidence,
        ceiling: result.unjournalledStockWrites.length,
        files: result.unjournalledStockWrites,
      },
      voucherWritesWithoutRequestIdentity: {
        ...existing.voucherWritesWithoutRequestIdentity,
        ceiling: result.voucherWritesWithoutRequestIdentity.length,
        files: result.voucherWritesWithoutRequestIdentity,
      },
    };
    fs.writeFileSync(baselinePath, `${JSON.stringify(updated, null, 2)}\n`);
    console.log(
      `Re-pinned: ${result.unjournalledStockWrites.length} unjournalled stock writes, ` +
        `${result.voucherWritesWithoutRequestIdentity.length} voucher writes without request identity.`
    );
    process.exit(0);
  }

  const baseline = readBaseline();
  const stock = compareBacklog(
    "Stock writes without journal evidence",
    result.unjournalledStockWrites,
    baseline.stockWritesWithoutJournalEvidence
  );
  const vouchers = compareBacklog(
    "Voucher writes without request identity",
    result.voucherWritesWithoutRequestIdentity,
    baseline.voucherWritesWithoutRequestIdentity
  );
  const errors = [...stock.errors, ...vouchers.errors];
  const notes = [...stock.notes, ...vouchers.notes];

  for (const file of result.unapprovedDirectVoucherCreation) {
    errors.push(
      `Direct voucher creation escape hatch: ${file} creates vouchers directly but is absent from the reviewed creation inventory.`
    );
  }

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ...result, errors, notes }, null, 2)}\n`);
  } else {
    console.log(
      `Write evidence across ${result.scannedFiles} server files: ` +
        `${result.unjournalledStockWrites.length} stock writes without journal evidence ` +
        `(ceiling ${baseline.stockWritesWithoutJournalEvidence.ceiling}), ` +
        `${result.voucherWritesWithoutRequestIdentity.length} voucher writes without request identity ` +
        `(ceiling ${baseline.voucherWritesWithoutRequestIdentity.ceiling}), ` +
        `${result.unapprovedDirectVoucherCreation.length} unapproved direct voucher creators.`
    );
    for (const note of notes) console.log(`NOTE: ${note}`);
    for (const error of errors) console.error(`ERROR: ${error}`);
  }

  process.exitCode = errors.length === 0 ? 0 : 1;
}
