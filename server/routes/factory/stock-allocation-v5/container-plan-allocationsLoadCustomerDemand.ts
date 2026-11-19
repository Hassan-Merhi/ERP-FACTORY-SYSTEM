// Extracted from ./container-plan-allocations.ts to keep that module under the source-size cap.
import type { Request } from "express";
import {
  buildPlanAllocationSummary,
  type CustomerDemandRow,
  type ExistingAllocation,
} from "@shared/containerCustomerAllocation";
import type { PlannerQueryable } from "./container-planner-source";

export function companyIdFor(req: Request): number | null {
  const value = req.session.factoryCompanyId || req.session.currentCompanyId;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function loadPlanHeader(client: PlannerQueryable, companyId: number, planId: number, forUpdate: boolean) {
  const result = await client.query<{ id: number; name: string; status: string }>(
    `SELECT id, name, status
     FROM factory_container_plans
     WHERE id = $1 AND company_id = $2
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [planId, companyId]
  );
  return result.rows[0] ?? null;
}

export async function writeAllocationAudit(
  client: PlannerQueryable,
  req: Request,
  companyId: number,
  planId: number,
  planName: string,
  changes: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (user_id, username, company_id, action, table_name, record_id, record_identifier, changes, created_at)
     VALUES ($1, $2, $3, 'update', 'factory_container_plan_allocations', $4, $5, $6::jsonb, NOW())`,
    [
      req.session.userId || "system",
      req.session.username || "unknown",
      companyId,
      planId,
      planName,
      JSON.stringify(changes),
    ]
  );
}

type ContainerLineRow = {
  container_id: number | string;
  container_name: string;
  position: number | string;
  article_code: string;
  product_name: string | null;
  planned_qty: number | string;
};

export async function loadContainersWithLines(client: PlannerQueryable, companyId: number, planId: number) {
  const result = await client.query<ContainerLineRow>(
    `SELECT c.id AS container_id, c.name AS container_name, c.position,
            l.article_code, l.product_name, l.planned_qty
     FROM factory_container_plan_containers c
     LEFT JOIN factory_container_plan_lines l
       ON l.plan_container_id = c.id AND l.company_id = c.company_id
     WHERE c.company_id = $1 AND c.plan_id = $2
     ORDER BY c.position, c.id`,
    [companyId, planId]
  );

  const byContainer = new Map<
    number,
    {
      containerId: number;
      containerName: string;
      position: number;
      lines: Array<{ articleCode: string; productName: string; plannedQty: number }>;
    }
  >();

  for (const row of result.rows) {
    const containerId = Number(row.container_id);
    const entry = byContainer.get(containerId) ?? {
      containerId,
      containerName: String(row.container_name),
      position: Number(row.position),
      lines: [],
    };
    if (row.article_code) {
      entry.lines.push({
        articleCode: String(row.article_code),
        productName: String(row.product_name || row.article_code),
        plannedQty: Number(row.planned_qty || 0),
      });
    }
    byContainer.set(containerId, entry);
  }

  return Array.from(byContainer.values()).sort((a, b) => a.position - b.position || a.containerId - b.containerId);
}

export async function loadAllocations(
  client: PlannerQueryable,
  companyId: number,
  planId: number,
  forUpdate = false
): Promise<ExistingAllocation[]> {
  const result = await client.query(
    `SELECT a.id, a.plan_container_id, a.customer_id, a.order_id, a.article_code,
            a.product_name, a.allocated_qty,
            COALESCE(cu.legal_name, cu.code, 'Customer ' || a.customer_id::text) AS customer_name
     FROM factory_container_plan_allocations a
     LEFT JOIN customers cu ON cu.id = a.customer_id
     WHERE a.company_id = $1 AND a.plan_id = $2
     ORDER BY a.plan_container_id, a.customer_id, a.article_code
     ${forUpdate ? "FOR UPDATE OF a" : ""}`,
    [companyId, planId]
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    containerId: Number(row.plan_container_id),
    customerId: Number(row.customer_id),
    customerName: String(row.customer_name),
    orderId: row.order_id == null ? null : Number(row.order_id),
    articleCode: String(row.article_code),
    productName: String(row.product_name || row.article_code),
    allocatedQty: Number(row.allocated_qty || 0),
  }));
}

/**
 * Outstanding customer demand, reusing the same commitment definition Phase 2
 * uses to reserve stock: proforma-expected quantities minus what each order has
 * already physically loaded.
 */
export async function loadCustomerDemand(client: PlannerQueryable, companyId: number): Promise<CustomerDemandRow[]> {
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
    }))
    .filter((row) => row.demandQty > 0);
}

export async function buildSummary(client: PlannerQueryable, companyId: number, planId: number) {
  const [containers, allocations, demand] = await Promise.all([
    loadContainersWithLines(client, companyId, planId),
    loadAllocations(client, companyId, planId),
    loadCustomerDemand(client, companyId),
  ]);
  return buildPlanAllocationSummary({ containers, allocations, demand });
}
