// Extracted from ./container-plan-optimizer.ts
import { type OptimizerDemandRow } from "@shared/containerOptimizer";
import { type PlannerQueryable } from "./container-planner-source";

/**
 * Open customer demand, using the same commitment definition as Phase 2 and 5:
 * proforma-expected quantities minus what the order has already loaded.
 *
 * Note that free-to-promise already excludes these commitments, so the
 * optimizer is told about demand and the stock that would serve it separately;
 * the caller decides which pool to plan from.
 */
export async function loadOptimizerDemand(
  client: PlannerQueryable,
  companyId: number,
  priorities: Map<number, number>
): Promise<OptimizerDemandRow[]> {
  const result = await client.query(
    `WITH loaded_by_order AS (
       SELECT cob.order_id, fb.article_code, COUNT(*)::int AS qty
       FROM customer_order_bales cob
       JOIN factory_bales fb ON fb.id = cob.bale_id
       JOIN customer_orders co ON co.id = cob.order_id
       WHERE co.company_id = $1 AND co.proforma_id_used IS NOT NULL
       GROUP BY cob.order_id, fb.article_code
     ),
     proforma_expected AS (
       SELECT cpl.proforma_id, cpl.article_code,
              MAX(cpl.product_name) AS product_name,
              COALESCE(SUM(cpl.quantity), 0)::int AS quantity
       FROM customer_proforma_lines cpl
       JOIN customer_proformas cp ON cp.id = cpl.proforma_id
       WHERE cp.company_id = $1
       GROUP BY cpl.proforma_id, cpl.article_code
     )
     SELECT co.customer_id AS "customerId",
            COALESCE(cu.legal_name, cu.code, 'Customer ' || co.customer_id::text) AS "customerName",
            co.id AS "orderId",
            pe.article_code AS "articleCode",
            COALESCE(pe.product_name, pe.article_code) AS "productName",
            GREATEST(COALESCE(cel.expected_qty, pe.quantity, 0) - COALESCE(lbo.qty, 0), 0)::int AS "demandQty"
     FROM customer_orders co
     JOIN proforma_expected pe ON pe.proforma_id = co.proforma_id_used
     LEFT JOIN customer_order_expected_lines cel
       ON cel.order_id = co.id AND cel.article_code = pe.article_code AND cel.company_id = co.company_id
     LEFT JOIN loaded_by_order lbo ON lbo.order_id = co.id AND lbo.article_code = pe.article_code
     LEFT JOIN customers cu ON cu.id = co.customer_id
     WHERE co.company_id = $1
       AND co.status IN ('DRAFT', 'LOADING')
       AND co.proforma_id_used IS NOT NULL`,
    [companyId]
  );

  return result.rows
    .map((row) => ({
      customerId: Number(row.customerId),
      customerName: String(row.customerName),
      orderId: row.orderId == null ? null : Number(row.orderId),
      articleCode: String(row.articleCode),
      productName: String(row.productName || row.articleCode),
      demandQty: Number(row.demandQty || 0),
      priority: priorities.get(Number(row.customerId)) ?? 0,
    }))
    .filter((row) => row.demandQty > 0);
}
