/**
 * Unified Accounting Phase 11: single-company financial statement workpaper.
 * READ ONLY. One canonical ledger, no posting/backdating/revaluing history.
 * Financial statements are provisional until the user's accounting team
 * certifies opening balances, cash flow classification and historical FX.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { companyBusinessDate } from "./companyBusinessDate";
import { fxDay } from "./monetaryFxRates";
import { loadBalanceRows, type BalanceRow, type BalanceRowKind } from "./balances/ledgerBalanceEngine";
import { buildTrialBalance } from "./integrity/trialBalance";
import { isIndirectIncome } from "./accountClassification";
import { financialStatementCategory } from "./unifiedAccountingFoundation";

type Classification = "asset" | "liability" | "equity" | "income" | "cost_of_sales" | "expense" | "unknown";
type CashSection = "operating" | "investing" | "financing" | "unclassified";
interface MetaRow extends Record<string, unknown> {
  id: number;
  sub_type: string | null;
  code: string;
}
interface BankLinkRow extends Record<string, unknown> {
  linked_ledger_id: number;
}
interface CashVoucher extends Record<string, unknown> {
  voucher_id: number;
  voucher_number: string;
  booked_on: string;
  cash_delta: string;
  cash_lines: number;
  other_lines: number;
  counter_class: string | null;
  source_count: string;
  source_cash_delta: string;
  source_operating: string;
  source_investing: string;
  source_financing: string;
  source_unclassified: string;
}
export interface StatementLine {
  kind: BalanceRowKind;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  category: Classification;
  amountUsd: string;
  openingSideAssumed: boolean;
  currentSourceIsMutable: boolean;
}
export interface StatementSection {
  lines: StatementLine[];
  totalUsd: string;
}
export interface SinglePeriodFinancialStatements {
  companyId: number;
  fromDate: string;
  asOfDate: string;
  currency: "USD";
  basis: "POSTED_HISTORICAL_BASE";
  financialPosition: {
    assets: StatementSection;
    liabilities: StatementSection;
    equity: StatementSection;
    unclassified: StatementSection;
    unclosedEarningsUsd: string;
    totalEquityIncludingEarningsUsd: string;
    // Reported assets minus liabilities minus equity, before unresolved accounts.
    reportedBalanceSheetDifferenceUsd: string;
    // Remaining ledger difference after explicitly displaying unclassified rows.
    assetsMinusLiabilitiesAndEquityUsd: string;
    balanced: boolean;
  };
  profitAndLoss: {
    revenue: StatementSection;
    otherIncome: StatementSection;
    costOfSales: StatementSection;
    operatingExpenses: StatementSection;
    grossProfitUsd: string;
    operatingResultUsd: string;
    periodNetResultUsd: string;
    priorPeriodClosingJournalsExcluded: true;
  };
  changesInEquity: {
    openingTotalEquityUsd: string;
    periodResultUsd: string;
    otherBookedEquityMovementsUsd: string;
    closingTotalEquityUsd: string;
    differenceUsd: string;
    otherMovementsRequireReview: true;
  };
  cashFlow: {
    operatingUsd: string;
    investingUsd: string;
    financingUsd: string;
    unclassifiedUsd: string;
    recognizedCashMovementUsd: string;
    actualCashMovementUsd: string;
    cashFlowClassificationDifferenceUsd: string;
    openingCashUsd: string;
    closingCashUsd: string;
    sourceVoucherCount: number;
    sampleTruncated: boolean;
    sourceSample: Array<{
      voucherId: number;
      voucherNumber: string;
      bookedOn: string;
      changeUsd: string;
      classification: CashSection;
    }>;
    basis: "POSTED_SIMPLE_COUNTERPARTY_JOURNALS";
    certified: false;
  };
  controls: {
    trialBalanceDifferenceUsd: string;
    trialBalanceBalanced: boolean;
    assumedOpeningSides: number;
    unknownAccounts: number;
    unknownAbsAmountUsd: string;
    recognizedCashAndSourceAgree: boolean;
    historicalMasterValuesUnversioned: true;
    certified: false;
    blockers: string[];
    warnings: string[];
  };
}
export interface ProfessionalFinancialPackage {
  companyId: number;
  fromDate: string;
  asOfDate: string;
  currency: "USD";
  current: SinglePeriodFinancialStatements;
  comparison: SinglePeriodFinancialStatements | null;
  comparisonPeriod: { fromDate: string; asOfDate: string } | null;
  reportStatus: "PROVISIONAL_NOT_CERTIFIED";
  disclosure: {
    postedOnly: string;
    fiscalClose: string;
    cashFlow: string;
    currency: string;
    factoryStock: string;
    intercompany: string;
    historical: string;
  };
}
const ZERO = new Decimal(0);
const dec = (x: unknown) => new Decimal(String(x ?? "0"));
const fmt = (n: Decimal) => n.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
function empty(): StatementSection {
  return { lines: [], totalUsd: "0.00" };
}
function append(section: StatementSection, line: StatementLine, total: Decimal) {
  section.lines.push({ ...line, amountUsd: fmt(total) });
  section.totalUsd = fmt(dec(section.totalUsd).plus(total));
}
function classification(row: BalanceRow, subtypes: Map<number, string | null>): Classification {
  if (row.kind === "missingAccount" || row.kind === "unassigned") return "unknown";
  if (row.kind === "bank" || row.kind === "fixedAsset") return "asset";
  const base = financialStatementCategory({
    code: row.code,
    accountType: row.accountType,
    subType: row.kind === "ledger" && row.id !== null ? subtypes.get(row.id) : null,
  });
  if (row.kind !== "ledger") return "asset"; // party debit/credit side is resolved later
  if (base === "party") return "asset"; // side resolved later, not a categorical asset assumption
  return base === "unknown" ? "unknown" : base;
}
function cashAccount(row: BalanceRow, subtypes: Map<number, string | null>, bankLinked: Set<number>) {
  if (row.kind === "bank") return true;
  if (row.kind !== "ledger") return false;
  if (row.id !== null && bankLinked.has(row.id)) return true;
  const type = String(row.accountType ?? "")
    .trim()
    .toLowerCase();
  const sub = String(row.id === null ? "" : (subtypes.get(row.id) ?? ""))
    .trim()
    .toLowerCase();
  return type === "cash" || type === "bank" || sub === "cash" || sub === "bank";
}
function signedSheet(row: BalanceRow) {
  return row.masterOpening.plus(row.carriedForward).plus(row.periodDebit).minus(row.periodCredit);
}
function priorClosingPeriod(fromDate: string, asOfDate: string) {
  const start = new Date(fromDate + "T00:00:00.000Z");
  const end = new Date(asOfDate + "T00:00:00.000Z");
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const prevEnd = new Date(start.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86400000);
  return { fromDate: prevStart.toISOString().slice(0, 10), asOfDate: prevEnd.toISOString().slice(0, 10) };
}
/**
 * The cash statement's source classification is deliberately conservative:
 * only vouchers with one actual non-cash counterpart and a nonzero cash delta
 * can enter a named section. Split receipts, bank transfers with extra lines,
 * mixed settlement vouchers and multi-line journals stay unclassified. This
 * prevents fabricated cash-flow classes or assertions of indirect CFO.
 *
 * A window aggregate across ALL qualifying vouchers prevents the 250-row
 * evidence sample cap from understating cash flow totals.
 */
async function sourceCashFlowTx(tx: DbTransaction, companyId: number, fromDate: string, asOfDate: string) {
  const rows = resultRows<CashVoucher>(
    await tx.execute(sql`
 WITH lines AS(
 SELECT v.id AS voucher_id,v.voucher_number,
  COALESCE(v.effective_date,v.voucher_date) AS booked_on,
  COALESCE(e.base_debit_amount,e.debit_amount,0)-
  COALESCE(e.base_credit_amount,e.credit_amount,0) AS movement,
  CASE WHEN (
    (e.ledger_account_id IS NOT NULL AND
      (LOWER(TRIM(COALESCE(la.account_type,''))) IN('cash','bank')
       OR EXISTS(
        SELECT 1 FROM bank_accounts ba
        WHERE ba.company_id=v.company_id
          AND ba.linked_ledger_id=e.ledger_account_id
          AND ba.deleted_at IS NULL)))
    OR (e.ledger_account_id IS NULL AND e.bank_account_id IS NOT NULL)
  ) THEN true ELSE false END AS is_cash,
  CASE WHEN e.fixed_asset_id IS NOT NULL THEN 'investing'
       WHEN LOWER(TRIM(COALESCE(la.account_type,''))) IN('equity','profit','loans','loan')
         THEN 'financing'
       WHEN LOWER(TRIM(COALESCE(la.account_type,''))) IN(
        'income','revenue','direct income','indirect income','expense',
        'direct expense','indirect expense','government taxes','cogs',
        'customer','supplier','accounts payable')
         OR e.customer_id IS NOT NULL OR e.supplier_id IS NOT NULL
         OR e.factory_supplier_id IS NOT NULL OR e.employee_id IS NOT NULL
         OR UPPER(COALESCE(la.code,'')) IN('INVENTORY','GOODS_IN_TRANSIT',
            'FACTORY_RAW_MATERIAL_STOCK','FACTORY_GOODS_IN_TRANSIT')
         THEN 'operating'
       ELSE 'unclassified' END AS contra_class
 FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
 LEFT JOIN ledger_accounts la ON la.id=e.ledger_account_id AND la.company_id=v.company_id
 WHERE v.company_id=${companyId} AND v.deleted_at IS NULL AND v.optional=false
   AND COALESCE(v.effective_date,v.voucher_date)>=${fromDate}::date
   AND COALESCE(v.effective_date,v.voucher_date)<=${asOfDate}::date
 ),
 vouchers_grouped AS(
 SELECT voucher_id,MAX(voucher_number) AS voucher_number,MAX(booked_on) AS booked_on,
   COALESCE(SUM(movement) FILTER (WHERE is_cash),0) AS cash_delta,
   COUNT(*) FILTER (WHERE is_cash)::int AS cash_lines,
   COUNT(*) FILTER (WHERE NOT is_cash)::int AS other_lines,
   MAX(contra_class) FILTER (WHERE NOT is_cash) AS counter_class
 FROM lines GROUP BY voucher_id
 HAVING COUNT(*) FILTER(WHERE is_cash)>0
 ),
 categorized AS(
 SELECT voucher_id,voucher_number,booked_on,cash_delta,cash_lines,other_lines,
   CASE WHEN cash_delta<>0 AND cash_lines=1 AND other_lines=1 AND counter_class IN('operating','investing','financing')
     THEN counter_class ELSE 'unclassified' END AS counter_class
 FROM vouchers_grouped
 ),
 totals AS(
 SELECT COUNT(*)::text AS source_count,
  COALESCE(SUM(cash_delta),0)::text AS source_cash_delta,
  COALESCE(SUM(cash_delta) FILTER (WHERE counter_class='operating'),0)::text AS source_operating,
  COALESCE(SUM(cash_delta) FILTER (WHERE counter_class='investing'),0)::text AS source_investing,
  COALESCE(SUM(cash_delta) FILTER (WHERE counter_class='financing'),0)::text AS source_financing,
  COALESCE(SUM(cash_delta) FILTER (WHERE counter_class='unclassified'),0)::text AS source_unclassified
 FROM categorized
 )
 SELECT c.voucher_id,c.voucher_number,c.booked_on::text,
  c.cash_delta::text,c.cash_lines,c.other_lines,c.counter_class,
  t.source_count,t.source_cash_delta,t.source_operating,
  t.source_investing,t.source_financing,t.source_unclassified
 FROM totals t LEFT JOIN categorized c ON true
 ORDER BY c.booked_on DESC,c.voucher_id DESC LIMIT 251
 `)
  );
  const sample = rows.filter((r) => r.voucher_id !== null && r.voucher_id !== undefined);
  const first = rows[0];
  const base = {
    operating: dec(first?.source_operating),
    investing: dec(first?.source_investing),
    financing: dec(first?.source_financing),
    unclassified: dec(first?.source_unclassified),
    sourceCash: dec(first?.source_cash_delta),
    count: Number(first?.source_count ?? 0),
  };
  return {
    ...base,
    truncated: base.count > 250,
    sample: sample.slice(0, 250).map((row) => ({
      voucherId: Number(row.voucher_id),
      voucherNumber: row.voucher_number,
      bookedOn: row.booked_on,
      changeUsd: fmt(dec(row.cash_delta)),
      classification: (row.counter_class ?? "unclassified") as CashSection,
    })),
  };
}
async function statementTx(
  tx: DbTransaction,
  input: { companyId: number; fromDate: string; asOfDate: string }
): Promise<SinglePeriodFinancialStatements> {
  const { companyId, fromDate, asOfDate } = input;
  const [sheetRows, pnlRows, trial, subtypeRows, linkedBanks, sourceCash] = await Promise.all([
    loadBalanceRows(tx, { companyId, from: fromDate, asOf: asOfDate }),
    loadBalanceRows(tx, { companyId, from: fromDate, asOf: asOfDate, excludeFiscalClose: true }),
    buildTrialBalance(companyId, asOfDate, tx),
    tx.execute(sql`SELECT id,code,sub_type FROM ledger_accounts WHERE company_id=${companyId}`),
    tx.execute(sql`SELECT linked_ledger_id FROM bank_accounts
    WHERE company_id=${companyId} AND linked_ledger_id IS NOT NULL
      AND deleted_at IS NULL`),
    sourceCashFlowTx(tx, companyId, fromDate, asOfDate),
  ]);
  const subtypes = new Map(resultRows<MetaRow>(subtypeRows).map((r) => [Number(r.id), r.sub_type]));
  const bankLinked = new Set(resultRows<BankLinkRow>(linkedBanks).map((r) => Number(r.linked_ledger_id)));
  const assets = empty(),
    liabilities = empty(),
    equity = empty(),
    unknown = empty();
  const revenue = empty(),
    otherIncome = empty(),
    costOfSales = empty(),
    operatingExpenses = empty();
  const financialLine = (row: BalanceRow, category: Classification): StatementLine => ({
    kind: row.kind,
    id: row.id,
    code: row.code,
    name: row.name,
    accountType: row.accountType,
    category,
    amountUsd: "0.00",
    openingSideAssumed: row.openingSideAssumed,
    currentSourceIsMutable: true,
  });
  let earnings = ZERO,
    openingTotalEquity = ZERO,
    cashOpening = ZERO,
    cashChange = ZERO;
  for (const row of sheetRows) {
    const closing = signedSheet(row);
    const brought = row.masterOpening.plus(row.carriedForward);
    const role = classification(row, subtypes);
    if (role === "equity" || role === "income" || role === "expense" || role === "cost_of_sales")
      openingTotalEquity = openingTotalEquity.minus(brought);
    if (cashAccount(row, subtypes, bankLinked)) {
      cashOpening = cashOpening.plus(row.masterOpening).plus(row.carriedForward);
      cashChange = cashChange.plus(row.periodDebit).minus(row.periodCredit);
    }
    if (closing.isZero()) continue;
    const item = financialLine(row, role);
    if (role === "income" || role === "expense" || role === "cost_of_sales") {
      earnings = earnings.minus(closing);
    } else if (role === "unknown") {
      append(unknown, item, closing.negated());
    } else if (role === "equity") {
      append(equity, item, closing.negated());
    } else if (role === "asset" || role === "liability") {
      // Customer/supplier advances and negative cash/asset balances retain
      // their *actual* Dr/Cr sign, never get netted into the wrong side.
      if (closing.gt(0)) append(assets, item, closing);
      else append(liabilities, item, closing.negated());
    }
  }
  for (const row of pnlRows) {
    if (row.kind !== "ledger") continue;
    const role = classification(row, subtypes);
    const movement = row.periodDebit.minus(row.periodCredit);
    if (movement.isZero()) continue;
    const item = financialLine(row, role);
    if (role === "income") {
      const code = String(row.code ?? "").toUpperCase();
      const other =
        isIndirectIncome(row.accountType, row.id === null ? null : subtypes.get(row.id)) ||
        code === "OTHER_INCOME" ||
        code.startsWith("OTHER_INCOME-") ||
        code === "FX-REALIZED" ||
        code.startsWith("FX-REALIZED-");
      append(other ? otherIncome : revenue, item, movement.negated());
    } else if (role === "cost_of_sales") append(costOfSales, item, movement);
    else if (role === "expense") append(operatingExpenses, item, movement);
  }
  const gross = dec(revenue.totalUsd).minus(costOfSales.totalUsd);
  const result = gross.plus(otherIncome.totalUsd).minus(operatingExpenses.totalUsd);
  const adjEquity = dec(equity.totalUsd).plus(earnings);
  const otherEquityMovements = adjEquity.minus(openingTotalEquity).minus(result);
  const equityBridgeDifference = openingTotalEquity.plus(result).plus(otherEquityMovements).minus(adjEquity);
  const reportedDifference = dec(assets.totalUsd).minus(liabilities.totalUsd).minus(adjEquity);
  // Unclassified credit-positive amounts explain part of the reported balance
  // sheet difference, but must never make an incomplete statement look balanced.
  const mismatch = reportedDifference.minus(unknown.totalUsd);
  const classifiedSum = sourceCash.operating
    .plus(sourceCash.investing)
    .plus(sourceCash.financing)
    .plus(sourceCash.unclassified);
  const controlDifference = cashChange.minus(classifiedSum);
  const blockers: string[] = [];
  const warnings: string[] = [
    "Report uses current master opening balances and classifications with historical effective-date postings; it is not an immutable past system-state snapshot.",
    "Cash-flow labels only cover single-counterparty vouchers. All other cash movements remain explicitly unclassified instead of inferred.",
    "Income and expense subtotals use source ledger codes/types; missing source attribution and unposted operating inventory/charges are not generated into GL.",
    "For closed fiscal years, balance-sheet earnings include posted closing movements; period P&L excludes fiscal-close journals.",
  ];
  const unknownAbs = unknown.lines.reduce((n, r) => n.plus(dec(r.amountUsd).abs()), ZERO);
  if (!trial.balanced || mismatch.abs().gt("0.01"))
    blockers.push(`Trial balance/balance sheet discrepancy: USD ${fmt(mismatch)}; no balancing entry generated.`);
  if (unknown.lines.length)
    blockers.push(`${unknown.lines.length} unclassified financial position line(s): USD ${fmt(unknownAbs)} absolute.`);
  if (controlDifference.abs().gt("0.01"))
    blockers.push(
      `Cash flow source line delta does not agree with canonical cash account activity: USD ${fmt(controlDifference)}.`
    );
  if (sourceCash.unclassified.abs().gt("0.01"))
    blockers.push("Some cash movements have no verified operating/investing/financing classification.");
  if (trial.openingSidesAssumed > 0)
    warnings.push(`${trial.openingSidesAssumed} account opening(s) rely on the default Dr/Cr side.`);
  if (sourceCash.truncated)
    warnings.push(
      "The cash-flow source voucher sample is capped at 250, but aggregate cash-flow totals cover all qualifying journals."
    );
  return {
    companyId,
    fromDate,
    asOfDate,
    currency: "USD",
    basis: "POSTED_HISTORICAL_BASE",
    financialPosition: {
      assets,
      liabilities,
      equity,
      unclassified: unknown,
      unclosedEarningsUsd: fmt(earnings),
      totalEquityIncludingEarningsUsd: fmt(adjEquity),
      reportedBalanceSheetDifferenceUsd: fmt(reportedDifference),
      assetsMinusLiabilitiesAndEquityUsd: fmt(mismatch),
      balanced: trial.balanced && mismatch.abs().lte("0.01") && unknown.lines.length === 0,
    },
    profitAndLoss: {
      revenue,
      otherIncome,
      costOfSales,
      operatingExpenses,
      grossProfitUsd: fmt(gross),
      operatingResultUsd: fmt(result),
      periodNetResultUsd: fmt(result),
      priorPeriodClosingJournalsExcluded: true,
    },
    changesInEquity: {
      openingTotalEquityUsd: fmt(openingTotalEquity),
      periodResultUsd: fmt(result),
      otherBookedEquityMovementsUsd: fmt(otherEquityMovements),
      closingTotalEquityUsd: fmt(adjEquity),
      differenceUsd: fmt(equityBridgeDifference),
      otherMovementsRequireReview: true,
    },
    cashFlow: {
      operatingUsd: fmt(sourceCash.operating),
      investingUsd: fmt(sourceCash.investing),
      financingUsd: fmt(sourceCash.financing),
      unclassifiedUsd: fmt(sourceCash.unclassified),
      recognizedCashMovementUsd: fmt(classifiedSum),
      actualCashMovementUsd: fmt(cashChange),
      cashFlowClassificationDifferenceUsd: fmt(controlDifference),
      openingCashUsd: fmt(cashOpening),
      closingCashUsd: fmt(cashOpening.plus(cashChange)),
      sourceVoucherCount: sourceCash.count,
      sampleTruncated: sourceCash.truncated,
      sourceSample: sourceCash.sample,
      basis: "POSTED_SIMPLE_COUNTERPARTY_JOURNALS",
      certified: false,
    },
    controls: {
      trialBalanceDifferenceUsd: trial.unexplainedDifference,
      trialBalanceBalanced: trial.balanced,
      assumedOpeningSides: trial.openingSidesAssumed,
      unknownAccounts: unknown.lines.length,
      unknownAbsAmountUsd: fmt(unknownAbs),
      recognizedCashAndSourceAgree: controlDifference.abs().lte("0.01"),
      historicalMasterValuesUnversioned: true,
      certified: false,
      blockers,
      warnings,
    },
  };
}
export async function professionalFinancialStatementsTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    asOfDate: string;
    fromDate: string;
    compare: boolean;
  }
): Promise<ProfessionalFinancialPackage> {
  const { companyId } = input;
  if (!Number.isSafeInteger(companyId) || companyId < 1) throw new Error("FINANCIAL_COMPANY_INVALID");
  await assertTransactionCompanyScope(tx, companyId);
  const asOfDate = fxDay(input.asOfDate),
    fromDate = fxDay(input.fromDate);
  if (fromDate > asOfDate) throw new Error("FINANCIAL_PERIOD_INVALID");
  const now = await companyBusinessDate(companyId, tx);
  if (asOfDate > now) throw new Error("FINANCIAL_FUTURE_DATE_INVALID");
  const base = await tx.execute(sql`SELECT COALESCE(base_currency,'USD') AS base_currency
  FROM companies WHERE id=${companyId}`);
  const company = resultRows<{ base_currency: string } & Record<string, unknown>>(base)[0];
  if (!company || String(company.base_currency).toUpperCase() !== "USD")
    throw new Error("FINANCIAL_BASE_CURRENCY_UNSUPPORTED");
  const current = await statementTx(tx, { companyId, fromDate, asOfDate });
  const comparePeriod = input.compare ? priorClosingPeriod(fromDate, asOfDate) : null;
  const comparison = comparePeriod
    ? await statementTx(tx, {
        companyId,
        fromDate: comparePeriod.fromDate,
        asOfDate: comparePeriod.asOfDate,
      })
    : null;
  return {
    companyId,
    fromDate,
    asOfDate,
    currency: "USD",
    current,
    comparison,
    comparisonPeriod: comparePeriod,
    reportStatus: "PROVISIONAL_NOT_CERTIFIED",
    disclosure: {
      postedOnly:
        "All statements use company-owned, live, nonoptional, posted voucher entries and their original historical USD base, plus existing opening balances. No expected invoices or stock profit values are fabricated.",
      fiscalClose:
        "Balance sheet includes fiscal closing journals in retained earnings; period P&L excludes them via canonical excludeFiscalClose rule.",
      cashFlow:
        "Direct cash classification is provisional and requires voucher source review, particularly split payments, capital expenditure, dividends, loan servicing, FX translation and internal cash transfers. Unclassified is included in cash movement, never silently discarded.",
      currency:
        "USD booked historic base only. No present-day FX revaluation of historical invoice, cost, expense or sales amounts.",
      factoryStock:
        "Factory raw, work in progress and finished goods must be included only via posted GL and not current operational Factory valuation added a second time.",
      intercompany:
        "Company standalone statement only. Internal revenue, loans, shared costs, unrealized group stock profit and investment/equity eliminations must be reviewed in the Phase 9 provisional consolidation workpaper.",
      historical:
        "Historical as-of data is a retrospective view of currently surviving ledger records, not an immutable system-time proof of what existed on the selected date. Missing legacy FX and mutable openings are unverified.",
    },
  };
}
