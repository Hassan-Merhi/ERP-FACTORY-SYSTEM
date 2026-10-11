import type { Express } from "express";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { containerOffloads, containers, voucherEntries, vouchers } from "@shared/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { retireVouchersTx, sessionRetirementActor } from "../../services/accounting/voucherRetirement";

async function findReversedOtwContainers(companyId: number) {
  return db
    .select({
      id: containers.id,
      containerNumber: containers.containerNumber,
      numberPlate: containers.numberPlate,
    })
    .from(containers)
    .leftJoin(containerOffloads, eq(containers.id, containerOffloads.containerId))
    .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW"), isNull(containerOffloads.id)));
}

async function findChargeVouchers(companyId: number, containerNumber: string) {
  return db
    .select({
      id: vouchers.id,
      voucherNumber: vouchers.voucherNumber,
      voucherType: vouchers.voucherType,
    })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        or(
          sql`${vouchers.voucherNumber} LIKE ${"DUTY-" + containerNumber + "%"}`,
          sql`${vouchers.voucherNumber} LIKE ${"TRANS-" + containerNumber + "%"}`,
          sql`${vouchers.voucherNumber} LIKE ${"OFFICE-" + containerNumber + "%"}`,
          sql`${vouchers.voucherNumber} LIKE ${"CHG-" + containerNumber + "%"}`,
          sql`${vouchers.voucherNumber} LIKE ${"XFER-" + containerNumber + "%"}`
        )
      )
    );
}

export function registerOrphanedChargeVoucherRoutes(app: Express) {
  app.get(
    "/api/debug/orphaned-charge-vouchers",
    requireAuth,
    requireRole("Admin", "Owner", "Manager"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) {
          return res.status(400).json({ message: "No company selected" });
        }

        const otwContainers = await findReversedOtwContainers(companyId);
        const orphanedVouchers: Array<{
          voucherId: number;
          voucherNumber: string;
          voucherType: string;
          containerNumber: string;
          containerId: number;
          totalDebit: number;
          totalCredit: number;
          reason: string;
        }> = [];

        for (const container of otwContainers) {
          const chargeVouchersForContainer = await findChargeVouchers(companyId, container.containerNumber);

          for (const voucher of chargeVouchersForContainer) {
            const entries = await db
              .select({
                debitAmount: voucherEntries.debitAmount,
                creditAmount: voucherEntries.creditAmount,
              })
              .from(voucherEntries)
              .where(eq(voucherEntries.voucherId, voucher.id));

            const totalDebit = entries.reduce((sum, entry) => sum + parseFloat(entry.debitAmount || "0"), 0);
            const totalCredit = entries.reduce((sum, entry) => sum + parseFloat(entry.creditAmount || "0"), 0);

            orphanedVouchers.push({
              voucherId: voucher.id,
              voucherNumber: voucher.voucherNumber,
              voucherType: voucher.voucherType,
              containerNumber: container.containerNumber,
              containerId: container.id,
              totalDebit,
              totalCredit,
              reason:
                "Container is OTW with no offload record but has charge vouchers (offload was reversed without cleanup)",
            });
          }
        }

        res.json({
          otwContainerCount: otwContainers.length,
          orphanedVoucherCount: orphanedVouchers.length,
          orphanedVouchers,
          totalImpact: orphanedVouchers.reduce(
            (sum, voucher) => sum + Math.abs(voucher.totalDebit - voucher.totalCredit),
            0
          ),
          explanation:
            "These vouchers exist for containers in OTW status that have no offload record. They were created during offload but not cleaned up when the offload was reversed.",
        });
      } catch (error: unknown) {
        logger.error("Orphaned charge vouchers diagnostics error:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post("/api/admin/fix-orphaned-charge-vouchers", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const otwContainers = await findReversedOtwContainers(companyId);
      const deletedVouchers: Array<{ voucherId: number; voucherNumber: string; containerNumber: string }> = [];

      for (const container of otwContainers) {
        const chargeVouchersForContainer = await findChargeVouchers(companyId, container.containerNumber);

        for (const voucher of chargeVouchersForContainer) {
          // Wave 16 (A): retired (soft delete with its lines, audited), not hard-deleted.
          await db.transaction((tx) =>
            retireVouchersTx(tx, {
              companyId,
              voucherIds: [voucher.id],
              reason: "orphaned-otw-charge-voucher-fix",
              actor: sessionRetirementActor(req),
            })
          );

          deletedVouchers.push({
            voucherId: voucher.id,
            voucherNumber: voucher.voucherNumber,
            containerNumber: container.containerNumber,
          });

          logger.info(`Deleted orphaned voucher: ${voucher.voucherNumber} for container ${container.containerNumber}`);
        }
      }

      res.json({
        message: `Deleted ${deletedVouchers.length} orphaned charge vouchers`,
        deletedCount: deletedVouchers.length,
        deletedVouchers,
        containersChecked: otwContainers.length,
      });
    } catch (error: unknown) {
      logger.error("Fix orphaned charge vouchers error:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
