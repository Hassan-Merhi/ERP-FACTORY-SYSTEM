// Extracted from ./registerV5ContainerPlanAllocationRoutes.ts
import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { validateContainerAllocation } from "@shared/containerCustomerAllocation";
import type { PlannerQueryable } from "./container-planner-source";
import {
  buildSummary,
  companyIdFor,
  loadAllocations,
  loadContainersWithLines,
  loadCustomerDemand,
  loadPlanHeader,
  positiveInt,
  writeAllocationAudit,
} from "./container-plan-allocationsLoadCustomerDemand";

export function registerV5ContainerPlanAllocationRoutesPart1(app: Express) {
  // Both sides of Phase 5: container coverage and customer order coverage.
  app.get("/api/factory/v5/container-plans/:planId/allocations", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = companyIdFor(req);
      const planId = positiveInt(req.params.planId);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!planId) return res.status(400).json({ message: "Invalid plan id" });

      const client = pool as unknown as PlannerQueryable;
      const header = await loadPlanHeader(client, companyId, planId, false);
      if (!header) return res.status(404).json({ message: "Container plan not found" });

      return res.json({
        planId,
        planName: header.name,
        checkedAt: new Date().toISOString(),
        summary: await buildSummary(client, companyId, planId),
      });
    } catch (error: unknown) {
      logger.error("[V5] container plan allocation read error", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Reserve part (or all) of one container for one customer.
  app.put(
    "/api/factory/v5/container-plans/:planId/containers/:containerId/allocations",
    requireAuth,
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        const containerId = positiveInt(req.params.containerId);
        const customerId = positiveInt(req.body?.customerId);
        const orderId = positiveInt(req.body?.orderId);
        const notes = typeof req.body?.notes === "string" ? req.body.notes.trim().slice(0, 500) : null;
        const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];

        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId || !containerId) return res.status(400).json({ message: "Invalid plan or container id" });
        if (!customerId) return res.status(400).json({ message: "Choose a customer" });
        if (lines.length === 0) return res.status(400).json({ message: "Send at least one product line" });

        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1, $2)", [731206, companyId]);

        const header = await loadPlanHeader(client, companyId, planId, true);
        if (!header) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container plan not found" });
        }

        const customer = await client.query<{ id: number; name: string }>(
          `SELECT id, COALESCE(legal_name, code, 'Customer ' || id::text) AS name
           FROM customers WHERE id = $1 AND company_id = $2`,
          [customerId, companyId]
        );
        if (customer.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Customer not found" });
        }

        const containers = await loadContainersWithLines(client, companyId, planId);
        const container = containers.find((entry) => entry.containerId === containerId);
        if (!container) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container not found in this plan" });
        }

        const allocations = await loadAllocations(client, companyId, planId, true);
        const plannedByArticle = new Map(
          container.lines.map((line) => [
            line.articleCode,
            { productName: line.productName, plannedQty: line.plannedQty },
          ])
        );
        const existingByArticle = new Map<string, number>();
        const currentCustomerByArticle = new Map<string, number>();
        const otherContainerByArticle = new Map<string, number>();
        for (const allocation of allocations) {
          if (allocation.containerId === containerId) {
            existingByArticle.set(
              allocation.articleCode,
              (existingByArticle.get(allocation.articleCode) ?? 0) + allocation.allocatedQty
            );
            if (allocation.customerId === customerId) {
              currentCustomerByArticle.set(
                allocation.articleCode,
                (currentCustomerByArticle.get(allocation.articleCode) ?? 0) + allocation.allocatedQty
              );
            }
          } else if (allocation.customerId === customerId) {
            otherContainerByArticle.set(
              allocation.articleCode,
              (otherContainerByArticle.get(allocation.articleCode) ?? 0) + allocation.allocatedQty
            );
          }
        }

        let demandByArticle: Map<string, number> | undefined;
        if (orderId) {
          const demand = await loadCustomerDemand(client, companyId);
          const forOrder = demand.filter((row) => row.orderId === orderId && row.customerId === customerId);
          if (forOrder.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "No outstanding order demand found for this customer" });
          }
          demandByArticle = new Map(forOrder.map((row) => [row.articleCode, row.demandQty]));
        }

        const validation = validateContainerAllocation({
          plannedByArticle,
          existingByArticle,
          currentCustomerByArticle,
          demandByArticle,
          otherContainerByArticle,
          lines,
        });

        if (validation.accepted.length === 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            message: validation.rejected[0]?.message || "No allocation line could be saved.",
            rejected: validation.rejected,
          });
        }

        // The request is the customer's full allocation for this container, so
        // anything not resent is released.
        await client.query(
          `DELETE FROM factory_container_plan_allocations
           WHERE company_id = $1 AND plan_id = $2 AND plan_container_id = $3 AND customer_id = $4`,
          [companyId, planId, containerId, customerId]
        );

        const positive = validation.accepted.filter((line) => line.qty > 0);
        for (const line of positive) {
          await client.query(
            `INSERT INTO factory_container_plan_allocations
               (company_id, plan_id, plan_container_id, customer_id, order_id, article_code,
                product_name, allocated_qty, notes, created_by, created_by_name, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())`,
            [
              companyId,
              planId,
              containerId,
              customerId,
              orderId,
              line.articleCode,
              line.productName,
              line.qty,
              notes,
              req.session.userId || null,
              req.session.username || null,
            ]
          );
        }

        await client.query(
          `UPDATE factory_container_plans SET revision = revision + 1, updated_at = NOW()
           WHERE id = $1 AND company_id = $2`,
          [planId, companyId]
        );
        await writeAllocationAudit(client, req, companyId, planId, header.name, {
          allocation: {
            containerId,
            customerId,
            customerName: customer.rows[0].name,
            orderId,
            lines: positive,
            rejected: validation.rejected.length,
          },
        });

        const summary = await buildSummary(client, companyId, planId);
        await client.query("COMMIT");

        return res.json({
          success: true,
          planId,
          containerId,
          customerId,
          saved: positive,
          rejected: validation.rejected,
          summary,
        });
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        logger.error("[V5] container plan allocation write error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      } finally {
        client.release();
      }
    }
  );
}
