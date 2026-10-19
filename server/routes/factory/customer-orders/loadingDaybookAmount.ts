import { sql, type SQL } from "drizzle-orm";

/**
 * Mirror the source order's authoritative, already-calculated selling total
 * into its LOADING_CREATED daybook event. This is informational only:
 * it neither posts revenue nor changes voucher/invoice journals.
 *
 * Run in the same transaction as the order total recalculation so failed
 * scans, duplicate scans, removals and reversals cannot leave stale amounts.
 */
export async function syncLoadingStartedDaybookTotal(
  tx: { execute: (query: SQL) => Promise<unknown> },
  orderId: number
): Promise<void> {
  await tx.execute(sql`
    UPDATE factory_daybook_entries entry
       SET amount_currency = COALESCE(orders.grand_total, 0),
           amount_usd = COALESCE(orders.grand_total, 0)
      FROM customer_orders orders
     WHERE orders.id = ${orderId}
       AND entry.company_id = orders.company_id
       AND entry.reference_table = 'customer_orders'
       AND entry.reference_id = orders.id
       AND entry.tx_type = 'LOADING_CREATED'
       AND entry.currency_code = 'USD'
       AND (entry.amount_currency IS DISTINCT FROM COALESCE(orders.grand_total, 0)
            OR entry.amount_usd IS DISTINCT FROM COALESCE(orders.grand_total, 0))
  `);
}
