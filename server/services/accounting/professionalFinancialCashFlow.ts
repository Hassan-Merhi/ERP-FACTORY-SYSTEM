/** Read-only categorized cash-flow evidence from posted vouchers. */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";

type CashSection = "operating" | "investing" | "financing" | "unclassified";
interface CashVoucher extends Record<string, unknown> {
  voucher_id: number;
  voucher_number: string;
  booked_on: string;
  cash_delta: string;
  cash_lines: number;
  other_lines: number;
  counter_class: string | null;
  source_count: string;
  source_cash_delta: string;
  source_operating: string;
  source_investing: string;
  source_financing: string;
  source_unclassified: string;
}
const dec = (x: unknown) => new Decimal(String(x ?? "0"));
const fmt = (n: Decimal) => n.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export async function sourceCashFlowTx(tx: DbTransaction, companyId: number, fromDate: string, asOfDate: string) {
  const rows = resultRows<CashVoucher>(
    await tx.execute(sql`
 WITH lines AS(
 SELECT v.id AS voucher_id,v.voucher_number,
  COALESCE(v.effective_date,v.voucher_date) AS booked_on,
  COALESCE(e.base_debit_amount,e.debit_amount,0)-
  COALESCE(e.base_credit_amount,e.credit_amount,0) AS movement,
  CASE WHEN (
    (e.ledger_account_id IS NOT NULL AND
      (LOWER(TRIM(COALESCE(la.account_type,''))) IN('cash','bank')
       OR EXISTS(
        SELECT 1 FROM bank_accounts ba
        WHERE ba.company_id=v.company_id
          AND ba.linked_ledger_id=e.ledger_account_id
          AND ba.deleted_at IS NULL)))
    OR (e.ledger_account_id IS NULL AND e.bank_account_id IS NOT NULL)
  ) THEN true ELSE false END AS is_cash,
  CASE WHEN e.fixed_asset_id IS NOT NULL THEN 'investing'
       WHEN LOWER(TRIM(COALESCE(la.account_type,''))) IN('equity','profit','loans','loan')
         THEN 'financing'
       WHEN LOWER(TRIM(COALESCE(la.account_type,''))) IN(
        'income','revenue','direct income','indirect income','expense',
        'direct expense','indirect expense','government taxes','cogs',
        'customer','supplier','accounts payable')
         OR e.customer_id IS NOT NULL OR e.supplier_id IS NOT NULL
         OR e.factory_supplier_id IS NOT NULL OR e.employee_id IS NOT NULL
         OR UPPER(COALESCE(la.code,'')) IN('INVENTORY','GOODS_IN_TRANSIT',
            'FACTORY_RAW_MATERIAL_STOCK','FACTORY_GOODS_IN_TRANSIT')
         THEN 'operating'
       ELSE 'unclassified' END AS contra_class
 FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
 LEFT JOIN ledger_accounts la ON la.id=e.ledger_account_id AND la.company_id=v.company_id
 WHERE v.company_id=${companyId} AND v.deleted_at IS NULL AND v.optional=false
   AND COALESCE(v.effective_date,v.voucher_date)>=${fromDate}::date
   AND COALESCE(v.effective_date,v.voucher_date)<=${asOfDate}::date
 ),
 vouchers_grouped AS(
 SELECT voucher_id,MAX(voucher_number) AS voucher_number,MAX(booked_on) AS booked_on,
   COALESCE(SUM(movement) FILTER (WHERE is_cash),0) AS cash_delta,
   COUNT(*) FILTER (WHERE is_cash)::int AS cash_lines,
   COUNT(*) FILTER (WHERE NOT is_cash)::int AS other_lines,
   MAX(contra_class) FILTER (WHERE NOT is_cash) AS counter_class
 FROM lines GROUP BY voucher_id
 HAVING COUNT(*) FILTER(WHERE is_cash)>0
 ),
 categorized AS(
 SELECT voucher_id,voucher_number,booked_on,cash_delta,cash_lines,other_lines,
   CASE WHEN cash_delta<>0 AND cash_lines=1 AND other_lines=1 AND counter_class IN('operating','investing','financing')
     THEN counter_class ELSE 'unclassified' END AS counter_class
 FROM vouchers_grouped
 ),
 totals AS(
 SELECT COUNT(*)::text AS source_count,
  COALESCE(SUM(cash_delta),0)::text AS source_cash_delta,
  COALESCE(SUM(cash_delta) FILTER (WHERE counter_class='operating'),0)::text AS source_operating,
  COALESCE(SUM(cash_delta) FILTER (WHERE counter_class='investing'),0)::text AS source_investing,
  COALESCE(SUM(cash_delta) FILTER (WHERE counter_class='financing'),0)::text AS source_financing,
  COALESCE(SUM(cash_delta) FILTER (WHERE counter_class='unclassified'),0)::text AS source_unclassified
 FROM categorized
 )
 SELECT c.voucher_id,c.voucher_number,c.booked_on::text,
  c.cash_delta::text,c.cash_lines,c.other_lines,c.counter_class,
  t.source_count,t.source_cash_delta,t.source_operating,
  t.source_investing,t.source_financing,t.source_unclassified
 FROM totals t LEFT JOIN categorized c ON true
 ORDER BY c.booked_on DESC,c.voucher_id DESC LIMIT 251
 `)
  );
  const sample = rows.filter((r) => r.voucher_id !== null && r.voucher_id !== undefined);
  const first = rows[0];
  const base = {
    operating: dec(first?.source_operating),
    investing: dec(first?.source_investing),
    financing: dec(first?.source_financing),
    unclassified: dec(first?.source_unclassified),
    sourceCash: dec(first?.source_cash_delta),
    count: Number(first?.source_count ?? 0),
  };
  return {
    ...base,
    truncated: base.count > 250,
    sample: sample.slice(0, 250).map((row) => ({
      voucherId: Number(row.voucher_id),
      voucherNumber: row.voucher_number,
      bookedOn: row.booked_on,
      changeUsd: fmt(dec(row.cash_delta)),
      classification: (row.counter_class ?? "unclassified") as CashSection,
    })),
  };
}
