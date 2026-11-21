// Extracted from ./professionalFinancialStatements.ts
import Decimal from "decimal.js";
import { type BalanceRow, type BalanceRowKind } from "./balances/ledgerBalanceEngine";
import { financialStatementCategory } from "./unifiedAccountingFoundation";

export type Classification = "asset" | "liability" | "equity" | "income" | "cost_of_sales" | "expense" | "unknown";

type CashSection = "operating" | "investing" | "financing" | "unclassified";

export interface MetaRow extends Record<string, unknown> {
  id: number;
  sub_type: string | null;
  code: string;
}

export interface BankLinkRow extends Record<string, unknown> {
  linked_ledger_id: number;
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

export const dec = (x: unknown) => new Decimal(String(x ?? "0"));

export const fmt = (n: Decimal) => n.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export function append(section: StatementSection, line: StatementLine, total: Decimal) {
  section.lines.push({ ...line, amountUsd: fmt(total) });
  section.totalUsd = fmt(dec(section.totalUsd).plus(total));
}

export function classification(row: BalanceRow, subtypes: Map<number, string | null>): Classification {
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

export function cashAccount(row: BalanceRow, subtypes: Map<number, string | null>, bankLinked: Set<number>) {
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

export function priorClosingPeriod(fromDate: string, asOfDate: string) {
  const start = new Date(fromDate + "T00:00:00.000Z");
  const end = new Date(asOfDate + "T00:00:00.000Z");
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const prevEnd = new Date(start.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86400000);
  return { fromDate: prevStart.toISOString().slice(0, 10), asOfDate: prevEnd.toISOString().slice(0, 10) };
}
