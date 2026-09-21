import type { PoolClient } from "pg";
import type { ContainerPlannerSourceRow } from "@shared/containerPlanner";

export type PlannerQueryable = Pick<PoolClient, "query">;

/**
 * Loads the authoritative V5 planning stock picture for one company.
 *
 * This is shared by saved-plan creation and Phase 3 reconciliation so both
 * operations protect the exact same customer/loading commitments, including
 * the legacy proforma fallback for orders that predate expected-line snapshots.
 */
export async function loadContainerPlannerSource(
  client: PlannerQueryable,
  companyId: number
): Promise<ContainerPlannerSourceRow[]> {
  const result = await client.query(
    `WITH
       in_stock AS (
         SELECT article_code, COUNT(*)::int AS qty
         FROM factory_bales
         WHERE company_id = $1 AND status = 'IN_STOCK'
         GROUP BY article_code
       ),
       loading AS (
         SELECT fb.article_code, COUNT(*)::int AS qty
         FROM customer_order_bales cob
         JOIN factory_bales fb ON fb.id = cob.bale_id
         JOIN customer_orders co ON co.id = cob.order_id
         WHERE co.company_id = $1
           AND co.status = 'LOADING'
           AND co.proforma_id_used IS NOT NULL
         GROUP BY fb.article_code
       ),
       loaded_by_order AS (
         SELECT cob.order_id, fb.article_code, COUNT(*)::int AS qty
         FROM customer_order_bales cob
         JOIN factory_bales fb ON fb.id = cob.bale_id
         JOIN customer_orders co ON co.id = cob.order_id
         WHERE co.company_id = $1
           AND co.proforma_id_used IS NOT NULL
         GROUP BY cob.order_id, fb.article_code
       ),
       proforma_expected AS (
         SELECT cpl.proforma_id,
                cpl.article_code,
                COALESCE(SUM(cpl.quantity), 0)::int AS quantity
         FROM customer_proforma_lines cpl
         JOIN customer_proformas cp ON cp.id = cpl.proforma_id
         WHERE cp.company_id = $1
         GROUP BY cpl.proforma_id, cpl.article_code
       ),
       expected_source AS (
         SELECT co.id AS order_id,
                pe.article_code,
                COALESCE(cel.expected_qty, pe.quantity, 0)::int AS expected_qty
         FROM customer_orders co
         JOIN proforma_expected pe
           ON pe.proforma_id = co.proforma_id_used
         LEFT JOIN customer_order_expected_lines cel
           ON cel.order_id = co.id
          AND cel.article_code = pe.article_code
          AND cel.company_id = co.company_id
         WHERE co.company_id = $1
           AND co.status IN ('DRAFT', 'LOADING')
           AND co.proforma_id_used IS NOT NULL
       ),
       expected AS (
         SELECT es.article_code,
                COALESCE(SUM(GREATEST(es.expected_qty - COALESCE(lbo.qty, 0), 0)), 0)::int AS qty
         FROM expected_source es
         LEFT JOIN loaded_by_order lbo
           ON lbo.order_id = es.order_id AND lbo.article_code = es.article_code
         GROUP BY es.article_code
       ),
       codes AS (
         SELECT article_code FROM in_stock
         UNION
         SELECT article_code FROM loading
         UNION
         SELECT article_code FROM expected
       ),
       products AS (
         SELECT DISTINCT ON (COALESCE(fbp.article_code, fbp.code))
                COALESCE(fbp.article_code, fbp.code) AS article_code,
                fbp.name,
                COALESCE(fc.name, '') AS category_name
         FROM factory_bale_products fbp
         LEFT JOIN factory_categories fc ON fc.id = fbp.category_id
         WHERE fbp.company_id = $1
         ORDER BY COALESCE(fbp.article_code, fbp.code), fbp.id DESC
       )
       SELECT c.article_code AS "articleCode",
              COALESCE(
                p.name,
                (SELECT fb2.product_name
                 FROM factory_bales fb2
                 WHERE fb2.company_id = $1
                   AND fb2.article_code = c.article_code
                   AND fb2.product_name IS NOT NULL
                   AND fb2.product_name <> ''
                 ORDER BY fb2.created_at DESC
                 LIMIT 1),
                c.article_code
              ) AS "productName",
              COALESCE(s.qty, 0)::int AS "stockAvailable",
              COALESCE(e.qty, 0)::int AS "expectedToLoad",
              COALESCE(l.qty, 0)::int AS "totalLoaded",
              (COALESCE(s.qty, 0) - COALESCE(e.qty, 0) - COALESCE(l.qty, 0))::int AS "freeToPromise",
              (
                LOWER(COALESCE(p.category_name, '')) LIKE '%wiper%'
                OR LOWER(COALESCE(p.category_name, '')) LIKE '%garbage%'
                OR LOWER(COALESCE(p.category_name, '')) LIKE '%rag%'
                OR LOWER(COALESCE(p.name, '')) LIKE '%wiper%'
                OR LOWER(COALESCE(p.name, '')) LIKE '%garbage%'
              ) AS "isGarbageOrWipers"
       FROM codes c
       LEFT JOIN in_stock s ON s.article_code = c.article_code
       LEFT JOIN loading l ON l.article_code = c.article_code
       LEFT JOIN expected e ON e.article_code = c.article_code
       LEFT JOIN products p ON p.article_code = c.article_code
       ORDER BY c.article_code`,
    [companyId]
  );

  return result.rows.map((row) => ({
    articleCode: String(row.articleCode),
    productName: String(row.productName || row.articleCode),
    stockAvailable: Number(row.stockAvailable || 0),
    expectedToLoad: Number(row.expectedToLoad || 0),
    totalLoaded: Number(row.totalLoaded || 0),
    freeToPromise: Number(row.freeToPromise || 0),
    isGarbageOrWipers: Boolean(row.isGarbageOrWipers),
  }));
}
