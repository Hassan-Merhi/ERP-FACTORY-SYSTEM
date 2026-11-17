// Extracted from ./cashBankReconciliationService.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { statementDate } from "./cashBankStatementParser";

export type CashBankKind = "bank" | "ledger";

export class CashBankError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = "CashBankError";
  }
}

export interface CashBankAccount {
  accountKind: CashBankKind;
  accountId: number;
  companyId: number;
  name: string;
  linkedLedgerId: number | null;
  openingBalance: string;
  openingSide: string | null;
  openingNativeAmount: string | null;
  openingCurrency: string | null;
  accountType: string | null;
}

export interface AccountRow extends Record<string, unknown> {
  id: number;
  company_id: number;
  name: string;
  linked_ledger_id: number | null;
  opening_balance: string | null;
  opening_balance_side: string | null;
  opening_balance_native_amount: string | null;
  opening_balance_currency: string | null;
  account_type: string | null;
}

export interface BookRow extends Record<string, unknown> {
  entry_id: number;
  voucher_id: number;
  voucher_number: string;
  booked_on: string;
  entry_currency: string | null;
  voucher_currency: string;
  transaction_debit: string | null;
  transaction_credit: string | null;
  base_debit: string;
  base_credit: string;
  active_match_id: number | null;
  matched_statement_id: number | null;
}

export interface StatementRow extends Record<string, unknown> {
  id: number;
  row_number: number;
  transaction_date: string;
  amount: string;
  reference: string | null;
  description: string | null;
  running_balance: string | null;
  review_category: string | null;
  review_note: string | null;
  match_id: number | null;
  matched_entry_id: number | null;
  matched_voucher_id: number | null;
  matched_voucher_number: string | null;
  match_is_live: boolean | null;
}

export interface StatementHeader extends Record<string, unknown> {
  id: number;
  company_id: number;
  account_kind: CashBankKind;
  account_id: number;
  currency: string;
  period_start: string;
  period_end: string;
  opening_balance: string;
  closing_balance: string;
  file_hash: string;
  file_name: string;
  imported_at: string;
}

export interface MatchRow extends Record<string, unknown> {
  id: number;
  company_id: number;
  statement_line_id: number;
  voucher_entry_id: number;
  voided_at: string | null;
  account_kind: CashBankKind;
  account_id: number;
  period_end: string;
  currency: string;
  amount: string;
}

export const dec = (v: unknown): Decimal => {
  const n = new Decimal(String(v ?? "0"));
  if (!n.isFinite()) throw new CashBankError("CASH_BANK_AMOUNT_INVALID", "An accounting amount is invalid");
  return n;
};

export const fmt = (n: Decimal) => n.toFixed(6);

export function id(n: number, name: string): number {
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new CashBankError("CASH_BANK_ID_INVALID", `${name} must be a positive integer`, 400);
  return n;
}

function kind(k: CashBankKind): CashBankKind {
  if (k !== "bank" && k !== "ledger")
    throw new CashBankError("CASH_BANK_KIND_INVALID", "Select Bank or Cash Ledger", 400);
  return k;
}

export function currency(v: string): string {
  const code = String(v ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(code))
    throw new CashBankError("CASH_BANK_CURRENCY_INVALID", "Currency must be a three-letter code", 400);
  return code;
}

export function asDate(v: string): string {
  try {
    return statementDate(v);
  } catch {
    throw new CashBankError("CASH_BANK_DATE_INVALID", "Invalid statement date", 400);
  }
}

export async function loadCashBankAccountTx(
  tx: DbTransaction,
  input: { companyId: number; accountKind: CashBankKind; accountId: number }
): Promise<CashBankAccount> {
  id(input.companyId, "companyId");
  id(input.accountId, "accountId");
  kind(input.accountKind);
  await assertTransactionCompanyScope(tx, input.companyId);
  const isBank = input.accountKind === "bank";
  const source = isBank ? "bank_accounts" : "ledger_accounts";
  const linked = isBank ? sql`linked_ledger_id` : sql`NULL::integer`;
  const accountType = isBank ? sql`'Bank'::text` : sql`account_type`;
  const rows = resultRows<AccountRow>(
    await tx.execute(sql`
    SELECT id, company_id, name, ${linked} AS linked_ledger_id,
      opening_balance::text,opening_balance_side,
      opening_balance_native_amount::text,opening_balance_currency,
      ${accountType} AS account_type
    FROM ${sql.identifier(source)}
    WHERE id=${input.accountId} AND company_id=${input.companyId}
      AND deleted_at IS NULL LIMIT 1
  `)
  );
  const row = rows[0];
  if (!row) throw new CashBankError("CASH_BANK_ACCOUNT_MISSING", "Account not found in selected company", 404);
  if (
    !isBank &&
    !["bank", "cash"].includes(
      String(row.account_type ?? "")
        .trim()
        .toLowerCase()
    )
  )
    throw new CashBankError("CASH_BANK_ACCOUNT_TYPE", "Select a Cash or Bank ledger account", 400);
  if (!isBank) {
    const customerOwners = resultRows<{ id: number } & Record<string, unknown>>(
      await tx.execute(sql`
      SELECT id FROM customers WHERE company_id=${input.companyId}
        AND ledger_account_id=${input.accountId} LIMIT 1
    `)
    );
    if (customerOwners.length)
      throw new CashBankError(
        "CASH_BANK_CUSTOMER_LEDGER",
        "A ledger linked to a customer is not an independently reconciled cash account",
        400
      );
    const links = resultRows<{ id: number } & Record<string, unknown>>(
      await tx.execute(sql`
      SELECT id FROM bank_accounts WHERE company_id=${input.companyId}
       AND linked_ledger_id=${input.accountId} AND deleted_at IS NULL LIMIT 1
    `)
    );
    if (links.length)
      throw new CashBankError(
        "CASH_BANK_LEDGER_LINKED",
        "This ledger belongs to a bank master: reconcile through that bank account",
        400
      );
  }
  const linkedLedgerId = row.linked_ledger_id === null ? null : Number(row.linked_ledger_id);
  if (linkedLedgerId !== null) {
    const ref = resultRows<{ id: number } & Record<string, unknown>>(
      await tx.execute(sql`
      SELECT id FROM ledger_accounts WHERE id=${linkedLedgerId}
       AND company_id=${input.companyId} AND deleted_at IS NULL
       AND LOWER(TRIM(account_type)) IN ('bank','cash')
       AND NOT EXISTS(SELECT 1 FROM customers c WHERE c.company_id=${input.companyId}
         AND c.ledger_account_id=ledger_accounts.id)
    `)
    );
    if (!ref.length) throw new CashBankError("CASH_BANK_LINK_BROKEN", "Bank-linked ledger is invalid for this company");
  }
  return {
    companyId: input.companyId,
    accountKind: input.accountKind,
    accountId: input.accountId,
    name: String(row.name),
    linkedLedgerId,
    openingBalance: String(row.opening_balance ?? "0"),
    openingSide: row.opening_balance_side,
    openingNativeAmount: row.opening_balance_native_amount,
    openingCurrency: row.opening_balance_currency,
    accountType: row.account_type,
  };
}

export async function listCashBankAccountsTx(tx: DbTransaction, companyId: number) {
  id(companyId, "companyId");
  await assertTransactionCompanyScope(tx, companyId);
  const bank = resultRows<{ id: number; name: string } & Record<string, unknown>>(
    await tx.execute(sql`
    SELECT id,name FROM bank_accounts WHERE company_id=${companyId} AND deleted_at IS NULL
     ORDER BY name,id
  `)
  );
  const ledger = resultRows<{ id: number; name: string } & Record<string, unknown>>(
    await tx.execute(sql`
    SELECT l.id,l.name FROM ledger_accounts l WHERE l.company_id=${companyId}
      AND l.deleted_at IS NULL AND LOWER(TRIM(l.account_type)) IN ('cash','bank')
      AND NOT EXISTS(SELECT 1 FROM bank_accounts b WHERE b.company_id=l.company_id
        AND b.linked_ledger_id=l.id AND b.deleted_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM customers c WHERE c.company_id=l.company_id
        AND c.ledger_account_id=l.id)
     ORDER BY l.name,l.id
  `)
  );
  return [
    ...bank.map((r) => ({ accountKind: "bank" as const, accountId: Number(r.id), name: String(r.name) })),
    ...ledger.map((r) => ({ accountKind: "ledger" as const, accountId: Number(r.id), name: String(r.name) })),
  ];
}

export function rowCurrency(row: BookRow): { amount: Decimal; currency: string; verified: boolean } {
  const code = String(row.entry_currency ?? "")
    .trim()
    .toUpperCase();
  const voucher = String(row.voucher_currency ?? "USD")
    .trim()
    .toUpperCase();
  if (code && row.transaction_debit !== null && row.transaction_credit !== null)
    return { amount: dec(row.transaction_debit).minus(dec(row.transaction_credit)), currency: code, verified: true };
  return { amount: dec(row.base_debit).minus(dec(row.base_credit)), currency: "USD", verified: voucher === "USD" };
}
