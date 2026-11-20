/**
 * Legacy manual FX journals were posted as native USD cash movements.
 * They cannot be treated as automatic base-only revaluations: doing so
 * books the same difference twice or corrupts the native-currency exposure.
 *
 * This is a READ-ONLY, company-scoped blocking diagnostic, not a repair.
 * A reviewed reversal + native-zero base-only replacement must resolve it.
 */
import { sql } from "drizzle-orm";
import { resultRows } from "../../lib/queryResult";
import type { db } from "../../db";

export type LegacyManualFxConflict = { voucherId: number; voucherNumber: string };

export function legacyManualFxConflictReason(conflicts: readonly LegacyManualFxConflict[]): string {
  return (
    "Automatic FX revaluation skipped: manual FX journal(s) " +
    conflicts.map((row) => row.voucherNumber).join(", ") +
    " contain ordinary native-USD cash/customer/loan entries. " +
    "Review and reverse the originals, classify the FX account as Indirect Expense, " +
    "then post a native-zero BASE_ONLY_REVALUATION correction. No new journal was created."
  );
}

export async function findLegacyManualFxConflicts(
  executor: Pick<typeof db, "execute">,
  companyId: number,
  businessDate: string
): Promise<LegacyManualFxConflict[]> {
  // A matching manual source, recognizable FX counter-line AND native-USD
  // monetary target are all required: ordinary cash vouchers must not block FX.
  // Exclude already reversed originals so a reviewed correction unblocks saves.
  const rows = resultRows<{ voucher_id: number; voucher_number: string }>(
    await executor.execute(sql`
      SELECT DISTINCT v.id AS voucher_id, v.voucher_number::text AS voucher_number
        FROM vouchers v
        JOIN accounting_posting_requests p
          ON p.company_id = v.company_id AND p.voucher_id = v.id
       WHERE v.company_id = ${companyId}
         AND p.source_type = 'manual-journal'
         AND v.deleted_at IS NULL AND v.optional = false
         AND COALESCE(v.effective_date, v.voucher_date) <= ${businessDate}::date
         AND (
           v.description ILIKE '%fx%reval%'
           OR v.description ILIKE '%exchange%reval%'
         )
         AND EXISTS (
           SELECT 1 FROM voucher_entries counter
           JOIN ledger_accounts fx
             ON fx.id = counter.ledger_account_id AND fx.company_id = v.company_id
           WHERE counter.company_id = v.company_id AND counter.voucher_id = v.id
             AND (
               fx.code IN ('FX-REVALUATION', 'FXREVGAI')
               OR lower(trim(fx.name)) = 'fx revaluation gain/loss'
             )
         )
         AND EXISTS (
           SELECT 1 FROM voucher_entries movement
           LEFT JOIN ledger_accounts account
             ON account.id = movement.ledger_account_id AND account.company_id = v.company_id
           WHERE movement.company_id = v.company_id AND movement.voucher_id = v.id
             AND upper(trim(COALESCE(movement.transaction_currency, ''))) = 'USD'
             AND movement.rate_convention = 'IDENTITY'
             AND ABS(COALESCE(movement.debit_amount, 0) - COALESCE(movement.credit_amount, 0)) >= 0.01
             AND (
               lower(trim(COALESCE(account.account_type, ''))) IN ('cash', 'bank', 'loan', 'loans', 'customer')
               OR movement.bank_account_id IS NOT NULL
               OR movement.customer_id IS NOT NULL
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM vouchers reversal
           WHERE reversal.company_id = v.company_id
             AND reversal.deleted_at IS NULL
             AND reversal.reversal_of_voucher_id = v.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM accounting_posting_requests reversal_request
           JOIN vouchers reversal
             ON reversal.id = reversal_request.voucher_id AND reversal.company_id = v.company_id
           WHERE reversal_request.company_id = v.company_id
             AND reversal_request.idempotency_key = ('voucher-reversal:' || v.company_id::text || ':' || v.id::text)
             AND reversal.deleted_at IS NULL
         )
       ORDER BY v.id
       LIMIT 10
    `)
  );
  return rows.map((row) => ({
    voucherId: Number(row.voucher_id),
    voucherNumber: row.voucher_number,
  }));
}
