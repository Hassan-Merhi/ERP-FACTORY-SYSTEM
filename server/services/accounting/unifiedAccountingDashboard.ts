/**
 * Phase 14 unified accounting net position — USD historical booked basis.
 *
 * The dashboard does not calculate a second ledger and never adds operational
 * inventory to recognized assets. Unposted management stock, prospective
 * selling values and intercompany eliminations remain separately disclosed.
 */
import Decimal from "decimal.js";
import type { DbTransaction } from "../../db";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { companyBusinessDate } from "./companyBusinessDate";
import { fxDay } from "./monetaryFxRates";
import {
  professionalFinancialStatementsTx,
  type StatementLine,
  type StatementSection,
} from "./professionalFinancialStatements";
import { companyStockValuation, companyStockValuationAsOf } from "../inventory/stockValuation";
import { factoryStockValuation } from "./perpetualInventory/factoryValuation";
import { getInventoryCutover, PERPETUAL_INVENTORY_POSTING_READY } from "./perpetualInventory/cutover";

const D = (v: unknown) => new Decimal(String(v ?? 0));
const fmt = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
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
function stockAccount(l: StatementLine) {
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
function breakdown(section: StatementSection) {
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
interface FactoryInventory {
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
function top(section: StatementSection, limit = 8) {
  return [...section.lines].sort((a, b) => D(b.amountUsd).abs().cmp(D(a.amountUsd).abs())).slice(0, limit);
}
function plainDay(s: string) {
  const v = fxDay(s);
  const d = new Date(v + "T00:00:00.000Z");
  if (!Number.isFinite(d.valueOf()) || d.toISOString().slice(0, 10) !== v) throw new Error("DASHBOARD_DATE_INVALID");
  return v;
}
export async function unifiedAccountingDashboardTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    fromDate: string;
    asOfDate: string;
    valuationBasis: ValuationBasis;
    includeOperational: boolean;
  }
): Promise<UnifiedAccountingDashboard> {
  const { companyId } = input;
  if (!Number.isSafeInteger(companyId) || companyId < 1) throw new Error("DASHBOARD_COMPANY_INVALID");
  await assertTransactionCompanyScope(tx, companyId);
  const fromDate = plainDay(input.fromDate),
    asOfDate = plainDay(input.asOfDate);
  const businessDate = await companyBusinessDate(companyId, tx);
  if (fromDate > asOfDate || asOfDate > businessDate) throw new Error("DASHBOARD_PERIOD_INVALID");
  const packageData = await professionalFinancialStatementsTx(tx, {
    companyId,
    fromDate,
    asOfDate,
    compare: false,
  });
  const statement = packageData.current;
  const position = statement.financialPosition,
    performance = statement.profitAndLoss;
  const assets = D(position.assets.totalUsd),
    liabilities = D(position.liabilities.totalUsd);
  const net = assets.minus(liabilities);
  const equity = D(position.totalEquityIncludingEarningsUsd);
  const stockGlRows = position.assets.lines.filter(stockAccount);
  const stockContraRows = position.liabilities.lines.filter(stockAccount);
  const bookedStock = stockGlRows
    .reduce((a, l) => a.plus(D(l.amountUsd)), new Decimal(0))
    .minus(stockContraRows.reduce((a, l) => a.plus(D(l.amountUsd)), new Decimal(0)));
  const controls = {
    certified: false as const,
    trialBalanceBalanced: statement.controls.trialBalanceBalanced,
    historicalMasterValuesUnversioned: true as const,
    bookedFiguresDoNotContainUnpostedOperationalAssets: true as const,
    cashFlowClassificationCertified: false as const,
    perpetualPostingGloballyReady: PERPETUAL_INVENTORY_POSTING_READY,
    blockers: [...statement.controls.blockers],
    warnings: [...statement.controls.warnings],
  };
  const opWarnings: string[] = [
    "Operational valuations are separate comparison memos and have NOT been added to the posted asset or net-position totals.",
    "The Cost/Selling switch on the Factory Net Position management report does not revalue statutory stock accounts or historical COGS.",
    "This is a single selected company. Intercompany receivables, loans, inventory profit and investment eliminations have not been removed.",
    "Pending Factory freight, unfinalized customer orders and expected rental charges are not posted income or debts in this view.",
  ];
  let erpStock: UnifiedAccountingDashboard["operations"]["erpStock"] = null;
  let factoryStock: FactoryInventory | null = null;
  const glToOperationalAtCost: UnifiedAccountingDashboard["operations"]["glToOperationalAtCost"] = [];
  let cutover: UnifiedAccountingDashboard["operations"]["cutover"] = null;
  let ledgerActive = false;
  if (input.includeOperational) {
    const activeCutover = await getInventoryCutover(tx, companyId);
    cutover = activeCutover
      ? {
          effectiveFrom: activeCutover.effectiveFrom,
          openingVoucherId: activeCutover.openingVoucherId,
        }
      : null;
    ledgerActive = !!activeCutover && activeCutover.status === "ACTIVE" && asOfDate >= activeCutover.effectiveFrom;
    const valuation =
      asOfDate === businessDate
        ? await companyStockValuation(tx, companyId)
        : await companyStockValuationAsOf(tx, companyId, asOfDate);
    erpStock = {
      costUsd: valuation.total,
      subLedgerSignedUsd: valuation.subLedgerTotal,
      asOfBasis: asOfDate === businessDate ? "current" : "as-of",
      shortageValueUsd: valuation.excluded.shortageValue,
      unitemizedMovementValueUsd: valuation.excluded.unitemizedMovementValue,
      anomalousRows: valuation.excluded.anomalousRows,
      locations: valuation.locations.length,
    };
    const stock = await factoryStockValuation(tx, companyId);
    const combined = stock.raw.plus(stock.wip).plus(stock.finished);
    factoryStock = {
      rawUsd: fmt(stock.raw),
      wipUsd: fmt(stock.wip),
      finishedUsd: fmt(stock.finished),
      totalUsd: fmt(combined),
      unvaluedCount: stock.unvalued.length,
      unvaluedSample: stock.unvalued.slice(0, 15).map((u) => ({
        source: u.source,
        id: u.id,
        reason: u.reason,
      })),
      reservedForOrders: stock.reservedForOrders,
      soldNotInvoiced: stock.soldNotInvoiced,
      basis: "CURRENT_COST_ONLY",
    };
    // Diagnostics are only comparisons. They never insert an opening
    // inventory voucher, and are not valid for historical Factory balances
    // that the operational cost tables cannot replay to an as-of date.
    const expected = new Map<string, string | null>([
      ["INVENTORY", valuation.subLedgerTotal],
      ["FACTORY_RAW_MATERIAL_STOCK", fmt(stock.raw)],
      ["FACTORY_WIP", fmt(stock.wip)],
      ["FACTORY_FINISHED_GOODS", fmt(stock.finished)],
      ["GOODS_IN_TRANSIT", null],
      ["FACTORY_GOODS_IN_TRANSIT", null],
    ]);
    for (const [accountCode, operationalCostUsd] of expected) {
      const glFromAssets = position.assets.lines
        .filter((l) => l.kind === "ledger" && String(l.code ?? "").toUpperCase() === accountCode)
        .reduce((sum, l) => sum.plus(D(l.amountUsd)), new Decimal(0));
      const glFromLiabilities = position.liabilities.lines
        .filter((l) => l.kind === "ledger" && String(l.code ?? "").toUpperCase() === accountCode)
        .reduce((sum, l) => sum.plus(D(l.amountUsd)), new Decimal(0));
      const book = glFromAssets.minus(glFromLiabilities);
      const factoryCode = accountCode.startsWith("FACTORY_");
      const unitemizedHistoricalErpMovements =
        !factoryCode && asOfDate < businessDate && !D(valuation.excluded.unitemizedMovementValue).isZero();
      const comparable =
        operationalCostUsd !== null &&
        ledgerActive &&
        !unitemizedHistoricalErpMovements &&
        (!factoryCode || asOfDate === businessDate) &&
        (factoryCode ? stock.unvalued.length === 0 : valuation.excluded.anomalousRows === 0);
      glToOperationalAtCost.push({
        accountCode,
        bookedGlUsd: fmt(book),
        operationalCostUsd,
        differenceUsd: comparable ? fmt(book.minus(D(operationalCostUsd))) : null,
        comparable,
        reason:
          operationalCostUsd === null
            ? "No reliable matching operational Goods in Transit cost value in this report"
            : !ledgerActive
              ? "Periodic inventory: operational cost is not required to equal a perpetual GL account"
              : factoryCode && asOfDate < businessDate
                ? "Factory cost is current only; cannot compare against historical posted GL"
                : factoryCode && stock.unvalued.length > 0
                  ? "Factory stock contains unvalued cost sources"
                  : !factoryCode && valuation.excluded.anomalousRows > 0
                    ? "ERP inventory contains anomalous value rows"
                    : unitemizedHistoricalErpMovements
                      ? "Historical ERP movements lack stock-item attribution; exact reconciliation withheld"
                      : "Recorded operational cost and posted stock asset as of report date",
      });
    }
    if (stock.unvalued.length)
      opWarnings.push(
        `${stock.unvalued.length} Factory cost source(s) have no recorded USD cost; management totals are incomplete and must not be used for audited valuation.`
      );
    if (valuation.excluded.anomalousRows)
      opWarnings.push(
        `${valuation.excluded.anomalousRows} ERP inventory row(s) violate the recorded cost valuation policy.`
      );
    if (asOfDate < businessDate && !D(valuation.excluded.unitemizedMovementValue).isZero())
      opWarnings.push(
        `ERP historical inventory replay contains USD ${valuation.excluded.unitemizedMovementValue} of movements without stock-item attribution; GL-to-ERP cost reconciliation is withheld.`
      );
    if (asOfDate < businessDate)
      opWarnings.push(
        "Factory stock cost is today's current valuation, NOT the selected historical accounting date. Historical Factory management net position cannot be reconstructed reliably from this valuation. No combined ERP-plus-Factory historical management total is provided."
      );
    if (ledgerActive)
      opWarnings.push(
        "A company inventory cutover is active as of this date: inventory booked on GL is already included in recognized assets. Operational stock is NEVER added again."
      );
    else
      opWarnings.push(
        "This company has no active perpetual-inventory cutover at the selected date. Operational stock cost is an external management memo, NOT a posted asset on the financial balance sheet."
      );
  } else
    opWarnings.push(
      "Operational stock comparison not loaded; select 'Load operational stock comparison' to fetch it separately from the booked ledger."
    );
  const stockCostComplete =
    asOfDate === businessDate &&
    !!factoryStock &&
    !!erpStock &&
    factoryStock.unvaluedCount === 0 &&
    erpStock.anomalousRows === 0;
  const managementCandidate =
    stockCostComplete && erpStock && factoryStock ? fmt(D(erpStock.costUsd).plus(D(factoryStock.totalUsd))) : null;
  const managementCandidateBasis = !input.includeOperational
    ? ("NOT_LOADED" as const)
    : asOfDate < businessDate
      ? ("WITHHELD_MIXED_DATES" as const)
      : !stockCostComplete
        ? ("WITHHELD_INCOMPLETE_COST" as const)
        : ("CURRENT_COST_MEMO" as const);
  const classAssets = breakdown(position.assets);
  const classLiabilities = breakdown(position.liabilities);
  return {
    companyId,
    fromDate,
    asOfDate,
    currency: "USD",
    presentation: "STANDALONE_BOOKED_NOT_GROUP_CONSOLIDATED",
    source: "POSTED_GENERAL_LEDGER_AND_EXISTING_ACCOUNTING_ENGINE",
    financialPosition: {
      assetsUsd: position.assets.totalUsd,
      liabilitiesUsd: position.liabilities.totalUsd,
      netAssetsUsd: fmt(net),
      equityIncludingEarningsUsd: fmt(equity),
      reportedBalanceSheetDifferenceUsd: position.reportedBalanceSheetDifferenceUsd,
      unexplainedDifferenceUsd: position.assetsMinusLiabilitiesAndEquityUsd,
      trialBalanceDifferenceUsd: statement.controls.trialBalanceDifferenceUsd,
      cashAndBanksUsd: fmt(D(classAssets.cash_and_banks).minus(D(classLiabilities.cash_and_banks))),
      liabilitiesAndEquityUsd: fmt(liabilities.plus(equity)),
      assetClasses: classAssets,
      liabilityClasses: classLiabilities,
      unclassifiedUsd: position.unclassified.totalUsd,
      unclassifiedAccounts: statement.controls.unknownAccounts,
      isBalanced: position.balanced,
    },
    performance: {
      salesRevenueUsd: performance.revenue.totalUsd,
      otherIncomeUsd: performance.otherIncome.totalUsd,
      costOfSalesUsd: performance.costOfSales.totalUsd,
      operatingExpensesUsd: performance.operatingExpenses.totalUsd,
      grossProfitUsd: performance.grossProfitUsd,
      netProfitUsd: performance.periodNetResultUsd,
      recognizedCashMovementUsd: statement.cashFlow.actualCashMovementUsd,
      cashFlowClassificationDifferenceUsd: statement.cashFlow.cashFlowClassificationDifferenceUsd,
      periodBasis: "POSTED_PERIOD_FROM_THROUGH_AS_OF",
    },
    controls,
    operations: {
      requestedValuationBasis: input.valuationBasis,
      financialStatementValuationBasis: "historical_booked_cost",
      perpetualStockLedgerActiveAsOf: ledgerActive,
      cutover,
      erpStock,
      factoryStock,
      bookedStockAssetUsd: fmt(bookedStock),
      managementCostCandidateUsd: managementCandidate,
      managementCostCandidateBasis: managementCandidateBasis,
      managementSellingValueUsd: null,
      managementSellingValueAvailableIn: "EXISTING_FACTORY_NET_POSITION",
      glToOperationalAtCost,
      operationalAmountsAddedToBookedNetAssets: false,
      completeness: {
        factoryHistoricalValuationAvailable: asOfDate === businessDate,
        erpHistoricalValuationAvailable: erpStock !== null,
        stockCostFullyValued: stockCostComplete,
      },
      warnings: opWarnings,
    },
    drilldown: {
      topAssetAccounts: top(position.assets),
      topLiabilities: top(position.liabilities),
      topRevenueAccounts: top(performance.revenue),
      topCostAccounts: top(performance.costOfSales),
      topExpenses: top(performance.operatingExpenses),
    },
    disclosures: [
      ...Object.values(packageData.disclosure),
      "Reported net assets are posted assets less posted liabilities, NOT the original management 'what we have minus what we owe plus selling inventory' figure.",
      "Unrecognized stock profit, future loading revenue, expected offload freight, bank/tenant/supplier memos and booked intercompany balances are not implied reserves.",
      "An 'as-of' accounting dashboard is a retrospective view of surviving accounting sources. Master opening and management hierarchy history may not reflect exactly what users knew on that date.",
    ],
    reportStatus: "PROVISIONAL_NOT_CERTIFIED",
  };
}
