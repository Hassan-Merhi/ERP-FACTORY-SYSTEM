import { selectOverAssignedBaleIds } from "@shared/containerBaleAssignment";
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
