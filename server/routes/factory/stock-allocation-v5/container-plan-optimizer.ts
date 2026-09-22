import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { MAX_CONTAINER_CAPACITY, normalizeContainerCapacity } from "@shared/containerPlanner";
import {
  buildContainerOptimizationPlan,
  type ContainerOptimizationPlan,
  type OptimizerDemandRow,
  type OptimizerStockRow,
} from "@shared/containerOptimizer";
import { loadContainerPlannerSource, type PlannerQueryable } from "./container-planner-source";

function companyIdFor(req: Request): number | null {
  const value = req.session.factoryCompanyId || req.session.currentCompanyId;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Turns the Phase 2 stock picture into optimizer input, applying the same
 * garbage/wipers exclusion the planner uses.
 */
function toOptimizerStock(
  rows: Awaited<ReturnType<typeof loadContainerPlannerSource>>,
  includeGarbageWipers: boolean
): OptimizerStockRow[] {
  return rows
    .filter((row) => includeGarbageWipers || row.isGarbageOrWipers !== true)
    .map((row) => ({
      articleCode: row.articleCode,
      productName: row.productName,
      availableQty: Math.max(0, Math.trunc(row.freeToPromise)),
    }))
    .filter((row) => row.availableQty > 0);
}

/**
 * Open customer demand, using the same commitment definition as Phase 2 and 5:
 * proforma-expected quantities minus what the order has already loaded.
 *
 * Note that free-to-promise already excludes these commitments, so the
 * optimizer is told about demand and the stock that would serve it separately;
 * the caller decides which pool to plan from.
 */
async function loadOptimizerDemand(
  client: PlannerQueryable,
  companyId: number,
  priorities: Map<number, number>
): Promise<OptimizerDemandRow[]> {
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
      priority: priorities.get(Number(row.customerId)) ?? 0,
    }))
    .filter((row) => row.demandQty > 0);
}

function parsePriorities(value: unknown): Map<number, number> {
  const priorities = new Map<number, number>();
  if (!Array.isArray(value)) return priorities;
  for (const entry of value) {
    const customerId = positiveInt((entry as { customerId?: unknown })?.customerId);
    const priority = Number((entry as { priority?: unknown })?.priority);
    if (customerId && Number.isFinite(priority)) {
      priorities.set(customerId, Math.max(0, Math.trunc(priority)));
    }
  }
  return priorities;
}

/**
 * Committed stock is excluded from free-to-promise, so serving open orders from
 * the same pool would double-count it. `includeCommittedDemand` adds the
 * committed quantities back so the optimizer can lay out order containers too.
 */
function withCommittedStock(stock: OptimizerStockRow[], demand: OptimizerDemandRow[]): OptimizerStockRow[] {
  const merged = new Map(stock.map((row) => [row.articleCode, { ...row }]));
  for (const row of demand) {
    const existing = merged.get(row.articleCode);
    if (existing) {
      existing.availableQty += row.demandQty;
    } else {
      merged.set(row.articleCode, {
        articleCode: row.articleCode,
        productName: row.productName,
        availableQty: row.demandQty,
      });
    }
  }
  return Array.from(merged.values());
}

export function registerV5ContainerPlanOptimizerRoutes(app: Express): void {
  // Read-only recommendation from live stock and open orders.
  app.post("/api/factory/v5/container-plans/optimize", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = companyIdFor(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const capacityBales = Number(req.body?.capacityBales);
      if (!Number.isSafeInteger(capacityBales) || capacityBales < 1 || capacityBales > MAX_CONTAINER_CAPACITY) {
        return res.status(400).json({ message: `Capacity must be a whole number from 1 to ${MAX_CONTAINER_CAPACITY}` });
      }
      const includeGarbageWipers = req.body?.includeGarbageWipers === true;
      const includeCommittedDemand = req.body?.includeCommittedDemand !== false;

      const client = pool as unknown as PlannerQueryable;
      const sourceRows = await loadContainerPlannerSource(client, companyId);
      const demand = includeCommittedDemand
        ? await loadOptimizerDemand(client, companyId, parsePriorities(req.body?.customerPriorities))
        : [];
      const freeStock = toOptimizerStock(sourceRows, includeGarbageWipers);
      const stock = includeCommittedDemand ? withCommittedStock(freeStock, demand) : freeStock;

      const suggestion = buildContainerOptimizationPlan({
        stock,
        demand,
        capacityBales: normalizeContainerCapacity(capacityBales),
      });

      return res.json({
        generatedAt: new Date().toISOString(),
        includeGarbageWipers,
        includeCommittedDemand,
        suggestion,
      });
    } catch (error: unknown) {
      logger.error("[V5] container plan optimizer preview error", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Rewrite a draft plan's containers with the recommended layout.
  app.post(
    "/api/factory/v5/container-plans/:planId/optimize/apply",
    requireAuth,
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId) return res.status(400).json({ message: "Invalid plan id" });

        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1, $2)", [731204, companyId]);

        const planResult = await client.query<{
          id: number;
          name: string;
          status: string;
          capacity_bales: number;
          include_garbage_wipers: boolean;
        }>(
          `SELECT id, name, status, capacity_bales, include_garbage_wipers
           FROM factory_container_plans
           WHERE id = $1 AND company_id = $2
           FOR UPDATE`,
          [planId, companyId]
        );
        const plan = planResult.rows[0];
        if (!plan) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container plan not found" });
        }
        if (plan.status !== "DRAFT") {
          await client.query("ROLLBACK");
          return res.status(409).json({ message: "Only draft container plans can be optimized." });
        }

        // Optimizing rebuilds every container, so it is refused while anything
        // downstream is already committed to the current layout.
        const blockers = await client.query<{
          locked: number;
          committed: number;
          assigned: number;
          allocated: number;
        }>(
          `SELECT
             (SELECT COUNT(*) FROM factory_container_plan_containers
               WHERE plan_id = $1 AND company_id = $2 AND is_locked)::int AS locked,
             (SELECT COUNT(*) FROM factory_container_plan_containers
               WHERE plan_id = $1 AND company_id = $2 AND lifecycle_status <> 'PLANNED')::int AS committed,
             (SELECT COUNT(*) FROM factory_container_plan_bales
               WHERE plan_id = $1 AND company_id = $2)::int AS assigned,
             (SELECT COUNT(*) FROM factory_container_plan_allocations
               WHERE plan_id = $1 AND company_id = $2)::int AS allocated`,
          [planId, companyId]
        );
        const blocker = blockers.rows[0];
        if (blocker.locked > 0 || blocker.committed > 0 || blocker.assigned > 0 || blocker.allocated > 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            code: "CONTAINER_PLAN_NOT_OPTIMIZABLE",
            message:
              "Optimizing rebuilds every container. Unlock containers and release their bale assignments and customer allocations first.",
            blockers: blocker,
          });
        }

        const capacity = Number(plan.capacity_bales);
        const includeGarbageWipers = Boolean(plan.include_garbage_wipers);
        const sourceRows = await loadContainerPlannerSource(client, companyId);
        const demand = await loadOptimizerDemand(client, companyId, parsePriorities(req.body?.customerPriorities));
        const stock = withCommittedStock(toOptimizerStock(sourceRows, includeGarbageWipers), demand);
        const suggestion: ContainerOptimizationPlan = buildContainerOptimizationPlan({
          stock,
          demand,
          capacityBales: capacity,
        });

        if (suggestion.containerCount === 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({ message: "There is no stock to lay out right now." });
        }

        await client.query(`DELETE FROM factory_container_plan_containers WHERE plan_id = $1 AND company_id = $2`, [
          planId,
          companyId,
        ]);

        for (const container of suggestion.containers) {
          const label = container.customerName
            ? `${container.label} · ${container.customerName}`
            : container.kind === "SINGLE_PRODUCT"
              ? `${container.label} · ${container.lines[0]?.productName ?? "Single product"}`
              : `${container.label} · Mixed`;

          const inserted = await client.query<{ id: number }>(
            `INSERT INTO factory_container_plan_containers
               (company_id, plan_id, position, name, capacity_bales, is_locked, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, false, NOW(), NOW())
             RETURNING id`,
            [companyId, planId, container.index, label.slice(0, 200), capacity]
          );
          const containerId = Number(inserted.rows[0].id);

          for (const line of container.lines) {
            await client.query(
              `INSERT INTO factory_container_plan_lines
                 (company_id, plan_id, plan_container_id, article_code, product_name, planned_qty, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
              [companyId, planId, containerId, line.articleCode, line.productName, line.qty]
            );
          }
        }

        await client.query(
          `UPDATE factory_container_plans
           SET revision = revision + 1, updated_at = NOW()
           WHERE id = $1 AND company_id = $2`,
          [planId, companyId]
        );
        await client.query(
          `INSERT INTO audit_log
             (user_id, username, company_id, action, table_name, record_id, record_identifier, changes, created_at)
           VALUES ($1, $2, $3, 'update', 'factory_container_plans', $4, $5, $6::jsonb, NOW())`,
          [
            req.session.userId || "system",
            req.session.username || "unknown",
            companyId,
            planId,
            plan.name,
            JSON.stringify({
              optimize: {
                containerCount: suggestion.containerCount,
                customerContainers: suggestion.customerContainers,
                singleProductContainers: suggestion.singleProductContainers,
                mixedContainers: suggestion.mixedContainers,
                averageFillPercent: Math.round(suggestion.averageFillPercent),
                unservedDemand: suggestion.unservedDemand.length,
              },
            }),
          ]
        );

        await client.query("COMMIT");
        return res.json({ success: true, planId, suggestion });
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        logger.error("[V5] container plan optimizer apply error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      } finally {
        client.release();
      }
    }
  );
}
