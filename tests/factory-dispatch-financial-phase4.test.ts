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

const root = process.cwd();
const file = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const posting = file("server/services/factory/dispatchTripFinancialPosting.ts");
const routes = file("server/routes/factory/customer-orders/loadingDispatchFinancialPostingRoutes.ts");
const legacyFinalize = file("server/routes/factory/customer-orders/finalize-loading/finalize.ts");
const legacyRevert = file("server/routes/factory/customer-orders/finalize-loading/unfinalize.ts");
const lifecycle = file("server/routes/factory/customer-orders/loadingDispatchLifecycleRoutes.ts");
const baleRemoval = file("server/routes/factory/customer-orders/bale-scanning/remove.ts");
const manualGuards = file("docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase4-guards.sql");

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
    expect(posting).toContain("TRIP_JOURNAL_UNBALANCED");
  });

  it("uses the canonical Factory voucher engine with a stable source identity", () => {
    expect(posting).toContain("postFactoryVoucherTx(tx");
    expect(posting).toContain('sourceType: "factory-dispatch-trip"');
    expect(posting).toContain('sourceType: "factory-dispatch-trip-internal"');
    expect(posting).toContain("customerLedgerAccountTx");
    expect(posting).toContain("FACTORY_DISPATCH_CLEARING");
    expect(posting).toContain("keyOf(scope.companyId,scope.dispatchId,revision");
    expect(posting).toContain('kind = \'POST\'');
    expect(posting).not.toContain("tx.insert(customerBalances)");
  });

  it("atomically freezes signed bale quantities before real voucher posting", () => {
    const freeze = posting.indexOf("INSERT INTO factory_dispatch_trip_financial_bales");
    const voucher = posting.indexOf("postFactoryVoucherTx(tx");
    expect(freeze).toBeGreaterThan(0);
    expect(voucher).toBeGreaterThan(freeze);
    expect(posting).toContain("loadDispatchTripFinancialSource");
    expect(posting).toContain("TRIP_CHARGES_CHANGED");
    expect(posting).toContain("TRIP_SOURCE_CHANGED");
    expect(routes).toContain("await db.transaction(tx => postDispatchTripFinancialTx");
  });

  it("does not allow the legacy full invoice to duplicate trip receivables", () => {
    expect(legacyFinalize).toContain("hasAnyPhysicalDispatchTx(tx, companyId, orderId)");
    expect(legacyFinalize).toContain("DISPATCH_CONSOLIDATION_REQUIRED");
    expect(legacyRevert).toContain("hasLiveFinancialTripTx(tx, companyId, orderId)");
    expect(legacyRevert).toContain("DISPATCH_FINANCIAL_REVERSAL_REQUIRED");
  });

  it("blocks physical reopening and returns-to-stock after financial posting", () => {
    expect(lifecycle).toContain("hasLiveFinancialTripTx(tx, scope.companyId, scope.orderId, scope.dispatchId)");
    expect(baleRemoval).toContain("isPostedDispatchBaleTx(tx, companyId, orderId, orderBale.baleId)");
    expect(manualGuards).toContain("factory_dispatch_guard_posted_physical_evidence");
    expect(manualGuards).toContain("factory_dispatch_guard_order_bale_evidence");
  });

  it("requires confirmation, role checks, and an auditable reason before reversal", () => {
    expect(routes).toContain("Only Admin, Owner or Developer");
    expect(routes).toContain('input.confirm !== true');
    expect(routes).toContain("reverseDispatchTripFinancialTx");
    expect(posting).toContain("TRIP_EXPORTED_LOCKED");
    expect(posting).toContain("TRIP_SETTLEMENT_LOCKED");
    expect(posting).toContain("TRIP_CUSTOMER_CREDIT_RECONCILIATION_REQUIRED");
    expect(posting).toContain('"TRIP_POSTING_REVERSED"');
    expect(posting).toContain("mirroredUsdLines");
  });

  it("keeps all new financial tables under explicit company RLS", () => {
    expect(manualGuards).toContain("FORCE ROW LEVEL SECURITY");
    expect(manualGuards).toContain("erp_company_scope_matches(company_id)");
    expect(manualGuards).toContain("factory_dispatch_trip_financials");
    expect(manualGuards).toContain("factory_dispatch_trip_charges");
    expect(manualGuards).toContain("factory_dispatch_financial_events");
  });
});
