import { sql } from "drizzle-orm";

import type { DatabaseOrTransaction } from "../../db";
import { toMoney } from "../../lib/money";
import { classifyAccountType } from "./accountClassification";

/**
 * Accounts with history (wave 16 B, owner decision; re-audit section 10 HIGH).
 *
 * An account that already carries voucher lines is part of the books: its
 * opening, its category and its company decide figures that were already
 * reported (and, after a close, moved by the closing journal). Rules:
 *   - opening (amount or side) of an account with posted lines: Admin or Owner
 *     only (Developer passes, as with requireRole), audited in the writer's
 *     transaction; the opening-balance lock still refuses it after a close;
 *   - account type change across category (classifyAccountType: Expense to
 *     Asset, Income to Liability...) once the account has a line on a
 *     non-deleted voucher: refused (409). A same-category change (a subtype,
 *     Expense to Direct Expense) is allowed and audited;
 *   - company change once the account has any line at all (any company, any
 *     voucher state): refused (409).
 */

/** Voucher-line columns that name an account, as the engine attributes lines. */
export type AccountLineColumn =
  | "ledger_account_id"
  | "bank_account_id"
  | "fixed_asset_id"
  | "supplier_id"
  | "employee_id"
  | "factory_supplier_id"
  | "customer_id";

const LINE_COLUMNS: ReadonlySet<AccountLineColumn> = new Set([
  "ledger_account_id",
  "bank_account_id",
  "fixed_asset_id",
  "supplier_id",
  "employee_id",
  "factory_supplier_id",
  "customer_id",
]);

export const ACCOUNT_HISTORY_EDIT_ROLES: ReadonlySet<string> = new Set(["Admin", "Owner", "Developer"]);

export const ACCOUNT_OPENING_CHANGE_FORBIDDEN_CODE = "ACCOUNT_OPENING_CHANGE_FORBIDDEN" as const;
export const ACCOUNT_OPENING_CHANGE_FORBIDDEN_MESSAGE =
  "Only an Admin or Owner can change the opening balance of an account that already has posted entries.";
export const ACCOUNT_TYPE_CATEGORY_CHANGE_CODE = "ACCOUNT_TYPE_CATEGORY_CHANGE_REFUSED" as const;
export const ACCOUNT_TYPE_CATEGORY_CHANGE_MESSAGE =
  "This account already has posted entries, so its type cannot be moved to another category (for example Expense to Asset). Create a new account and move the balance with a journal entry.";
export const ACCOUNT_COMPANY_CHANGE_CODE = "ACCOUNT_COMPANY_CHANGE_REFUSED" as const;
export const ACCOUNT_COMPANY_CHANGE_MESSAGE =
  "This account already has voucher entries, so it cannot be moved to another company.";

export type AccountHistoryErrorCode =
  | typeof ACCOUNT_OPENING_CHANGE_FORBIDDEN_CODE
  | typeof ACCOUNT_TYPE_CATEGORY_CHANGE_CODE
  | typeof ACCOUNT_COMPANY_CHANGE_CODE;

export class AccountHistoryError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 409,
    readonly code: AccountHistoryErrorCode
  ) {
    super(message);
    this.name = "AccountHistoryError";
  }
}

/** HTTP mapping for routes; null when the error is not an account-history refusal. */
export function accountHistoryErrorResponse(
  error: unknown
): { status: 403 | 409; body: { message: string; code: AccountHistoryErrorCode } } | null {
  if (!(error instanceof AccountHistoryError)) return null;
  return { status: error.status, body: { message: error.message, code: error.code } };
}

export interface AccountLineCounts {
  /** Lines on vouchers that are not soft-deleted (optional ones included). */
  live: number;
  /** Every line naming the account, whatever its voucher's state or company. */
  any: number;
}

/**
 * How many voucher lines name the account. Several targets (a bank account
 * and its linked ledger, a customer and its owned ledger) are counted
 * together: a line naming any of them is history of the account.
 */
export async function countAccountLines(
  executor: DatabaseOrTransaction,
  targets: ReadonlyArray<readonly [AccountLineColumn, number | null | undefined]>
): Promise<AccountLineCounts> {
  const named = targets.filter((target): target is readonly [AccountLineColumn, number] => target[1] != null);
  if (named.length === 0) return { live: 0, any: 0 };
  for (const [column, id] of named) {
    if (!LINE_COLUMNS.has(column) || !Number.isSafeInteger(id)) throw new Error("account_history_invalid_target");
  }
  const predicate = sql.join(
    named.map(([column, id]) => sql`${sql.raw(`ve.${column}`)} = ${id}`),
    sql` OR `
  );
  const result = await executor.execute<{ live: string | number; any: string | number }>(sql`
    SELECT COUNT(*) FILTER (WHERE v.id IS NOT NULL AND v.deleted_at IS NULL) AS live, COUNT(*) AS any
      FROM voucher_entries ve
      LEFT JOIN vouchers v ON v.id = ve.voucher_id
     WHERE ${predicate}
  `);
  const row = result.rows[0];
  return { live: Number(row?.live ?? 0), any: Number(row?.any ?? 0) };
}

const LOCKABLE_TABLES: ReadonlySet<string> = new Set([
  "ledger_accounts",
  "bank_accounts",
  "fixed_assets",
  "factory_suppliers",
  "customers",
  "suppliers",
  "employees",
]);

/** Locks the master row for the rest of the transaction (the check and the write see the same row). */
export async function lockAccountRow(executor: DatabaseOrTransaction, table: string, id: number): Promise<void> {
  if (!LOCKABLE_TABLES.has(table) || !Number.isSafeInteger(id)) throw new Error("account_history_invalid_lock");
  await executor.execute(sql`SELECT id FROM ${sql.raw(table)} WHERE id = ${id} FOR UPDATE`);
}

/** The role a request acts with (the loaded user's, else the session's). */
export function requestRole(req: {
  user?: { role?: string | null } | null;
  session?: { currentRole?: string | null };
}) {
  return req.user?.role ?? req.session?.currentRole ?? null;
}

/** Same opening: equal amounts (exact Decimal) and, when non-zero, the same side (`defaultSide` when unset). */
function sameOpening(
  before: { amount: unknown; side?: unknown },
  after: { amount: unknown; side?: unknown },
  defaultSide: "Dr" | "Cr"
): boolean {
  const amount = (value: unknown) => toMoney(typeof value === "number" ? String(value) : (value as string | null));
  const side = (value: unknown) => (value === "Dr" || value === "Cr" ? value : defaultSide);
  const beforeAmount = amount(before.amount);
  if (!beforeAmount.equals(amount(after.amount))) return false;
  return beforeAmount.isZero() || side(before.side) === side(after.side);
}

export interface AccountChangeCheck {
  role: string | null | undefined;
  lines: AccountLineCounts;
  opening?: {
    before: { amount: unknown; side?: unknown };
    after: { amount: unknown; side?: unknown };
    defaultSide: "Dr" | "Cr";
  };
  type?: {
    before: { accountType: string | null | undefined; subType?: string | null };
    after: { accountType: string | null | undefined; subType?: string | null };
  };
  company?: { before: number | null | undefined; after: number | null | undefined };
}

/** True when the opening (amount or side) changes. */
export function openingChanges(check: Pick<AccountChangeCheck, "opening">): boolean {
  if (!check.opening) return false;
  return !sameOpening(check.opening.before, check.opening.after, check.opening.defaultSide);
}

/**
 * Applies the rules above. Throws AccountHistoryError; returns what changed
 * so the caller can audit it.
 */
export function assertAccountChangeAllowed(check: AccountChangeCheck): {
  openingChanged: boolean;
  typeChanged: boolean;
  companyChanged: boolean;
} {
  const companyChanged = !!check.company && check.company.after != null && check.company.after !== check.company.before;
  if (companyChanged && check.lines.any > 0) {
    throw new AccountHistoryError(ACCOUNT_COMPANY_CHANGE_MESSAGE, 409, ACCOUNT_COMPANY_CHANGE_CODE);
  }
  let typeChanged = false;
  if (check.type) {
    const before = check.type.before;
    const after = check.type.after;
    typeChanged =
      (before.accountType ?? null) !== (after.accountType ?? null) ||
      (before.subType ?? null) !== (after.subType ?? null);
    if (typeChanged && check.lines.live > 0) {
      const beforeClass = classifyAccountType(before.accountType, before.subType);
      const afterClass = classifyAccountType(after.accountType, after.subType);
      // An unknown type is never guessed to be in the same category as another one.
      const sameType =
        (before.accountType ?? "").trim().toLowerCase() === (after.accountType ?? "").trim().toLowerCase();
      if (beforeClass !== afterClass || (beforeClass === "unknown" && !sameType)) {
        throw new AccountHistoryError(ACCOUNT_TYPE_CATEGORY_CHANGE_MESSAGE, 409, ACCOUNT_TYPE_CATEGORY_CHANGE_CODE);
      }
    }
  }
  const openingChanged = openingChanges(check);
  if (openingChanged && check.lines.live > 0 && !ACCOUNT_HISTORY_EDIT_ROLES.has(String(check.role ?? ""))) {
    throw new AccountHistoryError(ACCOUNT_OPENING_CHANGE_FORBIDDEN_MESSAGE, 403, ACCOUNT_OPENING_CHANGE_FORBIDDEN_CODE);
  }
  return { openingChanged, typeChanged, companyChanged };
}
