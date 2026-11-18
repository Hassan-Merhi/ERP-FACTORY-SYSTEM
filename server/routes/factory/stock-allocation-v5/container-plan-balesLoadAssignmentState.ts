// Extracted from ./container-plan-bales.ts to keep that module under the source-size cap.
import type { Request } from "express";
import type { AssignableBale, ContainerAssignmentTarget } from "@shared/containerBaleAssignment";
import type { PlannerQueryable } from "./container-planner-source";

type ContainerRow = {
  id: number | string;
  position: number | string;
  name: string;
  capacity_bales: number | string;
  is_locked: boolean;
};

type LineRow = {
  plan_container_id: number | string;
  article_code: string;
  product_name: string | null;
  planned_qty: number | string;
};

type AssignmentRow = {
  id: number | string;
  plan_container_id: number | string;
  bale_id: number | string;
  article_code: string;
  bale_code: string;
  reference_number: string;
  product_name: string;
  weight_kg: string | number;
  assigned_via: string;
  assigned_by_name: string | null;
  created_at: Date | string;
};

export function companyIdFor(req: Request): number | null {
  const value = req.session.factoryCompanyId || req.session.currentCompanyId;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function writeAssignmentAudit(
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
     VALUES ($1, $2, $3, 'update', 'factory_container_plan_bales', $4, $5, $6::jsonb, NOW())`,
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

export async function loadPlanHeader(client: PlannerQueryable, companyId: number, planId: number, forUpdate: boolean) {
  const result = await client.query<{ id: number; name: string; status: string; capacity_bales: number }>(
    `SELECT id, name, status, capacity_bales
     FROM factory_container_plans
     WHERE id = $1 AND company_id = $2
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [planId, companyId]
  );
  return result.rows[0] ?? null;
}

/**
 * Loads containers, planned lines and current bale assignments in one pass so
 * the loading screen and every write path share the same progress model.
 */
export async function loadAssignmentState(client: PlannerQueryable, companyId: number, planId: number) {
  const containerResult = await client.query<ContainerRow>(
    `SELECT id, position, name, capacity_bales, is_locked
     FROM factory_container_plan_containers
     WHERE company_id = $1 AND plan_id = $2
     ORDER BY position, id`,
    [companyId, planId]
  );
  const containerIds = containerResult.rows.map((row) => Number(row.id));

  const lineResult =
    containerIds.length === 0
      ? { rows: [] as LineRow[] }
      : await client.query<LineRow>(
          `SELECT plan_container_id, article_code, product_name, planned_qty
           FROM factory_container_plan_lines
           WHERE company_id = $1 AND plan_id = $2 AND plan_container_id = ANY($3::int[])`,
          [companyId, planId, containerIds]
        );

  const assignmentResult =
    containerIds.length === 0
      ? { rows: [] as AssignmentRow[] }
      : await client.query<AssignmentRow>(
          `SELECT id, plan_container_id, bale_id, article_code, bale_code, reference_number,
                  product_name, weight_kg, assigned_via, assigned_by_name, created_at
           FROM factory_container_plan_bales
           WHERE company_id = $1 AND plan_id = $2 AND plan_container_id = ANY($3::int[])
           ORDER BY bale_code, id`,
          [companyId, planId, containerIds]
        );

  const linesByContainer = new Map<number, Array<{ articleCode: string; productName: string; plannedQty: number }>>();
  for (const row of lineResult.rows) {
    const key = Number(row.plan_container_id);
    const list = linesByContainer.get(key) ?? [];
    list.push({
      articleCode: String(row.article_code),
      productName: String(row.product_name || row.article_code),
      plannedQty: Number(row.planned_qty || 0),
    });
    linesByContainer.set(key, list);
  }

  const assignmentsByContainer = new Map<number, AssignmentRow[]>();
  for (const row of assignmentResult.rows) {
    const key = Number(row.plan_container_id);
    const list = assignmentsByContainer.get(key) ?? [];
    list.push(row);
    assignmentsByContainer.set(key, list);
  }

  const containers = containerResult.rows.map((row) => ({
    containerId: Number(row.id),
    containerName: String(row.name),
    position: Number(row.position),
    capacityBales: Number(row.capacity_bales),
    isLocked: Boolean(row.is_locked),
    lines: linesByContainer.get(Number(row.id)) ?? [],
    assignments: (assignmentsByContainer.get(Number(row.id)) ?? []).map((assignment) => ({
      assignmentId: Number(assignment.id),
      baleId: Number(assignment.bale_id),
      articleCode: String(assignment.article_code),
      baleCode: String(assignment.bale_code),
      referenceNumber: String(assignment.reference_number),
      productName: String(assignment.product_name),
      weightKg: Number(assignment.weight_kg || 0),
      assignedVia: String(assignment.assigned_via),
      assignedByName: assignment.assigned_by_name,
      assignedAt: assignment.created_at,
    })),
  }));

  return containers;
}

export function buildTarget(
  container: Awaited<ReturnType<typeof loadAssignmentState>>[number]
): ContainerAssignmentTarget {
  const plannedByArticle = new Map<string, number>();
  for (const line of container.lines) {
    plannedByArticle.set(line.articleCode, (plannedByArticle.get(line.articleCode) ?? 0) + Number(line.plannedQty));
  }
  const assignedByArticle = new Map<string, number>();
  for (const assignment of container.assignments) {
    assignedByArticle.set(assignment.articleCode, (assignedByArticle.get(assignment.articleCode) ?? 0) + 1);
  }
  return {
    containerId: container.containerId,
    containerName: container.containerName,
    capacityBales: container.capacityBales,
    isLocked: container.isLocked,
    plannedByArticle,
    assignedByArticle,
  };
}

export type BaleLookupRow = {
  id: number | string;
  bale_code: string;
  reference_number: string;
  article_code: string | null;
  product_name: string | null;
  weight_kg: string | number;
  status: string;
  assigned_container_id: number | string | null;
  assigned_container_name: string | null;
};

export function toAssignableBale(row: BaleLookupRow): AssignableBale {
  return {
    id: Number(row.id),
    baleCode: String(row.bale_code),
    referenceNumber: String(row.reference_number),
    articleCode: String(row.article_code || ""),
    productName: String(row.product_name || row.article_code || ""),
    weightKg: Number(row.weight_kg || 0),
    status: String(row.status),
    assignedContainerId: row.assigned_container_id == null ? null : Number(row.assigned_container_id),
    assignedContainerName: row.assigned_container_name,
  };
}

export async function lookupBales(
  client: PlannerQueryable,
  companyId: number,
  baleIds: number[],
  baleCodes: string[]
): Promise<BaleLookupRow[]> {
  if (baleIds.length === 0 && baleCodes.length === 0) return [];
  const result = await client.query<BaleLookupRow>(
    `SELECT fb.id, fb.bale_code, fb.reference_number, fb.article_code, fb.product_name,
            fb.weight_kg, fb.status,
            cpb.plan_container_id AS assigned_container_id,
            cpc.name AS assigned_container_name
     FROM factory_bales fb
     LEFT JOIN factory_container_plan_bales cpb
       ON cpb.bale_id = fb.id AND cpb.company_id = fb.company_id
     LEFT JOIN factory_container_plan_containers cpc
       ON cpc.id = cpb.plan_container_id
     WHERE fb.company_id = $1
       AND fb.deleted_at IS NULL
       AND (
         fb.id = ANY($2::int[])
         OR UPPER(fb.bale_code) = ANY($3::text[])
         OR UPPER(fb.reference_number) = ANY($3::text[])
       )`,
    [companyId, baleIds, baleCodes]
  );
  return result.rows;
}
