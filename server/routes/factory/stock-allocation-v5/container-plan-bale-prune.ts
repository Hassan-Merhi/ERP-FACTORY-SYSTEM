import { selectOverAssignedBaleIds } from "@shared/containerBaleAssignment";
import { selectOverAllocatedIds } from "@shared/containerCustomerAllocation";
import type { PlannerQueryable } from "./container-planner-source";

/**
 * Releases Phase 4 bale assignments that a Phase 1-3 quantity edit has just
 * invalidated.
 *
 * Moving, rebalancing or reconciling a plan changes how many bales of a product
 * a container is allowed to hold. Assignments above the new quota - and any
 * assignment whose product left the container entirely - are released back into
 * unassigned stock, newest scan first, so the earliest-loaded bales keep their
 * place. Locked containers are never touched because their quantities cannot
 * change in the first place.
 */
export async function pruneOverAssignedPlanBales(
  client: PlannerQueryable,
  companyId: number,
  planId: number
): Promise<number> {
  const assignmentResult = await client.query<{
    id: number | string;
    plan_container_id: number | string;
    article_code: string;
  }>(
    `SELECT id, plan_container_id, article_code
     FROM factory_container_plan_bales
     WHERE company_id = $1 AND plan_id = $2
     FOR UPDATE`,
    [companyId, planId]
  );
  if (assignmentResult.rows.length === 0) return 0;

  const lineResult = await client.query<{
    plan_container_id: number | string;
    article_code: string;
    planned_qty: number | string;
  }>(
    `SELECT plan_container_id, article_code, planned_qty
     FROM factory_container_plan_lines
     WHERE company_id = $1 AND plan_id = $2`,
    [companyId, planId]
  );

  const plannedByContainer = new Map<number, Map<string, number>>();
  for (const row of lineResult.rows) {
    const containerId = Number(row.plan_container_id);
    const byArticle = plannedByContainer.get(containerId) ?? new Map<string, number>();
    byArticle.set(String(row.article_code), Number(row.planned_qty || 0));
    plannedByContainer.set(containerId, byArticle);
  }

  const assignmentsByContainer = new Map<number, Array<{ assignmentId: number; articleCode: string }>>();
  for (const row of assignmentResult.rows) {
    const containerId = Number(row.plan_container_id);
    const list = assignmentsByContainer.get(containerId) ?? [];
    list.push({ assignmentId: Number(row.id), articleCode: String(row.article_code) });
    assignmentsByContainer.set(containerId, list);
  }

  const releaseIds = selectOverAssignedBaleIds(
    Array.from(assignmentsByContainer.entries()).map(([containerId, assignments]) => ({
      containerId,
      plannedByArticle: plannedByContainer.get(containerId) ?? new Map<string, number>(),
      assignments,
    }))
  );
  if (releaseIds.length === 0) return 0;

  const deleted = await client.query<{ id: number }>(
    `DELETE FROM factory_container_plan_bales
     WHERE company_id = $1 AND plan_id = $2 AND id = ANY($3::int[])
     RETURNING id`,
    [companyId, planId, releaseIds]
  );
  return deleted.rows.length;
}

/**
 * Releases Phase 5 customer allocations that a quantity edit has invalidated.
 *
 * Allocations are trimmed rather than deleted outright where the container still
 * plans some of that product, so a customer keeps as much of their reservation
 * as the new plan can honour. Earliest reservations win.
 */
export async function pruneOverAllocatedPlanAllocations(
  client: PlannerQueryable,
  companyId: number,
  planId: number
): Promise<number> {
  const allocationResult = await client.query<{
    id: number | string;
    plan_container_id: number | string;
    article_code: string;
    allocated_qty: number | string;
  }>(
    `SELECT id, plan_container_id, article_code, allocated_qty
     FROM factory_container_plan_allocations
     WHERE company_id = $1 AND plan_id = $2
     FOR UPDATE`,
    [companyId, planId]
  );
  if (allocationResult.rows.length === 0) return 0;

  const lineResult = await client.query<{
    plan_container_id: number | string;
    article_code: string;
    planned_qty: number | string;
  }>(
    `SELECT plan_container_id, article_code, planned_qty
     FROM factory_container_plan_lines
     WHERE company_id = $1 AND plan_id = $2`,
    [companyId, planId]
  );

  const plannedByContainer = new Map<number, Map<string, number>>();
  for (const row of lineResult.rows) {
    const containerId = Number(row.plan_container_id);
    const byArticle = plannedByContainer.get(containerId) ?? new Map<string, number>();
    byArticle.set(String(row.article_code), Number(row.planned_qty || 0));
    plannedByContainer.set(containerId, byArticle);
  }

  const allocationsByContainer = new Map<number, Array<{ id: number; articleCode: string; allocatedQty: number }>>();
  for (const row of allocationResult.rows) {
    const containerId = Number(row.plan_container_id);
    const list = allocationsByContainer.get(containerId) ?? [];
    list.push({
      id: Number(row.id),
      articleCode: String(row.article_code),
      allocatedQty: Number(row.allocated_qty || 0),
    });
    allocationsByContainer.set(containerId, list);
  }

  const changes = selectOverAllocatedIds(
    Array.from(allocationsByContainer.entries()).map(([containerId, allocations]) => ({
      containerId,
      plannedByArticle: plannedByContainer.get(containerId) ?? new Map<string, number>(),
      allocations,
    }))
  );
  if (changes.length === 0) return 0;

  const removed = changes.filter((change) => change.keepQty <= 0).map((change) => change.id);
  const trimmed = changes.filter((change) => change.keepQty > 0);

  if (removed.length > 0) {
    await client.query(
      `DELETE FROM factory_container_plan_allocations
       WHERE company_id = $1 AND plan_id = $2 AND id = ANY($3::int[])`,
      [companyId, planId, removed]
    );
  }
  for (const change of trimmed) {
    await client.query(
      `UPDATE factory_container_plan_allocations
       SET allocated_qty = $1, updated_at = NOW()
       WHERE company_id = $2 AND plan_id = $3 AND id = $4`,
      [change.keepQty, companyId, planId, change.id]
    );
  }

  return changes.length;
}
