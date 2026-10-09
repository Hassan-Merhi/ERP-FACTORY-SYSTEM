import type { Express, NextFunction, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireAuth, requireNonPOS } from "../../auth";
import { requireActionAccess } from "../../lib/permissionMiddleware";
import { db } from "../../db";
import { locations } from "@shared/schema";
import { logAudit } from "../_helpers";
import { sendRevisedTransferWhatsApp } from "../../helpers/sendRevisedTransferWhatsApp";
import {
  approvePendingStockTransferRevision,
  savePendingStockTransferRevision,
} from "../../services/stockTransferRevisionLifecycle";
import { sendBaleMirrorMovementRefusal } from "../../services/accounting/perpetualInventory/cutoverRefusal";

const pendingRevisionSchema = z.object({
  note: z.string().optional().nullable(),
  optional: z.literal(true),
  items: z
    .array(
      z.object({
        stockItemId: z.coerce.number().int().positive(),
        stockItemName: z.string().min(1),
        sourceLocationId: z.coerce.number().int().positive(),
        sourceLocationName: z.string().optional().nullable(),
        originalQuantity: z.coerce.number().nonnegative(),
        newQuantity: z.coerce.number().nonnegative(),
        delta: z.coerce.number().optional(),
      })
    )
    .min(1),
});

function errorStatus(error: unknown): number {
  const code = String((error as { code: unknown })?.code ?? "");
  const message = String((error as { message: unknown })?.message ?? "");
  if (
    code === "STOCK_TRANSFER_INSUFFICIENT_STOCK" ||
    code === "STOCK_TRANSFER_DESTINATION_STOCK_CONFLICT" ||
    code === "STOCK_TRANSFER_REVISION_STALE"
  ) {
    return 409;
  }
  if (/different company|own source location/i.test(message)) return 403;
  if (
    /required|positive|non-negative|different|missing|deleted|not found|not a stock transfer|inactive|no effective/i.test(
      message
    )
  ) {
    return 400;
  }
  return 500;
}

function sendError(res: Response, error: unknown, context: string) {
  // Wave 15: a factory bale-mirror item after the cut-over (409, translated).
  if (sendBaleMirrorMovementRefusal(res, error)) return res;
  const status = errorStatus(error);
  if (status === 500) logger.error(`[StockTransferRevisionLifecycle ${context}]`, { error: error });
  const payload: Record<string, unknown> = {
    message: String(
      (error as { message: unknown })?.message ?? `Failed to ${context.toLowerCase()} stock transfer revision`
    ),
  };
  for (const field of ["code", "stockItemId", "sourceLocationId", "requiredQuantity", "availableQuantity"]) {
    if ((error as { [key: string]: undefined })?.[field] !== undefined)
      payload[field] = (error as { [key: string]: unknown })[field];
  }
  return res.status(status).json(payload);
}

export function registerStockTransferRevisionLifecycleRoutes(app: Express) {
  /**
   * Optional POS revisions are exact pending snapshots. Registering this before
   * the legacy route prevents the old update-then-insert flow from duplicating
   * revision rows every time a user edits an existing pending revision.
   */
  app.post(
    "/api/stock-transfers/:transferId/revisions",
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      if (req.body?.optional !== true) return next();

      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const transferId = Number(req.params.transferId);
        if (!Number.isInteger(transferId) || transferId <= 0) {
          return res.status(400).json({ message: "Transfer ID is required" });
        }
        const userId = String(req.user?.id ?? req.session.userId ?? "");
        if (!userId) return res.status(401).json({ message: "User session is required" });

        const parsed = pendingRevisionSchema.parse(req.body);
        const role = req.user?.role ?? req.session.currentRole;
        const assignedLocationId =
          role === "POS" ? Number(req.user?.assignedLocationId ?? req.session.currentLocationId ?? 0) || null : null;
        if (role === "POS" && !assignedLocationId) {
          return res.status(403).json({ message: "POS user has no assigned source location" });
        }

        const result = await savePendingStockTransferRevision({
          companyId,
          transferId,
          userId,
          note: parsed.note,
          sourceLocationIdLimit: assignedLocationId,
          items: parsed.items.map((item) => ({
            stockItemId: item.stockItemId,
            stockItemName: item.stockItemName,
            sourceLocationId: item.sourceLocationId,
            sourceLocationName: item.sourceLocationName,
            originalQuantity: item.originalQuantity,
            newQuantity: item.newQuantity,
          })),
        });

        try {
          await logAudit({
            userId,
            username: req.session.username || req.user?.username || "unknown",
            companyId,
            action: "update",
            tableName: "stock_transfer_revisions",
            recordId: result.revisionId,
            recordIdentifier: `transfer-${result.transferId}-revision-${result.revisionNumber}`,
            changes: {
              status: { old: "pending", new: "pending" },
              itemCount: { old: null, new: result.itemCount },
              note: { old: null, new: parsed.note || null },
            },
          });
        } catch {
          // Revision persistence must not fail because audit logging is unavailable.
        }

        res.json({
          id: result.revisionId,
          transferId: result.transferId,
          revisionNumber: result.revisionNumber,
          optional: true,
          items: result.items,
        });

        setImmediate(async () => {
          try {
            const firstItem = result.items[0];
            if (!firstItem?.sourceLocationId) return;
            const [destination] = await db
              .select({ name: locations.name })
              .from(locations)
              .where(eq(locations.id, result.destinationLocationId))
              .limit(1);
            const sourceName = firstItem.sourceLocationName || `Location ${firstItem.sourceLocationId}`;
            await sendRevisedTransferWhatsApp({
              sourceLocationId: firstItem.sourceLocationId,
              sourceLocationName: sourceName,
              destLocationName: destination?.name ?? "Unknown",
              items: result.items.map((item) => ({
                stockItemId: item.stockItemId,
                stockItemName: item.stockItemName,
                originalQuantity: Number(item.originalQuantity),
                delta: Number(item.delta),
                newQuantity: Number(item.newQuantity),
              })),
              voucherNumber: result.voucherNumber,
              voucherDate: result.voucherDate,
            });
          } catch (error: unknown) {
            logger.error("[RevisedTransferWA] Failed to send safe pending revision:", {
              error: getErrorMessage(error),
            });
          }
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ message: "Invalid revision data", errors: error.issues });
        }
        return sendError(res, error, "Save");
      }
    }
  );

  /**
   * Locks all pending revisions, the transfer and inventory rows. A second
   * concurrent approval sees no pending rows and returns a no-op.
   */
  app.post(
    "/api/stock-transfer-revisions/:id/approve",
    requireAuth,
    requireNonPOS,
    requireActionAccess("act_transfer_stock"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const revisionId = Number(req.params.id);
        if (!Number.isInteger(revisionId) || revisionId <= 0) {
          return res.status(400).json({ message: "Revision ID is required" });
        }

        const result = await approvePendingStockTransferRevision(companyId, revisionId);
        try {
          await logAudit({
            userId: String(req.user?.id ?? req.session.userId ?? "unknown"),
            username: req.session.username || req.user?.username || "unknown",
            companyId,
            action: "update",
            tableName: "stock_transfer_revisions",
            recordId: revisionId,
            recordIdentifier: `transfer-${result.transferId}-revision-approval`,
            changes: {
              status: { old: "pending", new: result.transition },
              approvedRevisionCount: { old: 0, new: result.approvedRevisionCount },
              changedItemCount: { old: 0, new: result.changedItemCount },
              totalAmount: { old: null, new: result.totalAmount },
            },
          });
        } catch {
          // Approval is already committed; audit failure remains non-fatal.
        }

        return res.json({ success: true, ...result });
      } catch (error) {
        return sendError(res, error, "Approve");
      }
    }
  );
}
