import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { db, type DbTransaction } from "../../db";
import { storage } from "../../storage";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { requireAuth, requireNonPOS } from "../../auth";
import { logAudit, buildItemLevelChanges } from "../_helpers";
import {
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  stockItems,
  type StockAdjustmentItem,
  type Voucher,
} from "@shared/schema";
import { eq } from "drizzle-orm";
import { registerVoucherPurchaseUpdateRoutesPart1, parseItemAmounts } from "./registerVoucherPurchaseUpdateRoutesPart1";

/**
 * After saving a journal voucher, if it has a customer entry + a ledger account entry,
 * look for order charges linked to that ledger account for that customer.
 * If exactly one charge is found, update its amount and recalculate the order totals.
 */

export function registerVoucherPurchaseUpdateRoutes(app: Express) {
  registerVoucherPurchaseUpdateRoutesPart1(app);

  app.patch("/api/vouchers/:id/adjustment", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid voucher ID" });
      const { voucherDate, description, locationId, items } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "At least one item is required" });
      }
      if (!locationId) return res.status(400).json({ message: "Location ID is required" });
      if (!parseItemAmounts(items)) return res.status(400).json({ message: "Invalid amount" });

      const existingVoucher = await storage.getVoucherById(id);
      if (!existingVoucher) return res.status(404).json({ message: "Voucher not found" });
      if (!["Consumption", "Production", "Mixed"].includes(existingVoucher.voucherType)) {
        return res
          .status(400)
          .json({ message: "This endpoint only updates Consumption, Production, or Mixed vouchers" });
      }
      if (existingVoucher.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({ message: "Access denied: Voucher belongs to a different company" });
      }
      const blockedVoucherReason = voucherMutationBlockReason(existingVoucher);
      if (blockedVoucherReason) {
        return res.status(403).json({ message: blockedVoucherReason });
      }
      const userRole = req.session.currentRole;
      if (!userRole) return res.status(403).json({ message: "User role not found" });
      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        if (userRole === "Manager") {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const existingDate = new Date(existingVoucher.voucherDate);
          existingDate.setHours(0, 0, 0, 0);
          if (existingDate.getTime() !== today.getTime()) {
            return res.status(403).json({ message: "Managers can only edit today's vouchers" });
          }
        } else {
          return res.status(403).json({ message: "Insufficient permissions to edit vouchers" });
        }
      }

      const adjustmentVoucher = await db
        .select()
        .from(stockAdjustmentVouchers)
        .where(eq(stockAdjustmentVouchers.voucherId, id))
        .limit(1)
        .then((rows) => rows[0]);
      const oldAdjustmentItems = adjustmentVoucher
        ? await db
            .select()
            .from(stockAdjustmentItems)
            .where(eq(stockAdjustmentItems.adjustmentId, adjustmentVoucher.id))
        : [];

      const parsedLocationId = parseInt(locationId);
      const adjustmentType = existingVoucher.voucherType as "Consumption" | "Production" | "Mixed";
      const normalizedItems = items.map((item) => ({
        stockItemId: Number(item.stockItemId),
        quantity: String(item.quantity),
        rate: String(item.rate),
      }));
      const voucherHeader = {
        ...(voucherDate !== undefined ? { voucherDate } : {}),
        ...(description !== undefined ? { description } : {}),
      };

      // Phase 21 (B): the edit audit is written on the adjustment's transaction.
      const writeAdjustmentAuditTx = async (
        tx: DbTransaction,
        written: { voucher: Voucher; items: StockAdjustmentItem[] }
      ) => {
        const updatedRow = written.voucher;
        const _adjChanges: Record<string, { old: unknown; new: unknown }> = {};
        if (existingVoucher.voucherDate !== updatedRow.voucherDate)
          _adjChanges.date = { old: existingVoucher.voucherDate, new: updatedRow.voucherDate };
        if (existingVoucher.totalAmount !== updatedRow.totalAmount)
          _adjChanges.totalAmount = { old: existingVoucher.totalAmount, new: updatedRow.totalAmount };
        if (existingVoucher.locationId !== updatedRow.locationId)
          _adjChanges.location = { old: existingVoucher.locationId, new: updatedRow.locationId };
        if ((existingVoucher.description ?? "") !== (updatedRow.description ?? ""))
          _adjChanges.description = { old: existingVoucher.description ?? "", new: updatedRow.description ?? "" };
        const _resolveAdjName = async (itemId: number) =>
          (await tx.select({ name: stockItems.name }).from(stockItems).where(eq(stockItems.id, itemId)))[0]?.name ??
          `Item #${itemId}`;
        const _adjItemDiff = await buildItemLevelChanges(
          oldAdjustmentItems.map((item) => ({
            stockItemId: item.stockItemId,
            quantity: item.quantity,
            rate: item.rate,
            totalAmount: item.totalAmount,
          })),
          written.items.map((item) => ({
            stockItemId: item.stockItemId,
            quantity: item.quantity,
            rate: item.rate,
            totalAmount: item.totalAmount,
          })),
          _resolveAdjName
        );
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId: req.session.currentCompanyId!,
            action: "update",
            tableName: "vouchers",
            recordId: updatedRow.id,
            recordIdentifier: updatedRow.voucherNumber,
            changes: { ..._adjChanges, ..._adjItemDiff },
          },
          tx
        );
      };

      const result = adjustmentVoucher
        ? await storage.updateStockAdjustment(
            adjustmentVoucher.id,
            parsedLocationId,
            adjustmentVoucher.adjustmentType,
            description || "",
            normalizedItems,
            voucherHeader,
            writeAdjustmentAuditTx
          )
        : await storage.createStockAdjustment(
            id,
            parsedLocationId,
            adjustmentType,
            description || "",
            normalizedItems,
            undefined,
            voucherHeader,
            adjustmentType.toLowerCase(),
            writeAdjustmentAuditTx
          );
      const updated = result.voucher;

      res.json(updated);
    } catch (error: unknown) {
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });

  // Update a stock transfer voucher with line items
}
