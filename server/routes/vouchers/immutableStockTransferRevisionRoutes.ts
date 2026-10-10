import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requireNonPOS } from "../../auth";
import { requireActionAccess } from "../../lib/permissionMiddleware";
import { logger } from "../../lib/logger";
import { logAudit } from "../_helpers";
import {
  approveImmutableStockTransferRevision,
  createImmutableStockTransferRevision,
  listImmutableStockTransferRevisions,
  rejectImmutableStockTransferRevision,
  resolveTransferIdByVoucher,
  type ImmutableRevisionResult,
} from "../../services/immutableStockTransferRevisionLifecycle";
import { sendRevisedTransferWhatsApp } from "../../helpers/sendRevisedTransferWhatsApp";
import { getErrorMessage } from "../../lib/httpHandlers";
import { sendBaleMirrorMovementRefusal } from "../../services/accounting/perpetualInventory/cutoverRefusal";

const revisionSchema = z.object({
  note: z.string().optional().nullable(),
  optional: z.boolean().optional().default(false),
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

const rejectionSchema = z.object({ reason: z.string().trim().max(1000).optional().nullable() });

function userId(req: Request): string {
  return String(req.user?.id ?? req.session.userId ?? "").trim();
}

function statusForError(error: unknown): number {
  const code = String((error as { code: unknown })?.code ?? "");
  const message = String((error as { message: unknown })?.message ?? "");
  if (code === "STOCK_TRANSFER_REVISION_SCOPE") return 403;
  if (
    code === "STOCK_TRANSFER_REVISION_STALE" ||
    code === "STOCK_TRANSFER_REVISION_DUPLICATE" ||
    code === "STOCK_TRANSFER_REVISION_STATUS" ||
    code === "STOCK_TRANSFER_INSUFFICIENT_STOCK" ||
    code === "STOCK_TRANSFER_DESTINATION_STOCK_CONFLICT"
  ) {
    return 409;
  }
  if (/not found/i.test(message)) return 404;
  if (/required|positive|non-negative|different|missing|deleted|inactive|duplicate|no effective/i.test(message)) {
    return 400;
  }
  return 500;
}

function sendError(res: Response, error: unknown, context: string) {
  // Wave 15: a factory bale-mirror item after the cut-over (409, translated).
  if (sendBaleMirrorMovementRefusal(res, error)) return res;
  const status = statusForError(error);
  if (status === 500) logger.error(`[ImmutableStockTransferRevision ${context}]`, { error });
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

/**
 * Post the revised-transfer image to the WhatsApp group configured for the
 * transfer's destination, mirroring what creating the transfer itself sends.
 * Fire-and-forget: a WhatsApp outage must never fail the revision that was
 * already committed.
 */
function revisionItemsForAudit(items: ImmutableRevisionResult["items"]) {
  return items.map((item) => ({
    stockItemId: Number(item.stockItemId),
    stockItemName: String(item.stockItemName || `Item #${item.stockItemId}`),
    sourceLocationId: Number(item.sourceLocationId || 0),
    sourceLocationName: item.sourceLocationName ? String(item.sourceLocationName) : null,
    originalQuantity: Number(item.originalQuantity || 0),
    newQuantity: Number(item.newQuantity || 0),
    delta: Number(item.delta || 0),
  }));
}

function queueRevisedTransferWhatsApp(result: ImmutableRevisionResult) {
  // Only revisions submitted for review (POS adjustments) are broadcast, the
  // same set the legacy handler sent before the immutable routes took over.
  if (!result.optional) return;

  const items = result.items
    .map((item) => ({
      stockItemId: Number(item.stockItemId),
      stockItemName: item.stockItemName ?? null,
      originalQuantity: Number(item.originalQuantity) || 0,
      delta: Number(item.delta) || 0,
      newQuantity: Number(item.newQuantity) || 0,
    }))
    .filter((item) => item.stockItemId > 0);
  if (items.length === 0) return;

  const sourceLocationId = Number(result.items.find((item) => item.sourceLocationId)?.sourceLocationId ?? 0);

  setImmediate(async () => {
    try {
      await sendRevisedTransferWhatsApp({
        sourceLocationId,
        sourceLocationName: result.sourceLocationName,
        destinationLocationId: result.destinationLocationId,
        destLocationName: result.destinationLocationName,
        items,
        voucherNumber: result.voucherNumber,
        voucherDate: result.voucherDate,
      });
    } catch (error) {
      logger.error("[RevisedTransferWA] Failed to send revision image", { error: getErrorMessage(error) });
    }
  });
}

async function auditRevision(
  req: Request,
  companyId: number,
  revisionId: number,
  identifier: string,
  action: "create" | "update" | "approve",
  changes: Record<string, { old?: unknown; new?: unknown }>
) {
  await logAudit({
    userId: userId(req) || "unknown",
    username: req.session.username || req.user?.username || "unknown",
    companyId,
    action,
    tableName: "stock_transfer_revisions",
    recordId: revisionId,
    recordIdentifier: identifier,
    changes,
  });
}

/**
 * Register before the legacy revision handlers. These routes own the immutable
 * lifecycle while preserving the existing public endpoint paths.
 */
export function registerImmutableStockTransferRevisionRoutes(app: Express) {
  app.post("/api/stock-transfers/:transferId/revisions", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const transferId = Number(req.params.transferId);
      if (!Number.isInteger(transferId) || transferId <= 0) {
        return res.status(400).json({ message: "Transfer ID is required" });
      }
      const actorId = userId(req);
      if (!actorId) return res.status(401).json({ message: "User session is required" });

      const parsed = revisionSchema.parse(req.body);
      const role = req.user?.role ?? req.session.currentRole;
      if (role === "POS" && parsed.optional !== true) {
        return res.status(403).json({ message: "POS users may only submit revisions for admin review" });
      }
      const assignedLocationId =
        role === "POS" ? Number(req.user?.assignedLocationId ?? req.session.currentLocationId ?? 0) || null : null;
      if (role === "POS" && !assignedLocationId) {
        return res.status(403).json({ message: "POS user has no assigned source location" });
      }

      const result = await createImmutableStockTransferRevision({
        companyId,
        transferId,
        userId: actorId,
        note: parsed.note,
        pending: parsed.optional,
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

      await auditRevision(
        req,
        companyId,
        result.revisionId,
        `transfer-${result.transferId}-revision-${result.revisionNumber}`,
        "create",
        {
          revisionNumber: { new: result.revisionNumber },
          status: { new: result.status },
          note: { new: parsed.note?.trim() || null },
          itemCount: { new: result.itemCount },
          route: {
            new: `${result.sourceLocationName} -> ${result.destinationLocationName}`,
          },
          items: { new: revisionItemsForAudit(result.items) },
        }
      );

      queueRevisedTransferWhatsApp(result);

      return res.status(201).json({
        id: result.revisionId,
        transferId: result.transferId,
        revisionNumber: result.revisionNumber,
        status: result.status,
        optional: result.optional,
        sourceLocationName: result.sourceLocationName,
        destinationLocationName: result.destinationLocationName,
        items: result.items,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid revision data", errors: error.issues });
      }
      return sendError(res, error, "Create");
    }
  });

  app.get("/api/stock-transfers/by-voucher/:voucherId/revisions", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const voucherId = Number(req.params.voucherId);
      if (!Number.isInteger(voucherId) || voucherId <= 0) {
        return res.status(400).json({ message: "Voucher ID is required" });
      }
      const transferId = await resolveTransferIdByVoucher(companyId, voucherId);
      if (!transferId) return res.json([]);
      return res.json(await listImmutableStockTransferRevisions(companyId, transferId));
    } catch (error) {
      return sendError(res, error, "Read");
    }
  });

  app.get("/api/stock-transfers/:transferId/revisions", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const transferId = Number(req.params.transferId);
      if (!Number.isInteger(transferId) || transferId <= 0) {
        return res.status(400).json({ message: "Transfer ID is required" });
      }
      return res.json(await listImmutableStockTransferRevisions(companyId, transferId));
    } catch (error) {
      return sendError(res, error, "Read");
    }
  });

  app.post(
    "/api/stock-transfer-revisions/:id/approve",
    requireAuth,
    requireNonPOS,
    requireActionAccess("act_transfer_stock"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const revisionId = Number(req.params.id);
        if (!Number.isInteger(revisionId) || revisionId <= 0) {
          return res.status(400).json({ message: "Revision ID is required" });
        }
        const actorId = userId(req);
        if (!actorId) return res.status(401).json({ message: "User session is required" });

        const result = await approveImmutableStockTransferRevision(companyId, revisionId, actorId);
        await auditRevision(
          req,
          companyId,
          revisionId,
          `transfer-${result.transferId}-revision-${result.revisionNumber}`,
          "approve",
          {
            revisionNumber: { new: result.revisionNumber },
            status:
              result.transition === "no-op"
                ? { old: "approved", new: "approved" }
                : { old: "pending", new: "approved" },
            changedItemCount: { new: result.changedItemCount },
            appliedRevisionCount: {
              new: result.transition === "no-op" ? 0 : (result.appliedRevisionCount ?? 1),
            },
            totalAmount: { new: result.totalAmount },
            items: { new: result.items },
          }
        );
        return res.json({ success: true, ...result });
      } catch (error) {
        return sendError(res, error, "Approve");
      }
    }
  );

  app.post(
    "/api/stock-transfer-revisions/:id/reject",
    requireAuth,
    requireNonPOS,
    requireActionAccess("act_transfer_stock"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const revisionId = Number(req.params.id);
        if (!Number.isInteger(revisionId) || revisionId <= 0) {
          return res.status(400).json({ message: "Revision ID is required" });
        }
        const actorId = userId(req);
        if (!actorId) return res.status(401).json({ message: "User session is required" });
        const parsed = rejectionSchema.parse(req.body ?? {});

        const result = await rejectImmutableStockTransferRevision(companyId, revisionId, actorId, parsed.reason);
        await auditRevision(
          req,
          companyId,
          revisionId,
          `transfer-${result.transferId}-revision-${result.revisionNumber}`,
          "update",
          {
            revisionNumber: { new: result.revisionNumber },
            status:
              result.transition === "no-op"
                ? { old: "rejected", new: "rejected" }
                : { old: "pending", new: "rejected" },
            reason: { new: result.transition === "no-op" ? null : parsed.reason || null },
            items: { new: result.items },
          }
        );
        return res.json({ success: true, ...result });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ message: "Invalid rejection data", errors: error.issues });
        }
        return sendError(res, error, "Reject");
      }
    }
  );

  app.patch("/api/stock-transfer-revisions/:id/optional", requireAuth, requireNonPOS, (_req, res) => {
    return res.status(409).json({
      message: "Revision status is immutable. Approve or reject the pending revision instead.",
      code: "STOCK_TRANSFER_REVISION_IMMUTABLE",
    });
  });

  app.delete("/api/stock-transfer-revisions/:id", requireAuth, requireNonPOS, (_req, res) => {
    return res.status(409).json({
      message: "Revision history is immutable and cannot be deleted.",
      code: "STOCK_TRANSFER_REVISION_IMMUTABLE",
    });
  });
}
