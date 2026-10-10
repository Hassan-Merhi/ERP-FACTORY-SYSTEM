/**
 * Phase 2: immutable Priority Scan allocation timeline.
 *
 * The active queue is intentionally NOT joined: changing a loading's current
 * priority/color must not rewrite which loading originally received a bale.
 * Reversed assignments remain visible with their original details.
 */
import type { Express, Request, Response } from "express";
import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";

import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { factoryPriorityScanHistory } from "@shared/schema";

const HISTORY_PATH = "/api/factory/customer-orders/loading-list/priority-allocation-history";
const MAX_PAGE_SIZE = 100;

function optionalId(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : NaN;
}

export function registerPriorityAllocationHistoryRoutes(app: Express): void {
  app.get(HISTORY_PATH, requireAuth, async (req: Request, res: Response) => {
    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    const baleId = optionalId(req.query.baleId);
    const orderId = optionalId(req.query.orderId);
    const beforeId = optionalId(req.query.beforeId);
    const referenceNumber = typeof req.query.referenceNumber === "string" ? req.query.referenceNumber.trim() : "";
    const rawLimit = req.query.limit;
    const limit =
      rawLimit === undefined
        ? 50
        : typeof rawLimit === "string" && /^[1-9][0-9]*$/.test(rawLimit)
          ? Number(rawLimit)
          : NaN;

    if (
      [baleId, orderId, beforeId].some((id) => id !== null && !Number.isSafeInteger(id)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE_SIZE ||
      referenceNumber.length > 100 ||
      (req.query.referenceNumber !== undefined && !referenceNumber)
    ) {
      return res.status(400).json({ message: "Invalid history filter or limit" });
    }
    if (baleId === null && orderId === null && !referenceNumber) {
      return res.status(400).json({ message: "Specify baleId, orderId, or referenceNumber" });
    }

    const filters: SQL[] = [eq(factoryPriorityScanHistory.companyId, companyId)];
    if (baleId != null) filters.push(eq(factoryPriorityScanHistory.baleId, baleId));
    if (orderId != null) filters.push(eq(factoryPriorityScanHistory.orderId, orderId));
    if (beforeId != null) filters.push(lt(factoryPriorityScanHistory.id, beforeId));
    if (referenceNumber) {
      filters.push(sql`LOWER(${factoryPriorityScanHistory.referenceNumber}) = ${referenceNumber.toLowerCase()}`);
    }

    try {
      const rows = await db
        .select({
          id: factoryPriorityScanHistory.id,
          baleId: factoryPriorityScanHistory.baleId,
          orderId: factoryPriorityScanHistory.orderId,
          referenceNumber: factoryPriorityScanHistory.referenceNumber,
          articleCode: factoryPriorityScanHistory.articleCode,
          productName: factoryPriorityScanHistory.productName,
          originalPriority: factoryPriorityScanHistory.priority,
          originalColor: factoryPriorityScanHistory.color,
          originalProformaId: factoryPriorityScanHistory.proformaId,
          allocationSource: factoryPriorityScanHistory.allocationSource,
          assignedByName: factoryPriorityScanHistory.scannedBy,
          assignedByUserId: factoryPriorityScanHistory.assignedByUserId,
          businessDate: factoryPriorityScanHistory.businessDate,
          assignedAt: factoryPriorityScanHistory.scannedAt,
          reversedAt: factoryPriorityScanHistory.reversedAt,
          reversedBy: factoryPriorityScanHistory.reversedBy,
          reversedByUserId: factoryPriorityScanHistory.reversedByUserId,
          reversalReason: factoryPriorityScanHistory.reversalReason,
        })
        .from(factoryPriorityScanHistory)
        .where(and(...filters))
        .orderBy(desc(factoryPriorityScanHistory.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      res.set("Cache-Control", "private, no-store");
      return res.json({
        items: page.map((row) => ({ ...row, active: row.reversedAt === null })),
        nextCursor: hasMore ? String(page[page.length - 1].id) : null,
      });
    } catch (error) {
      logger.error("Failed to fetch Priority Scan allocation history", { error: getErrorMessage(error) });
      return res.status(500).json({ message: "Failed to load Priority Scan allocation history" });
    }
  });
}
