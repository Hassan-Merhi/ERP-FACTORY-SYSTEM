// Extracted from ./cashBankReconciliationService.ts to keep that module under the source-size cap.
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { writeAuditEvent } from "../audit";
import type { ParsedStatementLine } from "./cashBankStatementParser";
import {
  CashBankError,
  asDate,
  currency,
  dec,
  fmt,
  loadCashBankAccountTx,
  type AccountRow,
  type BookRow,
  type CashBankAccount,
  type CashBankKind,
  type StatementHeader,
} from "./cashBankReconciliationServiceLoadCashBankAccountTx";

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

export async function bankOpeningTx(tx: DbTransaction, a: CashBankAccount, code: string) {
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

export async function bookTx(tx: DbTransaction, account: CashBankAccount, through: string): Promise<BookRow[]> {
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

export async function statementHeaderTx(tx: DbTransaction, companyId: number, statementId: number) {
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
