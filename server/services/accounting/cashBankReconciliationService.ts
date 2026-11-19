/**
 * Cash & Bank reconciliation, Phase 4.
 * Reconciliation is *metadata*, never an adjusting journal.
 *
 * Bank master targets include direct bank_account_id voucher entries and
 * entries on their linked ledger (deduplicated per entry ID). A ledger target
 * includes only ledger_account_id entries not owned by customers or a linked
 * bank master. This matches the existing ledger attribution priority.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { writeAuditEvent } from "../audit";
import { companyBusinessDate } from "./companyBusinessDate";
import {
  CashBankError,
  dec,
  fmt,
  id,
  loadCashBankAccountTx,
  rowCurrency,
  type CashBankKind,
  type StatementHeader,
  type StatementRow,
} from "./cashBankReconciliationServiceLoadCashBankAccountTx";
import { bankOpeningTx, bookTx, statementHeaderTx } from "./importCashBankStatementTx";
export { matchCashBankLineTx } from "./cashBankReconciliationServiceMatchCashBankLineTx";
export {
  CashBankError,
  listCashBankAccountsTx,
  loadCashBankAccountTx,
} from "./cashBankReconciliationServiceLoadCashBankAccountTx";
export type { CashBankAccount, CashBankKind } from "./cashBankReconciliationServiceLoadCashBankAccountTx";
export { importCashBankStatementTx } from "./importCashBankStatementTx";
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
