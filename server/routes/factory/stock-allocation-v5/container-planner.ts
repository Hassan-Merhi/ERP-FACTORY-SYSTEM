import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import {
  buildContainerPlannerPreview,
  MAX_CONTAINER_CAPACITY,
  rebalanceUnlockedContainerPlan,
  type SavedPlannerContainer,
} from "@shared/containerPlanner";
import { loadContainerPlannerSource, type PlannerQueryable as Queryable } from "./container-planner-source";
import { pruneOverAssignedPlanBales } from "./container-plan-bale-prune";

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

function companyIdFor(req: Request): number | null {
  const value = req.session.factoryCompanyId || req.session.currentCompanyId;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanPlanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return name.slice(0, 120);
}

function defaultPlanName(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 16);
  return `Container Plan ${date} ${time}`;
}

async function writePlannerAudit(
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

async function loadPlanDetail(client: Queryable, companyId: number, planId: number) {
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

async function insertPlanLines(
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

async function lockPlan(client: Queryable, planId: number, companyId: number): Promise<PlannerPlanRow | null> {
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

export function registerV5ContainerPlannerRoutes(app: Express): void {
  app.get("/api/factory/v5/container-plans", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = companyIdFor(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const result = await pool.query(
        `SELECT p.id, p.name, p.status, p.capacity_bales AS "capacityBales",
                p.include_garbage_wipers AS "includeGarbageWipers",
                p.source_plannable_total AS "sourcePlannableTotal",
                p.revision, p.created_at AS "createdAt", p.updated_at AS "updatedAt",
                COUNT(DISTINCT c.id)::int AS "containerCount",
                (COUNT(DISTINCT c.id) FILTER (WHERE c.is_locked))::int AS "lockedCount",
                COALESCE(SUM(l.planned_qty), 0)::int AS "totalPlanned"
         FROM factory_container_plans p
         LEFT JOIN factory_container_plan_containers c
           ON c.plan_id = p.id AND c.company_id = p.company_id
         LEFT JOIN factory_container_plan_lines l
           ON l.plan_container_id = c.id AND l.company_id = p.company_id
         WHERE p.company_id = $1
         GROUP BY p.id
         ORDER BY p.updated_at DESC, p.id DESC
         LIMIT 100`,
        [companyId]
      );

      return res.json({ plans: result.rows });
    } catch (error: unknown) {
      logger.error("[V5] container planner list error", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/v5/container-plans/:planId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = companyIdFor(req);
      const planId = positiveInt(req.params.planId);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!planId) return res.status(400).json({ message: "Invalid plan id" });

      const plan = await loadPlanDetail(pool as unknown as Queryable, companyId, planId);
      if (!plan) return res.status(404).json({ message: "Container plan not found" });
      return res.json({ plan });
    } catch (error: unknown) {
      logger.error("[V5] container planner detail error", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/v5/container-plans", requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const companyId = companyIdFor(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const capacityBales = Number(req.body?.capacityBales);
      if (!Number.isSafeInteger(capacityBales) || capacityBales < 1 || capacityBales > MAX_CONTAINER_CAPACITY) {
        return res.status(400).json({ message: `Capacity must be a whole number from 1 to ${MAX_CONTAINER_CAPACITY}` });
      }
      const includeGarbageWipers = req.body?.includeGarbageWipers === true;
      const clientRequestId =
        typeof req.body?.clientRequestId === "string" ? req.body.clientRequestId.trim().slice(0, 100) : "";
      const requestedName = cleanPlanName(req.body?.name);
      const planName = requestedName || defaultPlanName();

      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [731204, companyId]);

      if (clientRequestId) {
        const existing = await client.query(
          `SELECT id FROM factory_container_plans
           WHERE company_id = $1 AND client_request_id = $2`,
          [companyId, clientRequestId]
        );
        if (existing.rows[0]?.id) {
          const existingPlan = await loadPlanDetail(client, companyId, Number(existing.rows[0].id));
          await client.query("COMMIT");
          return res.status(200).json({ plan: existingPlan, duplicate: true });
        }
      }

      const sourceRows = await loadContainerPlannerSource(client, companyId);
      const preview = buildContainerPlannerPreview(sourceRows, capacityBales, { includeGarbageWipers });
      if (preview.totalPlannable <= 0 || preview.containerCount <= 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "There is no positive uncommitted stock available to save." });
      }

      const planInsert = await client.query(
        `INSERT INTO factory_container_plans
           (company_id, name, status, capacity_bales, include_garbage_wipers,
            source_stock_total, source_committed_total, source_loading_total, source_plannable_total,
            client_request_id, created_by, created_by_name, revision, created_at, updated_at)
         VALUES ($1, $2, 'DRAFT', $3, $4, $5, $6, $7, $8, NULLIF($9, ''), $10, $11, 1, NOW(), NOW())
         RETURNING id`,
        [
          companyId,
          planName,
          capacityBales,
          includeGarbageWipers,
          preview.totalStockAvailable,
          preview.customerCommitted,
          preview.alreadyLoading,
          preview.totalPlannable,
          clientRequestId,
          req.session.userId || null,
          req.session.username || null,
        ]
      );
      const planId = Number(planInsert.rows[0].id);

      for (const container of preview.containers) {
        const containerInsert = await client.query(
          `INSERT INTO factory_container_plan_containers
             (company_id, plan_id, position, name, capacity_bales, is_locked, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, false, NOW(), NOW())
           RETURNING id`,
          [companyId, planId, container.index, container.label, capacityBales]
        );
        const containerId = Number(containerInsert.rows[0].id);
        const lines = preview.products.map((product) => ({
          articleCode: product.articleCode,
          productName: product.productName,
          plannedQty: product.allocations[container.index] ?? 0,
        }));
        await insertPlanLines(client, companyId, planId, containerId, lines);
      }

      await writePlannerAudit(client, req, companyId, "create", planId, planName, {
        capacityBales,
        includeGarbageWipers,
        containerCount: preview.containerCount,
        totalPlanned: preview.totalPlannable,
      });
      const plan = await loadPlanDetail(client, companyId, planId);
      await client.query("COMMIT");
      return res.status(201).json({ plan });
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.error("[V5] container planner create error", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    } finally {
      client.release();
    }
  });

  app.patch("/api/factory/v5/container-plans/:planId", requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const companyId = companyIdFor(req);
      const planId = positiveInt(req.params.planId);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!planId) return res.status(400).json({ message: "Invalid plan id" });
      const name = cleanPlanName(req.body?.name);
      if (!name) return res.status(400).json({ message: "Plan name is required" });

      await client.query("BEGIN");
      const plan = await lockPlan(client, planId, companyId);
      if (!plan) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Container plan not found" });
      }
      await client.query(
        `UPDATE factory_container_plans
         SET name = $1, revision = revision + 1, updated_at = NOW()
         WHERE id = $2 AND company_id = $3`,
        [name, planId, companyId]
      );
      await writePlannerAudit(client, req, companyId, "update", planId, name, {
        name: { old: plan.name, new: name },
      });
      const detail = await loadPlanDetail(client, companyId, planId);
      await client.query("COMMIT");
      return res.json({ plan: detail });
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.error("[V5] container planner rename error", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    } finally {
      client.release();
    }
  });

  app.post("/api/factory/v5/container-plans/:planId/move", requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const companyId = companyIdFor(req);
      const planId = positiveInt(req.params.planId);
      const fromContainerId = positiveInt(req.body?.fromContainerId);
      const toContainerId = positiveInt(req.body?.toContainerId);
      const quantity = positiveInt(req.body?.quantity);
      const articleCode = typeof req.body?.articleCode === "string" ? req.body.articleCode.trim() : "";

      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!planId || !fromContainerId || !toContainerId || !quantity || !articleCode) {
        return res
          .status(400)
          .json({ message: "Plan, source, destination, product and positive quantity are required" });
      }
      if (fromContainerId === toContainerId) {
        return res.status(400).json({ message: "Choose a different destination container" });
      }

      await client.query("BEGIN");
      const plan = await lockPlan(client, planId, companyId);
      if (!plan) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Container plan not found" });
      }

      const containerResult = await client.query(
        `SELECT id, position, name, capacity_bales, is_locked
         FROM factory_container_plan_containers
         WHERE plan_id = $1 AND company_id = $2 AND id = ANY($3::int[])
         ORDER BY id
         FOR UPDATE`,
        [planId, companyId, [fromContainerId, toContainerId]]
      );
      if (containerResult.rows.length !== 2) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Source or destination container not found" });
      }

      const byId = new Map(containerResult.rows.map((row) => [Number(row.id), row]));
      const from = byId.get(fromContainerId);
      const to = byId.get(toContainerId);
      if (from?.is_locked || to?.is_locked) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "Locked containers cannot be edited. Unlock them first." });
      }

      const linesResult = await client.query(
        `SELECT id, plan_container_id, article_code, product_name, planned_qty
         FROM factory_container_plan_lines
         WHERE plan_id = $1 AND company_id = $2 AND plan_container_id = ANY($3::int[])
         FOR UPDATE`,
        [planId, companyId, [fromContainerId, toContainerId]]
      );
      const fromLine = linesResult.rows.find(
        (line) => Number(line.plan_container_id) === fromContainerId && String(line.article_code) === articleCode
      );
      if (!fromLine || Number(fromLine.planned_qty) < quantity) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "The source container does not have enough of this product." });
      }

      const destinationTotal = linesResult.rows
        .filter((line) => Number(line.plan_container_id) === toContainerId)
        .reduce((sum, line) => sum + Number(line.planned_qty || 0), 0);
      const destinationCapacity = Number(to.capacity_bales);
      if (destinationTotal + quantity > destinationCapacity) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          message: `Destination capacity exceeded. Only ${Math.max(destinationCapacity - destinationTotal, 0)} more bales fit.`,
        });
      }

      const remaining = Number(fromLine.planned_qty) - quantity;
      if (remaining === 0) {
        await client.query(
          `DELETE FROM factory_container_plan_lines
           WHERE id = $1 AND company_id = $2 AND plan_id = $3`,
          [fromLine.id, companyId, planId]
        );
      } else {
        await client.query(
          `UPDATE factory_container_plan_lines
           SET planned_qty = $1, updated_at = NOW()
           WHERE id = $2 AND company_id = $3 AND plan_id = $4`,
          [remaining, fromLine.id, companyId, planId]
        );
      }

      await client.query(
        `INSERT INTO factory_container_plan_lines
           (company_id, plan_id, plan_container_id, article_code, product_name, planned_qty, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT (plan_container_id, article_code)
         DO UPDATE SET planned_qty = factory_container_plan_lines.planned_qty + EXCLUDED.planned_qty,
                       product_name = EXCLUDED.product_name,
                       updated_at = NOW()`,
        [companyId, planId, toContainerId, articleCode, fromLine.product_name || articleCode, quantity]
      );

      // Quantities just moved, so Phase 4 assignments above the new per-product
      // quota are released back into unassigned stock.
      const releasedBales = await pruneOverAssignedPlanBales(client, companyId, planId);

      await client.query(
        `UPDATE factory_container_plans SET revision = revision + 1, updated_at = NOW()
         WHERE id = $1 AND company_id = $2`,
        [planId, companyId]
      );
      await writePlannerAudit(client, req, companyId, "update", planId, plan.name, {
        move: {
          articleCode,
          quantity,
          fromContainerId,
          toContainerId,
          releasedBales,
        },
      });
      const detail = await loadPlanDetail(client, companyId, planId);
      await client.query("COMMIT");
      return res.json({ plan: detail, releasedBales });
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.error("[V5] container planner move error", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    } finally {
      client.release();
    }
  });

  app.patch(
    "/api/factory/v5/container-plans/:planId/containers/:containerId/lock",
    requireAuth,
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        const containerId = positiveInt(req.params.containerId);
        const isLocked = req.body?.isLocked;

        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId || !containerId || typeof isLocked !== "boolean") {
          return res.status(400).json({ message: "Valid plan, container and lock state are required" });
        }

        await client.query("BEGIN");
        const plan = await lockPlan(client, planId, companyId);
        if (!plan) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container plan not found" });
        }

        const result = await client.query(
          `UPDATE factory_container_plan_containers
           SET is_locked = $1,
               locked_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
               locked_by = CASE WHEN $1 THEN $2 ELSE NULL END,
               locked_by_name = CASE WHEN $1 THEN $3 ELSE NULL END,
               updated_at = NOW()
           WHERE id = $4 AND plan_id = $5 AND company_id = $6
           RETURNING id, name`,
          [isLocked, req.session.userId || null, req.session.username || null, containerId, planId, companyId]
        );
        if (result.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container not found" });
        }

        await client.query(
          `UPDATE factory_container_plans SET revision = revision + 1, updated_at = NOW()
           WHERE id = $1 AND company_id = $2`,
          [planId, companyId]
        );
        await writePlannerAudit(client, req, companyId, "update", planId, plan.name, {
          containerLock: { containerId, isLocked },
        });
        const detail = await loadPlanDetail(client, companyId, planId);
        await client.query("COMMIT");
        return res.json({ plan: detail });
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        logger.error("[V5] container planner lock error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      } finally {
        client.release();
      }
    }
  );

  app.post("/api/factory/v5/container-plans/:planId/rebalance", requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const companyId = companyIdFor(req);
      const planId = positiveInt(req.params.planId);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!planId) return res.status(400).json({ message: "Invalid plan id" });

      await client.query("BEGIN");
      const plan = await lockPlan(client, planId, companyId);
      if (!plan) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Container plan not found" });
      }

      const containersResult = await client.query(
        `SELECT id, position, is_locked
         FROM factory_container_plan_containers
         WHERE plan_id = $1 AND company_id = $2
         ORDER BY position, id
         FOR UPDATE`,
        [planId, companyId]
      );
      const linesResult = await client.query(
        `SELECT plan_container_id, article_code, product_name, planned_qty
         FROM factory_container_plan_lines
         WHERE plan_id = $1 AND company_id = $2
         FOR UPDATE`,
        [planId, companyId]
      );

      const linesByContainer = new Map<number, SavedPlannerContainer["lines"]>();
      for (const line of linesResult.rows) {
        const containerId = Number(line.plan_container_id);
        if (!linesByContainer.has(containerId)) linesByContainer.set(containerId, []);
        linesByContainer.get(containerId)!.push({
          articleCode: String(line.article_code),
          productName: String(line.product_name || line.article_code),
          plannedQty: Number(line.planned_qty),
        });
      }

      const savedContainers: SavedPlannerContainer[] = containersResult.rows.map((container) => ({
        id: Number(container.id),
        position: Number(container.position),
        isLocked: Boolean(container.is_locked),
        lines: linesByContainer.get(Number(container.id)) ?? [],
      }));

      let rebalanced;
      try {
        rebalanced = rebalanceUnlockedContainerPlan(savedContainers, Number(plan.capacity_bales));
      } catch (error) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: getErrorMessage(error) });
      }

      const unlockedIds = savedContainers.filter((container) => !container.isLocked).map((container) => container.id);
      if (unlockedIds.length > 0) {
        await client.query(
          `DELETE FROM factory_container_plan_lines
           WHERE plan_id = $1 AND company_id = $2 AND plan_container_id = ANY($3::int[])`,
          [planId, companyId, unlockedIds]
        );
        for (const container of rebalanced) {
          await insertPlanLines(client, companyId, planId, container.containerId, container.lines);
        }
      }

      const releasedBales = await pruneOverAssignedPlanBales(client, companyId, planId);

      await client.query(
        `UPDATE factory_container_plans SET revision = revision + 1, updated_at = NOW()
         WHERE id = $1 AND company_id = $2`,
        [planId, companyId]
      );
      await writePlannerAudit(client, req, companyId, "update", planId, plan.name, {
        rebalance: {
          unlockedContainers: unlockedIds.length,
          lockedContainers: savedContainers.length - unlockedIds.length,
          releasedBales,
        },
      });
      const detail = await loadPlanDetail(client, companyId, planId);
      await client.query("COMMIT");
      return res.json({ plan: detail, releasedBales });
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.error("[V5] container planner rebalance error", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    } finally {
      client.release();
    }
  });

  app.delete("/api/factory/v5/container-plans/:planId", requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const companyId = companyIdFor(req);
      const planId = positiveInt(req.params.planId);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!planId) return res.status(400).json({ message: "Invalid plan id" });

      await client.query("BEGIN");
      const plan = await lockPlan(client, planId, companyId);
      if (!plan) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Container plan not found" });
      }
      await writePlannerAudit(client, req, companyId, "delete", planId, plan.name, {
        deleted: true,
        revision: plan.revision,
      });
      await client.query(`DELETE FROM factory_container_plans WHERE id = $1 AND company_id = $2`, [planId, companyId]);
      await client.query("COMMIT");
      return res.json({ success: true });
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.error("[V5] container planner delete error", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    } finally {
      client.release();
    }
  });
}
