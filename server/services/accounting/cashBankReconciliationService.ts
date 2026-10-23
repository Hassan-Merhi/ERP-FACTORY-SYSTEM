/**
 * Cash & Bank reconciliation, Phase 4.
 * Reconciliation is *metadata*, never an adjusting journal.
 *
 * Bank master targets include direct bank_account_id voucher entries and
 * entries on their linked ledger (deduplicated per entry ID). A ledger target
 * includes only ledger_account_id entries not owned by customers or a linked
 * bank master. This matches the existing ledger attribution priority.
 */
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { writeAuditEvent } from "../audit";
import { companyBusinessDate } from "./companyBusinessDate";
import { statementDate, type ParsedStatementLine } from "./cashBankStatementParser";

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
interface AccountRow extends Record<string, unknown> {
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
interface BookRow extends Record<string, unknown> {
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
interface StatementRow extends Record<string, unknown> {
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
interface StatementHeader extends Record<string, unknown> {
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
interface MatchRow extends Record<string, unknown> {
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
const dec = (v: unknown): Decimal => {
  const n = new Decimal(String(v ?? "0"));
  if (!n.isFinite()) throw new CashBankError("CASH_BANK_AMOUNT_INVALID", "An accounting amount is invalid");
  return n;
};
const fmt = (n: Decimal) => n.toFixed(6);
function id(n: number, name: string): number {
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new CashBankError("CASH_BANK_ID_INVALID", `${name} must be a positive integer`, 400);
  return n;
}
function kind(k: CashBankKind): CashBankKind {
  if (k !== "bank" && k !== "ledger")
    throw new CashBankError("CASH_BANK_KIND_INVALID", "Select Bank or Cash Ledger", 400);
  return k;
}
function currency(v: string): string {
  const code = String(v ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(code))
    throw new CashBankError("CASH_BANK_CURRENCY_INVALID", "Currency must be a three-letter code", 400);
  return code;
}
function asDate(v: string): string {
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
    FROM ${sql.raw(source)}
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
function rowCurrency(row: BookRow): { amount: Decimal; currency: string; verified: boolean } {
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
function opening(input: CashBankAccount, currencyCode: string): { amount: Decimal; verified: boolean } {
  const raw = dec(input.openingBalance);
  const original = input.openingNativeAmount !== null ? dec(input.openingNativeAmount) : null;
  const nativeCode = String(input.openingCurrency ?? "").toUpperCase();
  if (original !== null && nativeCode === currencyCode)
    return { amount: input.openingSide === "Cr" ? original.negated() : original, verified: true };
  if (raw.isZero()) return { amount: new Decimal(0), verified: true };
  if (currencyCode === "USD" && (!nativeCode || nativeCode === "USD"))
    return { amount: input.openingSide === "Cr" ? raw.negated() : raw, verified: true };
  return { amount: new Decimal(0), verified: false };
}
async function bankOpeningTx(tx: DbTransaction, a: CashBankAccount, code: string) {
  const parts = [opening(a, code)];
  if (a.linkedLedgerId !== null) {
    const rows = resultRows<AccountRow>(
      await tx.execute(sql`
      SELECT id,company_id,name,NULL::integer AS linked_ledger_id,
        opening_balance::text,opening_balance_side,
        opening_balance_native_amount::text,opening_balance_currency,account_type
      FROM ledger_accounts WHERE id=${a.linkedLedgerId} AND company_id=${a.companyId}
    `)
    );
    const linked = rows[0];
    if (linked)
      parts.push(
        opening(
          {
            ...a,
            openingBalance: String(linked.opening_balance ?? "0"),
            openingSide: linked.opening_balance_side,
            openingNativeAmount: linked.opening_balance_native_amount,
            openingCurrency: linked.opening_balance_currency,
            accountType: linked.account_type,
          },
          code
        )
      );
  }
  return {
    amount: parts.reduce((sum, p) => sum.plus(p.amount), new Decimal(0)),
    verified: parts.every((p) => p.verified),
  };
}
async function bookTx(tx: DbTransaction, account: CashBankAccount, through: string): Promise<BookRow[]> {
  const owned =
    account.accountKind === "bank"
      ? sql`((e.bank_account_id=${account.accountId} AND e.ledger_account_id IS NULL)
       OR (${account.linkedLedgerId}::integer IS NOT NULL AND e.ledger_account_id=${account.linkedLedgerId}))`
      : sql`e.ledger_account_id=${account.accountId}`;
  return resultRows<BookRow>(
    await tx.execute(sql`
    SELECT e.id AS entry_id,v.id AS voucher_id,v.voucher_number,
      COALESCE(v.effective_date,v.voucher_date)::text AS booked_on,
      v.currency AS voucher_currency,e.transaction_currency AS entry_currency,
      e.transaction_debit_amount::text AS transaction_debit,
      e.transaction_credit_amount::text AS transaction_credit,
      COALESCE(e.base_debit_amount,e.debit_amount,0)::text AS base_debit,
      COALESCE(e.base_credit_amount,e.credit_amount,0)::text AS base_credit,
      m.id AS active_match_id,ls.statement_id AS matched_statement_id
    FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
    LEFT JOIN accounting_cash_bank_matches m ON m.voucher_entry_id=e.id AND m.voided_at IS NULL
    LEFT JOIN accounting_cash_bank_statement_lines ls ON ls.id=m.statement_line_id
    WHERE v.company_id=${account.companyId} AND v.optional=false AND v.deleted_at IS NULL
      AND COALESCE(v.effective_date,v.voucher_date)<=${through}::date
      AND ${owned}
    ORDER BY COALESCE(v.effective_date,v.voucher_date),e.id
  `)
  );
}

export async function importCashBankStatementTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    accountKind: CashBankKind;
    accountId: number;
    currency: string;
    periodStart: string;
    periodEnd: string;
    openingBalance: string;
    closingBalance: string;
    fileName: string;
    fileBytes: Buffer;
    lines: ParsedStatementLine[];
    actor: { userId: string; username: string };
  }
) {
  const a = await loadCashBankAccountTx(tx, input);
  const code = currency(input.currency);
  const from = asDate(input.periodStart),
    through = asDate(input.periodEnd);
  if (from > through) throw new CashBankError("CASH_BANK_PERIOD_INVALID", "Statement start is after end", 400);
  if (!input.lines.length || input.lines.length > 5000)
    throw new CashBankError("CASH_BANK_IMPORT_SIZE", "A statement needs 1–5,000 transactions", 400);
  const begin = dec(input.openingBalance),
    end = dec(input.closingBalance);
  if ([begin, end].some((v) => v.decimalPlaces() > 6 || v.abs().gte("100000000000000")))
    throw new CashBankError(
      "CASH_BANK_PRECISION",
      "Statement balances must fit six decimals and permitted currency range",
      400
    );
  const movement = input.lines.reduce((sum, l) => sum.plus(dec(l.signedAmount)), new Decimal(0));
  if (!begin.plus(movement).eq(end))
    throw new CashBankError(
      "CASH_BANK_STATEMENT_UNBALANCED",
      `Imported rows do not reconcile to the statement closing amount (computed ${fmt(begin.plus(movement))}, supplied ${fmt(end)})`,
      400
    );
  if (input.lines.some((l) => l.transactionDate < from || l.transactionDate > through))
    throw new CashBankError("CASH_BANK_PERIOD_INVALID", "Statement line outside selected period", 400);
  const hash = createHash("sha256").update(input.fileBytes).digest("hex");
  // Serialize duplicate imports across concurrent HTTP requests.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`bank-import:${input.companyId}:${input.accountKind}:${input.accountId}:${hash}`}))`
  );
  const existing = resultRows<
    {
      id: number;
      period_start: string;
      period_end: string;
      currency: string;
      opening_balance: string;
      closing_balance: string;
    } & Record<string, unknown>
  >(
    await tx.execute(sql`
      SELECT id,period_start::text,period_end::text,currency,opening_balance::text,closing_balance::text
      FROM accounting_cash_bank_statements WHERE company_id=${input.companyId}
        AND account_kind=${input.accountKind} AND account_id=${input.accountId}
        AND file_hash=${hash} LIMIT 1
    `)
  )[0];
  if (existing) {
    if (
      existing.period_start !== from ||
      existing.period_end !== through ||
      existing.currency !== code ||
      !dec(existing.opening_balance).eq(begin) ||
      !dec(existing.closing_balance).eq(end)
    )
      throw new CashBankError(
        "CASH_BANK_IMPORT_CONFLICT",
        "This statement file is already imported with different settings"
      );
    return { statementId: Number(existing.id), replayed: true, count: input.lines.length };
  }
  const ins = resultRows<{ id: number } & Record<string, unknown>>(
    await tx.execute(sql`
    INSERT INTO accounting_cash_bank_statements
      (company_id,account_kind,account_id,currency,period_start,period_end,
       opening_balance,closing_balance,file_hash,file_name,imported_by)
    VALUES (${input.companyId},${input.accountKind},${input.accountId},${code},
      ${from}::date,${through}::date,${fmt(begin)}::numeric,${fmt(end)}::numeric,
      ${hash},${input.fileName.slice(0, 255)},${input.actor.userId}) RETURNING id
  `)
  )[0];
  if (!ins) throw new CashBankError("CASH_BANK_IMPORT_FAILED", "Statement import could not be saved");
  for (const l of input.lines) {
    await tx.execute(sql`
      INSERT INTO accounting_cash_bank_statement_lines
       (company_id,statement_id,row_number,transaction_date,amount,reference,description,running_balance)
      VALUES (${input.companyId},${Number(ins.id)},${l.rowNumber},${l.transactionDate}::date,
        ${l.signedAmount}::numeric,${l.reference},${l.description},
        ${l.runningBalance}::numeric)
    `);
  }
  await writeAuditEvent(
    {
      companyId: input.companyId,
      userId: input.actor.userId,
      username: input.actor.username,
      action: "import",
      tableName: "accounting_cash_bank_statements",
      recordId: Number(ins.id),
      recordIdentifier: hash,
      changes: {
        account: { new: `${a.accountKind}:${a.accountId}` },
        currency: { new: code },
        period: { new: `${from}..${through}` },
        rows: { new: input.lines.length },
      },
    },
    tx
  );
  return { statementId: Number(ins.id), replayed: false, count: input.lines.length };
}

async function statementHeaderTx(tx: DbTransaction, companyId: number, statementId: number) {
  const rows = resultRows<StatementHeader>(
    await tx.execute(sql`
    SELECT id,company_id,account_kind,account_id,currency,
      period_start::text,period_end::text,opening_balance::text,closing_balance::text,
      file_hash,file_name,imported_at::text
    FROM accounting_cash_bank_statements
    WHERE company_id=${companyId} AND id=${statementId} LIMIT 1
  `)
  );
  if (!rows.length) throw new CashBankError("CASH_BANK_STATEMENT_NOT_FOUND", "Statement not found", 404);
  return rows[0];
}
export async function listCashBankStatementsTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    accountKind: CashBankKind;
    accountId: number;
  }
) {
  await loadCashBankAccountTx(tx, input);
  return resultRows<StatementHeader>(
    await tx.execute(sql`
    SELECT id,company_id,account_kind,account_id,currency,
      period_start::text,period_end::text,opening_balance::text,closing_balance::text,
      file_hash,file_name,imported_at::text
    FROM accounting_cash_bank_statements
    WHERE company_id=${input.companyId} AND account_kind=${input.accountKind}
      AND account_id=${input.accountId} ORDER BY period_end DESC,id DESC LIMIT 100
  `)
  );
}
export async function cashBankStatementDetailTx(tx: DbTransaction, companyId: number, statementId: number) {
  id(companyId, "companyId");
  id(statementId, "statementId");
  await assertTransactionCompanyScope(tx, companyId);
  const head = await statementHeaderTx(tx, companyId, statementId);
  const account = await loadCashBankAccountTx(tx, {
    companyId,
    accountKind: head.account_kind,
    accountId: Number(head.account_id),
  });
  const lines = resultRows<StatementRow>(
    await tx.execute(sql`
    SELECT l.id,l.row_number,l.transaction_date::text,l.amount::text,
      l.reference,l.description,l.running_balance::text,l.review_category,l.review_note,
      m.id AS match_id,m.voucher_entry_id AS matched_entry_id,
      v.id AS matched_voucher_id,v.voucher_number AS matched_voucher_number,
      (v.id IS NOT NULL AND v.deleted_at IS NULL AND v.optional=false) AS match_is_live
    FROM accounting_cash_bank_statement_lines l
    LEFT JOIN accounting_cash_bank_matches m
      ON m.statement_line_id=l.id AND m.voided_at IS NULL
    LEFT JOIN voucher_entries e ON e.id=m.voucher_entry_id
    LEFT JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=${companyId}
    WHERE l.company_id=${companyId} AND l.statement_id=${statementId}
    ORDER BY l.row_number
  `)
  );
  const book = await bookTx(tx, account, head.period_end);
  const opened = await bankOpeningTx(tx, account, head.currency);
  const unverified = book.filter((r) => !rowCurrency(r).verified);
  const otherCurrency = book.filter((r) => rowCurrency(r).verified && rowCurrency(r).currency !== head.currency);
  const matchingBook = book.filter((r) => rowCurrency(r).verified && rowCurrency(r).currency === head.currency);
  const bookedBefore = matchingBook
    .filter((r) => r.booked_on < head.period_start)
    .reduce((s, r) => s.plus(rowCurrency(r).amount), opened.amount);
  const bookedEnd = matchingBook.reduce((s, r) => s.plus(rowCurrency(r).amount), opened.amount);
  const matchedEntries = new Set(
    lines.filter((r) => r.match_id != null && r.match_is_live).map((r) => Number(r.matched_entry_id))
  );
  const uncleared = matchingBook.filter((r) => r.active_match_id === null);
  const unclearedAmount = uncleared.reduce((s, r) => s.plus(rowCurrency(r).amount), new Decimal(0));
  const unmatchedStatement = lines.filter((r) => r.match_id === null || !r.match_is_live);
  const unenteredAmount = unmatchedStatement.reduce((s, r) => s.plus(dec(r.amount)), new Decimal(0));
  const adjusted = bookedEnd.minus(unclearedAmount).plus(unenteredAmount);
  const possible = opened.verified && unverified.length === 0 && otherCurrency.length === 0;
  const entries = book.map((r) => {
    const c = rowCurrency(r);
    return {
      entryId: Number(r.entry_id),
      voucherId: Number(r.voucher_id),
      voucherNumber: r.voucher_number,
      date: r.booked_on,
      amount: fmt(c.amount),
      currency: c.currency,
      currencyVerified: c.verified,
      eligible: c.verified && c.currency === head.currency && r.active_match_id === null,
      matched: r.active_match_id !== null,
      matchedToStatementId: r.matched_statement_id === null ? null : Number(r.matched_statement_id),
    };
  });
  return {
    statement: head,
    account: {
      name: account.name,
      kind: account.accountKind,
      id: account.accountId,
      linkedLedgerId: account.linkedLedgerId,
    },
    lines: lines.map((r) => ({
      id: Number(r.id),
      rowNumber: Number(r.row_number),
      date: r.transaction_date,
      amount: r.amount,
      reference: r.reference,
      description: r.description,
      reviewCategory: r.review_category,
      reviewNote: r.review_note,
      matchId: r.match_id === null ? null : Number(r.match_id),
      matchedEntryId: r.matched_entry_id === null ? null : Number(r.matched_entry_id),
      matchedVoucherId: r.matched_voucher_id === null ? null : Number(r.matched_voucher_id),
      matchedVoucherNumber: r.matched_voucher_number,
      status: r.match_id === null ? "unmatched" : r.match_is_live ? "matched" : "stale",
    })),
    bookEntries: entries,
    balances: {
      currency: head.currency,
      statementOpening: head.opening_balance,
      statementClosing: head.closing_balance,
      statementMovement: fmt(lines.reduce((sum, r) => sum.plus(dec(r.amount)), new Decimal(0))),
      bookOpening: possible ? fmt(bookedBefore) : null,
      bookClosing: possible ? fmt(bookedEnd) : null,
      bookVsStatementDifference: possible ? fmt(dec(head.closing_balance).minus(bookedEnd)) : null,
      unclearedBook: fmt(unclearedAmount),
      unmatchedStatement: fmt(unenteredAmount),
      adjustedBook: possible ? fmt(adjusted) : null,
      residual: possible ? fmt(dec(head.closing_balance).minus(adjusted)) : null,
      matched: matchedEntries.size,
      unmatchedStatementCount: unmatchedStatement.length,
      unclearedBookCount: uncleared.length,
      openingVerified: opened.verified,
      unverifiedEntries: unverified.length,
      otherCurrencyEntries: otherCurrency.length,
      reconcilable:
        possible &&
        unmatchedStatement.length === 0 &&
        uncleared.length === 0 &&
        dec(head.closing_balance).eq(bookedEnd),
    },
  };
}
export async function matchCashBankLineTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    statementLineId: number;
    voucherEntryId: number;
    actor: { userId: string; username: string };
    reason?: string | null;
  }
) {
  id(input.companyId, "companyId");
  id(input.statementLineId, "statementLineId");
  id(input.voucherEntryId, "voucherEntryId");
  await assertTransactionCompanyScope(tx, input.companyId);
  const fetched = resultRows<MatchRow>(
    await tx.execute(sql`
    SELECT l.id AS statement_line_id,l.amount::text,m.id,m.voided_at::text,
      s.company_id AS company_id,s.account_kind,s.account_id,s.period_end::text,s.currency,
      m.voucher_entry_id
    FROM accounting_cash_bank_statement_lines l
    JOIN accounting_cash_bank_statements s ON s.id=l.statement_id AND s.company_id=l.company_id
    LEFT JOIN accounting_cash_bank_matches m ON m.statement_line_id=l.id AND m.voided_at IS NULL
    WHERE l.company_id=${input.companyId} AND l.id=${input.statementLineId} FOR UPDATE OF l
  `)
  );
  const line = fetched[0];
  if (!line) throw new CashBankError("CASH_BANK_LINE_NOT_FOUND", "Statement line not found", 404);
  const account = await loadCashBankAccountTx(tx, {
    companyId: input.companyId,
    accountKind: line.account_kind,
    accountId: Number(line.account_id),
  });
  // Serialize all matching in this account; unique active-entry index also
  // protects against entry reuse across different accounts/periods.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`bank-match:${input.companyId}:${account.accountKind}:${account.accountId}`}))`
  );
  const entries = await bookTx(tx, account, line.period_end);
  if (line.id != null) {
    const savedEntry = entries.find((r) => Number(r.entry_id) === Number(line.voucher_entry_id));
    if (!savedEntry)
      throw new CashBankError(
        "CASH_BANK_MATCH_STALE",
        "Existing match references a retired or no-longer-eligible voucher; unmatch it first"
      );
    if (Number(line.voucher_entry_id) === input.voucherEntryId) return { matchId: Number(line.id), replayed: true };
    throw new CashBankError("CASH_BANK_LINE_ALREADY_MATCHED", "Statement line is already matched");
  }
  const entry = entries.find((r) => Number(r.entry_id) === input.voucherEntryId);
  if (!entry)
    throw new CashBankError("CASH_BANK_ENTRY_INELIGIBLE", "Voucher entry is not a live posting to this account");
  if (entry.active_match_id !== null)
    throw new CashBankError("CASH_BANK_ENTRY_ALREADY_MATCHED", "Voucher entry was matched to another statement");
  const amount = rowCurrency(entry);
  if (!amount.verified || amount.currency !== line.currency)
    throw new CashBankError(
      "CASH_BANK_FX_UNVERIFIED",
      "Voucher currency must match the statement with verified native amounts"
    );
  if (!amount.amount.eq(dec(line.amount)))
    throw new CashBankError(
      "CASH_BANK_MATCH_AMOUNT_MISMATCH",
      "Statement and voucher movement amounts must match exactly"
    );
  const bookedOn = await companyBusinessDate(input.companyId, tx);
  await tx.execute(sql`SELECT erp_assert_accounting_date_open(${input.companyId},${bookedOn}::date)`);
  const ins = resultRows<{ id: number } & Record<string, unknown>>(
    await tx.execute(sql`
    INSERT INTO accounting_cash_bank_matches
     (company_id,statement_line_id,voucher_entry_id,matched_on,matched_by,reason)
    VALUES (${input.companyId},${input.statementLineId},${input.voucherEntryId},
      ${bookedOn}::date,${input.actor.userId},${input.reason ?? null}) RETURNING id
  `)
  )[0];
  if (!ins) throw new CashBankError("CASH_BANK_MATCH_FAILED", "Could not persist statement match");
  await writeAuditEvent(
    {
      companyId: input.companyId,
      userId: input.actor.userId,
      username: input.actor.username,
      action: "create",
      tableName: "accounting_cash_bank_matches",
      recordId: Number(ins.id),
      recordIdentifier: `statement-line:${input.statementLineId}`,
      changes: {
        voucherEntryId: { new: input.voucherEntryId },
        amount: { new: fmt(amount.amount) },
        currency: { new: line.currency },
        reason: { new: input.reason ?? null },
      },
    },
    tx
  );
  return { matchId: Number(ins.id), replayed: false };
}
export async function voidCashBankMatchTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    matchId: number;
    reason: string;
    actor: { userId: string; username: string };
  }
) {
  id(input.companyId, "companyId");
  id(input.matchId, "matchId");
  if (!input.reason?.trim()) throw new CashBankError("CASH_BANK_REASON_REQUIRED", "Unmatching requires a reason", 400);
  await assertTransactionCompanyScope(tx, input.companyId);
  const row = resultRows<{ id: number; matched_on: string; voided_at: string | null } & Record<string, unknown>>(
    await tx.execute(sql`
      SELECT id,matched_on::text,voided_at::text FROM accounting_cash_bank_matches
      WHERE company_id=${input.companyId} AND id=${input.matchId} FOR UPDATE
    `)
  )[0];
  if (!row) throw new CashBankError("CASH_BANK_MATCH_NOT_FOUND", "Match not found", 404);
  if (row.voided_at) throw new CashBankError("CASH_BANK_MATCH_ALREADY_VOIDED", "Match was already cancelled");
  const bookedOn = await companyBusinessDate(input.companyId, tx);
  await tx.execute(sql`SELECT erp_assert_accounting_date_open(${input.companyId},${bookedOn}::date)`);
  await tx.execute(sql`UPDATE accounting_cash_bank_matches
    SET voided_at=now(),voided_by=${input.actor.userId},void_reason=${input.reason.trim()}
    WHERE company_id=${input.companyId} AND id=${input.matchId} AND voided_at IS NULL`);
  await writeAuditEvent(
    {
      companyId: input.companyId,
      userId: input.actor.userId,
      username: input.actor.username,
      action: "void",
      tableName: "accounting_cash_bank_matches",
      recordId: input.matchId,
      recordIdentifier: `match:${input.matchId}`,
      changes: { voided: { old: false, new: true }, reason: { new: input.reason.trim() } },
    },
    tx
  );
  return { matchId: input.matchId, voided: true };
}

/** Categorize unmatched statement evidence without posting an accounting entry. */
export async function reviewCashBankLineTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    statementLineId: number;
    category: "bank_fee" | "transfer" | "unidentified_receipt" | "unidentified_payment" | "other" | null;
    note: string | null;
    actor: { userId: string; username: string };
  }
) {
  id(input.companyId, "companyId");
  id(input.statementLineId, "statementLineId");
  await assertTransactionCompanyScope(tx, input.companyId);
  const record = resultRows<
    { id: number; amount: string; review_category: string | null; review_note: string | null } & Record<string, unknown>
  >(
    await tx.execute(sql`
      SELECT id,amount::text,review_category,review_note
      FROM accounting_cash_bank_statement_lines WHERE id=${input.statementLineId}
      AND company_id=${input.companyId} FOR UPDATE
    `)
  )[0];
  if (!record) throw new CashBankError("CASH_BANK_LINE_NOT_FOUND", "Statement line not found", 404);
  if (input.category === "unidentified_receipt" && dec(record.amount).lte(0))
    throw new CashBankError("CASH_BANK_CATEGORY_INVALID", "Unidentified receipts must be positive", 400);
  if (input.category === "unidentified_payment" && dec(record.amount).gte(0))
    throw new CashBankError("CASH_BANK_CATEGORY_INVALID", "Unidentified payments must be negative", 400);
  if (input.note && input.note.length > 1500)
    throw new CashBankError("CASH_BANK_NOTE_TOO_LONG", "Review notes have a 1,500 character limit", 400);
  if (record.review_category === input.category && (record.review_note ?? null) === (input.note ?? null))
    return { lineId: input.statementLineId, unchanged: true };
  const today = await companyBusinessDate(input.companyId, tx);
  await tx.execute(sql`SELECT erp_assert_accounting_date_open(${input.companyId},${today}::date)`);
  await tx.execute(sql`UPDATE accounting_cash_bank_statement_lines
    SET review_category=${input.category},review_note=${input.note ?? null},
      reviewed_by=${input.actor.userId},reviewed_at=NOW()
    WHERE id=${input.statementLineId} AND company_id=${input.companyId}`);
  await writeAuditEvent(
    {
      companyId: input.companyId,
      userId: input.actor.userId,
      username: input.actor.username,
      action: "update",
      tableName: "accounting_cash_bank_statement_lines",
      recordId: input.statementLineId,
      recordIdentifier: `bank-line:${input.statementLineId}`,
      changes: {
        category: { old: record.review_category, new: input.category },
        note: { old: record.review_note, new: input.note },
      },
    },
    tx
  );
  return { lineId: input.statementLineId, unchanged: false };
}
