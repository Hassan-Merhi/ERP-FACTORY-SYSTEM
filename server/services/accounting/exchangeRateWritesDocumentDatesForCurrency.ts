// Extracted from ./exchangeRateWrites.ts
import { sql } from "drizzle-orm";
import { type DbTransaction } from "../../db";

/** Why a factory rate row was kept by a currency delete. */
export type KeptFactoryFxRateReason = "used_by_document" | "recorded_auto_rate" | "archived_rate";

export interface KeptFactoryFxRate {
  id: number;
  rate: string;
  effectiveDate: string;
  source: string;
  reason: KeptFactoryFxRateReason;
}

export interface DeleteFactoryFxRatesResult {
  removed: number;
  removedRows: { id: number; rate: string; effectiveDate: string; source: string }[];
  kept: KeptFactoryFxRate[];
}

/**
 * The distinct dates (YYYY-MM-DD) of every document of the company in one
 * currency that a dated factory rate may have priced: vouchers (by voucher and
 * effective date, deleted and optional ones included, since they can be
 * restored), voucher lines in that transaction currency, factory POS sales and
 * factory daybook events. Conservative on purpose: a date counts whatever the
 * document's state.
 */
export async function documentDatesForCurrency(
  tx: DbTransaction,
  companyId: number,
  currencyCode: string
): Promise<string[]> {
  const result = await tx.execute<{ d: string } & Record<string, unknown>>(sql`
    SELECT DISTINCT d::text AS d FROM (
      SELECT v.voucher_date AS d FROM vouchers v
       WHERE v.company_id = ${companyId} AND UPPER(COALESCE(v.currency, 'USD')) = ${currencyCode}
      UNION
      SELECT v.effective_date FROM vouchers v
       WHERE v.company_id = ${companyId} AND UPPER(COALESCE(v.currency, 'USD')) = ${currencyCode}
         AND v.effective_date IS NOT NULL
      UNION
      SELECT COALESCE(v.effective_date, v.voucher_date) FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
       WHERE v.company_id = ${companyId} AND UPPER(ve.transaction_currency) = ${currencyCode}
      UNION
      SELECT s.tx_date FROM factory_pos_sales s
       WHERE s.company_id = ${companyId} AND UPPER(s.currency_code) = ${currencyCode}
      UNION
      SELECT e.tx_date FROM factory_daybook_entries e
       WHERE e.company_id = ${companyId} AND UPPER(e.currency_code) = ${currencyCode}
    ) dates WHERE d IS NOT NULL
  `);
  return (result.rows as unknown as { d: string }[]).map((row) => String(row.d).slice(0, 10));
}

export interface FetchedFactoryRateInput {
  currencyCode: string;
  effectiveDate: string;
}
