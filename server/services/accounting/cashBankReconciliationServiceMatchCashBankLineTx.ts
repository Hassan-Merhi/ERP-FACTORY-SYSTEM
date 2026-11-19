// Extracted from ./cashBankReconciliationService.ts
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
  type MatchRow,
} from "./cashBankReconciliationServiceLoadCashBankAccountTx";
import { bookTx } from "./importCashBankStatementTx";

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
