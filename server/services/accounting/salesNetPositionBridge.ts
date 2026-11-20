/**
 * Phase 5: explicit bridge between recorded Sales Report cost, actual stock
 * relief and management Net Position. This is diagnostic arithmetic ONLY:
 * never infer that Sales Cost Profit must equal Assets - Liabilities for
 * arbitrary companies, periods, loan movements or opening balances.
 */
import Decimal from "decimal.js";

export interface SalesNetPositionBridgeInput {
  salesItemsUsd: string;
  salesReportCostUsd: string;
  postedSalesLedgerUsd: string;
  actualInventoryReliefUsd: string | null;
  stockOnHandUsd: string;
  stockOtwUsd: string;
  purchaseAndLandedCostsUsd: string;
  cashBookUsd: string;
  recordedLiabilitiesUsd: string;
  fxCounterBookDebitUsd: string;
  fxCounterAccountType: string | null;
  missingCostEvidenceCount: number;
  unsupportedAccountCount: number;
  balanceOpeningCount: number;
}

export interface SalesNetPositionBridge {
  status: "reconciled" | "needs_review";
  blockers: string[];
  readOnly: true;
  salesReport: { revenueUsd: string; costUsd: string; costProfitUsd: string };
  ledger: { postedRevenueUsd: string; revenueRoundingDifferenceUsd: string };
  inventory: {
    reportCostUsd: string;
    actualReliefUsd: string | null;
    saleCostDifferenceUsd: string | null;
    stockOnHandUsd: string;
    stockOtwUsd: string;
    sourceFundingUsd: string;
    stockSourceResidualUsd: string | null;
  };
  fx: { bookedDebitUsd: string; accountType: string | null; misclassified: boolean };
  profitBridge: {
    salesReportProfitAfterFxUsd: string;
    salesPostingDifferenceUsd: string;
    inventoryReliefDifferenceUsd: string | null;
    normalizedProfitAfterFxUsd: string | null;
    cashAndStockMinusLiabilitiesUsd: string;
    residualUsd: string | null;
  };
  /** Net Position's report-only synthetic FX row is NOT part of book profit. */
  reportedNetPositionUsd: null;
}

const money = (value: Decimal.Value) => new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const fixed = (value: Decimal) => value.toFixed(2);

export function bridgeSalesToNetPosition(input: SalesNetPositionBridgeInput): SalesNetPositionBridge {
  const reportSales = money(input.salesItemsUsd);
  const reportCost = money(input.salesReportCostUsd);
  const postedSales = money(input.postedSalesLedgerUsd);
  const bookCash = money(input.cashBookUsd);
  const stock = money(input.stockOnHandUsd);
  const otw = money(input.stockOtwUsd);
  const funding = money(input.purchaseAndLandedCostsUsd);
  const liabilities = money(input.recordedLiabilitiesUsd);
  const fxDebit = money(input.fxCounterBookDebitUsd);
  const storedProfit = reportSales.minus(reportCost);
  const salesDifference = postedSales.minus(reportSales);
  const assetsMinusLiabilities = bookCash.plus(stock).plus(otw).minus(liabilities);
  const blockers: string[] = [];
  if (input.missingCostEvidenceCount > 0 || input.actualInventoryReliefUsd === null) {
    blockers.push("UNRESOLVED_SALE_COST_EVIDENCE");
  }
  if (input.unsupportedAccountCount > 0) blockers.push("ADDITIONAL_LEDGER_ACCOUNT_ACTIVITY");
  if (input.balanceOpeningCount > 0) blockers.push("NONZERO_OPENING_BALANCES");
  if (input.fxCounterAccountType !== null && input.fxCounterAccountType !== "Indirect Expense") {
    blockers.push("FX_ACCOUNT_CLASSIFICATION_REQUIRED");
  }

  const actualRelief = input.actualInventoryReliefUsd === null ? null : money(input.actualInventoryReliefUsd);
  const inventoryDifference = actualRelief === null ? null : reportCost.minus(actualRelief);
  const sourceResidual = actualRelief === null ? null : stock.plus(otw).plus(actualRelief).minus(funding);
  const normalizedProfit = actualRelief === null ? null : postedSales.minus(actualRelief).minus(fxDebit);
  const residual = normalizedProfit === null ? null : assetsMinusLiabilities.minus(normalizedProfit);
  if (sourceResidual !== null && !sourceResidual.isZero()) blockers.push("STOCK_SOURCE_VALUE_NOT_RECONCILED");
  if (!funding.eq(liabilities)) blockers.push("FUNDING_LIABILITIES_NOT_RECONCILED");
  if (residual !== null && !residual.isZero()) blockers.push("NET_POSITION_BRIDGE_NOT_RECONCILED");

  return {
    status: blockers.length === 0 ? "reconciled" : "needs_review",
    blockers,
    readOnly: true,
    salesReport: {
      revenueUsd: fixed(reportSales),
      costUsd: fixed(reportCost),
      costProfitUsd: fixed(storedProfit),
    },
    ledger: {
      postedRevenueUsd: fixed(postedSales),
      revenueRoundingDifferenceUsd: fixed(salesDifference),
    },
    inventory: {
      reportCostUsd: fixed(reportCost),
      actualReliefUsd: actualRelief === null ? null : fixed(actualRelief),
      saleCostDifferenceUsd: inventoryDifference === null ? null : fixed(inventoryDifference),
      stockOnHandUsd: fixed(stock),
      stockOtwUsd: fixed(otw),
      sourceFundingUsd: fixed(funding),
      stockSourceResidualUsd: sourceResidual === null ? null : fixed(sourceResidual),
    },
    fx: {
      bookedDebitUsd: fixed(fxDebit),
      accountType: input.fxCounterAccountType,
      misclassified: input.fxCounterAccountType !== null && input.fxCounterAccountType !== "Indirect Expense",
    },
    profitBridge: {
      salesReportProfitAfterFxUsd: fixed(storedProfit.minus(fxDebit)),
      salesPostingDifferenceUsd: fixed(salesDifference),
      inventoryReliefDifferenceUsd: inventoryDifference === null ? null : fixed(inventoryDifference),
      normalizedProfitAfterFxUsd: normalizedProfit === null ? null : fixed(normalizedProfit),
      cashAndStockMinusLiabilitiesUsd: fixed(assetsMinusLiabilities),
      residualUsd: residual === null ? null : fixed(residual),
    },
    reportedNetPositionUsd: null,
  };
}
