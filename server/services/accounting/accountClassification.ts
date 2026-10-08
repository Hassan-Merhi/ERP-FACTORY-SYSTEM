/**
 * One definition of the account types the ledger uses (2026-10 accounting audit).
 *
 * `ledger_accounts.account_type` is free text, and the audit found mis-cased
 * types written by code ('EXPENSE', 'LIABILITY', 'ASSET', 'EQUITY') that every
 * report missed, and a fiscal close that only closed 'Income' and 'Expense',
 * leaving every Direct/Indirect Expense and Indirect Income balance open into
 * the next year.
 *
 * Wave 10 ("one balance engine") adds classifyAccountType, the single answer
 * to "is this account an asset, a liability, equity, income, an expense or a
 * party?" that net position, the P&L, net profit, the chat reports and the
 * fiscal close all use.
 */

/** Every account type the application writes and the reports recognise. */
export const CANONICAL_ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  "Asset",
  "Liability",
  "Equity",
  "Income",
  "Expense",
  "Bank",
  "Cash",
  "Indirect Expense",
  "Direct Expense",
  "Government Taxes",
  "Loans",
  "Duty Agent",
  "Transporter Agent",
  "Accounts Payable",
  "Profit",
  "Intercompany",
  "Indirect Income",
]);

/**
 * The class of a ledger account type, the one answer every balance engine
 * uses (wave 10, "one balance engine"):
 *   - asset / liability / equity: balance-sheet accounts;
 *   - income / expense: income-statement accounts, whose net is earnings and
 *     which a fiscal close moves to retained earnings;
 *   - party: an account whose side depends on its balance (a customer in
 *     credit is a liability, a supplier or intercompany account in debit an
 *     asset);
 *   - unknown: a type this table does not know. Callers report it; it is
 *     never guessed into a class.
 */
export type AccountClass = "asset" | "liability" | "equity" | "income" | "expense" | "party" | "unknown";

/**
 * Every type (lower case) the ledger holds, by class. Besides the canonical
 * types this covers the legacy spellings found in stored data:
 *   - "Revenue": how factory sales income accounts were typed;
 *   - "Indirect Income" as an account type (bulk-payroll recoveries) as well as
 *     the UI's "Income" + subType "Indirect Income";
 *   - "Profit": the capital / retained-profit accounts, so equity, never revenue;
 *   - "Government Taxes": duties and taxes charged on imports and offloads,
 *     an expense;
 *   - "Intercompany": a party account; it is a receivable in debit and a
 *     payable in credit, decided by its balance;
 *   - "Customer" / "Supplier": party accounts, likewise by balance.
 * Case and surrounding spaces are ignored ('EXPENSE' is "Expense").
 */
const ACCOUNT_TYPES_BY_CLASS: Readonly<Record<Exclude<AccountClass, "unknown">, readonly string[]>> = {
  asset: ["asset", "current asset", "fixed asset", "bank", "cash"],
  liability: ["liability", "current liability", "loan", "loans", "duty agent", "transporter agent", "accounts payable"],
  equity: ["equity", "profit"],
  income: ["income", "revenue", "indirect income", "direct income"],
  expense: ["expense", "direct expense", "indirect expense", "government taxes", "cogs"],
  party: ["customer", "supplier", "intercompany"],
};

const CLASS_BY_TYPE = new Map<string, AccountClass>(
  Object.entries(ACCOUNT_TYPES_BY_CLASS).flatMap(([accountClass, types]) =>
    types.map((type) => [type, accountClass as AccountClass] as const)
  )
);

function normalizeType(type: string | null | undefined): string {
  return (type ?? "").trim().toLowerCase();
}

/**
 * The class of an account from its type, case-insensitive. When the type is
 * missing or unknown, a subType that is itself a known type ("Indirect
 * Income", "Current Asset") decides; otherwise the class is "unknown".
 */
export function classifyAccountType(accountType: string | null | undefined, subType?: string | null): AccountClass {
  return CLASS_BY_TYPE.get(normalizeType(accountType)) ?? CLASS_BY_TYPE.get(normalizeType(subType)) ?? "unknown";
}

/** Lower-case type names of the given classes, for `LOWER(TRIM(account_type)) IN (...)` filters. */
export function accountTypeNamesOf(...classes: Exclude<AccountClass, "unknown">[]): string[] {
  return classes.flatMap((accountClass) => ACCOUNT_TYPES_BY_CLASS[accountClass]);
}

/** True for income-statement accounts (income or expense). */
export function isProfitAndLossAccount(accountType: string | null | undefined, subType?: string | null): boolean {
  const accountClass = classifyAccountType(accountType, subType);
  return accountClass === "income" || accountClass === "expense";
}

/** Income stored either as type "Indirect Income" or as "Income" + subType "Indirect Income". */
export function isIndirectIncome(accountType: string | null | undefined, subType?: string | null): boolean {
  if (classifyAccountType(accountType, subType) !== "income") return false;
  return normalizeType(accountType) === "indirect income" || normalizeType(subType) === "indirect income";
}

/**
 * The expense bucket of an expense account, normalising both storage forms
 * ("Direct Expense" as the type, or "Expense" + subType "Direct Expense"):
 * "Direct Expense", "Indirect Expense", or the canonical type itself for the
 * rest ("Expense", "Government Taxes", "COGS"). Null for non-expense accounts.
 */
export function expenseCategory(accountType: string | null | undefined, subType?: string | null): string | null {
  if (classifyAccountType(accountType, subType) !== "expense") return null;
  const type = normalizeType(accountType);
  const sub = normalizeType(subType);
  if (type === "direct expense" || sub === "direct expense") return "Direct Expense";
  if (type === "indirect expense" || sub === "indirect expense") return "Indirect Expense";
  if (type === "cogs") return "COGS";
  return canonicalAccountType(accountType) ?? canonicalAccountType(subType) ?? "Expense";
}

/**
 * The side an opening balance with no recorded side is on: Dr for assets,
 * expenses and customers; Cr for liabilities, equity, income, suppliers and
 * intercompany accounts. Null for an unknown type (the caller keeps its own
 * default and should report the assumption).
 */
export function defaultOpeningSide(
  accountType: string | null | undefined,
  subType?: string | null
): "Dr" | "Cr" | null {
  switch (classifyAccountType(accountType, subType)) {
    case "asset":
    case "expense":
      return "Dr";
    case "liability":
    case "equity":
    case "income":
      return "Cr";
    case "party":
      return normalizeType(accountType) === "customer" || normalizeType(subType) === "customer" ? "Dr" : "Cr";
    default:
      return null;
  }
}

/**
 * Income-statement types in their stored spelling: a fiscal close moves their
 * balances to retained earnings. Derived from the classifier (income and
 * expense classes), so it now includes legacy "Revenue" and "Government
 * Taxes" (an expense; see ACCOUNT_TYPES_BY_CLASS). Matching should be
 * case-insensitive (see accountTypeNamesOf); this list is for display and for
 * callers that compare canonical spellings.
 */
export const PROFIT_AND_LOSS_ACCOUNT_TYPES: readonly string[] = [
  "Income",
  "Indirect Income",
  "Direct Income",
  "Revenue",
  "Expense",
  "Direct Expense",
  "Indirect Expense",
  "Government Taxes",
  "COGS",
];

const CANONICAL_BY_LOWER = new Map([...CANONICAL_ACCOUNT_TYPES].map((type) => [type.toLowerCase(), type]));

/**
 * The canonical spelling of a type that differs only by case or surrounding
 * spaces ('EXPENSE' → 'Expense'), or null when the type is unknown.
 */
export function canonicalAccountType(type: string | null | undefined): string | null {
  if (!type) return null;
  return CANONICAL_BY_LOWER.get(type.trim().toLowerCase()) ?? null;
}
