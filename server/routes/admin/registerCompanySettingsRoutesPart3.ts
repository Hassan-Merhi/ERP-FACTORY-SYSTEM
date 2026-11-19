// Extracted from ./registerCompanySettingsRoutesPart2.ts
import { logger } from "../../lib/logger";
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { writeAuditEvent } from "../../services/audit";
import { containers, ledgerAccounts, stockItems, voucherEntries, vouchers } from "@shared/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  AUDIT_MAX_ROWS,
  ID_CHUNK_SIZE,
  RESET_AUDIT_TABLE,
  SOFT_RESET_IDENTIFIER,
  auditActor,
  auditPages,
  chunk,
  closedBooksResetRefusal,
  resetCompanyId,
  sendResetError,
} from "./registerCompanySettingsRoutesPart1";

export function registerCompanySettingsRoutesPart3(app: Express) {
  // Company Data Reset - Delete vouchers (keep OTW container vouchers only) and clear opening balances
  app.post("/api/admin/company-data-reset", requireAuth, requireRole("Owner"), async (req, res) => {
    try {
      const companyId = resetCompanyId(req);
      const { accountIds, clearStockOpeningBalances } = req.body;

      if (!Array.isArray(accountIds)) {
        return res.status(400).json({ message: "companyId and accountIds array are required" });
      }

      const closedRefusal = await closedBooksResetRefusal(companyId);
      if (closedRefusal) {
        return res.status(409).json({ message: closedRefusal, code: "ACCOUNTING_PERIOD_CLOSED" });
      }

      const results = {
        vouchersDeleted: 0,
        openingBalancesCleared: 0,
        stockOpeningBalancesCleared: 0,
      };

      // Every voucher this reset soft-deletes carries this exact deleted_at. It
      // is recorded in the audit row and is what undo-company-reset matches on.
      const resetAt = new Date();

      // Start a transaction
      await db.transaction(async (tx) => {
        // 1. Get OTW container numbers to preserve their Purchase vouchers
        const otwContainers = await tx
          .select({ containerNumber: containers.containerNumber })
          .from(containers)
          .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW")));

        const otwContainerNumbers = otwContainers.map((c) => c.containerNumber);
        logger.info("OTW containers to preserve:", { otwContainerNumbers: otwContainerNumbers });

        // 2. Get inter-company credit account IDs (accounts with "Credit" in name - e.g., "KINSHASA Credit")
        const interCompanyAccounts = await tx
          .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), sql`"ledger_accounts"."name" ILIKE '%Credit%'`));
        const interCompanyAccountIds = new Set(interCompanyAccounts.map((a) => a.id));
        logger.info("Inter-company credit accounts to preserve", { accounts: interCompanyAccounts.map((a) => a.name) });

        // 3. Get voucher IDs that have entries involving inter-company credit accounts
        const interCompanyAccountIdArray = [...interCompanyAccountIds];
        const interCompanyVoucherEntries =
          interCompanyAccountIdArray.length > 0
            ? await tx
                .select({ voucherId: voucherEntries.voucherId })
                .from(voucherEntries)
                .where(inArray(voucherEntries.ledgerAccountId, interCompanyAccountIdArray))
            : [];
        const interCompanyVoucherIds = new Set(interCompanyVoucherEntries.map((e) => e.voucherId));
        logger.info("Vouchers involving inter-company accounts to preserve", { count: interCompanyVoucherIds.size });

        // 4. Get the company's live vouchers. Vouchers that were already deleted
        //    keep their own deleted_at, so an undo of this reset never revives them.
        const allVouchers = await tx
          .select({
            id: vouchers.id,
            voucherType: vouchers.voucherType,
            voucherNumber: vouchers.voucherNumber,
            description: vouchers.description,
          })
          .from(vouchers)
          .where(and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt)))
          .orderBy(vouchers.id);

        // 5. Filter out vouchers that should be preserved:
        //    - Purchase vouchers that belong to OTW containers
        //    - Any vouchers involving inter-company credit accounts
        const vouchersToDelete = allVouchers.filter((v) => {
          // Preserve vouchers that involve inter-company credit accounts
          if (interCompanyVoucherIds.has(v.id)) {
            logger.info("Preserving inter-company voucher", {
              voucherId: v.id,
              voucherType: v.voucherType,
              description: v.description,
            });
            return false; // Don't delete
          }

          // If it's a Purchase voucher, check if it belongs to an OTW container
          if (v.voucherType === "Purchase") {
            // Check if any OTW container number is in the description
            const belongsToOtw = otwContainerNumbers.some((cn) => v.description && v.description.includes(cn));
            if (belongsToOtw) {
              logger.info("Preserving OTW voucher", { voucherId: v.id, description: v.description });
              return false; // Don't delete - it's for an OTW container
            }
          }
          return true; // Delete all other vouchers
        });
        const voucherIdsToDelete = vouchersToDelete.map((v) => v.id);
        logger.info("Vouchers to delete", { count: voucherIdsToDelete.length });
        logger.info("Vouchers preserved (OTW + inter-company)", {
          count: allVouchers.length - voucherIdsToDelete.length,
        });

        if (voucherIdsToDelete.length > 0) {
          // SOFT DELETE vouchers only - DON'T delete voucher entries
          // This allows undo to work properly
          for (const ids of chunk(voucherIdsToDelete, ID_CHUNK_SIZE)) {
            await tx.update(vouchers).set({ deletedAt: resetAt }).where(inArray(vouchers.id, ids));
          }

          results.vouchersDeleted = voucherIdsToDelete.length;
        }

        // 6. Clear opening balances for selected accounts, recording them first
        let previousOpeningBalances: Array<{
          id: number;
          code: string;
          name: string;
          openingBalance: string | null;
          openingBalanceSide: string | null;
        }> = [];
        if (accountIds.length > 0) {
          previousOpeningBalances = await tx
            .select({
              id: ledgerAccounts.id,
              code: ledgerAccounts.code,
              name: ledgerAccounts.name,
              openingBalance: ledgerAccounts.openingBalance,
              openingBalanceSide: ledgerAccounts.openingBalanceSide,
            })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.id, accountIds)))
            .orderBy(ledgerAccounts.id);

          await tx
            .update(ledgerAccounts)
            .set({ openingBalance: "0", openingBalanceSide: null })
            .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.id, accountIds)));

          results.openingBalancesCleared = accountIds.length;
        }

        // 7. Clear stock item opening balances if requested, recording the non-zero ones first
        let previousStockOpenings: Array<{
          id: number;
          code: string;
          openingQty: string | null;
          openingRate: string | null;
          openingValue: string | null;
        }> = [];
        if (clearStockOpeningBalances) {
          // Count first
          const stockItemCount = await tx
            .select({ count: sql<number>`count(*)` })
            .from(stockItems)
            .where(eq(stockItems.companyId, companyId));

          results.stockOpeningBalancesCleared = Number(stockItemCount[0]?.count) || 0;

          previousStockOpenings = await tx
            .select({
              id: stockItems.id,
              code: stockItems.code,
              openingQty: stockItems.openingQty,
              openingRate: stockItems.openingRate,
              openingValue: stockItems.openingValue,
            })
            .from(stockItems)
            .where(
              and(
                eq(stockItems.companyId, companyId),
                sql`(COALESCE(${stockItems.openingQty}, 0) <> 0 OR COALESCE(${stockItems.openingRate}, 0) <> 0 OR COALESCE(${stockItems.openingValue}, 0) <> 0)`
              )
            )
            .orderBy(stockItems.id);

          await tx
            .update(stockItems)
            .set({ openingQty: "0", openingRate: "0", openingValue: "0" })
            .where(eq(stockItems.companyId, companyId));
        }

        // 8. Audit, in the same transaction: the undo marker, the vouchers
        //    soft-deleted and the opening balances as they were before zeroing.
        await writeAuditEvent(
          {
            ...auditActor(req),
            companyId,
            action: "delete",
            tableName: RESET_AUDIT_TABLE,
            recordIdentifier: SOFT_RESET_IDENTIFIER,
            changes: {
              resetMarker: {
                new: {
                  resetAt: resetAt.toISOString(),
                  voucherCount: vouchersToDelete.length,
                  vouchersRecordedInFull: vouchersToDelete.length <= AUDIT_MAX_ROWS,
                },
              },
              summary: { new: results },
              vouchers: {
                old: auditPages(
                  vouchersToDelete.map((v) => ({
                    id: v.id,
                    voucherNumber: v.voucherNumber,
                    voucherType: v.voucherType,
                  }))
                ),
                new: { deletedAt: resetAt.toISOString() },
              },
              openingBalances: {
                old: auditPages(previousOpeningBalances),
                new: { openingBalance: "0", openingBalanceSide: null },
              },
              ...(clearStockOpeningBalances
                ? {
                    stockOpeningBalances: {
                      old: auditPages(previousStockOpenings),
                      new: { openingQty: "0", openingRate: "0", openingValue: "0" },
                    },
                  }
                : {}),
            },
          },
          tx
        );
      });

      logger.info(`Company data reset completed for company ${companyId}:`, { results: results });
      res.json({ success: true, results });
    } catch (error: unknown) {
      return sendResetError(res, error, "Company data reset error:");
    }
  });
}
