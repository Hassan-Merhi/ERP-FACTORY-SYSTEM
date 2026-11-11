/**
 * Phase 4 regression contract. Authored for later developer-run checks.
 * This task intentionally DID NOT execute tests or CI.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MoneyDecimal } from "../server/lib/money";
import { buildTripChargePreview, type TripChargeRow } from
  "../server/routes/factory/customer-orders/loadingDispatchFinancialChargeModel";
import { codeShape, fragmentFor, shaped } from "./helpers/codeShape";

const root = process.cwd();
const file = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const posting = file("server/services/factory/dispatchTripFinancialPosting.ts");
const routes = file("server/routes/factory/customer-orders/loadingDispatchFinancialPostingRoutes.ts");
const legacyFinalize = file("server/routes/factory/customer-orders/finalize-loading/finalize.ts");
const legacyRevert = file("server/routes/factory/customer-orders/finalize-loading/unfinalize.ts");
const lifecycle = file("server/routes/factory/customer-orders/loadingDispatchLifecycleRoutes.ts");
const baleRemoval = file("server/routes/factory/customer-orders/bale-scanning/remove.ts");
const manualGuards = file("docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase4-guards.sql");
const voucherCorrection = file("server/services/accounting/voucherCorrection.ts");
const voucherRetirement = file("server/services/accounting/voucherRetirement.ts");
const voucherOwnership = file("server/services/factory/dispatchTripFinancialGuards.ts");

const charge = (id: number, kind: TripChargeRow["kind"], amount: string): TripChargeRow => ({
  id, name: "charge" + id, kind, amount, currency: "USD", revision: 1,
  ledgerAccountId: id + 100, offsetLedgerAccountId: kind === "INTERNAL" ? 800 : null,
  erpChargeType: null, notes: null, lockedAt: null,
});

describe("Factory trip financial finalization accounting contracts", () => {
  it("balances the signed goods clearing / charge / discount journal to cents", () => {
    const charges = [
      charge(1, "BILLABLE", "7.25"),
      charge(2, "DISCOUNT", "2.10"),
      charge(3, "INTERNAL", "19.30"),
    ];
    const totals = buildTripChargePreview("150.40", charges);
    const debits = new MoneyDecimal(totals.customerTotal).plus(totals.discountTotal);
    const credits = new MoneyDecimal(totals.goodsSubtotal).plus(totals.billableChargesTotal);
    expect(debits.toFixed(2)).toBe("157.65");
    expect(credits.toFixed(2)).toBe("157.65");
    expect(totals.internalExpenseTotal).toBe("19.30");
    expect(shaped(posting)).toContain(fragmentFor(posting, "TRIP_JOURNAL_UNBALANCED"));
  });

  it("uses the canonical Factory voucher engine with a stable source identity", () => {
    expect(shaped(posting)).toContain(fragmentFor(posting, "postFactoryVoucherTx(tx"));
    expect(shaped(posting)).toContain(fragmentFor(posting, 'sourceType: "factory-dispatch-trip"'));
    expect(shaped(posting)).toContain(fragmentFor(posting, 'sourceType: "factory-dispatch-trip-internal"'));
    expect(shaped(posting)).toContain(fragmentFor(posting, "customerLedgerAccountTx"));
    expect(shaped(posting)).toContain(fragmentFor(posting, "FACTORY_DISPATCH_CLEARING"));
    expect(shaped(posting)).toContain(fragmentFor(posting, "keyOf(scope.companyId,scope.dispatchId,revision"));
    expect(shaped(posting)).toContain(fragmentFor(posting, 'kind = \'POST\''));
    expect(shaped(posting)).not.toContain(fragmentFor(posting, "tx.insert(customerBalances)"));
  });

  it("atomically freezes signed bale quantities before real voucher posting", () => {
    const freeze = codeShape(posting).indexOf(codeShape("INSERT INTO factory_dispatch_trip_financial_bales"));
    const voucher = codeShape(posting).indexOf(codeShape("postFactoryVoucherTx(tx"));
    expect(freeze).toBeGreaterThan(0);
    expect(voucher).toBeGreaterThan(freeze);
    expect(shaped(posting)).toContain(fragmentFor(posting, "loadDispatchTripFinancialSource"));
    expect(shaped(posting)).toContain(fragmentFor(posting, "TRIP_CHARGES_CHANGED"));
    expect(shaped(posting)).toContain(fragmentFor(posting, "TRIP_SOURCE_CHANGED"));
    expect(shaped(routes)).toContain(fragmentFor(routes, "await db.transaction(tx => postDispatchTripFinancialTx"));
  });

  it("does not allow the legacy full invoice to duplicate trip receivables", () => {
    expect(shaped(legacyFinalize)).toContain(fragmentFor(legacyFinalize, "hasAnyPhysicalDispatchTx(tx, companyId, orderId)"));
    expect(shaped(legacyFinalize)).toContain(fragmentFor(legacyFinalize, "DISPATCH_CONSOLIDATION_REQUIRED"));
    expect(shaped(legacyRevert)).toContain(fragmentFor(legacyRevert, "hasLiveFinancialTripTx(tx, companyId, orderId)"));
    expect(shaped(legacyRevert)).toContain(fragmentFor(legacyRevert, "DISPATCH_FINANCIAL_REVERSAL_REQUIRED"));
  });

  it("blocks physical reopening and returns-to-stock after financial posting", () => {
    expect(shaped(lifecycle)).toContain(fragmentFor(lifecycle, "hasLiveFinancialTripTx(tx, scope.companyId, scope.orderId, scope.dispatchId)"));
    expect(shaped(baleRemoval)).toContain(fragmentFor(baleRemoval, "isPostedDispatchBaleTx(tx, companyId, orderId, orderBale.baleId)"));
    expect(shaped(manualGuards)).toContain(fragmentFor(manualGuards, "factory_dispatch_guard_posted_physical_evidence"));
    expect(shaped(manualGuards)).toContain(fragmentFor(manualGuards, "factory_dispatch_guard_order_bale_evidence"));
  });

  it("requires confirmation, role checks, and an auditable reason before reversal", () => {
    expect(shaped(routes)).toContain(fragmentFor(routes, "Only Admin, Owner or Developer"));
    expect(shaped(routes)).toContain(fragmentFor(routes, 'input.confirm !== true'));
    expect(shaped(routes)).toContain(fragmentFor(routes, "reverseDispatchTripFinancialTx"));
    expect(shaped(posting)).toContain(fragmentFor(posting, "TRIP_EXPORTED_LOCKED"));
    expect(shaped(posting)).toContain(fragmentFor(posting, "TRIP_SETTLEMENT_LOCKED"));
    expect(shaped(posting)).toContain(fragmentFor(posting, "TRIP_CUSTOMER_CREDIT_RECONCILIATION_REQUIRED"));
    expect(shaped(posting)).toContain(fragmentFor(posting, '"TRIP_POSTING_REVERSED"'));
    expect(shaped(posting)).toContain(fragmentFor(posting, "mirroredUsdLines"));
  });

  it("blocks generic voucher edits, reversals and retirement of finalized-truck vouchers", () => {
    expect(shaped(voucherOwnership)).toContain(fragmentFor(voucherOwnership, "isDispatchFinancialVoucherTx"));
    expect(shaped(voucherCorrection)).toContain(fragmentFor(voucherCorrection, "DISPATCH_TRIP_VOUCHER_LOCKED"));
    expect(shaped(voucherRetirement)).toContain(fragmentFor(voucherRetirement, "DISPATCH_TRIP_VOUCHER_LOCKED"));
    expect(shaped(manualGuards)).toContain(fragmentFor(manualGuards, "factory_dispatch_source_voucher_guard"));
    expect(shaped(manualGuards)).toContain(fragmentFor(manualGuards, "factory_dispatch_source_voucher_entries_guard"));
    expect(shaped(manualGuards)).toContain(fragmentFor(manualGuards, "factory_dispatch_source_posting_identity_guard"));
    expect(shaped(posting)).toContain(fragmentFor(posting, "assertHardenedFinancialSchemaTx(tx)"));
  });

  it("keeps all new financial tables under explicit company RLS", () => {
    expect(shaped(manualGuards)).toContain(fragmentFor(manualGuards, "FORCE ROW LEVEL SECURITY"));
    expect(shaped(manualGuards)).toContain(fragmentFor(manualGuards, "erp_company_scope_matches(company_id)"));
    expect(shaped(manualGuards)).toContain(fragmentFor(manualGuards, "factory_dispatch_trip_financials"));
    expect(shaped(manualGuards)).toContain(fragmentFor(manualGuards, "factory_dispatch_trip_charges"));
    expect(shaped(manualGuards)).toContain(fragmentFor(manualGuards, "factory_dispatch_financial_events"));
  });
});
