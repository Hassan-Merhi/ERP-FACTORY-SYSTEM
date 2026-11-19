// Extracted from ./orphaned-pos.ts
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { emptyBody, emptyQuery, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";
import {
  assertNoInventoryCutoverTx,
  sendInventoryCutoverRefusal,
} from "../../../services/accounting/perpetualInventory/cutoverRefusal";
import { vouchers, voucherEntries, salesItems, locations } from "@shared/schema";
import { eq, and, or, inArray, isNull, isNotNull } from "drizzle-orm";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import { plusMoney } from "../../../lib/money";

const deleteOrphanedPosSalesInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerAdminOrphanedPosRoutesPart1(app: Express) {
  // Get orphaned POS sales (vouchers at deleted locations)
  app.get("/api/admin/orphaned-pos-sales", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Find all vouchers with locationId pointing to deleted or non-existent locations
      const orphanedVouchers = await db
        .select({
          id: vouchers.id,
          voucherNumber: vouchers.voucherNumber,
          voucherType: vouchers.voucherType,
          voucherDate: vouchers.voucherDate,
          locationId: vouchers.locationId,
          notes: vouchers.description,
        })
        .from(vouchers)
        .leftJoin(locations, eq(vouchers.locationId, locations.id))
        .where(
          and(
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            isNotNull(vouchers.locationId),
            or(
              isNull(locations.id), // Location doesn't exist
              isNotNull(locations.deletedAt) // Location is soft-deleted
            )
          )
        );

      // Get entry totals for each orphaned voucher
      const vouchersWithTotals = await Promise.all(
        orphanedVouchers.map(async (v) => {
          const entries = await db
            .select({
              debitAmount: voucherEntries.debitAmount,
              creditAmount: voucherEntries.creditAmount,
            })
            .from(voucherEntries)
            .where(eq(voucherEntries.voucherId, v.id));

          const totalDebit = entries.reduce((sum, e) => plusMoney(sum, e.debitAmount), 0);
          const totalCredit = entries.reduce((sum, e) => plusMoney(sum, e.creditAmount), 0);

          // Check if it has sales items
          const saleItems = await db
            .select({ id: salesItems.id, quantity: salesItems.quantity, totalCost: salesItems.totalCost })
            .from(salesItems)
            .where(eq(salesItems.voucherId, v.id));

          return {
            ...v,
            totalDebit,
            totalCredit,
            salesItemCount: saleItems.length,
            salesItemsTotalCost: saleItems.reduce((sum, s) => plusMoney(sum, s.totalCost), 0),
          };
        })
      );

      const totalImpact = vouchersWithTotals.reduce((sum, v) => sum + Math.abs(v.totalDebit - v.totalCredit), 0);

      res.json({
        count: vouchersWithTotals.length,
        totalImpact,
        vouchers: vouchersWithTotals,
        explanation:
          "These vouchers have a locationId that points to a deleted or non-existent location. They are orphaned and can be safely deleted.",
      });
    } catch (error: unknown) {
      logger.error("Orphaned POS sales check error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Delete orphaned POS sales (vouchers at deleted locations)
  app.post(
    "/api/admin/delete-orphaned-pos-sales",
    requireAuth,
    requireRole("Admin"),
    validateRequest(deleteOrphanedPosSalesInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) {
          return res.status(400).json({ message: "No company selected" });
        }
        // Wave 11: hard-deleting sales (and their COGS journals) would move the
        // ledger's Inventory with no stock movement: refused after the cut-over.
        await assertNoInventoryCutoverTx(db, companyId, "delete-orphaned-pos-sales");

        // Find all vouchers with locationId pointing to deleted or non-existent locations
        const orphanedVouchers = await db
          .select({
            id: vouchers.id,
            voucherNumber: vouchers.voucherNumber,
          })
          .from(vouchers)
          .leftJoin(locations, eq(vouchers.locationId, locations.id))
          .where(
            and(
              eq(vouchers.companyId, companyId),
              isNull(vouchers.deletedAt),
              isNotNull(vouchers.locationId),
              or(
                isNull(locations.id), // Location doesn't exist
                isNotNull(locations.deletedAt) // Location is soft-deleted
              )
            )
          );

        if (orphanedVouchers.length === 0) {
          return res.json({ message: "No orphaned POS sales found", deleted: 0 });
        }

        const voucherIds = orphanedVouchers.map((v) => v.id);

        // Wave 16 (A): one transaction; the vouchers are retired (soft delete
        // with their lines, audited here), not hard-deleted with their lines.
        const { deletedSalesItems, deletedEntries, deletedVouchers } = await db.transaction(async (tx) => {
          const salesResult = await tx.delete(salesItems).where(inArray(salesItems.voucherId, voucherIds));
          const lineRows = await tx
            .select({ id: voucherEntries.id })
            .from(voucherEntries)
            .where(inArray(voucherEntries.voucherId, voucherIds));
          const retired = await retireVouchersTx(tx, {
            companyId,
            voucherIds,
            reason: "orphaned-pos-sale-delete",
            actor: sessionRetirementActor(req),
          });
          return {
            deletedSalesItems: salesResult.rowCount ?? 0,
            deletedEntries: lineRows.length,
            deletedVouchers: retired.length,
          };
        });

        res.json({
          message: `Deleted ${deletedVouchers} orphaned POS vouchers, ${deletedEntries} entries, and ${deletedSalesItems} sales items`,
          deleted: deletedVouchers,
          deletedEntries,
          deletedSalesItems,
          voucherNumbers: orphanedVouchers.map((v) => v.voucherNumber),
        });
      } catch (error: unknown) {
        if (sendInventoryCutoverRefusal(res, error)) return;
        logger.error("Delete orphaned POS sales error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
