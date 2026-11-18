// Extracted from ./container-planner.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { buildContainerPlannerPreview, MAX_CONTAINER_CAPACITY } from "@shared/containerPlanner";
import { loadContainerPlannerSource, type PlannerQueryable as Queryable } from "./container-planner-source";
import {
  cleanPlanName,
  companyIdFor,
  defaultPlanName,
  insertPlanLines,
  loadPlanDetail,
  positiveInt,
  writePlannerAudit,
} from "./container-plannerLoadPlanDetail";
import { registerV5ContainerPlannerRoutesPart2 } from "./registerV5ContainerPlannerRoutesPart2";

export function registerV5ContainerPlannerRoutesPart1(app: Express) {
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

  registerV5ContainerPlannerRoutesPart2(app);
}
