/**
 * Plan batch 4 (owner-approved 2026-11-05): a Payment / Receipt voucher as it
 * stands, reduced to one SHA-256. The factory LAN server records it before an
 * offline edit or delete. The cloud computes it the same way, with this same
 * function, before applying the change, so a payment the cloud changed during
 * the outage is held instead of being overwritten.
 *
 * Covered: type, dates, optional flag, currency, rate, total, deleted state,
 * and every entry's account link and amounts. Ids and voucher numbers are
 * left out because they differ between the LAN and the cloud.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../db";
import { hashEvidence } from "./edgeSyncStageProtocol.mjs";

/** The voucher's digest, with the voucher row locked; null if it is not a Payment/Receipt of this company. */
export async function phase9PaymentSnapshotTx(
  tx: DbTransaction,
  companyId: number,
  voucherId: number
): Promise<string | null> {
  const header = await tx.execute(sql`
    SELECT voucher_type AS "voucherType", voucher_date::text AS "voucherDate",
           effective_date::text AS "effectiveDate", optional, currency,
           exchange_rate::text AS "exchangeRate", total_amount::text AS "totalAmount",
           (deleted_at IS NOT NULL) AS deleted
      FROM vouchers
     WHERE id = ${voucherId} AND company_id = ${companyId} AND voucher_type IN ('Payment', 'Receipt')
     FOR UPDATE
  `);
  const row = header.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const entries = await tx.execute(sql`
    SELECT ledger_account_id, bank_account_id, fixed_asset_id, supplier_id, employee_id, customer_id,
           factory_supplier_id, debit_amount::text AS debit, credit_amount::text AS credit,
           transaction_currency, transaction_debit_amount::text AS tx_debit,
           transaction_credit_amount::text AS tx_credit
      FROM voucher_entries
     WHERE voucher_id = ${voucherId} AND company_id = ${companyId}
  `);
  const lines = (entries.rows as Array<Record<string, unknown>>).map((entry) => JSON.stringify(entry)).sort();
  return hashEvidence({ header: row, lines });
}

/** Is any line of this voucher matched to a bank statement (an active reconciliation match)? */
export async function phase9PaymentReconciledTx(
  tx: DbTransaction,
  companyId: number,
  voucherId: number
): Promise<boolean> {
  const installed = await tx.execute(sql`SELECT to_regclass('public.accounting_cash_bank_matches') IS NOT NULL AS ok`);
  if ((installed.rows[0] as { ok?: boolean } | undefined)?.ok !== true) return false;
  const matched = await tx.execute(sql`
    SELECT 1
      FROM accounting_cash_bank_matches m
      JOIN voucher_entries e ON e.id = m.voucher_entry_id
     WHERE e.voucher_id = ${voucherId} AND m.company_id = ${companyId} AND m.voided_at IS NULL
     LIMIT 1
  `);
  return matched.rows.length > 0;
}
