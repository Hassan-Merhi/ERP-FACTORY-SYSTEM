/**
 * One definition of the account types the ledger uses (2026-10 accounting audit).
 *
 * `ledger_accounts.account_type` is free text, and the audit found mis-cased
 * types written by code ('EXPENSE', 'LIABILITY', 'ASSET', 'EQUITY') that every
 * report missed, and a fiscal close that only closed 'Income' and 'Expense',
 * leaving every Direct/Indirect Expense and Indirect Income balance open into
 * the next year.
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
 * Income-statement types: a fiscal close moves their balances to retained
 * earnings. "Government Taxes" is left out on purpose: it is used both for tax
 * expense and for taxes owed, so it is not closed automatically.
 */
export const PROFIT_AND_LOSS_ACCOUNT_TYPES: readonly string[] = [
  "Income",
  "Indirect Income",
  "Expense",
  "Direct Expense",
  "Indirect Expense",
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
