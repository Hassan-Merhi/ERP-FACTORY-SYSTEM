// Extracted from ./container-plan-allocations.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { buildCustomerPackingList, validateContainerAllocation } from "@shared/containerCustomerAllocation";
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
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  stringParam,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../../lib/validateRequest";

const numberOrString = z.union([z.number(), z.string()]);

// The handler keeps its required checks; validateContainerAllocation rejects
// bad lines one by one with its own messages.
const saveAllocationInput = {
  params: z.strictObject({ planId: stringParam, containerId: stringParam }),
  query: emptyQuery,
  body: z.strictObject({
    customerId: numberOrString.optional(),
    orderId: numberOrString.nullable().optional(),
    notes: z.string().nullable().optional(),
    lines: z.array(z.strictObject({ articleCode: z.string().optional(), qty: numberOrString.optional() })).optional(),
  }),
} satisfies RequestSchemas;

const releaseAllocationInput = {
  params: z.strictObject({ planId: stringParam, containerId: stringParam, customerId: stringParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export function registerV5ContainerPlanAllocationRoutes(app: Express): void {
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
    validateRequest(saveAllocationInput),
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const { params } = validatedInput(req, saveAllocationInput);
        const planId = positiveInt(params.planId);
        const containerId = positiveInt(params.containerId);
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

  // Release a customer's whole reservation on one container.
  app.delete(
    "/api/factory/v5/container-plans/:planId/containers/:containerId/allocations/:customerId",
    requireAuth,
    validateRequest(releaseAllocationInput),
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const { params } = validatedInput(req, releaseAllocationInput);
        const planId = positiveInt(params.planId);
        const containerId = positiveInt(params.containerId);
        const customerId = positiveInt(params.customerId);
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
