// Extracted from ./unifiedAccountingDashboard.ts
import Decimal from "decimal.js";
import { fxDay } from "./monetaryFxRates";
import { type StatementLine, type StatementSection } from "./professionalFinancialStatements";

export const D = (v: unknown) => new Decimal(String(v ?? 0));

export const fmt = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export type ValuationBasis = "cost" | "selling";

const INVENTORY_CODES = new Set([
  "INVENTORY",
  "GOODS_IN_TRANSIT",
  "FACTORY_RAW_MATERIAL_STOCK",
  "FACTORY_WIP",
  "FACTORY_FINISHED_GOODS",
  "FACTORY_GOODS_IN_TRANSIT",
]);

function lineTotal(lines: StatementLine[], test: (row: StatementLine) => boolean) {
  return fmt(lines.filter(test).reduce((a, l) => a.plus(D(l.amountUsd)), new Decimal(0)));
}

export function stockAccount(l: StatementLine) {
  return l.kind === "ledger" && INVENTORY_CODES.has(String(l.code ?? "").toUpperCase());
}

function family(
  line: StatementLine
): "cash_and_banks" | "customer_and_party" | "recognized_inventory" | "fixed_assets" | "other" {
  const t = String(line.accountType ?? "").toLowerCase();
  if (stockAccount(line)) return "recognized_inventory";
  if (line.kind === "bank" || ["bank", "cash"].includes(t)) return "cash_and_banks";
  if (["customer", "supplier", "factorySupplier", "employee"].includes(line.kind)) return "customer_and_party";
  if (line.kind === "fixedAsset" || t === "fixed asset" || t === "fixed assets") return "fixed_assets";
  return "other";
}

export function breakdown(section: StatementSection) {
  const categories = {
    cash_and_banks: "0.00",
    customer_and_party: "0.00",
    recognized_inventory: "0.00",
    fixed_assets: "0.00",
    other: "0.00",
  };
  for (const key of Object.keys(categories) as Array<keyof typeof categories>)
    categories[key] = lineTotal(section.lines, (l) => family(l) === key);
  return categories;
}

export interface FactoryInventory {
  rawUsd: string;
  wipUsd: string;
  finishedUsd: string;
  totalUsd: string;
  unvaluedCount: number;
  unvaluedSample: Array<{ source: string; id: number; reason: string }>;
  reservedForOrders: { bales: number; cost: string };
  soldNotInvoiced: { bales: number; cost: string };
  basis: "CURRENT_COST_ONLY";
}

export interface UnifiedAccountingDashboard {
  companyId: number;
  asOfDate: string;
  fromDate: string;
  currency: "USD";
  presentation: "STANDALONE_BOOKED_NOT_GROUP_CONSOLIDATED";
  source: "POSTED_GENERAL_LEDGER_AND_EXISTING_ACCOUNTING_ENGINE";
  financialPosition: {
    assetsUsd: string;
    liabilitiesUsd: string;
    netAssetsUsd: string;
    equityIncludingEarningsUsd: string;
    // Assets - liabilities - recognized equity, before unresolved accounts.
    reportedBalanceSheetDifferenceUsd: string;
    // The remaining ledger difference after separately disclosing unknown rows.
    unexplainedDifferenceUsd: string;
    trialBalanceDifferenceUsd: string;
    cashAndBanksUsd: string;
    liabilitiesAndEquityUsd: string;
    assetClasses: ReturnType<typeof breakdown>;
    liabilityClasses: ReturnType<typeof breakdown>;
    unclassifiedUsd: string;
    unclassifiedAccounts: number;
    isBalanced: boolean;
  };
  performance: {
    salesRevenueUsd: string;
    otherIncomeUsd: string;
    costOfSalesUsd: string;
    operatingExpensesUsd: string;
    grossProfitUsd: string;
    netProfitUsd: string;
    recognizedCashMovementUsd: string;
    cashFlowClassificationDifferenceUsd: string;
    periodBasis: "POSTED_PERIOD_FROM_THROUGH_AS_OF";
  };
  controls: {
    certified: false;
    trialBalanceBalanced: boolean;
    historicalMasterValuesUnversioned: true;
    bookedFiguresDoNotContainUnpostedOperationalAssets: true;
    cashFlowClassificationCertified: false;
    perpetualPostingGloballyReady: boolean;
    blockers: string[];
    warnings: string[];
  };
  operations: {
    requestedValuationBasis: ValuationBasis;
    financialStatementValuationBasis: "historical_booked_cost";
    perpetualStockLedgerActiveAsOf: boolean;
    cutover: { effectiveFrom: string; openingVoucherId: number | null } | null;
    erpStock: {
      costUsd: string;
      subLedgerSignedUsd: string;
      asOfBasis: "as-of" | "current";
      shortageValueUsd: string;
      unitemizedMovementValueUsd: string;
      anomalousRows: number;
      locations: number;
    } | null;
    factoryStock: FactoryInventory | null;
    bookedStockAssetUsd: string;
    // Null on past dates: current Factory cost cannot be combined with ERP
    // historic cost and labeled a common-date management valuation.
    managementCostCandidateUsd: string | null;
    managementCostCandidateBasis:
      "CURRENT_COST_MEMO" | "WITHHELD_MIXED_DATES" | "WITHHELD_INCOMPLETE_COST" | "NOT_LOADED";
    managementSellingValueUsd: null;
    managementSellingValueAvailableIn: "EXISTING_FACTORY_NET_POSITION";
    glToOperationalAtCost: Array<{
      accountCode: string;
      bookedGlUsd: string;
      operationalCostUsd: string | null;
      differenceUsd: string | null;
      comparable: boolean;
      reason: string;
    }>;
    operationalAmountsAddedToBookedNetAssets: false;
    completeness: {
      factoryHistoricalValuationAvailable: boolean;
      erpHistoricalValuationAvailable: boolean;
      stockCostFullyValued: boolean;
    };
    warnings: string[];
  };
  drilldown: {
    topAssetAccounts: StatementLine[];
    topLiabilities: StatementLine[];
    topRevenueAccounts: StatementLine[];
    topCostAccounts: StatementLine[];
    topExpenses: StatementLine[];
  };
  disclosures: string[];
  reportStatus: "PROVISIONAL_NOT_CERTIFIED";
}

export function top(section: StatementSection, limit = 8) {
  return [...section.lines].sort((a, b) => D(b.amountUsd).abs().cmp(D(a.amountUsd).abs())).slice(0, limit);
}

export function plainDay(s: string) {
  const v = fxDay(s);
  const d = new Date(v + "T00:00:00.000Z");
  if (!Number.isFinite(d.valueOf()) || d.toISOString().slice(0, 10) !== v) throw new Error("DASHBOARD_DATE_INVALID");
  return v;
}
