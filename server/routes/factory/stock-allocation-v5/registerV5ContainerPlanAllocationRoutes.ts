// Extracted from ./container-plan-allocations.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { buildCustomerPackingList } from "@shared/containerCustomerAllocation";
import type { PlannerQueryable } from "./container-planner-source";
import {
  buildSummary,
  companyIdFor,
  loadAllocations,
  loadContainersWithLines,
  loadPlanHeader,
  positiveInt,
  writeAllocationAudit,
} from "./container-plan-allocationsLoadCustomerDemand";
import { registerV5ContainerPlanAllocationRoutesPart1 } from "./registerV5ContainerPlanAllocationRoutesPart1";

export function registerV5ContainerPlanAllocationRoutes(app: Express): void {
  registerV5ContainerPlanAllocationRoutesPart1(app);

  // Release a customer's whole reservation on one container.
  app.delete(
    "/api/factory/v5/container-plans/:planId/containers/:containerId/allocations/:customerId",
    requireAuth,
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        const containerId = positiveInt(req.params.containerId);
        const customerId = positiveInt(req.params.customerId);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId || !containerId || !customerId) {
          return res.status(400).json({ message: "Invalid plan, container or customer id" });
        }

        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1, $2)", [731206, companyId]);

        const header = await loadPlanHeader(client, companyId, planId, true);
        if (!header) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container plan not found" });
        }

        const deleted = await client.query<{ id: number }>(
          `DELETE FROM factory_container_plan_allocations
           WHERE company_id = $1 AND plan_id = $2 AND plan_container_id = $3 AND customer_id = $4
           RETURNING id`,
          [companyId, planId, containerId, customerId]
        );
        if (deleted.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "No allocation found for this customer on this container" });
        }

        await client.query(
          `UPDATE factory_container_plans SET revision = revision + 1, updated_at = NOW()
           WHERE id = $1 AND company_id = $2`,
          [planId, companyId]
        );
        await writeAllocationAudit(client, req, companyId, planId, header.name, {
          allocationReleased: { containerId, customerId, lines: deleted.rows.length },
        });

        const summary = await buildSummary(client, companyId, planId);
        await client.query("COMMIT");
        return res.json({ success: true, released: deleted.rows.length, summary });
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        logger.error("[V5] container plan allocation delete error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      } finally {
        client.release();
      }
    }
  );

  // Customer loading list / packing list, with exact bale codes once Phase 4 ran.
  app.get(
    "/api/factory/v5/container-plans/:planId/customers/:customerId/packing-list",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        const customerId = positiveInt(req.params.customerId);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId || !customerId) return res.status(400).json({ message: "Invalid plan or customer id" });

        const client = pool as unknown as PlannerQueryable;
        const header = await loadPlanHeader(client, companyId, planId, false);
        if (!header) return res.status(404).json({ message: "Container plan not found" });

        const [containers, allocations] = await Promise.all([
          loadContainersWithLines(client, companyId, planId),
          loadAllocations(client, companyId, planId),
        ]);

        const assignmentResult = await client.query(
          `SELECT plan_container_id, article_code, bale_code, weight_kg
           FROM factory_container_plan_bales
           WHERE company_id = $1 AND plan_id = $2
           ORDER BY bale_code`,
          [companyId, planId]
        );
        const assignmentsByContainer = new Map<
          number,
          Array<{ articleCode: string; baleCode: string; weightKg: number }>
        >();
        for (const row of assignmentResult.rows) {
          const key = Number(row.plan_container_id);
          const list = assignmentsByContainer.get(key) ?? [];
          list.push({
            articleCode: String(row.article_code),
            baleCode: String(row.bale_code),
            weightKg: Number(row.weight_kg || 0),
          });
          assignmentsByContainer.set(key, list);
        }

        const packingList = buildCustomerPackingList({
          customerId,
          containers: containers.map((container) => ({
            containerId: container.containerId,
            containerName: container.containerName,
            position: container.position,
            allocations: allocations
              .filter((allocation) => allocation.containerId === container.containerId)
              .map((allocation) => ({
                customerId: allocation.customerId,
                articleCode: allocation.articleCode,
                productName: allocation.productName,
                allocatedQty: allocation.allocatedQty,
              })),
            assignments: assignmentsByContainer.get(container.containerId) ?? [],
          })),
        });

        const customerName =
          allocations.find((allocation) => allocation.customerId === customerId)?.customerName ??
          `Customer ${customerId}`;

        return res.json({
          planId,
          planName: header.name,
          customerId,
          customerName,
          generatedAt: new Date().toISOString(),
          ...packingList,
        });
      } catch (error: unknown) {
        logger.error("[V5] container plan packing list error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Allocation history straight from the audit trail.
  app.get(
    "/api/factory/v5/container-plans/:planId/allocation-history",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId) return res.status(400).json({ message: "Invalid plan id" });

        const result = await pool.query(
          `SELECT id, username, action, changes, created_at AS "createdAt"
           FROM audit_log
           WHERE company_id = $1
             AND table_name = 'factory_container_plan_allocations'
             AND record_id = $2
           ORDER BY created_at DESC, id DESC
           LIMIT 100`,
          [companyId, planId]
        );

        return res.json({
          planId,
          history: result.rows.map((row) => ({
            id: Number(row.id),
            username: row.username,
            action: row.action,
            changes: row.changes,
            createdAt: row.createdAt,
          })),
        });
      } catch (error: unknown) {
        logger.error("[V5] container plan allocation history error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
