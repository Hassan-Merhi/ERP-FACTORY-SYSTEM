import { pool } from "../../db";
import { toMoney } from "../../lib/money";

export interface RealizedProfitQuery {
  text: string;
  params: Array<number | string>;
}

/**
 * Build the bounded POS-profit query separately from the net-position
 * calculation. The baseline is a lower bound (inclusive); a missing baseline
 * deliberately omits that predicate to preserve the legacy all-time result.
 */
export function buildRealizedProfitQuery(
  companyId: number,
  baselineDate: string | null,
  toDate: string | null | undefined
): RealizedProfitQuery {
  const params: Array<number | string> = [companyId];
  // Phase 27 (RP-11): optional vouchers are not sales, and a voucher counts
  // from COALESCE(effective_date, voucher_date) as in every report.
  const predicates = ["v.voucher_type = 'Sales'", "v.deleted_at IS NULL", "v.optional = false"];

  if (baselineDate) {
    params.push(baselineDate);
    predicates.push(`COALESCE(v.effective_date, v.voucher_date) >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate);
    predicates.push(`COALESCE(v.effective_date, v.voucher_date) <= $${params.length}`);
  }

  return {
    text: `
      SELECT COALESCE(SUM(si.profit::numeric), 0) AS total
      FROM sales_items si
      JOIN vouchers v ON si.voucher_id = v.id
      WHERE v.company_id = $1
        AND ${predicates.join("\n        AND ")}
    `,
    params,
  };
}

export async function getSupplierPartnerPosProfit(
  companyId: number,
  baselineDate: string | null,
  toDate: string | null | undefined
): Promise<number> {
  const query = buildRealizedProfitQuery(companyId, baselineDate, toDate);
  const result = await pool.query<{ total: string | null }>(query.text, query.params);
  return toMoney(result.rows[0]?.total ?? 0)
    .toDecimalPlaces(2)
    .toNumber();
}
