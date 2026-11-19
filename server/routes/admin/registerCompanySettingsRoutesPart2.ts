// Extracted from ./companySettingsRoutes.ts to keep that module under the source-size cap.
import { HttpError } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { writeAuditEvent } from "../../services/audit";
import { auditLog, vouchers } from "@shared/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  ID_CHUNK_SIZE,
  NO_RESET_TO_UNDO_MESSAGE,
  RESET_AUDIT_TABLE,
  SOFT_RESET_IDENTIFIER,
  UNDO_RESET_IDENTIFIER,
  auditActor,
  auditPages,
  chunk,
  resetCompanyId,
  sendResetError,
  softResetMarker,
} from "./registerCompanySettingsRoutesPart1";
import { registerCompanySettingsRoutesPart3 } from "./registerCompanySettingsRoutesPart3";

export function registerCompanySettingsRoutesPart2(app: Express) {
  registerCompanySettingsRoutesPart3(app);

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
}
