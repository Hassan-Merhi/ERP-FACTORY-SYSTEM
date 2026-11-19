import { describe, expect, it } from "vitest";
import { readModuleFamily } from "../../../scripts/lib/readModuleFamily.mjs";

const routeSource = readModuleFamily(new URL("./spGoldenCoastPosSaleDeductionsRoutes.ts", import.meta.url));
const autoHadiSource = readModuleFamily(new URL("./goldenCoastAutoHadi.ts", import.meta.url));
const spIndexSource = readModuleFamily(new URL("./index.ts", import.meta.url));
const phase5RouteSource = readModuleFamily(new URL("./spGoldenCoastPosSalePostingRoutes.ts", import.meta.url));
const phase6ServiceSource = readModuleFamily(
  new URL("../../services/accounting/goldenCoastSpecialLocationDeduction.ts", import.meta.url)
);

describe("Golden Coast Phase 6 POS sale route", () => {
  it("is the canonical mounted Golden Coast sale surface", () => {
    expect(spIndexSource).toContain("registerSpGoldenCoastPhase6PosSaleRoutes(app);");
    expect(spIndexSource).not.toContain("registerSpGoldenCoastPhase5PosSaleRoutes(app);");
    expect(routeSource).toContain('"/api/sp/golden-coast/phase6/pos-sale"');
    expect(phase5RouteSource).toContain('"/api/sp/golden-coast/phase5/pos-sale"');
  });

  it("keeps FIFO revenue and COGS posting inside one transaction", () => {
    expect(routeSource).toContain("db.transaction(async (tx) =>");
    expect(routeSource).toContain("pg_advisory_xact_lock");
    expect(routeSource).toContain("planGoldenCoastPhase5Sale");
    expect(routeSource).toContain("buildGoldenCoastPhase5SalePostings");
    expect(routeSource).toContain("adjustSpInventoryAtomic");
    expect(routeSource).toContain("postBalancedVoucherTx");
  });

  it("uses the existing location-level per-unit deduction configuration", () => {
    expect(routeSource).toContain("supplierPartnerPayableDeductionPerQty");
    expect(routeSource).toContain("GC_PHASE6_SPECIAL_LOCATION_AMBIGUOUS");
    expect(routeSource).toContain("configured.length > 1");
  });

  it("allows only one active positive-deduction location", () => {
    expect(routeSource).toContain("CAST(${locations.supplierPartnerPayableDeductionPerQty} AS numeric) > 0");
    expect(routeSource).toContain("Golden Coast allows exactly one special deduction location");
  });

  it("validates canonical account types and matches Phase 5 line-level revenue rounding", () => {
    expect(routeSource).toContain("definition.acceptedAccountTypes.includes(account.accountType)");
    expect(routeSource).toContain("times(new Decimal(line.unitPriceUsd)).toDecimalPlaces(2)");
  });

  it("does not reactivate the retired Phase 1 location-sale mutation source", () => {
    expect(routeSource).not.toContain('sourceType: "location_sale"');
    expect(phase6ServiceSource).not.toContain('sourceType: "location_sale"');
  });

  it("credits the deduction to canonical Hassan Savings and debits GC Sales Cash", () => {
    for (const role of ["gc_sales_cash", "stock_in_hand", "hassan_savings"]) {
      expect(routeSource).toContain(`"${role}"`);
    }
    expect(routeSource).toContain("gcSalesCashAccountId: saleSide.id");
    expect(routeSource).toContain("hassanSavingsAccountId: hassanSavings.id");
    expect(phase6ServiceSource).toContain("ledgerAccountId: gcSalesCashAccountId");
    expect(phase6ServiceSource).toContain("debitAmount: plan.deductionUsd");
    expect(phase6ServiceSource).toContain("ledgerAccountId: hassanSavingsAccountId");
    expect(phase6ServiceSource).toContain("creditAmount: plan.deductionUsd");
  });

  it("keeps the special deduction in the same transaction as the sale", () => {
    const txIndex = routeSource.indexOf("db.transaction(async (tx) =>");
    const deductionIndex = routeSource.indexOf(
      "const deductionRequest = buildGoldenCoastPhase6SpecialLocationDeductionPosting",
      txIndex
    );
    const returnIndex = routeSource.indexOf("return { replayed: false as const", txIndex);
    expect(txIndex).toBeGreaterThan(-1);
    expect(deductionIndex).toBeGreaterThan(txIndex);
    expect(deductionIndex).toBeLessThan(returnIndex);
  });

  it("binds deduction replay to the originating sale and deduction configuration", () => {
    expect(routeSource).toContain("goldenCoastPhase6IdempotencyKey");
    expect(routeSource).toContain("goldenCoastPhase6SourceId");
    expect(routeSource).toContain("GC_PHASE6_IDEMPOTENCY_CONFLICT");
    expect(routeSource).toContain("GC_PHASE6_IDEMPOTENCY_INCONSISTENT");
  });

  it("delegates the Fresh Start claim reclassification without touching Hassan equity", () => {
    expect(autoHadiSource).toContain("buildGoldenCoastPhase15SalesPayablePosting");
    expect(autoHadiSource).not.toContain('eq(ledgerAccounts.subType, "gc_owner_capital")');
  });

  it("keeps old Phase 5 code present for history while making it unreachable", () => {
    expect(phase5RouteSource).toContain("registerSpGoldenCoastPhase5PosSaleRoutes");
    expect(spIndexSource).not.toContain('from "./spGoldenCoastPosSalePostingRoutes"');
  });
});
