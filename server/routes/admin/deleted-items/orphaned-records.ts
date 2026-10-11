/**
 * deletedItemsRoutes: OrphanedRecord endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS, requireRole } from "../../../auth";
import { sqlArray } from "../../../lib/sqlArray";
import { vouchers, voucherEntries, locations } from "@shared/schema";
import { eq, and, or, inArray, sql, isNull, isNotNull } from "drizzle-orm";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import { writeAuditEvent } from "../../../services/audit";
import { companyClosedThrough, isDateInClosedPeriod } from "../../../services/accounting/scheduledPostingScope";

export function registerOrphanedRecordRoutes(app: Express) {
  app.get("/api/orphaned-records", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Find vouchers that have a locationId but the location is deleted or no longer exists
      const orphanedVouchers = await db
        .select({
          id: vouchers.id,
          voucherNumber: vouchers.voucherNumber,
          voucherType: vouchers.voucherType,
          voucherDate: vouchers.voucherDate,
          locationId: vouchers.locationId,
          locationName: vouchers.locationName,
          totalAmount: vouchers.totalAmount,
          description: vouchers.description,
          createdAt: vouchers.createdAt,
        })
        .from(vouchers)
        .leftJoin(locations, eq(vouchers.locationId, locations.id))
        .where(
          and(
            eq(vouchers.companyId, companyId),
            sql`${vouchers.locationId} IS NOT NULL`,
            or(sql`${locations.id} IS NULL`, isNotNull(locations.deletedAt))
          )
        )
        .orderBy(sql`${vouchers.createdAt} DESC`);

      // Find unbalanced vouchers (debits != credits)
      const unbalancedVouchers = await db
        .select({
          id: vouchers.id,
          voucherNumber: vouchers.voucherNumber,
          voucherType: vouchers.voucherType,
          voucherDate: vouchers.voucherDate,
          locationId: vouchers.locationId,
          locationName: vouchers.locationName,
          totalAmount: vouchers.totalAmount,
          description: vouchers.description,
          createdAt: vouchers.createdAt,
          totalDebits: sql<string>`COALESCE(SUM(${voucherEntries.debitAmount}::numeric), 0)::text`,
          totalCredits: sql<string>`COALESCE(SUM(${voucherEntries.creditAmount}::numeric), 0)::text`,
          imbalance: sql<string>`(COALESCE(SUM(${voucherEntries.debitAmount}::numeric), 0) - COALESCE(SUM(${voucherEntries.creditAmount}::numeric), 0))::text`,
        })
        .from(vouchers)
        .leftJoin(voucherEntries, eq(vouchers.id, voucherEntries.voucherId))
        .where(and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt), eq(vouchers.optional, false)))
        .groupBy(vouchers.id)
        .having(
          sql`ABS(COALESCE(SUM(${voucherEntries.debitAmount}::numeric), 0) - COALESCE(SUM(${voucherEntries.creditAmount}::numeric), 0)) > 0.01`
        )
        .orderBy(sql`${vouchers.createdAt} DESC`);

      res.json({
        orphanedVouchers,
        unbalancedVouchers,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Phase 19 (A), DI9: reassigning the location of posted vouchers is Admin/Owner,
  // one transaction with the vouchers locked, refused when one is dated in a
  // closed period, and audited per voucher (location before and after) in the
  // transaction. It ran as one unaudited update for any non-POS user.
  app.post("/api/orphaned-records/reassign", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { voucherIds, newLocationId } = req.body;

      if (!voucherIds || !Array.isArray(voucherIds) || voucherIds.length === 0) {
        return res.status(400).json({ message: "No vouchers selected" });
      }
      const ids = [...new Set(voucherIds.map(Number))];
      if (ids.some((voucherId) => !Number.isInteger(voucherId) || voucherId <= 0)) {
        return res.status(400).json({ message: "Some vouchers not found or belong to different company" });
      }

      if (!newLocationId) {
        return res.status(400).json({ message: "New location is required" });
      }

      // Verify the new location exists and belongs to current company
      const newLocation = await storage.getLocationById(newLocationId);
      if (!newLocation || newLocation.companyId !== companyId) {
        return res.status(400).json({ message: "Invalid location" });
      }

      const actor = sessionRetirementActor(req);
      const outcome = await db.transaction(async (tx) => {
        const vouchersToUpdate = await tx
          .select()
          .from(vouchers)
          .where(and(eq(vouchers.companyId, companyId), inArray(vouchers.id, ids)))
          .orderBy(vouchers.id)
          .for("update");
        if (vouchersToUpdate.length !== ids.length) return { missing: true as const };

        const closedThrough = await companyClosedThrough(companyId, tx);
        const closed = vouchersToUpdate.filter(
          (v) =>
            isDateInClosedPeriod(closedThrough, String(v.voucherDate)) ||
            isDateInClosedPeriod(closedThrough, String(v.effectiveDate ?? v.voucherDate))
        );
        if (closed.length) return { closed: closed.map((v) => v.voucherNumber), closedThrough };

        await tx
          .update(vouchers)
          .set({ locationId: newLocation.id, locationName: newLocation.name })
          .where(and(eq(vouchers.companyId, companyId), inArray(vouchers.id, ids)));
        for (const voucher of vouchersToUpdate) {
          await writeAuditEvent(
            {
              userId: actor.userId,
              username: actor.username,
              companyId,
              action: "update",
              tableName: "vouchers",
              recordId: voucher.id,
              recordIdentifier: voucher.voucherNumber,
              changes: {
                locationId: { old: voucher.locationId, new: newLocation.id },
                locationName: { old: voucher.locationName, new: newLocation.name },
                reason: { new: "orphaned-records-reassign" },
              },
            },
            tx
          );
        }
        return { updated: vouchersToUpdate.length };
      });

      if ("missing" in outcome) {
        return res.status(400).json({ message: "Some vouchers not found or belong to different company" });
      }
      if ("closed" in outcome && outcome.closed) {
        const closedVouchers = outcome.closed.join(", ");
        return res.status(409).json({
          code: "ACCOUNTING_PERIOD_CLOSED",
          message: `These vouchers are in a closed period (closed through ${outcome.closedThrough}), so their location cannot be changed: ${closedVouchers}`,
          vouchers: outcome.closed,
        });
      }

      res.json({ success: true, updated: outcome.updated, newLocationName: newLocation.name });
    } catch (error: unknown) {
      logger.error("Error reassigning orphaned vouchers:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Delete all orphaned vouchers permanently
  app.delete("/api/orphaned-records/delete-all", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      logger.info("[DELETE-ALL] Starting delete-all for companyId:", { companyId: companyId });
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Find all orphaned vouchers (those with deleted or non-existent locations)
      // Must match the exact same query as GET /api/orphaned-records (NO deletedAt filter!)
      const orphanedVouchers = await db
        .select({
          id: vouchers.id,
          voucherNumber: vouchers.voucherNumber,
          locationId: vouchers.locationId,
          voucherCompanyId: vouchers.companyId,
        })
        .from(vouchers)
        .leftJoin(locations, eq(vouchers.locationId, locations.id))
        .where(
          and(
            eq(vouchers.companyId, companyId),
            sql`${vouchers.locationId} IS NOT NULL`,
            or(sql`${locations.id} IS NULL`, isNotNull(locations.deletedAt))
          )
        );

      logger.info("[DELETE-ALL] Found orphaned vouchers", { count: orphanedVouchers.length });
      if (orphanedVouchers.length > 0) {
        logger.info("[DELETE-ALL] First 3 vouchers", { sample: orphanedVouchers.slice(0, 3) });
      }

      if (orphanedVouchers.length === 0) {
        // Debug: check what vouchers exist for this company at all
        const allVouchers = await db
          .select({ id: vouchers.id, locationId: vouchers.locationId })
          .from(vouchers)
          .where(eq(vouchers.companyId, companyId))
          .limit(5);
        logger.info("[DELETE-ALL] Sample vouchers for company", { vouchers: allVouchers });
        return res.json({
          success: true,
          deleted: 0,
          message: "No orphaned vouchers found",
          debug: { companyId, sampleVouchers: allVouchers.length },
        });
      }

      const orphanedIds = orphanedVouchers.map((v) => v.id);
      logger.info("[DELETE-ALL] Deleting from related tables", { voucherCount: orphanedIds.length });

      // Use parameterized array binding (= ANY($1)) instead of string-interpolated IN list
      // to keep the query injection-safe even if the source of the IDs ever changes.
      // Wave 16 (A): the vouchers are retired (soft delete with their ledger
      // lines, audited in this transaction, numbers released), not
      // hard-deleted, and salary advances naming them are kept (an advance is
      // the employee's balance history). The stock document rows go as before.
      await db.transaction(async (tx) => {
        const oArr = sqlArray(orphanedIds);
        await tx.execute(sql`DELETE FROM stock_transfer_vouchers WHERE voucher_id = ANY(${oArr})`);
        await tx.execute(sql`DELETE FROM stock_adjustment_vouchers WHERE voucher_id = ANY(${oArr})`);
        await tx.execute(sql`DELETE FROM sales_items WHERE voucher_id = ANY(${oArr})`);
        await retireVouchersTx(tx, {
          companyId,
          voucherIds: orphanedIds,
          reason: "orphaned-records-delete-all",
          actor: sessionRetirementActor(req),
        });
      });

      res.json({ success: true, deleted: orphanedIds.length });
    } catch (error: unknown) {
      logger.error("Error deleting orphaned vouchers:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
