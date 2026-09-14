import type { Express, NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { stockAdjustmentVouchers, vouchers } from "@shared/schema";
import { requireAuth, requireNonPOS, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { storage } from "../../storage";
import {
  deleteStockAdjustmentVoucher,
  StockAdjustmentDeletionError,
} from "../../services/stockAdjustmentDeletion";
import { buildVoucherChangesForDelete, logAudit, snapshotVoucherEntries } from "../_helpers";

const editSchema = z.object({
  voucherDate: z.string().optional(),
  description: z.string().optional().default(""),
  locationId: z.coerce.number().int().positive(),
  adjustmentType: z.enum(["Production", "Consumption", "Mixed"]),
  items: z
    .array(
      z.object({
        stockItemId: z.coerce.number().int().positive(),
        quantity: z.coerce.number().refine((value) => value !== 0, "Quantity cannot be zero"),
        rate: z.coerce.number().nonnegative(),
      })
    )
    .min(1),
});

function isAdjustmentVoucherType(value: string | null | undefined): boolean {
  return (
    value === "Production" || value === "Consumption" || value === "Mixed" || value === "Stock Adjustment"
  );
}

export function registerExactStockAdjustmentLifecycleRoutes(app: Express): void {
  app.patch(
    "/api/vouchers/:id/adjustment",
    requireAuth,
    requireNonPOS,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const voucherId = Number(req.params.id);
        if (!Number.isInteger(voucherId) || voucherId <= 0) {
          return res.status(400).json({ message: "Invalid voucher ID" });
        }

        const [voucher] = await db.select().from(vouchers).where(eq(vouchers.id, voucherId)).limit(1);
        if (!voucher) return next();
        if (voucher.companyId !== companyId) {
          return res.status(403).json({ message: "Voucher belongs to a different company" });
        }

        const [adjustment] = await db
          .select()
          .from(stockAdjustmentVouchers)
          .where(eq(stockAdjustmentVouchers.voucherId, voucherId))
          .limit(1);
        if (!adjustment) return next();

        const blockedReason = voucherMutationBlockReason(voucher);
        if (blockedReason) return res.status(403).json({ message: blockedReason });
        if (voucher.deletedAt) {
          return res.status(400).json({ message: "Deleted stock adjustments cannot be changed" });
        }

        const parsed = editSchema.parse(req.body);
        const updated = await storage.updateStockAdjustment(
          adjustment.id,
          parsed.locationId,
          parsed.adjustmentType,
          parsed.description,
          parsed.items.map((item) => ({
            stockItemId: item.stockItemId,
            quantity: item.quantity.toFixed(3),
            rate: item.rate.toFixed(2),
          }))
        );

        const totalAmount = updated.items.reduce((sum, item) => {
          const amount = Math.abs(Number(item.totalAmount || 0));
          if (parsed.adjustmentType !== "Mixed") return sum + amount;
          return sum + (Number(item.quantity) >= 0 ? amount : -amount);
        }, 0);

        const [updatedVoucher] = await db
          .update(vouchers)
          .set({
            locationId: parsed.locationId,
            totalAmount: totalAmount.toFixed(2),
            description: parsed.description,
            ...(parsed.voucherDate !== undefined ? { voucherDate: parsed.voucherDate } : {}),
          })
          .where(eq(vouchers.id, voucherId))
          .returning();

        return res.json(updatedVoucher);
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ message: "Invalid stock adjustment data", errors: error.issues });
        }
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.delete(
    "/api/vouchers/:id",
    requireAuth,
    requireRole("Admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      const voucherId = Number(req.params.id);
      if (!Number.isInteger(voucherId) || voucherId <= 0) return next();
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const [candidate] = await db.select().from(vouchers).where(eq(vouchers.id, voucherId)).limit(1);
      if (!candidate) return next();
      if (candidate.companyId !== companyId) {
        return res.status(403).json({ message: "Access denied: Voucher belongs to a different company" });
      }

      const [adjustment] = await db
        .select({ id: stockAdjustmentVouchers.id })
        .from(stockAdjustmentVouchers)
        .where(eq(stockAdjustmentVouchers.voucherId, voucherId))
        .limit(1);
      if (!adjustment && !candidate.deletedAt && !isAdjustmentVoucherType(candidate.voucherType)) return next();
      if (!adjustment && !candidate.deletedAt) return next();
      if (!adjustment && candidate.deletedAt && !isAdjustmentVoucherType(candidate.voucherType)) return next();

      try {
        const result = await deleteStockAdjustmentVoucher({ companyId, voucherId });

        if (!result.replayed) {
          try {
            const snapshot = await snapshotVoucherEntries(result.entries);
            await logAudit({
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId,
              action: "delete",
              tableName: "vouchers",
              recordId: voucherId,
              recordIdentifier: result.voucher.voucherNumber,
              changes: buildVoucherChangesForDelete(result.voucher, snapshot),
            });
          } catch {
            // Audit is non-fatal, matching the other central voucher lifecycles.
          }
        }

        return res.json({
          message: "Voucher deleted successfully",
          replayed: result.replayed,
          reversedInventory: result.reversedInventory,
        });
      } catch (error: unknown) {
        if (error instanceof StockAdjustmentDeletionError) {
          return res.status(error.status).json({ message: error.message, code: error.code });
        }
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
