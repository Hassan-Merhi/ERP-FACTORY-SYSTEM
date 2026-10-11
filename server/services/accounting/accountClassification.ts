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
 *   - "Government Taxes": a tax account (phase 23, C3, decided by default):
 *     a liability (tax payable), or an asset when its sub-type says the tax
 *     is receivable (see TAX_ASSET_SUBTYPE); it is no longer an expense, so
 *     the fiscal close no longer sweeps it into retained earnings;
 *   - "Intercompany": a party account; it is a receivable in debit and a
 *     payable in credit, decided by its balance;
 *   - "Customer" / "Supplier": party accounts, likewise by balance.
 * Case and surrounding spaces are ignored ('EXPENSE' is "Expense").
 */
const ACCOUNT_TYPES_BY_CLASS: Readonly<Record<Exclude<AccountClass, "unknown">, readonly string[]>> = {
  asset: ["asset", "current asset", "fixed asset", "bank", "cash"],
  liability: [
    "liability",
    "current liability",
    "loan",
    "loans",
    "duty agent",
    "transporter agent",
    "accounts payable",
    "government taxes",
  ],
  equity: ["equity", "profit"],
  income: ["income", "revenue", "indirect income", "direct income"],
  expense: ["expense", "direct expense", "indirect expense", "cogs"],
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
  const byType = CLASS_BY_TYPE.get(normalizeType(accountType));
  if (byType === "liability" && isTaxAssetAccount(accountType, subType)) return "asset";
  return byType ?? CLASS_BY_TYPE.get(normalizeType(subType)) ?? "unknown";
}

/**
 * Phase 23, C3: a tax account whose sub-type names a receivable (input VAT,
 * recoverable or prepaid tax, a tax refund due) is an asset; every other tax
 * account is a liability.
 */
const TAX_ASSET_SUBTYPE = /receivable|recoverable|input|prepaid|refund/i;
const INTERCOMPANY_ASSET_SUBTYPE = /receivable|due[ _-]?from|hadi_sp_intercompany/i;
const INTERCOMPANY_LIABILITY_SUBTYPE = /payable|due[ _-]?to|_credit|sp_hadi_intercompany/i;

function isTaxAssetAccount(accountType: string | null | undefined, subType: string | null | undefined): boolean {
  return normalizeType(accountType) === "government taxes" && TAX_ASSET_SUBTYPE.test(subType ?? "");
}

/**
 * The stored nature of an account (phase 23, C3: ledger_accounts.account_class,
 * constrained by a CHECK): one of the five classes of the accounting equation.
 * The type stays the sub-type ("Bank", "Duty Agent", "Loans", ...). Party types
 * get a nature from their usual side: a customer ASSET, a supplier LIABILITY;
 * an intercompany account by its sub-type (due from / receivable: ASSET; due to
 * / payable / a parent credit account: LIABILITY), null when the sub-type says
 * neither. Null for a type the classifier does not know (listed, never guessed).
 */
export type AccountNature = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
export const ACCOUNT_NATURES: readonly AccountNature[] = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];

export function accountNatureOf(accountType: string | null | undefined, subType?: string | null): AccountNature | null {
  const accountClass = classifyAccountType(accountType, subType);
  switch (accountClass) {
    case "asset":
      return "ASSET";
    case "liability":
      return "LIABILITY";
    case "equity":
      return "EQUITY";
    case "income":
      return "INCOME";
    case "expense":
      return "EXPENSE";
    case "party": {
      const type = normalizeType(accountType) || normalizeType(subType);
      if (type === "customer") return "ASSET";
      if (type === "supplier") return "LIABILITY";
      const sub = subType ?? "";
      if (INTERCOMPANY_ASSET_SUBTYPE.test(sub)) return "ASSET";
      if (INTERCOMPANY_LIABILITY_SUBTYPE.test(sub)) return "LIABILITY";
      return null;
    }
    default:
      return null;
  }
}

/**
 * Phase 23, C4: a case- and space-insensitive comparison of an account type with
 * one or more type names, for the call sites that check a specific sub-type
 * ("Cash", "Bank", "Intercompany", "Equity") rather than a class. Replaces raw
 * `accountType === "Cash"` comparisons, which missed 'CASH' and ' Cash'.
 */
export function isAccountType(accountType: string | null | undefined, ...names: string[]): boolean {
  const type = normalizeType(accountType);
  return type !== "" && names.some((name) => normalizeType(name) === type);
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
  // Phase 23: a sideless tax-account opening keeps the Dr it was read with while
  // the type was an expense, so reclassifying the type moves no balance.
  if (LEGACY_DEBIT_OPENING_TYPES.has(normalizeType(accountType))) return "Dr";
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

/** Types whose sideless opening stays Dr whatever their class (phase 23: tax accounts, formerly expenses). */
export const LEGACY_DEBIT_OPENING_TYPES: ReadonlySet<string> = new Set(["government taxes"]);

/**
 * Income-statement types in their stored spelling: a fiscal close moves their
 * balances to retained earnings. Derived from the classifier (income and
 * expense classes), so it includes legacy "Revenue"; "Government Taxes" is a
 * tax (balance-sheet) account since phase 23. Matching should be
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
