import type { Express, Request, Response } from "express";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { firstRow } from "../../../lib/queryResult";
import { getProformaCapacitySnapshot } from "./proformaCapacity";
import { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";
import { evaluateProformaArticleCapacity } from "./proformaCapacityEnforcement";
import {
  advanceSatisfiedPriorityScanConfigs,
  loadActivePriorityRows,
  PRIORITY_SCAN_LOCK_NAMESPACE,
  rewriteActivePriorityQueue,
} from "./priorityScanQueue";
import { customerOrderPriorityScanConfigs, customerOrders, factoryBales } from "@shared/schema";

const MAX_COLOR_LENGTH = 64;
const MAX_PRIORITY = 10_000;
const PRIORITY_SCAN_LIST_PATH = "/api/factory/customer-orders/loading-list/priority-scan-configs";
const PRIORITY_SCAN_ORDER_PATH = "/api/factory/customer-orders/:id/loading-list/priority-scan-config";
const PRIORITY_SCAN_ROUTE_PATH = "/api/factory/customer-orders/loading-list/priority-scan-route";

function normalizeColor(raw: unknown): { color: string; colorKey: string } | null {
  if (typeof raw !== "string") return null;
  const color = raw.trim().replace(/\s+/g, " ");
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

class PriorityScanConfigError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}


export function registerPriorityScanConfigRoutes(app: Express) {
  app.get(PRIORITY_SCAN_ROUTE_PATH, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      await disableStalePriorityScanConfigs(companyId);
      await advanceSatisfiedPriorityScanConfigs(companyId);

      const rawCode = typeof req.query.code === "string" ? req.query.code.trim() : "";
      if (!rawCode) return res.status(400).json({ message: "code is required" });

      const scanLower = rawCode.toLocaleLowerCase("en-US");

      const [bale] = await db
        .select({
          id: factoryBales.id,
          referenceNumber: factoryBales.referenceNumber,
          baleCode: factoryBales.baleCode,
          articleCode: factoryBales.articleCode,
          productName: factoryBales.productName,
          productId: factoryBales.productId,
          erpLocationId: factoryBales.erpLocationId,
          canonicalArticleCode: sql<string | null>`(
            SELECT fbp.article_code
            FROM factory_bale_products fbp
            WHERE fbp.id = ${factoryBales.productId}
              AND fbp.company_id = ${companyId}
            LIMIT 1
          )`,
          canonicalProductName: sql<string | null>`(
            SELECT fbp.name
            FROM factory_bale_products fbp
            WHERE fbp.id = ${factoryBales.productId}
              AND fbp.company_id = ${companyId}
            LIMIT 1
          )`,
        })
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            isNull(factoryBales.deletedAt),
            eq(factoryBales.status, "IN_STOCK"),
            or(
              sql`LOWER(${factoryBales.referenceNumber}) = ${scanLower}`,
              sql`LOWER(${factoryBales.baleCode}) = ${scanLower}`
            )
          )
        )
        .limit(1);

      if (!bale) {
        return res.status(404).json({ message: "Reference is not available in stock." });
      }
      if (!bale.erpLocationId) {
        return res.status(409).json({ message: "Reference has no stock location and cannot be routed." });
      }

      const duplicateCheck = await db.execute(sql`
        SELECT cob.order_id, co.status, co.invoice_number
        FROM customer_order_bales cob
        JOIN customer_orders co ON co.id = cob.order_id
        WHERE cob.bale_id = ${bale.id}
          AND co.status <> 'CANCELLED'
          AND co.deleted_at IS NULL
        ORDER BY cob.order_id
        LIMIT 1
      `);
      const duplicate = firstRow(duplicateCheck);
      if (duplicate) {
        const orderRef = duplicate.invoice_number
          ? `invoice ${duplicate.invoice_number}`
          : `loading #${duplicate.order_id}`;
        return res.status(409).json({
          message: `Bale ${bale.referenceNumber} is already in ${orderRef} (${duplicate.status}).`,
        });
      }

      const effectiveArticleCode = (bale.articleCode || bale.canonicalArticleCode || "").trim();
      if (!effectiveArticleCode) {
        return res.status(409).json({ message: "Reference has no article code and cannot be matched to a priority." });
      }

      const queue = await db
        .select({
          orderId: customerOrderPriorityScanConfigs.orderId,
          color: customerOrderPriorityScanConfigs.color,
          priority: customerOrderPriorityScanConfigs.priority,
          proformaIdUsed: customerOrders.proformaIdUsed,
        })
        .from(customerOrderPriorityScanConfigs)
        .innerJoin(customerOrders, eq(customerOrders.id, customerOrderPriorityScanConfigs.orderId))
        .where(
          and(
            eq(customerOrderPriorityScanConfigs.companyId, companyId),
            eq(customerOrderPriorityScanConfigs.enabled, true),
            eq(customerOrders.companyId, companyId),
            eq(customerOrders.status, "LOADING"),
            isNull(customerOrders.deletedAt)
          )
        )
        .orderBy(asc(customerOrderPriorityScanConfigs.priority), asc(customerOrderPriorityScanConfigs.orderId));

      const candidates: Array<{
        orderId: number;
        priority: number;
        color: string;
        proformaId: number;
        remainingQty: number;
      }> = [];

      for (const row of queue) {
        if (!row.proformaIdUsed) continue;
        const snapshot = await getProformaCapacitySnapshot(db, {
          companyId,
          proformaId: row.proformaIdUsed,
          currentOrderId: row.orderId,
        });
        if (!snapshot) continue;
        const decision = evaluateProformaArticleCapacity(snapshot, effectiveArticleCode, 1, "per_loading");
        if (!decision.allowed) continue;
        candidates.push({
          orderId: row.orderId,
          priority: row.priority,
          color: row.color,
          proformaId: row.proformaIdUsed,
          remainingQty: decision.remainingQty,
        });
      }

      if (candidates.length === 0) {
        return res.status(409).json({
          message: "This reference is not required by any active Priority Scan loading.",
          referenceNumber: bale.referenceNumber,
          articleCode: effectiveArticleCode,
        });
      }

      return res.json({
        referenceNumber: bale.referenceNumber,
        baleId: bale.id,
        productName: bale.canonicalProductName || bale.productName || null,
        articleCode: effectiveArticleCode,
        locationId: bale.erpLocationId,
        target: candidates[0],
        candidates,
      });
    } catch (error: unknown) {
      logger.error("Error resolving Priority Scan route", { error: getErrorMessage(error) });
      return res.status(500).json({ message: "Failed to resolve Priority Scan destination." });
    }
  });

  app.get(PRIORITY_SCAN_LIST_PATH, requireAuth, async (req: Request, res: Response) => {
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

  app.put(PRIORITY_SCAN_ORDER_PATH, requireAuth, async (req: Request, res: Response) => {
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

      const actorId = req.session.userId == null ? null : String(req.session.userId);
      const actorName = String(req.session.username ?? req.session.userId ?? "unknown");

      const saved = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);

        const [order] = await tx
          .select({
            id: customerOrders.id,
            status: customerOrders.status,
            proformaIdUsed: customerOrders.proformaIdUsed,
          })
          .from(customerOrders)
          .where(
            and(
              eq(customerOrders.id, orderId),
              eq(customerOrders.companyId, companyId),
              isNull(customerOrders.deletedAt)
            )
          )
          .limit(1);

        if (!order) throw new PriorityScanConfigError(404, "Pending loading not found.");
        if (order.status !== "LOADING") {
          throw new PriorityScanConfigError(409, "Only pending loadings in LOADING status can use Priority Scan.");
        }
        if (enabled && !order.proformaIdUsed) {
          throw new PriorityScanConfigError(409, "Link a proforma before enabling Priority Scan for this loading.");
        }
        if (enabled && order.proformaIdUsed) {
          await acquireProformaCapacityTransactionLock(tx, {
            companyId,
            proformaId: order.proformaIdUsed,
          });
          const snapshot = await getProformaCapacitySnapshot(tx, {
            companyId,
            proformaId: order.proformaIdUsed,
            currentOrderId: orderId,
          });
          if (snapshot && snapshot.requestedTotalQty > 0 && snapshot.remainingTotalQty <= 0) {
            throw new PriorityScanConfigError(
              409,
              "This loading already satisfies its linked proforma and does not need Priority Scan."
            );
          }
        }

        const existing = await tx
          .select({
            id: customerOrderPriorityScanConfigs.id,
            createdBy: customerOrderPriorityScanConfigs.createdBy,
            createdByName: customerOrderPriorityScanConfigs.createdByName,
            enabled: customerOrderPriorityScanConfigs.enabled,
          })
          .from(customerOrderPriorityScanConfigs)
          .where(
            and(
              eq(customerOrderPriorityScanConfigs.companyId, companyId),
              eq(customerOrderPriorityScanConfigs.orderId, orderId)
            )
          )
          .limit(1);

        const activeRows = await loadActivePriorityRows(tx, companyId);
        if (
          enabled &&
          activeRows.some((row) => row.orderId !== orderId && row.colorKey === normalizedColor.colorKey)
        ) {
          throw new PriorityScanConfigError(
            409,
            "That color is already assigned to another active priority loading."
          );
        }

        // Temporarily keep the target disabled while the active queue is rewritten.
        // This releases the partial unique indexes so moving #2 to #1 can be done
        // atomically without transient duplicate-priority failures.
        const [target] = await tx
          .insert(customerOrderPriorityScanConfigs)
          .values({
            companyId,
            orderId,
            color: normalizedColor.color,
            colorKey: normalizedColor.colorKey,
            priority,
            enabled: false,
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
              enabled: false,
              updatedBy: actorId,
              updatedByName: actorName,
              updatedAt: sql`now()`,
            },
          })
          .returning();

        const remainingActiveIds = activeRows.filter((row) => row.orderId !== orderId).map((row) => row.id);

        if (enabled) {
          const insertAt = Math.min(Math.max(priority - 1, 0), remainingActiveIds.length);
          const orderedIds = [...remainingActiveIds];
          orderedIds.splice(insertAt, 0, target.id);
          await rewriteActivePriorityQueue(tx, companyId, orderedIds, actorId, actorName);
        } else if (existing[0]?.enabled) {
          await rewriteActivePriorityQueue(tx, companyId, remainingActiveIds, actorId, actorName);
        }

        const [result] = await tx
          .select()
          .from(customerOrderPriorityScanConfigs)
          .where(
            and(
              eq(customerOrderPriorityScanConfigs.companyId, companyId),
              eq(customerOrderPriorityScanConfigs.orderId, orderId)
            )
          )
          .limit(1);
        return result;
      });

      return res.json(saved);
    } catch (error: unknown) {
      if (error instanceof PriorityScanConfigError) {
        return res.status(error.status).json({ message: error.message });
      }
      const constraint = uniqueConstraint(error);
      if (constraint) return sendPriorityConflict(res, constraint);
      logger.error("Error saving Priority Scan config", { error: getErrorMessage(error) });
      return res.status(500).json({ message: "Failed to save Priority Scan configuration." });
    }
  });

  app.delete(
    "/api/factory/customer-orders/:id/loading-list/priority-scan-config",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const orderId = parseId(req.params.id);
        if (orderId === null) return res.status(400).json({ message: "Invalid loading id" });

        const actorId = req.session.userId == null ? null : String(req.session.userId);
        const actorName = String(req.session.username ?? req.session.userId ?? "unknown");

        const cleared = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);

          const activeRows = await loadActivePriorityRows(tx, companyId);
          const targetWasActive = activeRows.some((row) => row.orderId === orderId);

          const deleted = await tx
            .delete(customerOrderPriorityScanConfigs)
            .where(
              and(
                eq(customerOrderPriorityScanConfigs.companyId, companyId),
                eq(customerOrderPriorityScanConfigs.orderId, orderId)
              )
            )
            .returning({ id: customerOrderPriorityScanConfigs.id });

          if (targetWasActive) {
            const remainingIds = activeRows.filter((row) => row.orderId !== orderId).map((row) => row.id);
            await rewriteActivePriorityQueue(tx, companyId, remainingIds, actorId, actorName);
          }

          return deleted.length > 0;
        });

        return res.json({ success: true, cleared });
      } catch (error: unknown) {
        logger.error("Error clearing Priority Scan config", { error: getErrorMessage(error) });
        return res.status(500).json({ message: "Failed to clear Priority Scan configuration." });
      }
    }
  );

}
