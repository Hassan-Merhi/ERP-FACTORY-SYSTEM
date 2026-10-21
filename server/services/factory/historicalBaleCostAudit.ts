/**
 * Read-only historical factory bale unit-cost audit.
 *
 * A stored cost/kg equal to today's catalogue production price may indicate the
 * legacy price-per-bale-versus-per-kg bug, but is NOT proof of the price charged
 * at bale production/sale. Neither these queries nor this endpoint mutate
 * historical invoices, sold bales, sales profit, COGS or journals.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";

export const HISTORICAL_BALE_AUDIT_GROUPS = [
  "INVOICED_OR_FINALIZED",
  "VERIFIED_WITH_INVOICE_EVIDENCE",
  "OPEN_VERIFIED_UNINVOICED",
  "OTHER_SOLD",
  "DELETED_REVIEW_ONLY",
  "AVAILABLE_REVIEW_ONLY",
] as const;
export type HistoricalBaleAuditGroup = (typeof HISTORICAL_BALE_AUDIT_GROUPS)[number];

const candidateSet = (companyId: number) => sql`
  WITH candidate AS (
    SELECT b.id, b.company_id, b.reference_number, b.article_code, b.status,
           b.weight_kg, b.cost_per_kg, b.total_cost, b.created_at,
           b.stock_entry_date, p.production_price AS current_catalogue_price,
           p.updated_at AS product_updated_at,
           (b.total_cost - p.production_price) AS nominal_difference,
           o.id AS order_id, o.status AS order_status, o.invoice_number,
           o.finalized_at AS order_finalized_at, o.container_number,
           COALESCE(o.document_frozen, FALSE) AS document_frozen,
           COALESCE(o.sale_balance_exists, FALSE) AS sale_balance_exists
      FROM factory_bales b
      JOIN factory_bale_products p
        ON p.id = b.product_id AND p.company_id = b.company_id
      LEFT JOIN LATERAL (
        -- Of every order linked to the bale, keep the one carrying the
        -- strongest invoice evidence, so a later clean VERIFIED link cannot
        -- hide an older frozen document or SALE ledger entry.
        SELECT linked.*
          FROM (
            SELECT co.id, co.status, co.invoice_number, co.finalized_at,
                   co.container_number,
                   EXISTS (
                     SELECT 1 FROM factory_invoice_document_snapshots snap
                      WHERE snap.company_id = ${companyId} AND snap.order_id = co.id
                   ) AS document_frozen,
                   EXISTS (
                     SELECT 1 FROM customer_balances cb
                      WHERE cb.company_id = ${companyId}
                        AND cb.reference_type = 'INVOICE'
                        AND cb.reference_id = co.id
                        AND cb.transaction_type = 'SALE'
                   ) AS sale_balance_exists
              FROM customer_order_bales cob
              JOIN customer_orders co ON co.id = cob.order_id
             WHERE cob.bale_id = b.id
               AND co.company_id = ${companyId}
               AND co.deleted_at IS NULL
          ) linked
         ORDER BY
           CASE WHEN linked.status IN ('FINALIZED','DISPATCHED','SOLD','INVOICED','COMPLETED') THEN 0
                WHEN linked.invoice_number IS NOT NULL OR linked.finalized_at IS NOT NULL
                  OR linked.document_frozen OR linked.sale_balance_exists THEN 1
                WHEN linked.status = 'VERIFIED' THEN 2 ELSE 3 END,
           linked.id DESC
         LIMIT 1
      ) o ON TRUE
     WHERE b.company_id = ${companyId}
       -- Physical deletion stamps deleted_at alongside status = 'DELETED';
       -- those rows belong to the read-only deleted cohort.
       AND (b.deleted_at IS NULL OR b.status = 'DELETED')
       AND b.mix_batch_id IS NULL
       AND b.status IN ('SOLD','DELETED','AVAILABLE')
       AND p.deleted_at IS NULL
       AND p.production_price > 0
       AND b.weight_kg > 1
       AND ABS(b.cost_per_kg - p.production_price) < 0.001
       AND ABS(b.total_cost - b.weight_kg * b.cost_per_kg) < 0.01
       AND b.total_cost > p.production_price + 0.01
  ), classified AS (
    SELECT *,
      CASE
        WHEN status = 'DELETED' THEN 'DELETED_REVIEW_ONLY'
        WHEN status = 'AVAILABLE' THEN 'AVAILABLE_REVIEW_ONLY'
        WHEN order_status IN ('FINALIZED','DISPATCHED','SOLD','INVOICED','COMPLETED')
          THEN 'INVOICED_OR_FINALIZED'
        WHEN invoice_number IS NOT NULL OR order_finalized_at IS NOT NULL
          OR document_frozen OR sale_balance_exists
          THEN 'VERIFIED_WITH_INVOICE_EVIDENCE'
        WHEN order_status = 'VERIFIED' THEN 'OPEN_VERIFIED_UNINVOICED'
        ELSE 'OTHER_SOLD'
      END AS review_group
    FROM candidate
  )
`;

type SummaryRow = {
  review_group: HistoricalBaleAuditGroup;
  bale_count: number;
  order_count: number;
  nominal_difference: string;
  current_recorded_cost: string;
  current_catalogue_basis: string;
};

type DetailRow = {
  id: number;
  reference_number: string;
  article_code: string;
  status: string;
  weight_kg: string;
  cost_per_kg: string;
  total_cost: string;
  current_catalogue_price: string;
  nominal_difference: string;
  stock_entry_date: string | null;
  created_at: string;
  product_updated_at: string;
  order_id: number | null;
  order_status: string | null;
  invoice_number: string | null;
  order_finalized_at: string | null;
  container_number: string | null;
  document_frozen: boolean;
  sale_balance_exists: boolean;
  review_group: HistoricalBaleAuditGroup;
};

export async function historicalBaleCostAuditPreview(
  companyId: number,
  options: { group?: HistoricalBaleAuditGroup; orderId?: number; limit?: number; offset?: number } = {}
) {
  const limit = Math.min(250, Math.max(1, Math.trunc(options.limit ?? 100)));
  const offset = Math.min(100000, Math.max(0, Math.trunc(options.offset ?? 0)));
  const group = options.group ?? null;
  const orderId = options.orderId ?? null;

  const [summaryRows, detailRows, ordersRows] = await Promise.all([
    db.execute(sql`
      ${candidateSet(companyId)}
      SELECT review_group,
             COUNT(*)::int AS bale_count,
             COUNT(DISTINCT order_id)::int AS order_count,
             SUM(nominal_difference)::text AS nominal_difference,
             SUM(total_cost)::text AS current_recorded_cost,
             SUM(current_catalogue_price)::text AS current_catalogue_basis
        FROM classified GROUP BY review_group ORDER BY review_group
    `),
    db.execute(sql`
      ${candidateSet(companyId)}
      SELECT id, reference_number, article_code, status,
             weight_kg::text AS weight_kg,
             cost_per_kg::text AS cost_per_kg,
             total_cost::text AS total_cost,
             current_catalogue_price::text AS current_catalogue_price,
             nominal_difference::text AS nominal_difference,
             stock_entry_date, created_at, product_updated_at, order_id,
             order_status, invoice_number, order_finalized_at,
             container_number, document_frozen, sale_balance_exists, review_group
        FROM classified
       WHERE (${group}::text IS NULL OR review_group = ${group}::text)
         AND (${orderId}::int IS NULL OR order_id = ${orderId}::int)
       ORDER BY order_id NULLS LAST, id
       LIMIT ${limit} OFFSET ${offset}
    `),
    db.execute(sql`
      ${candidateSet(companyId)}
      SELECT order_id, order_status, invoice_number, container_number,
             review_group, COUNT(*)::int AS bale_count,
             SUM(nominal_difference)::text AS nominal_difference
        FROM classified
       WHERE order_id IS NOT NULL
       GROUP BY order_id, order_status, invoice_number, container_number, review_group
       ORDER BY SUM(nominal_difference) DESC
       LIMIT 300
    `),
  ]);

  return {
    companyId,
    readOnly: true,
    valuationBasis: "current-catalogue-only-NOT-historical-price-at-sale",
    warning: "Nominal differences are screening estimates, not approved historical cost or journal adjustments.",
    summary: summaryRows.rows as unknown as SummaryRow[],
    orders: ordersRows.rows as unknown as Array<{
      order_id: number;
      order_status: string;
      invoice_number: string | null;
      container_number: string | null;
      review_group: HistoricalBaleAuditGroup;
      bale_count: number;
      nominal_difference: string;
    }>,
    details: detailRows.rows as unknown as DetailRow[],
    limit,
    offset,
    group,
    orderId,
  };
}
