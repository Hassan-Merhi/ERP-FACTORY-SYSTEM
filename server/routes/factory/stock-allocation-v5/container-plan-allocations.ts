import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import {
  buildCustomerPackingList,
  buildPlanAllocationSummary,
  validateContainerAllocation,
  type CustomerDemandRow,
  type ExistingAllocation,
} from "@shared/containerCustomerAllocation";
import type { PlannerQueryable } from "./container-planner-source";

function companyIdFor(req: Request): number | null {
  const value = req.session.factoryCompanyId || req.session.currentCompanyId;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function loadPlanHeader(client: PlannerQueryable, companyId: number, planId: number, forUpdate: boolean) {
  const result = await client.query<{ id: number; name: string; status: string }>(
    `SELECT id, name, status
     FROM factory_container_plans
     WHERE id = $1 AND company_id = $2
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [planId, companyId]
  );
  return result.rows[0] ?? null;
}

async function writeAllocationAudit(
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
     VALUES ($1, $2, $3, 'update', 'factory_container_plan_allocations', $4, $5, $6::jsonb, NOW())`,
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

type ContainerLineRow = {
  container_id: number | string;
  container_name: string;
  position: number | string;
  article_code: string;
  product_name: string | null;
  planned_qty: number | string;
};

async function loadContainersWithLines(client: PlannerQueryable, companyId: number, planId: number) {
  const result = await client.query<ContainerLineRow>(
    `SELECT c.id AS container_id, c.name AS container_name, c.position,
            l.article_code, l.product_name, l.planned_qty
     FROM factory_container_plan_containers c
     LEFT JOIN factory_container_plan_lines l
       ON l.plan_container_id = c.id AND l.company_id = c.company_id
     WHERE c.company_id = $1 AND c.plan_id = $2
     ORDER BY c.position, c.id`,
    [companyId, planId]
  );

  const byContainer = new Map<
    number,
    {
      containerId: number;
      containerName: string;
      position: number;
      lines: Array<{ articleCode: string; productName: string; plannedQty: number }>;
    }
  >();

  for (const row of result.rows) {
    const containerId = Number(row.container_id);
    const entry = byContainer.get(containerId) ?? {
      containerId,
      containerName: String(row.container_name),
      position: Number(row.position),
      lines: [],
    };
    if (row.article_code) {
      entry.lines.push({
        articleCode: String(row.article_code),
        productName: String(row.product_name || row.article_code),
        plannedQty: Number(row.planned_qty || 0),
      });
    }
    byContainer.set(containerId, entry);
  }

  return Array.from(byContainer.values()).sort((a, b) => a.position - b.position || a.containerId - b.containerId);
}

async function loadAllocations(
  client: PlannerQueryable,
  companyId: number,
  planId: number,
  forUpdate = false
): Promise<ExistingAllocation[]> {
  const result = await client.query(
    `SELECT a.id, a.plan_container_id, a.customer_id, a.order_id, a.article_code,
            a.product_name, a.allocated_qty,
            COALESCE(cu.legal_name, cu.code, 'Customer ' || a.customer_id::text) AS customer_name
     FROM factory_container_plan_allocations a
     LEFT JOIN customers cu ON cu.id = a.customer_id
     WHERE a.company_id = $1 AND a.plan_id = $2
     ORDER BY a.plan_container_id, a.customer_id, a.article_code
     ${forUpdate ? "FOR UPDATE OF a" : ""}`,
    [companyId, planId]
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    containerId: Number(row.plan_container_id),
    customerId: Number(row.customer_id),
    customerName: String(row.customer_name),
    orderId: row.order_id == null ? null : Number(row.order_id),
    articleCode: String(row.article_code),
    productName: String(row.product_name || row.article_code),
    allocatedQty: Number(row.allocated_qty || 0),
  }));
}

/**
 * Outstanding customer demand, reusing the same commitment definition Phase 2
 * uses to reserve stock: proforma-expected quantities minus what each order has
 * already physically loaded.
 */
async function loadCustomerDemand(client: PlannerQueryable, companyId: number): Promise<CustomerDemandRow[]> {
  const result = await client.query(
    `WITH loaded_by_order AS (
       SELECT cob.order_id, fb.article_code, COUNT(*)::int AS qty
       FROM customer_order_bales cob
       JOIN factory_bales fb ON fb.id = cob.bale_id
       JOIN customer_orders co ON co.id = cob.order_id
       WHERE co.company_id = $1 AND co.proforma_id_used IS NOT NULL
       GROUP BY cob.order_id, fb.article_code
     ),
     proforma_expected AS (
       SELECT cpl.proforma_id, cpl.article_code,
              MAX(cpl.product_name) AS product_name,
              COALESCE(SUM(cpl.quantity), 0)::int AS quantity
       FROM customer_proforma_lines cpl
       JOIN customer_proformas cp ON cp.id = cpl.proforma_id
       WHERE cp.company_id = $1
       GROUP BY cpl.proforma_id, cpl.article_code
     )
     SELECT co.customer_id AS "customerId",
            COALESCE(cu.legal_name, cu.code, 'Customer ' || co.customer_id::text) AS "customerName",
            co.id AS "orderId",
            pe.article_code AS "articleCode",
            COALESCE(pe.product_name, pe.article_code) AS "productName",
            GREATEST(COALESCE(cel.expected_qty, pe.quantity, 0) - COALESCE(lbo.qty, 0), 0)::int AS "demandQty"
     FROM customer_orders co
     JOIN proforma_expected pe ON pe.proforma_id = co.proforma_id_used
     LEFT JOIN customer_order_expected_lines cel
       ON cel.order_id = co.id AND cel.article_code = pe.article_code AND cel.company_id = co.company_id
     LEFT JOIN loaded_by_order lbo ON lbo.order_id = co.id AND lbo.article_code = pe.article_code
     LEFT JOIN customers cu ON cu.id = co.customer_id
     WHERE co.company_id = $1
       AND co.status IN ('DRAFT', 'LOADING')
       AND co.proforma_id_used IS NOT NULL`,
    [companyId]
  );

  return result.rows
    .map((row) => ({
      customerId: Number(row.customerId),
      customerName: String(row.customerName),
      orderId: row.orderId == null ? null : Number(row.orderId),
      articleCode: String(row.articleCode),
      productName: String(row.productName || row.articleCode),
      demandQty: Number(row.demandQty || 0),
    }))
    .filter((row) => row.demandQty > 0);
}

async function buildSummary(client: PlannerQueryable, companyId: number, planId: number) {
  const [containers, allocations, demand] = await Promise.all([
    loadContainersWithLines(client, companyId, planId),
    loadAllocations(client, companyId, planId),
    loadCustomerDemand(client, companyId),
  ]);
  return buildPlanAllocationSummary({ containers, allocations, demand });
}

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
