// Extracted from ./registerV5ContainerPlannerRoutesPart1.ts
import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { pruneOverAllocatedPlanAllocations, pruneOverAssignedPlanBales } from "./container-plan-bale-prune";
import {
  cleanPlanName,
  companyIdFor,
  loadPlanDetail,
  lockPlan,
  positiveInt,
  writePlannerAudit,
} from "./container-plannerLoadPlanDetail";

export function registerV5ContainerPlannerRoutesPart2(app: Express) {
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
      const adjustedAllocations = await pruneOverAllocatedPlanAllocations(client, companyId, planId);

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
          adjustedAllocations,
        },
      });
      const detail = await loadPlanDetail(client, companyId, planId);
      await client.query("COMMIT");
      return res.json({ plan: detail, releasedBales, adjustedAllocations });
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.error("[V5] container planner move error", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    } finally {
      client.release();
    }
  });
}
