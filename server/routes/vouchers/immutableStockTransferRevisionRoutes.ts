import type { Express } from "express";
import { z } from "zod";
import { requireAuth, requireNonPOS } from "../../auth";
import { requireActionAccess } from "../../lib/permissionMiddleware";
import {
  approveImmutableStockTransferRevision,
  createImmutableStockTransferRevision,
  listImmutableStockTransferRevisions,
  rejectImmutableStockTransferRevision,
  resolveTransferIdByVoucher,
} from "../../services/immutableStockTransferRevisionLifecycle";
import {
  captureStockTransferRevisionReviewTx,
  captureStockTransferRevisionTx,
} from "../../services/inventory/stockTransferWorkflowCapture";
import {
  userId,
  sendError,
  revisionItemsForAudit,
  queueRevisedTransferWhatsApp,
  auditRevision,
} from "./immutableStockTransferRevisionRoutesHelpers";

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

      const result = await createImmutableStockTransferRevision(
        {
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
        },
        async (tx, written) => {
          // Factory LAN server: the revision is recorded for the cloud in this transaction.
          await captureStockTransferRevisionTx(req, tx, written, {
            note: parsed.note ?? null,
            pending: parsed.optional,
            sourceLocationIdLimit: assignedLocationId,
            items: parsed.items.map((item) => ({
              stockItemId: item.stockItemId,
              stockItemName: item.stockItemName,
              sourceLocationId: item.sourceLocationId,
              sourceLocationName: item.sourceLocationName ?? null,
              originalQuantity: item.originalQuantity,
              newQuantity: item.newQuantity,
            })),
          });
          await auditRevision(
            req,
            companyId,
            written.revisionId,
            `transfer-${written.transferId}-revision-${written.revisionNumber}`,
            "create",
            {
              revisionNumber: { new: written.revisionNumber },
              status: { new: written.status },
              note: { new: parsed.note?.trim() || null },
              itemCount: { new: written.itemCount },
              route: {
                new: `${written.sourceLocationName} -> ${written.destinationLocationName}`,
              },
              items: { new: revisionItemsForAudit(written.items) },
            },
            tx
          );
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

        const result = await approveImmutableStockTransferRevision(
          companyId,
          revisionId,
          actorId,
          async (tx, written) => {
            await captureStockTransferRevisionReviewTx(req, tx, written, "approve", null);
            await auditRevision(
              req,
              companyId,
              revisionId,
              `transfer-${written.transferId}-revision-${written.revisionNumber}`,
              "approve",
              {
                revisionNumber: { new: written.revisionNumber },
                status:
                  written.transition === "no-op"
                    ? { old: "approved", new: "approved" }
                    : { old: "pending", new: "approved" },
                changedItemCount: { new: written.changedItemCount },
                appliedRevisionCount: {
                  new: written.transition === "no-op" ? 0 : (written.appliedRevisionCount ?? 1),
                },
                totalAmount: { new: written.totalAmount },
                items: { new: written.items },
              },
              tx
            );
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

        const result = await rejectImmutableStockTransferRevision(
          companyId,
          revisionId,
          actorId,
          parsed.reason,
          async (tx, written) => {
            await captureStockTransferRevisionReviewTx(req, tx, written, "reject", parsed.reason ?? null);
            await auditRevision(
              req,
              companyId,
              revisionId,
              `transfer-${written.transferId}-revision-${written.revisionNumber}`,
              "update",
              {
                revisionNumber: { new: written.revisionNumber },
                status:
                  written.transition === "no-op"
                    ? { old: "rejected", new: "rejected" }
                    : { old: "pending", new: "rejected" },
                reason: { new: written.transition === "no-op" ? null : parsed.reason || null },
                items: { new: written.items },
              },
              tx
            );
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
