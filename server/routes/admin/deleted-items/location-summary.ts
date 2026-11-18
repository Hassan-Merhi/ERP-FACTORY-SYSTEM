/**
 * deletedItemsRoutes: LocationSummary endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { containers, purchaseOrders, vouchers } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import { registerLocationSummaryRoutesPart1 } from "./registerLocationSummaryRoutesPart1";

export function registerLocationSummaryRoutes(app: Express) {
  registerLocationSummaryRoutesPart1(app);

  // Cleanup endpoint to remove orphaned charge vouchers - admin only (destructive)
  app.post("/api/cleanup/orphaned-charges", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      // Wave 16 (A): the current company's live CHARGE vouchers only (it read
      // every company's), retired rather than hard-deleted.
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const chargeVouchers = await db
        .select()
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            sql`${vouchers.voucherNumber} LIKE 'CHARGE-%'`
          )
        );

      let deletedCount = 0;

      for (const chargeVoucher of chargeVouchers) {
        // Extract container number from voucher number (format: CHARGE-CONT-XXXX-YYYY-...)
        const containerNumber =
          chargeVoucher.voucherNumber.split("-")[1] + "-" + chargeVoucher.voucherNumber.split("-")[2];

        // Check if any POs exist for this container
        const remainingPOs = await db
          .select()
          .from(purchaseOrders)
          .leftJoin(containers, eq(purchaseOrders.containerId, containers.id))
          .where(and(eq(containers.containerNumber, containerNumber), eq(containers.companyId, companyId)))
          .limit(1);

        // If no POs for this container, delete the charge voucher
        if (remainingPOs.length === 0) {
          const retired = await db.transaction((tx) =>
            retireVouchersTx(tx, {
              companyId,
              voucherIds: [chargeVoucher.id],
              reason: "orphaned-charge-voucher-cleanup",
              actor: sessionRetirementActor(req),
            })
          );
          deletedCount += retired.length;
        }
      }

      res.json({
        message: `Cleaned up ${deletedCount} orphaned charge vouchers`,
        deletedCount,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ============================================================
  // DELETED ITEMS MANAGEMENT (Trash/Recycle Bin)
  // ============================================================
}
