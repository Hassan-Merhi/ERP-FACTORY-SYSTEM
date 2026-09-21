import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import {
  buildContainerPlanReconciliation,
  distributeContainerPlannerProducts,
  type ContainerPlannerReconciliation,
  type SavedPlannerContainer,
  type SavedPlannerLine,
} from "@shared/containerPlanner";
import { loadContainerPlannerSource, type PlannerQueryable } from "./container-planner-source";

type PlannerHeaderRow = {
  id: number;
  name: string;
  status: string;
  capacity_bales: number;
  include_garbage_wipers: boolean;
  revision: number;
};

type PlannerContainerRow = {
  id: number | string;
  position: number | string;
  name: string;
  capacity_bales: number | string;
  is_locked: boolean;
};

type PlannerLineRow = {
  plan_container_id: number | string;
  article_code: string;
  product_name: string | null;
  planned_qty: number | string;
};

function companyIdFor(req: Request): number | null {
  const value = req.session.factoryCompanyId || req.session.currentCompanyId;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function loadPlanHeader(
  client: PlannerQueryable,
  companyId: number,
  planId: number,
  forUpdate: boolean
): Promise<PlannerHeaderRow | null> {
  const result = await client.query<PlannerHeaderRow>(
    `SELECT id, name, status, capacity_bales, include_garbage_wipers, revision
     FROM factory_container_plans
     WHERE id = $1 AND company_id = $2
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [planId, companyId]
  );
  return result.rows[0] ?? null;
}

async function loadSavedContainers(
  client: PlannerQueryable,
  companyId: number,
  planId: number,
  forUpdate: boolean
): Promise<Array<SavedPlannerContainer & { name: string; capacityBales: number }>> {
  const containerResult = await client.query<PlannerContainerRow>(
    `SELECT id, position, name, capacity_bales, is_locked
     FROM factory_container_plan_containers
     WHERE company_id = $1 AND plan_id = $2
     ORDER BY position, id
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [companyId, planId]
  );

  const containerIds = containerResult.rows.map((row) => Number(row.id));
  const lineResult =
    containerIds.length === 0
      ? { rows: [] as PlannerLineRow[] }
      : await client.query<PlannerLineRow>(
          `SELECT plan_container_id, article_code, product_name, planned_qty
           FROM factory_container_plan_lines
           WHERE company_id = $1
             AND plan_id = $2
             AND plan_container_id = ANY($3::int[])
           ${forUpdate ? "FOR UPDATE" : ""}`,
          [companyId, planId, containerIds]
        );

  const linesByContainer = new Map<number, SavedPlannerLine[]>();
  for (const row of lineResult.rows) {
    const containerId = Number(row.plan_container_id);
    const lines = linesByContainer.get(containerId) ?? [];
    lines.push({
      articleCode: String(row.article_code),
      productName: String(row.product_name || row.article_code),
      plannedQty: Number(row.planned_qty || 0),
    });
    linesByContainer.set(containerId, lines);
  }

  return containerResult.rows.map((row) => ({
    id: Number(row.id),
    position: Number(row.position),
    name: String(row.name),
    capacityBales: Number(row.capacity_bales),
    isLocked: Boolean(row.is_locked),
    lines: linesByContainer.get(Number(row.id)) ?? [],
  }));
}

async function buildLiveReconciliation(
  client: PlannerQueryable,
  companyId: number,
  header: PlannerHeaderRow,
  containers: SavedPlannerContainer[]
): Promise<ContainerPlannerReconciliation> {
  const sourceRows = await loadContainerPlannerSource(client, companyId);
  return buildContainerPlanReconciliation(sourceRows, containers, {
    includeGarbageWipers: Boolean(header.include_garbage_wipers),
  });
}

async function writePlannerAudit(
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
     VALUES ($1, $2, $3, 'update', 'factory_container_plans', $4, $5, $6::jsonb, NOW())`,
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

async function insertPlanLines(
  client: PlannerQueryable,
  companyId: number,
  planId: number,
  containerId: number,
  lines: SavedPlannerLine[]
): Promise<void> {
  const positive = lines.filter((line) => Number.isSafeInteger(line.plannedQty) && line.plannedQty > 0);
  if (positive.length === 0) return;

  const values: unknown[] = [];
  const tuples = positive.map((line, index) => {
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

function desiredUnlockedProducts(reconciliation: ContainerPlannerReconciliation) {
  return reconciliation.products
    .map((product) => ({
      articleCode: product.articleCode,
      productName: product.productName,
      qty: Math.max(product.currentPlannableQty - product.lockedQty, 0),
    }))
    .filter((product) => product.qty > 0)
    .sort((a, b) => a.productName.localeCompare(b.productName) || a.articleCode.localeCompare(b.articleCode));
}

export function registerV5ContainerPlannerReconciliationRoutes(app: Express): void {
  app.get(
    "/api/factory/v5/container-plans/:planId/reconciliation",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId) return res.status(400).json({ message: "Invalid plan id" });

        const header = await loadPlanHeader(pool as unknown as PlannerQueryable, companyId, planId, false);
        if (!header) return res.status(404).json({ message: "Container plan not found" });

        const containers = await loadSavedContainers(pool as unknown as PlannerQueryable, companyId, planId, false);
        const reconciliation = await buildLiveReconciliation(
          pool as unknown as PlannerQueryable,
          companyId,
          header,
          containers
        );

        return res.json({
          planId,
          revision: Number(header.revision),
          checkedAt: new Date().toISOString(),
          reconciliation,
        });
      } catch (error: unknown) {
        logger.error("[V5] container planner reconciliation read error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post("/api/factory/v5/container-plans/:planId/reconcile", requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const companyId = companyIdFor(req);
      const planId = positiveInt(req.params.planId);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!planId) return res.status(400).json({ message: "Invalid plan id" });

      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [731204, companyId]);

      const header = await loadPlanHeader(client, companyId, planId, true);
      if (!header) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Container plan not found" });
      }
      if (header.status !== "DRAFT") {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "Only draft container plans can be reconciled." });
      }

      const beforeContainers = await loadSavedContainers(client, companyId, planId, true);
      const sourceRows = await loadContainerPlannerSource(client, companyId);
      const before = buildContainerPlanReconciliation(sourceRows, beforeContainers, {
        includeGarbageWipers: Boolean(header.include_garbage_wipers),
      });

      if (before.lockedConflictTotal > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          code: "CONTAINER_PLAN_LOCKED_STOCK_CONFLICT",
          message:
            "Locked container quantities exceed current available stock. Unlock the affected containers before reconciling.",
          reconciliation: before,
        });
      }

      const capacity = Number(header.capacity_bales);
      const desiredProducts = desiredUnlockedProducts(before);
      const totalDesiredUnlocked = desiredProducts.reduce((sum, product) => sum + product.qty, 0);
      const requiredUnlockedCount =
        totalDesiredUnlocked > 0 ? Math.ceil(totalDesiredUnlocked / Math.max(capacity, 1)) : 0;

      const lockedContainers = beforeContainers.filter((container) => container.isLocked);
      const existingUnlocked = beforeContainers
        .filter((container) => !container.isLocked)
        .sort((a, b) => a.position - b.position || a.id - b.id);

      const keptUnlocked = existingUnlocked.slice(0, requiredUnlockedCount);
      const removedUnlocked = existingUnlocked.slice(requiredUnlockedCount);
      let nextPosition =
        beforeContainers.length > 0 ? Math.max(...beforeContainers.map((container) => container.position)) + 1 : 0;
      const addedContainerIds: number[] = [];

      while (keptUnlocked.length < requiredUnlockedCount) {
        const position = nextPosition;
        nextPosition += 1;
        const inserted = await client.query<{ id: number }>(
          `INSERT INTO factory_container_plan_containers
               (company_id, plan_id, position, name, capacity_bales, is_locked, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, false, NOW(), NOW())
             RETURNING id`,
          [companyId, planId, position, `Container ${position + 1}`, capacity]
        );
        const id = Number(inserted.rows[0].id);
        addedContainerIds.push(id);
        keptUnlocked.push({
          id,
          position,
          name: `Container ${position + 1}`,
          capacityBales: capacity,
          isLocked: false,
          lines: [],
        });
      }

      if (removedUnlocked.length > 0) {
        await client.query(
          `DELETE FROM factory_container_plan_containers
             WHERE company_id = $1 AND plan_id = $2 AND id = ANY($3::int[]) AND is_locked = false`,
          [companyId, planId, removedUnlocked.map((container) => container.id)]
        );
      }

      const keptUnlockedIds = keptUnlocked.map((container) => container.id);
      if (keptUnlockedIds.length > 0) {
        await client.query(
          `DELETE FROM factory_container_plan_lines
             WHERE company_id = $1 AND plan_id = $2 AND plan_container_id = ANY($3::int[])`,
          [companyId, planId, keptUnlockedIds]
        );

        const distributed = distributeContainerPlannerProducts(desiredProducts, keptUnlocked.length);
        if (distributed.totals.some((total) => total > capacity)) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            message: "The current stock cannot fit inside the available unlocked container capacity.",
          });
        }

        for (let index = 0; index < keptUnlocked.length; index += 1) {
          const container = keptUnlocked[index];
          const lines = distributed.products
            .map((product) => ({
              articleCode: product.articleCode,
              productName: product.productName,
              plannedQty: product.allocations[index] ?? 0,
            }))
            .filter((line) => line.plannedQty > 0);
          await insertPlanLines(client, companyId, planId, container.id, lines);
        }
      }

      await client.query(
        `UPDATE factory_container_plans
           SET source_stock_total = $1,
               source_committed_total = $2,
               source_loading_total = $3,
               source_plannable_total = $4,
               revision = revision + 1,
               updated_at = NOW()
           WHERE id = $5 AND company_id = $6`,
        [
          before.currentStockTotal,
          before.currentCommittedTotal,
          before.currentLoadingTotal,
          before.currentPlannableTotal,
          planId,
          companyId,
        ]
      );

      const afterContainers = await loadSavedContainers(client, companyId, planId, false);
      const after = buildContainerPlanReconciliation(sourceRows, afterContainers, {
        includeGarbageWipers: Boolean(header.include_garbage_wipers),
      });

      await writePlannerAudit(client, req, companyId, planId, header.name, {
        reconciliation: {
          beforeStatus: before.status,
          afterStatus: after.status,
          beforeUnplanned: before.unplannedTotal,
          beforeOverplanned: before.overplannedTotal,
          lockedContainersPreserved: lockedContainers.length,
          addedContainers: addedContainerIds.length,
          removedContainers: removedUnlocked.length,
          currentPlannableTotal: before.currentPlannableTotal,
        },
      });

      const revisionResult = await client.query<{ revision: number }>(
        `SELECT revision FROM factory_container_plans WHERE id = $1 AND company_id = $2`,
        [planId, companyId]
      );

      await client.query("COMMIT");
      return res.json({
        success: true,
        planId,
        revision: Number(revisionResult.rows[0]?.revision ?? Number(header.revision) + 1),
        addedContainers: addedContainerIds.length,
        removedContainers: removedUnlocked.length,
        checkedAt: new Date().toISOString(),
        reconciliation: after,
      });
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.error("[V5] container planner reconciliation write error", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    } finally {
      client.release();
    }
  });
}
