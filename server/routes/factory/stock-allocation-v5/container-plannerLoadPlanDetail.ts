// Extracted from ./container-planner.ts to keep that module under the source-size cap.
import type { Request } from "express";
import type { PlannerQueryable as Queryable } from "./container-planner-source";

type PlannerPlanRow = {
  id: number;
  company_id: number;
  name: string;
  status: string;
  capacity_bales: number;
  include_garbage_wipers: boolean;
  source_stock_total: number;
  source_committed_total: number;
  source_loading_total: number;
  source_plannable_total: number;
  revision: number;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type PlannerLineRow = {
  id: number | string;
  plan_container_id: number | string;
  article_code: string;
  product_name: string | null;
  planned_qty: number | string;
};

type PlannerDetailLine = {
  id: number;
  articleCode: string;
  productName: string;
  plannedQty: number;
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

export function cleanPlanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return name.slice(0, 120);
}

export function defaultPlanName(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 16);
  return `Container Plan ${date} ${time}`;
}

export async function writePlannerAudit(
  client: Queryable,
  req: Request,
  companyId: number,
  action: "create" | "update" | "delete",
  planId: number,
  identifier: string,
  changes: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (user_id, username, company_id, action, table_name, record_id, record_identifier, changes, created_at)
     VALUES ($1, $2, $3, $4, 'factory_container_plans', $5, $6, $7::jsonb, NOW())`,
    [
      req.session.userId || "system",
      req.session.username || "unknown",
      companyId,
      action,
      planId,
      identifier,
      JSON.stringify(changes),
    ]
  );
}

export async function loadPlanDetail(client: Queryable, companyId: number, planId: number) {
  const planResult = await client.query<PlannerPlanRow>(
    `SELECT id, company_id, name, status, capacity_bales, include_garbage_wipers,
            source_stock_total, source_committed_total, source_loading_total, source_plannable_total,
            revision, created_by, created_by_name, created_at, updated_at
     FROM factory_container_plans
     WHERE id = $1 AND company_id = $2`,
    [planId, companyId]
  );
  const plan = planResult.rows[0];
  if (!plan) return null;

  const containersResult = await client.query(
    `SELECT id, position, name, capacity_bales, is_locked, locked_at, locked_by, locked_by_name
     FROM factory_container_plan_containers
     WHERE plan_id = $1 AND company_id = $2
     ORDER BY position, id`,
    [planId, companyId]
  );

  const containerIds = containersResult.rows.map((row) => Number(row.id));
  const linesResult =
    containerIds.length === 0
      ? { rows: [] as PlannerLineRow[] }
      : await client.query<PlannerLineRow>(
          `SELECT id, plan_container_id, article_code, product_name, planned_qty
           FROM factory_container_plan_lines
           WHERE plan_id = $1
             AND company_id = $2
             AND plan_container_id = ANY($3::int[])
           ORDER BY product_name, article_code`,
          [planId, companyId, containerIds]
        );

  const linesByContainer = new Map<number, PlannerDetailLine[]>();
  for (const line of linesResult.rows) {
    const containerId = Number(line.plan_container_id);
    if (!linesByContainer.has(containerId)) linesByContainer.set(containerId, []);
    linesByContainer.get(containerId)!.push({
      id: Number(line.id),
      articleCode: String(line.article_code),
      productName: String(line.product_name || line.article_code),
      plannedQty: Number(line.planned_qty),
    });
  }

  const containers = containersResult.rows.map((container) => {
    const lines = linesByContainer.get(Number(container.id)) ?? [];
    return {
      id: Number(container.id),
      position: Number(container.position),
      name: String(container.name),
      capacityBales: Number(container.capacity_bales),
      isLocked: Boolean(container.is_locked),
      lockedAt: container.locked_at ?? null,
      lockedBy: container.locked_by ?? null,
      lockedByName: container.locked_by_name ?? null,
      totalBales: lines.reduce((sum, line) => sum + Number(line.plannedQty || 0), 0),
      lines,
    };
  });

  return {
    id: Number(plan.id),
    name: plan.name,
    status: plan.status,
    capacityBales: Number(plan.capacity_bales),
    includeGarbageWipers: Boolean(plan.include_garbage_wipers),
    sourceStockTotal: Number(plan.source_stock_total),
    sourceCommittedTotal: Number(plan.source_committed_total),
    sourceLoadingTotal: Number(plan.source_loading_total),
    sourcePlannableTotal: Number(plan.source_plannable_total),
    revision: Number(plan.revision),
    createdBy: plan.created_by,
    createdByName: plan.created_by_name,
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
    totalPlanned: containers.reduce((sum, container) => sum + container.totalBales, 0),
    lockedCount: containers.filter((container) => container.isLocked).length,
    containers,
  };
}

export async function insertPlanLines(
  client: Queryable,
  companyId: number,
  planId: number,
  containerId: number,
  lines: Array<{ articleCode: string; productName: string; plannedQty: number }>
): Promise<void> {
  const nonZero = lines.filter((line) => Number.isSafeInteger(line.plannedQty) && line.plannedQty > 0);
  if (nonZero.length === 0) return;

  const values: unknown[] = [];
  const tuples = nonZero.map((line, index) => {
    const offset = index * 6;
    values.push(companyId, planId, containerId, line.articleCode, line.productName, line.plannedQty);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`;
  });

  await client.query(
    `INSERT INTO factory_container_plan_lines
       (company_id, plan_id, plan_container_id, article_code, product_name, planned_qty)
     VALUES ${tuples.join(", ")}`,
    values
  );
}

export async function lockPlan(client: Queryable, planId: number, companyId: number): Promise<PlannerPlanRow | null> {
  const result = await client.query<PlannerPlanRow>(
    `SELECT id, company_id, name, status, capacity_bales, include_garbage_wipers,
            source_stock_total, source_committed_total, source_loading_total, source_plannable_total,
            revision, created_by, created_by_name, created_at, updated_at
     FROM factory_container_plans
     WHERE id = $1 AND company_id = $2
     FOR UPDATE`,
    [planId, companyId]
  );
  return result.rows[0] ?? null;
}
