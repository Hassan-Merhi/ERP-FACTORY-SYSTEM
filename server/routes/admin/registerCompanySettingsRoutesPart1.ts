// Extracted from ./companySettingsRoutes.ts to keep that module under the source-size cap.
import { getErrorMessage, HttpError, sendHttpError } from "../../lib/httpHandlers";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { logger } from "../../lib/logger";
import type { Express, Request, Response } from "express";
import { db, type DbTransaction } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole } from "../../auth";
import { writeAuditEvent } from "../../services/audit";
import { accountingPostingRequests, fiscalPeriodClosures, voucherEntries, vouchers } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Both resets delete vouchers in bulk. The closed-period guard refuses any of
 * them dated inside closed books, which mid-loop would leave a partial reset,
 * so refuse up front instead.
 */
export async function closedBooksResetRefusal(companyId: number): Promise<string | null> {
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
export const RESET_AUDIT_TABLE = "company_data_reset";

/** record_identifier of the hard reset (POST /api/admin/reset-company-data). */
const HARD_RESET_IDENTIFIER = "reset-company-data";

/** record_identifier of the soft reset (POST /api/admin/company-data-reset) that undo reverses. */
export const SOFT_RESET_IDENTIFIER = "company-data-reset";

export const UNDO_RESET_IDENTIFIER = "undo-company-reset";

const RESET_OTHER_COMPANY_MESSAGE = "You can only reset the company you are currently working in";

export const NO_RESET_TO_UNDO_MESSAGE = "There is no company data reset to undo for this company";

const CLOSING_VOUCHER_MESSAGE = "A fiscal-period closing voucher cannot be deleted";

/** The audit sanitizer keeps 100 items per array; nest pages of 100 so up to 10,000 rows survive. */
const AUDIT_PAGE_SIZE = 100;

export const AUDIT_MAX_ROWS = AUDIT_PAGE_SIZE * AUDIT_PAGE_SIZE;

/** Keeps every IN (...) list far below PostgreSQL's bind-parameter limit. */
export const ID_CHUNK_SIZE = 5_000;

export function chunk<T>(rows: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < rows.length; index += size) pages.push(rows.slice(index, index + size));
  return pages;
}

export function auditPages<T>(rows: readonly T[]): T[][] {
  return chunk(rows, AUDIT_PAGE_SIZE);
}

/**
 * The company a reset acts on: always the session's current company. The reset
 * page still sends a companyId; it is accepted only when it names that company.
 */
export function resetCompanyId(req: Request): number {
  const companyId = req.session.currentCompanyId;
  if (!companyId) throw new HttpError(400, "No company selected");
  const requested = (req.body as { companyId?: unknown } | undefined)?.companyId;
  if (requested !== undefined && requested !== null && requested !== "" && Number(requested) !== companyId) {
    throw new HttpError(403, RESET_OTHER_COMPANY_MESSAGE);
  }
  return companyId;
}

export function auditActor(req: Request) {
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
export function sendResetError(res: Response, error: unknown, label: string) {
  const closedPeriod = closedPeriodErrorResponse(error);
  if (closedPeriod) return res.status(closedPeriod.status).json(closedPeriod.body);
  if (!(error instanceof HttpError)) logger.error(label, { error: error });
  return sendHttpError(res, error);
}

/** The soft reset's marker as written to its audit row, or null for a row without one. */
export function softResetMarker(changes: unknown): { resetAt: Date; voucherIds: number[] | null } | null {
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

export function registerCompanySettingsRoutesPart1(app: Express) {
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
}
