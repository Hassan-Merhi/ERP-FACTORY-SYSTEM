import type { Express, Request, Response } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";

import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { getProformaCapacitySnapshot } from "./proformaCapacity";
import { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";
import { loadActivePriorityRows, PRIORITY_SCAN_LOCK_NAMESPACE, rewriteActivePriorityQueue } from "./priorityScanQueue";
import { customerOrderPriorityScanConfigs, customerOrders } from "@shared/schema";
import {
  PRIORITY_SCAN_ORDER_PATH,
  PriorityScanConfigError,
  canManagePriorityPosition,
  disableStalePriorityScanConfigs,
  normalizeColor,
  parsePriority,
  sendPriorityConflict,
  uniqueConstraint,
} from "./disableStalePriorityScanConfigs";
import { registerPriorityScanConfigRoutesPart1 } from "./registerPriorityScanConfigRoutesPart1";
import { z } from "zod";
import { emptyBody, emptyQuery, idParams, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";

// The Priority Scan control sends { color?, enabled: true, priority? }. The
// handler keeps its approved-colour, priority-range and admin-only checks.
const savePriorityScanConfigInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    color: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    priority: z.union([z.number(), z.string()]).nullable().optional(),
  }),
} satisfies RequestSchemas;

const clearPriorityScanConfigInput = { params: idParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerPriorityScanConfigRoutes(app: Express) {
  registerPriorityScanConfigRoutesPart1(app);
  registerPriorityScanConfigRoutesPart2(app);
}

function registerPriorityScanConfigRoutesPart2(app: Express) {
  app.put(
    PRIORITY_SCAN_ORDER_PATH,
    requireAuth,
    validateRequest(savePriorityScanConfigInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        await disableStalePriorityScanConfigs(companyId);

        const orderId = parseId(req.params.id);
        if (orderId === null) return res.status(400).json({ message: "Invalid loading id" });

        // An existing legacy priority may be moved without recoloring it.
        // Every create, re-enable or color edit still requires an approved color.
        const moveOnly = req.body?.color === undefined && req.body?.enabled === true;
        const normalizedRequestedColor = moveOnly ? null : normalizeColor(req.body?.color);
        if (!moveOnly && !normalizedRequestedColor) {
          return res.status(400).json({ message: "Priority color must be one of the 11 approved HEX colors." });
        }

        const canManagePriority = canManagePriorityPosition(req);
        if (moveOnly && !canManagePriority) {
          return res.status(403).json({ code: "PRIORITY_POSITION_ADMIN_ONLY", message: "Access denied" });
        }
        if (!canManagePriority && req.body?.priority !== undefined) {
          return res.status(403).json({ code: "PRIORITY_POSITION_ADMIN_ONLY", message: "Access denied" });
        }

        const requestedPriority = canManagePriority ? parsePriority(req.body?.priority) : null;
        if (canManagePriority && requestedPriority === null) {
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
              priority: customerOrderPriorityScanConfigs.priority,
              color: customerOrderPriorityScanConfigs.color,
              colorKey: customerOrderPriorityScanConfigs.colorKey,
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

          if (moveOnly && !existing[0]?.enabled) {
            throw new PriorityScanConfigError(
              409,
              "Only an existing active priority can be moved without choosing a new color."
            );
          }
          const normalizedColor = moveOnly
            ? { color: existing[0]!.color, colorKey: existing[0]!.colorKey }
            : normalizedRequestedColor!;

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

          const remainingActiveIds = activeRows.filter((row) => row.orderId !== orderId).map((row) => row.id);
          const effectivePriority = canManagePriority
            ? requestedPriority!
            : existing[0]?.enabled
              ? existing[0].priority
              : remainingActiveIds.length + 1;

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
              priority: effectivePriority,
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
                priority: effectivePriority,
                enabled: false,
                updatedBy: actorId,
                updatedByName: actorName,
                updatedAt: sql`now()`,
              },
            })
            .returning();

          if (enabled) {
            const insertAt = Math.min(Math.max(effectivePriority - 1, 0), remainingActiveIds.length);
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
    }
  );

  app.delete(
    "/api/factory/customer-orders/:id/loading-list/priority-scan-config",
    requireAuth,
    validateRequest(clearPriorityScanConfigInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!canManagePriorityPosition(req)) {
          return res.status(403).json({ code: "PRIORITY_POSITION_ADMIN_ONLY", message: "Access denied" });
        }

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
