import type { Express, Request, Response } from "express";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { customerOrderPriorityScanConfigs, customerOrders } from "@shared/schema";

const MAX_COLOR_LENGTH = 64;
const MAX_PRIORITY = 10_000;

function normalizeColor(raw: unknown): { color: string; colorKey: string } | null {
  if (typeof raw !== "string") return null;
  const color = raw.trim().replace(/\\s+/g, " ");
  if (!color || color.length > MAX_COLOR_LENGTH) return null;
  return { color, colorKey: color.toLocaleLowerCase("en-US") };
}

function parsePriority(raw: unknown): number | null {
  const priority = typeof raw === "number" ? raw : Number(raw);
  return Number.isSafeInteger(priority) && priority > 0 && priority <= MAX_PRIORITY ? priority : null;
}

function uniqueConstraint(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: unknown; constraint?: unknown };
  return value.code === "23505" && typeof value.constraint === "string" ? value.constraint : null;
}

function sendPriorityConflict(res: Response, constraint: string | null) {
  if (constraint === "copsc_active_color_unique") {
    return res.status(409).json({ message: "That color is already assigned to another active priority loading." });
  }
  if (constraint === "copsc_active_priority_unique") {
    return res.status(409).json({ message: "That priority is already assigned to another active priority loading." });
  }
  return res.status(409).json({ message: "Priority Scan configuration changed at the same time. Please try again." });
}

async function disableStalePriorityScanConfigs(companyId: number): Promise<void> {
  // A finished/cancelled/deleted loading must never keep a color or priority
  // reserved forever. Cleanup runs before queue reads and writes so the active
  // uniqueness constraints continue to describe the pending-loading queue.
  await db.execute(sql`
    UPDATE customer_order_priority_scan_configs AS config
    SET enabled = FALSE,
        updated_by = NULL,
        updated_by_name = 'system',
        updated_at = now()
    FROM customer_orders AS order_row
    WHERE config.order_id = order_row.id
      AND config.company_id = ${companyId}
      AND order_row.company_id = ${companyId}
      AND config.enabled = TRUE
      AND (order_row.status <> 'LOADING' OR order_row.deleted_at IS NOT NULL)
  `);
}

export function registerPriorityScanConfigRoutes(app: Express) {
  app.get("/api/factory/customer-orders/priority-scan-configs", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      await disableStalePriorityScanConfigs(companyId);

      const rows = await db
        .select({
          id: customerOrderPriorityScanConfigs.id,
          companyId: customerOrderPriorityScanConfigs.companyId,
          orderId: customerOrderPriorityScanConfigs.orderId,
          color: customerOrderPriorityScanConfigs.color,
          priority: customerOrderPriorityScanConfigs.priority,
          enabled: customerOrderPriorityScanConfigs.enabled,
          createdBy: customerOrderPriorityScanConfigs.createdBy,
          createdByName: customerOrderPriorityScanConfigs.createdByName,
          updatedBy: customerOrderPriorityScanConfigs.updatedBy,
          updatedByName: customerOrderPriorityScanConfigs.updatedByName,
          createdAt: customerOrderPriorityScanConfigs.createdAt,
          updatedAt: customerOrderPriorityScanConfigs.updatedAt,
          orderStatus: customerOrders.status,
          proformaIdUsed: customerOrders.proformaIdUsed,
        })
        .from(customerOrderPriorityScanConfigs)
        .innerJoin(customerOrders, eq(customerOrders.id, customerOrderPriorityScanConfigs.orderId))
        .where(
          and(
            eq(customerOrderPriorityScanConfigs.companyId, companyId),
            eq(customerOrders.companyId, companyId),
            isNull(customerOrders.deletedAt)
          )
        )
        .orderBy(asc(customerOrderPriorityScanConfigs.priority), asc(customerOrderPriorityScanConfigs.orderId));

      return res.json(rows);
    } catch (error: unknown) {
      logger.error("Error listing Priority Scan configs", { error: getErrorMessage(error) });
      return res.status(500).json({ message: "Failed to load Priority Scan configuration." });
    }
  });

  app.put("/api/factory/customer-orders/:id/priority-scan-config", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      await disableStalePriorityScanConfigs(companyId);

      const orderId = parseId(req.params.id);
      if (orderId === null) return res.status(400).json({ message: "Invalid loading id" });

      const normalizedColor = normalizeColor(req.body?.color);
      if (!normalizedColor) {
        return res.status(400).json({ message: "Color is required and must be 64 characters or fewer." });
      }

      const priority = parsePriority(req.body?.priority);
      if (priority === null) {
        return res.status(400).json({ message: "Priority must be a whole number between 1 and 10000." });
      }

      if (req.body?.enabled !== undefined && typeof req.body.enabled !== "boolean") {
        return res.status(400).json({ message: "enabled must be true or false." });
      }
      const enabled = req.body?.enabled !== false;

      const [order] = await db
        .select({
          id: customerOrders.id,
          status: customerOrders.status,
          proformaIdUsed: customerOrders.proformaIdUsed,
        })
        .from(customerOrders)
        .where(
          and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt))
        )
        .limit(1);

      if (!order) return res.status(404).json({ message: "Pending loading not found." });
      if (order.status !== "LOADING") {
        return res.status(409).json({ message: "Only pending loadings in LOADING status can use Priority Scan." });
      }
      if (enabled && !order.proformaIdUsed) {
        return res.status(409).json({ message: "Link a proforma before enabling Priority Scan for this loading." });
      }

      const actorId = req.session.userId ?? null;
      const actorName = req.session.username ?? actorId ?? "unknown";
      const existing = await db
        .select({ id: customerOrderPriorityScanConfigs.id, createdBy: customerOrderPriorityScanConfigs.createdBy, createdByName: customerOrderPriorityScanConfigs.createdByName })
        .from(customerOrderPriorityScanConfigs)
        .where(
          and(
            eq(customerOrderPriorityScanConfigs.companyId, companyId),
            eq(customerOrderPriorityScanConfigs.orderId, orderId)
          )
        )
        .limit(1);

      const [saved] = await db
        .insert(customerOrderPriorityScanConfigs)
        .values({
          companyId,
          orderId,
          color: normalizedColor.color,
          colorKey: normalizedColor.colorKey,
          priority,
          enabled,
          createdBy: existing[0]?.createdBy ?? actorId,
          createdByName: existing[0]?.createdByName ?? actorName,
          updatedBy: actorId,
          updatedByName: actorName,
        })
        .onConflictDoUpdate({
          target: [customerOrderPriorityScanConfigs.companyId, customerOrderPriorityScanConfigs.orderId],
          set: {
            color: normalizedColor.color,
            colorKey: normalizedColor.colorKey,
            priority,
            enabled,
            updatedBy: actorId,
            updatedByName: actorName,
            updatedAt: sql`now()`,
          },
        })
        .returning();

      return res.json(saved);
    } catch (error: unknown) {
      const constraint = uniqueConstraint(error);
      if (constraint) return sendPriorityConflict(res, constraint);
      logger.error("Error saving Priority Scan config", { error: getErrorMessage(error) });
      return res.status(500).json({ message: "Failed to save Priority Scan configuration." });
    }
  });

  app.delete(
    "/api/factory/customer-orders/:id/priority-scan-config",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const orderId = parseId(req.params.id);
        if (orderId === null) return res.status(400).json({ message: "Invalid loading id" });

        const deleted = await db
          .delete(customerOrderPriorityScanConfigs)
          .where(
            and(
              eq(customerOrderPriorityScanConfigs.companyId, companyId),
              eq(customerOrderPriorityScanConfigs.orderId, orderId)
            )
          )
          .returning({ id: customerOrderPriorityScanConfigs.id });

        return res.json({ success: true, cleared: deleted.length > 0 });
      } catch (error: unknown) {
        logger.error("Error clearing Priority Scan config", { error: getErrorMessage(error) });
        return res.status(500).json({ message: "Failed to clear Priority Scan configuration." });
      }
    }
  );
}
