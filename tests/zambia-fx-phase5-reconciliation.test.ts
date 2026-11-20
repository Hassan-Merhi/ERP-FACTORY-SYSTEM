/**
 * Phase 5: Zambia book-vs-Sales Report bridge.
 * Pure decimal fixtures from the read-only audit, no production DB access.
 */
import { describe, expect, it } from "vitest";
import {
  bridgeSalesToNetPosition,
  type SalesNetPositionBridgeInput,
} from "../server/services/accounting/salesNetPositionBridge";

const zambia: SalesNetPositionBridgeInput = {
  salesItemsUsd: "11030.31",
  salesReportCostUsd: "7524.09",
  postedSalesLedgerUsd: "11030.32",
  actualInventoryReliefUsd: "7523.79",
  stockOnHandUsd: "90437.09",
  stockOtwUsd: "79579.50",
  purchaseAndLandedCostsUsd: "177540.38",
  cashBookUsd: "10984.69",
  recordedLiabilitiesUsd: "177540.38",
  fxCounterBookDebitUsd: "45.63",
  fxCounterAccountType: "Asset",
  missingCostEvidenceCount: 0,
  unsupportedAccountCount: 0,
  balanceOpeningCount: 0,
};

describe("Phase 5 Zambia Sales ↔ Net Position diagnostic bridge", () => {
  it("explains the $0.31 book-vs-cost-profit gap without making a correcting journal", () => {
    const report = bridgeSalesToNetPosition(zambia);
    expect(report.readOnly).toBe(true);
    expect(report.salesReport).toEqual({
      revenueUsd: "11030.31",
      costUsd: "7524.09",
      costProfitUsd: "3506.22",
    });
    expect(report.ledger.revenueRoundingDifferenceUsd).toBe("0.01");
    expect(report.inventory.actualReliefUsd).toBe("7523.79");
    expect(report.inventory.saleCostDifferenceUsd).toBe("0.30");
    expect(report.inventory.stockSourceResidualUsd).toBe("0.00");
    expect(report.profitBridge).toEqual({
      salesReportProfitAfterFxUsd: "3460.59",
      salesPostingDifferenceUsd: "0.01",
      inventoryReliefDifferenceUsd: "0.30",
      normalizedProfitAfterFxUsd: "3460.90",
      cashAndStockMinusLiabilitiesUsd: "3460.90",
      residualUsd: "0.00",
    });
    expect(report.reportedNetPositionUsd).toBeNull();
    expect(report.fx.misclassified).toBe(true);
    expect(report.status).toBe("needs_review");
    expect(report.blockers).toEqual(["FX_ACCOUNT_CLASSIFICATION_REQUIRED"]);
  });

  it("never declares a fully reconciled FX position while a missing value_moved exists", () => {
    const report = bridgeSalesToNetPosition({
      ...zambia,
      actualInventoryReliefUsd: null,
      missingCostEvidenceCount: 1,
      fxCounterAccountType: "Indirect Expense",
    });
    expect(report.status).toBe("needs_review");
    expect(report.inventory.actualReliefUsd).toBeNull();
    expect(report.profitBridge.normalizedProfitAfterFxUsd).toBeNull();
    expect(report.blockers).toContain("UNRESOLVED_SALE_COST_EVIDENCE");
  });

  it("identifies other funding, stock and open-balance differences instead of hiding them", () => {
    const report = bridgeSalesToNetPosition({
      ...zambia,
      purchaseAndLandedCostsUsd: "177540.08",
      unsupportedAccountCount: 1,
      balanceOpeningCount: 1,
      fxCounterAccountType: "Indirect Expense",
    });
    expect(report.status).toBe("needs_review");
    expect(report.blockers).toContain("STOCK_SOURCE_VALUE_NOT_RECONCILED");
    expect(report.blockers).toContain("FUNDING_LIABILITIES_NOT_RECONCILED");
    expect(report.blockers).toContain("ADDITIONAL_LEDGER_ACCOUNT_ACTIVITY");
    expect(report.blockers).toContain("NONZERO_OPENING_BALANCES");
    expect(report.profitBridge.residualUsd).toBe("0.00");
  });

  it("compares to an actual book Net Position, not to a synthetic FX display row", () => {
    const report = bridgeSalesToNetPosition({
      ...zambia,
      fxCounterAccountType: "Indirect Expense",
    });
    expect(report.status).toBe("reconciled");
    expect(report.reportedNetPositionUsd).toBeNull();
    expect(report.profitBridge.normalizedProfitAfterFxUsd).toBe(
      report.profitBridge.cashAndStockMinusLiabilitiesUsd
    );
  });

  it("detects one-cent source changes with exact decimal arithmetic", () => {
    const report = bridgeSalesToNetPosition({
      ...zambia,
      stockOnHandUsd: "90437.08",
      fxCounterAccountType: "Indirect Expense",
    });
    expect(report.inventory.stockSourceResidualUsd).toBe("-0.01");
    expect(report.profitBridge.residualUsd).toBe("-0.01");
    expect(report.blockers).toContain("NET_POSITION_BRIDGE_NOT_RECONCILED");
  });
});
