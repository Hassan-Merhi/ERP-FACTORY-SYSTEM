/**
 * Statement classification map (accounting audit phase 27, RP-4/RP-6).
 *
 * Owner decision (decided by default, owner can override): the fiscal year is
 * the calendar year, and a balance-sheet line is current or non-current by its
 * account class and sub type:
 *
 *   - cash and cash equivalents are the bank accounts (bank_accounts) and the
 *     ledger accounts of class asset typed or sub-typed Cash or Bank; they are
 *     current, and an overdrawn one (a credit balance) is a current liability,
 *     as a party is placed by the side of its balance;
 *   - non-current assets: fixed assets (fixed_assets and the types/sub types
 *     below); every other asset is current;
 *   - non-current liabilities: loans and long-term liabilities, unless the sub
 *     type marks them short-term or current; every other liability is current;
 *   - parties (customers, suppliers, employees, factory suppliers, the
 *     Customer/Supplier/Intercompany ledger types) are current and placed by
 *     the side of their balance.
 *
 * Phase 23 adds an `account_class` column; until it is present the class
 * comes from accountClassification.classifyAccountType, which that column is
 * derived from. This module is the one place the reports ask "current or not".
 */
import { classifyAccountType, type AccountClass } from "../accountClassification";

export type StatementSection =
  | "currentAssets"
  | "nonCurrentAssets"
  | "currentLiabilities"
  | "nonCurrentLiabilities"
  | "equity"
  | "earnings"
  | "unclassified";

/** Engine row kinds the map knows (ledgerBalanceEngine.BalanceRowKind). */
export type ClassifiableRowKind =
  | "ledger"
  | "bank"
  | "fixedAsset"
  | "supplier"
  | "employee"
  | "factorySupplier"
  | "customer"
  | "missingAccount"
  | "unassigned";

const PARTY_ROW_KINDS: ReadonlySet<string> = new Set(["customer", "supplier", "employee", "factorySupplier"]);

const CASH_TYPES: ReadonlySet<string> = new Set(["cash", "bank", "cash in hand", "cash at bank", "petty cash"]);
const NON_CURRENT_ASSET_TYPES: ReadonlySet<string> = new Set([
  "fixed asset",
  "fixed assets",
  "non-current asset",
  "non current asset",
  "long-term asset",
  "long-term investment",
  "investment",
  "investments",
  "property, plant and equipment",
  "accumulated depreciation",
]);
const NON_CURRENT_LIABILITY_TYPES: ReadonlySet<string> = new Set([
  "loan",
  "loans",
  "long-term loan",
  "long-term liability",
  "long term liability",
  "non-current liability",
  "non current liability",
]);
const SHORT_TERM_MARKERS: ReadonlySet<string> = new Set([
  "current liability",
  "short-term loan",
  "short term loan",
  "current",
  "short-term",
]);

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export interface ClassifiableRow {
  kind: ClassifiableRowKind | string;
  accountType: string | null;
  subType?: string | null;
}

/** The account class of an engine row (bank/fixed asset are assets; parties are "party"). */
export function rowAccountClass(row: ClassifiableRow): AccountClass {
  if (row.kind === "bank" || row.kind === "fixedAsset") return "asset";
  if (PARTY_ROW_KINDS.has(row.kind)) return "party";
  if (row.kind !== "ledger") return "unknown";
  return classifyAccountType(row.accountType, row.subType);
}

/** Cash and cash equivalents: bank accounts and Cash/Bank ledger accounts of class asset. */
export function isCashRow(row: ClassifiableRow): boolean {
  if (row.kind === "bank") return true;
  if (row.kind !== "ledger") return false;
  if (classifyAccountType(row.accountType, row.subType) !== "asset") return false;
  return CASH_TYPES.has(norm(row.accountType)) || CASH_TYPES.has(norm(row.subType));
}

/** True for a non-current asset row (fixed assets and long-term types). */
export function isNonCurrentAssetRow(row: ClassifiableRow): boolean {
  if (row.kind === "fixedAsset") return true;
  if (row.kind !== "ledger") return false;
  return NON_CURRENT_ASSET_TYPES.has(norm(row.accountType)) || NON_CURRENT_ASSET_TYPES.has(norm(row.subType));
}

/** True for a non-current liability row (loans unless marked short-term). */
export function isNonCurrentLiabilityRow(row: ClassifiableRow): boolean {
  if (row.kind !== "ledger") return false;
  if (SHORT_TERM_MARKERS.has(norm(row.subType))) return false;
  return NON_CURRENT_LIABILITY_TYPES.has(norm(row.accountType)) || NON_CURRENT_LIABILITY_TYPES.has(norm(row.subType));
}

/**
 * The balance-sheet section of a row given its debit-positive closing balance.
 * Cash rows and parties are placed by sign (an overdrawn bank is a current
 * liability); income and expense rows are earnings; an unknown type is
 * unclassified, never guessed.
 */
export function statementSectionOf(row: ClassifiableRow, debitBalance: { isNegative(): boolean }): StatementSection {
  const accountClass = rowAccountClass(row);
  const credit = debitBalance.isNegative();
  switch (accountClass) {
    case "asset":
      if (isCashRow(row)) return credit ? "currentLiabilities" : "currentAssets";
      return isNonCurrentAssetRow(row) ? "nonCurrentAssets" : "currentAssets";
    case "liability":
      return isNonCurrentLiabilityRow(row) ? "nonCurrentLiabilities" : "currentLiabilities";
    case "equity":
      return "equity";
    case "income":
    case "expense":
      return "earnings";
    case "party":
      return credit ? "currentLiabilities" : "currentAssets";
    default:
      return "unclassified";
  }
}

/** Cash-flow activity of a non-cash row (indirect method). */
export type CashFlowActivity = "operating" | "investing" | "financing" | "earnings" | "cash" | "unclassified";

export function cashFlowActivityOf(row: ClassifiableRow): CashFlowActivity {
  if (isCashRow(row)) return "cash";
  const accountClass = rowAccountClass(row);
  switch (accountClass) {
    case "asset":
      return isNonCurrentAssetRow(row) ? "investing" : "operating";
    case "liability":
      return isNonCurrentLiabilityRow(row) ? "financing" : "operating";
    case "equity":
      return "financing";
    case "income":
    case "expense":
      return "earnings";
    case "party":
      return "operating";
    default:
      return "unclassified";
  }
}

/** Depreciation/amortisation expense rows, added back in operating activities (type or sub type only). */
export function isDepreciationRow(row: ClassifiableRow): boolean {
  if (row.kind !== "ledger" || classifyAccountType(row.accountType, row.subType) !== "expense") return false;
  const text = `${norm(row.accountType)} ${norm(row.subType)}`;
  return text.includes("depreciation") || text.includes("amortisation") || text.includes("amortization");
}

// ── Fiscal year (calendar year, decided by default) ──────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** First day of the calendar fiscal year containing `date`. */
export function fiscalYearStart(date: string): string {
  return `${date.slice(0, 4)}-01-01`;
}

/** Last day of the calendar fiscal year containing `date`. */
export function fiscalYearEnd(date: string): string {
  return `${date.slice(0, 4)}-12-31`;
}

/** `date` shifted by whole days (UTC calendar arithmetic). */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** The same calendar date one year earlier (29 Feb becomes 28 Feb). */
export function sameDateLastYear(date: string): string {
  const year = Number(date.slice(0, 4)) - 1;
  const monthDay = date.slice(5);
  if (monthDay === "02-29") return `${year}-02-28`;
  return `${year}-${monthDay}`;
}

/** The period of the same length ending the day before `from`. */
export function priorPeriod(from: string, to: string): { from: string; to: string } {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  const priorTo = addDays(from, -1);
  return { from: addDays(priorTo, -days), to: priorTo };
}
