import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { rebalanceUnlockedContainerPlan, type SavedPlannerContainer } from "@shared/containerPlanner";
import { pruneOverAllocatedPlanAllocations, pruneOverAssignedPlanBales } from "./container-plan-bale-prune";
import { isShipmentCommitted, type ContainerLifecycleStatus } from "@shared/containerShipment";
import {
  companyIdFor,
  insertPlanLines,
  loadPlanDetail,
  lockPlan,
  positiveInt,
  writePlannerAudit,
} from "./container-plannerLoadPlanDetail";
import { registerV5ContainerPlannerRoutesPart1 } from "./registerV5ContainerPlannerRoutesPart1";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  stringParam,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../../lib/validateRequest";

const planIdParams = z.strictObject({ planId: stringParam });

// The handler keeps its "lock state is required" check and message.
const lockContainerInput = {
  params: z.strictObject({ planId: stringParam, containerId: stringParam }),
  query: emptyQuery,
  body: z.strictObject({ isLocked: z.boolean().optional() }),
} satisfies RequestSchemas;

const rebalancePlanInput = { params: planIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;
const deletePlanInput = { params: planIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerV5ContainerPlannerRoutes(app: Express): void {
  registerV5ContainerPlannerRoutesPart1(app);
  registerV5ContainerPlannerRoutesPart2(app);
}

function registerV5ContainerPlannerRoutesPart2(app: Express) {
  app.patch(
    "/api/factory/v5/container-plans/:planId/containers/:containerId/lock",
    requireAuth,
    validateRequest(lockContainerInput),
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const { params } = validatedInput(req, lockContainerInput);
        const planId = positiveInt(params.planId);
        const containerId = positiveInt(params.containerId);
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

        // A container that has left PLANNED is physically committed (Phase 6), so
        // it must stay locked until its shipment status is walked back.
        const lifecycleResult = await client.query<{ lifecycle_status: string }>(
          `SELECT lifecycle_status
           FROM factory_container_plan_containers
           WHERE id = $1 AND plan_id = $2 AND company_id = $3
           FOR UPDATE`,
          [containerId, planId, companyId]
        );
        const lifecycleStatus = lifecycleResult.rows[0]?.lifecycle_status;
        if (!lifecycleStatus) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container not found" });
        }
        if (!isLocked && isShipmentCommitted(lifecycleStatus as ContainerLifecycleStatus)) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            code: "CONTAINER_SHIPMENT_COMMITTED",
            message: `This container is ${lifecycleStatus}. Move its shipment status back to PLANNED before unlocking it.`,
          });
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

  app.post(
    "/api/factory/v5/container-plans/:planId/rebalance",
    requireAuth,
    validateRequest(rebalancePlanInput),
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(validatedInput(req, rebalancePlanInput).params.planId);
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
        const adjustedAllocations = await pruneOverAllocatedPlanAllocations(client, companyId, planId);

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
            adjustedAllocations,
          },
        });
        const detail = await loadPlanDetail(client, companyId, planId);
        await client.query("COMMIT");
        return res.json({ plan: detail, releasedBales, adjustedAllocations });
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        logger.error("[V5] container planner rebalance error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      } finally {
        client.release();
      }
    }
  );

  app.delete(
    "/api/factory/v5/container-plans/:planId",
    requireAuth,
    validateRequest(deletePlanInput),
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(validatedInput(req, deletePlanInput).params.planId);
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
        await client.query(`DELETE FROM factory_container_plans WHERE id = $1 AND company_id = $2`, [
          planId,
          companyId,
        ]);
        await client.query("COMMIT");
        return res.json({ success: true });
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        logger.error("[V5] container planner delete error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      } finally {
        client.release();
      }
    }
  );
}
