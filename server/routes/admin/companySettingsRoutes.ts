import { getErrorMessage, HttpError, sendHttpError } from "../../lib/httpHandlers";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { firstRow } from "../../lib/queryResult";
import { toFiniteNumber } from "@shared/typeGuards";
import { logger } from "../../lib/logger";
import type { Express, Request, Response } from "express";
import { db, pool, type DbTransaction } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole } from "../../auth";
import { writeAuditEvent } from "../../services/audit";

import {
  stockItems,
  containers,
  vouchers,
  voucherEntries,
  ledgerAccounts,
  accountingPostingRequests,
  auditLog,
  fiscalPeriodClosures,
} from "@shared/schema";
import { eq, and, inArray, sql, isNull, desc } from "drizzle-orm";

/**
 * Both resets delete vouchers in bulk. The closed-period guard refuses any of
 * them dated inside closed books, which mid-loop would leave a partial reset,
 * so refuse up front instead.
 */
async function closedBooksResetRefusal(companyId: number): Promise<string | null> {
  const closures = await storage.getFiscalPeriodClosures(companyId);
  const closedThrough = closures
    .filter((closure) => closure.status === "CLOSED")
    .map((closure) => String(closure.periodEndDate))
    .sort()
    .pop();
  return closedThrough
    ? `This company's books are closed through ${closedThrough}. A data reset would delete closed-period vouchers, so it is not allowed.`
    : null;
}

// ── Wave 9 (ledger safety) ───────────────────────────────────────────────────
// The three reset routes rewrite a company's accounting history, so they are
// Owner-only, act on the session's company only, run in one transaction and
// leave an audit_log row that records what they removed or zeroed.

/** audit_log.table_name of every reset / undo record. */
const RESET_AUDIT_TABLE = "company_data_reset";
/** record_identifier of the hard reset (POST /api/admin/reset-company-data). */
const HARD_RESET_IDENTIFIER = "reset-company-data";
/** record_identifier of the soft reset (POST /api/admin/company-data-reset) that undo reverses. */
const SOFT_RESET_IDENTIFIER = "company-data-reset";
const UNDO_RESET_IDENTIFIER = "undo-company-reset";

const RESET_OTHER_COMPANY_MESSAGE = "You can only reset the company you are currently working in";
const NO_RESET_TO_UNDO_MESSAGE = "There is no company data reset to undo for this company";
const CLOSING_VOUCHER_MESSAGE = "A fiscal-period closing voucher cannot be deleted";

/** The audit sanitizer keeps 100 items per array; nest pages of 100 so up to 10,000 rows survive. */
const AUDIT_PAGE_SIZE = 100;
const AUDIT_MAX_ROWS = AUDIT_PAGE_SIZE * AUDIT_PAGE_SIZE;
/** Keeps every IN (...) list far below PostgreSQL's bind-parameter limit. */
const ID_CHUNK_SIZE = 5_000;

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < rows.length; index += size) pages.push(rows.slice(index, index + size));
  return pages;
}

function auditPages<T>(rows: readonly T[]): T[][] {
  return chunk(rows, AUDIT_PAGE_SIZE);
}

/**
 * The company a reset acts on: always the session's current company. The reset
 * page still sends a companyId; it is accepted only when it names that company.
 */
function resetCompanyId(req: Request): number {
  const companyId = req.session.currentCompanyId;
  if (!companyId) throw new HttpError(400, "No company selected");
  const requested = (req.body as { companyId?: unknown } | undefined)?.companyId;
  if (requested !== undefined && requested !== null && requested !== "" && Number(requested) !== companyId) {
    throw new HttpError(403, RESET_OTHER_COMPANY_MESSAGE);
  }
  return companyId;
}

function auditActor(req: Request) {
  return {
    userId: req.session.userId ?? "unknown",
    username: req.session.username || "unknown",
  };
}

/** Refuses (409) when any of the vouchers is the closing journal of a fiscal period. */
async function refuseClosingVouchers(tx: DbTransaction, voucherIds: readonly number[]): Promise<void> {
  for (const ids of chunk(voucherIds, ID_CHUNK_SIZE)) {
    const [closing] = await tx
      .select({ id: fiscalPeriodClosures.id })
      .from(fiscalPeriodClosures)
      .where(inArray(fiscalPeriodClosures.closingVoucherId, ids))
      .limit(1);
    if (closing) throw new HttpError(409, CLOSING_VOUCHER_MESSAGE);
  }
}

/** Closed-period trigger rejections become 409 (the transaction has rolled back); the rest go through sendHttpError. */
function sendResetError(res: Response, error: unknown, label: string) {
  const closedPeriod = closedPeriodErrorResponse(error);
  if (closedPeriod) return res.status(closedPeriod.status).json(closedPeriod.body);
  if (!(error instanceof HttpError)) logger.error(label, { error: error });
  return sendHttpError(res, error);
}

/** The soft reset's marker as written to its audit row, or null for a row without one. */
function softResetMarker(changes: unknown): { resetAt: Date; voucherIds: number[] | null } | null {
  const record = changes as Record<string, { old?: unknown; new?: unknown } | undefined> | null;
  const marker = record?.resetMarker?.new as { resetAt?: unknown; voucherCount?: unknown } | undefined;
  const resetAt = typeof marker?.resetAt === "string" ? new Date(marker.resetAt) : null;
  if (!resetAt || Number.isNaN(resetAt.getTime())) return null;
  const voucherCount = Number(marker?.voucherCount);
  const pages = record?.vouchers?.old;
  const voucherIds = Array.isArray(pages)
    ? pages.flatMap((page) => (Array.isArray(page) ? page : [])).map((row) => Number((row as { id?: unknown })?.id))
    : [];
  const complete =
    Number.isInteger(voucherCount) &&
    voucherIds.length === voucherCount &&
    voucherIds.every((id) => Number.isInteger(id) && id > 0);
  return { resetAt, voucherIds: complete ? voucherIds : null };
}

export function registerCompanySettingsRoutes(app: Express) {
  // Hard reset: deletes the company's Payment, Receipt and Journal vouchers and their lines.
  app.post("/api/admin/reset-company-data", requireAuth, requireRole("Owner"), async (req, res) => {
    try {
      const companyId = resetCompanyId(req);

      const company = await storage.getCompanyById(companyId);
      if (!company) {
        return res.status(400).json({ message: "Company not found." });
      }

      const closedRefusal = await closedBooksResetRefusal(companyId);
      if (closedRefusal) {
        return res.status(409).json({ message: closedRefusal, code: "ACCOUNTING_PERIOD_CLOSED" });
      }

      // Define voucher types to DELETE (Payment, Receipt, Journal - excluding POS, Production, Consumption, Stock Transfer)
      const voucherTypesToDelete = ["Payment", "Receipt", "Journal"];

      // One transaction for the whole reset: a refusal or failure part-way
      // (closed period, a referenced voucher) leaves every voucher in place.
      const outcome = await db.transaction(async (tx) => {
        const vouchersToDelete = await tx
          .select({
            id: vouchers.id,
            voucherType: vouchers.voucherType,
            voucherNumber: vouchers.voucherNumber,
            voucherDate: vouchers.voucherDate,
            totalAmount: vouchers.totalAmount,
          })
          .from(vouchers)
          .where(and(eq(vouchers.companyId, companyId), inArray(vouchers.voucherType, voucherTypesToDelete)))
          .orderBy(vouchers.id);
        const voucherIds = vouchersToDelete.map((v) => v.id);

        await refuseClosingVouchers(tx, voucherIds);

        let deletedEntryCount = 0;
        let deletedPostingRequestCount = 0;
        for (const ids of chunk(voucherIds, ID_CHUNK_SIZE)) {
          // Engine-posted vouchers keep a posting-request identity whose FK is
          // ON DELETE RESTRICT; drop it first, as
          // deleteInfrastructurePostingIdentityForVoucherTx does per voucher.
          const postingRequests = await tx
            .delete(accountingPostingRequests)
            .where(inArray(accountingPostingRequests.voucherId, ids))
            .returning({ id: accountingPostingRequests.id });
          deletedPostingRequestCount += postingRequests.length;
          // Then the lines, then the vouchers (respecting foreign keys).
          const entries = await tx
            .delete(voucherEntries)
            .where(inArray(voucherEntries.voucherId, ids))
            .returning({ id: voucherEntries.id });
          deletedEntryCount += entries.length;
          await tx.delete(vouchers).where(and(eq(vouchers.companyId, companyId), inArray(vouchers.id, ids)));
        }

        // Summary by type
        const typeSummary = voucherTypesToDelete.map((type) => ({
          type,
          count: vouchersToDelete.filter((v) => v.voucherType === type).length,
        }));

        await writeAuditEvent(
          {
            ...auditActor(req),
            companyId,
            action: "delete",
            tableName: RESET_AUDIT_TABLE,
            recordIdentifier: HARD_RESET_IDENTIFIER,
            changes: {
              summary: {
                old: {
                  deletedVouchers: vouchersToDelete.length,
                  deletedEntries: deletedEntryCount,
                  deletedPostingRequests: deletedPostingRequestCount,
                  typeSummary,
                  vouchersRecordedInFull: vouchersToDelete.length <= AUDIT_MAX_ROWS,
                },
              },
              vouchers: {
                old: auditPages(
                  vouchersToDelete.map((v) => ({
                    id: v.id,
                    voucherNumber: v.voucherNumber,
                    voucherType: v.voucherType,
                    voucherDate: v.voucherDate,
                    amount: v.totalAmount || "0",
                  }))
                ),
              },
            },
          },
          tx
        );

        return { deletedVoucherCount: vouchersToDelete.length, deletedEntryCount, typeSummary };
      });

      const { deletedVoucherCount, deletedEntryCount, typeSummary } = outcome;
      res.json({
        message: `Reset complete for ${company.name}. Deleted ${deletedVoucherCount} voucher(s) and ${deletedEntryCount} entries.`,
        deletedVouchers: deletedVoucherCount,
        deletedEntries: deletedEntryCount,
        typeSummary,
        preserved: [
          "Containers",
          "Container Offloads",
          "Inventory",
          "Locations",
          "Ledger Accounts",
          "POS Vouchers",
          "Production/Consumption/Stock Transfer Vouchers",
          "Purchase Orders",
        ],
      });
    } catch (error: unknown) {
      return sendResetError(res, error, "Reset company data error:");
    }
  });

  // System Settings - Parent Company (Admin + Developer only)
  app.get("/api/system/parent-company", requireAuth, async (req, res) => {
    try {
      const userRole = req.session.currentRole;
      if (userRole !== "Admin" && userRole !== "Developer") {
        return res.status(403).json({ message: "Only Admin users can access the parent company setting" });
      }
      const parentCompanyId = await storage.getParentCompanyId();
      res.json({ parentCompanyId });
    } catch (error: unknown) {
      logger.error("Get parent company error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/system/parent-company", requireAuth, async (req, res) => {
    try {
      // Only Admin can change parent company setting
      const userRole = req.session.currentRole;
      if (userRole !== "Admin" && userRole !== "Developer") {
        return res.status(403).json({ message: "Only Admin users can change the parent company setting" });
      }

      const { parentCompanyId } = req.body;

      // Validate parentCompanyId is null or a valid number
      if (parentCompanyId !== null && parentCompanyId !== undefined) {
        const numericId = typeof parentCompanyId === "string" ? parseInt(parentCompanyId, 10) : parentCompanyId;
        if (typeof numericId !== "number" || isNaN(numericId)) {
          return res.status(400).json({ message: "Invalid parent company ID: must be a number or null" });
        }

        // Validate the company exists
        const company = await storage.getCompanyById(numericId);
        if (!company) {
          return res.status(400).json({ message: "Company not found" });
        }

        await storage.setParentCompanyId(numericId);
        res.json({ success: true, parentCompanyId: numericId });
      } else {
        // Setting to null (clear the parent company)
        await storage.setParentCompanyId(null);
        res.json({ success: true, parentCompanyId: null });
      }
    } catch (error: unknown) {
      logger.error("Set parent company error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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

  // Undo Last Reset - Restore the vouchers the company's last soft reset deleted.
  //
  // Only that reset's vouchers come back: those whose deleted_at is exactly the
  // reset's timestamp (written as one value for the whole reset and recorded in
  // its audit row), further limited to the voucher ids the audit row lists when
  // it lists all of them. Vouchers deleted any other way keep their deletion.
  app.post("/api/admin/undo-company-reset", requireAuth, requireRole("Owner"), async (req, res) => {
    try {
      const companyId = resetCompanyId(req);

      const restoredCount = await db.transaction(async (tx) => {
        const [lastReset] = await tx
          .select({ id: auditLog.id, changes: auditLog.changes })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.companyId, companyId),
              eq(auditLog.tableName, RESET_AUDIT_TABLE),
              eq(auditLog.action, "delete"),
              eq(auditLog.recordIdentifier, SOFT_RESET_IDENTIFIER)
            )
          )
          .orderBy(desc(auditLog.id))
          .limit(1);
        const marker = lastReset ? softResetMarker(lastReset.changes) : null;
        if (!lastReset || !marker) throw new HttpError(404, NO_RESET_TO_UNDO_MESSAGE);

        const [alreadyUndone] = await tx
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.companyId, companyId),
              eq(auditLog.tableName, RESET_AUDIT_TABLE),
              eq(auditLog.action, "restore"),
              eq(auditLog.recordId, lastReset.id)
            )
          )
          .limit(1);
        if (alreadyUndone) throw new HttpError(404, NO_RESET_TO_UNDO_MESSAGE);

        const restored: number[] = [];
        const scopes = marker.voucherIds ? chunk(marker.voucherIds, ID_CHUNK_SIZE) : [null];
        for (const ids of scopes) {
          const rows = await tx
            .update(vouchers)
            .set({ deletedAt: null })
            .where(
              and(
                eq(vouchers.companyId, companyId),
                eq(vouchers.deletedAt, marker.resetAt),
                ...(ids ? [inArray(vouchers.id, ids)] : [])
              )
            )
            .returning({ id: vouchers.id });
          restored.push(...rows.map((row) => row.id));
        }

        await writeAuditEvent(
          {
            ...auditActor(req),
            companyId,
            action: "restore",
            tableName: RESET_AUDIT_TABLE,
            recordId: lastReset.id,
            recordIdentifier: UNDO_RESET_IDENTIFIER,
            changes: {
              vouchers: {
                old: { deletedAt: marker.resetAt.toISOString() },
                new: { deletedAt: null, vouchersRestored: restored.length, voucherIds: auditPages(restored) },
              },
            },
          },
          tx
        );
        return restored.length;
      });

      logger.info(`Undo reset completed for company ${companyId}: restored ${restoredCount} vouchers`);
      res.json({
        success: true,
        message: `Restored ${restoredCount} vouchers`,
        vouchersRestored: restoredCount,
      });
    } catch (error: unknown) {
      return sendResetError(res, error, "Undo company reset error:");
    }
  });

  app.get("/api/admin/deployment-diagnostics", requireAuth, requireRole("Admin", "Developer"), async (_req, res) => {
    try {
      const VALID_ROLES = `'Developer','Admin','Owner','Manager','POS','Normal User'`;
      const OLD_POS_ROLES = `'POS1','POS2','POS3','POS4','POS5','POS6'`;

      const [
        invalidRoleRows,
        posWithoutStation,
        posWithoutLocation,
        posWithoutCash,
        duplicateRoleRows,
        oldUserRoleRows,
        oldPosRoleRows,
        canDeleteCol,
        posStationCol,
      ] = await Promise.all([
        db.execute(`SELECT COUNT(*)::int AS n FROM user_company_roles WHERE role NOT IN (${VALID_ROLES})`),
        db.execute(`SELECT COUNT(*)::int AS n FROM user_company_roles WHERE role = 'POS' AND pos_station IS NULL`),
        db.execute(
          `SELECT COUNT(*)::int AS n FROM user_company_roles WHERE role = 'POS' AND assigned_location_id IS NULL`
        ),
        db.execute(`SELECT COUNT(*)::int AS n FROM user_company_roles WHERE role = 'POS' AND cash_account_id IS NULL`),
        db.execute(
          `SELECT COUNT(*)::int AS n FROM (
             SELECT user_id, company_id, COUNT(*) FROM user_company_roles
             GROUP BY user_id, company_id HAVING COUNT(*) > 1
           ) sub`
        ),
        db.execute(`SELECT COUNT(*)::int AS n FROM user_company_roles WHERE role = 'User'`),
        db.execute(`SELECT COUNT(*)::int AS n FROM user_company_roles WHERE role IN (${OLD_POS_ROLES})`),
        db.execute(
          `SELECT COUNT(*)::int AS n FROM information_schema.columns
           WHERE table_name = 'user_company_roles' AND column_name = 'can_delete_records'`
        ),
        db.execute(
          `SELECT COUNT(*)::int AS n FROM information_schema.columns
           WHERE table_name = 'user_company_roles' AND column_name = 'pos_station'`
        ),
      ]);

      const pick = (result: unknown) => toFiniteNumber(firstRow<{ n: number }>(result)?.n) ?? 0;

      res.json({
        timestamp: new Date().toISOString(),
        schema: {
          can_delete_records_column_exists: pick(canDeleteCol) > 0,
          pos_station_column_exists: pick(posStationCol) > 0,
        },
        roles: {
          invalid_role_count: pick(invalidRoleRows),
          old_user_role_count: pick(oldUserRoleRows),
          old_pos_role_count: pick(oldPosRoleRows),
        },
        pos_users: {
          without_pos_station: pick(posWithoutStation),
          without_assigned_location: pick(posWithoutLocation),
          without_cash_account: pick(posWithoutCash),
        },
        user_company_roles: {
          duplicate_user_company_pairs: pick(duplicateRoleRows),
        },
        health: {
          all_clear:
            pick(invalidRoleRows) === 0 &&
            pick(oldUserRoleRows) === 0 &&
            pick(oldPosRoleRows) === 0 &&
            pick(canDeleteCol) > 0 &&
            pick(posStationCol) > 0,
        },
      });
    } catch (error: unknown) {
      logger.error("[DeploymentDiag] Error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Fix orphaned RESERVED_FOR_ORDER bales ────────────────────────────────
  // Returns any bale stuck in RESERVED_FOR_ORDER that has no active customer
  // order (non-deleted, status LOADING / PENDING_VERIFICATION / VERIFIED)
  // referencing it back to IN_STOCK. Safe to run multiple times.

  app.post(
    "/api/admin/apply-missing-migrations",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (_req, res) => {
      const client = await pool.connect();
      const results: { sql: string; status: string; error?: string }[] = [];
      const statements = [
        `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS effective_date date`,
        `ALTER TABLE factory_daybook_entries ADD COLUMN IF NOT EXISTS effective_date date`,
        `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS shift_id integer`,
        `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS location_name text`,
        `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS exchange_rate numeric(20,6)`,
        `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS source_module text DEFAULT 'ERP'`,
        `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS is_credit_sale boolean DEFAULT false`,
        `CREATE TABLE IF NOT EXISTS stock_item_code_aliases (
        id serial PRIMARY KEY,
        company_id integer NOT NULL,
        stock_item_id integer NOT NULL,
        alias_code varchar(50) NOT NULL,
        description text,
        created_at timestamp NOT NULL DEFAULT now()
      )`,
        `CREATE UNIQUE INDEX IF NOT EXISTS stock_item_code_aliases_company_alias_unique ON stock_item_code_aliases (company_id, alias_code)`,
      ];
      try {
        // No lock_timeout — wait as long as needed to acquire the DDL lock
        await client.query(`SET lock_timeout = '0'`);
        await client.query(`SET statement_timeout = '300s'`);
        for (const stmt of statements) {
          const label = stmt.trim().substring(0, 80);
          try {
            await client.query(stmt);
            results.push({ sql: label, status: "ok" });
          } catch (err: unknown) {
            results.push({ sql: label, status: "error", error: getErrorMessage(err)?.split("\n")[0] });
          }
        }
        res.json({ success: true, results });
      } catch (err: unknown) {
        res.status(500).json({ success: false, message: getErrorMessage(err), results });
      } finally {
        client.release();
      }
    }
  );
}
