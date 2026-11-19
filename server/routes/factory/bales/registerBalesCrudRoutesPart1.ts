// Extracted from ./balesCrudRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { writeAuditEvent } from "../../../services/audit/auditService";
import {
  BaleStatusChangeRefusal,
  FACTORY_BALE_STATUS_CHANGES_VALUE_MESSAGE,
  isValueNeutralBaleStatusChange,
} from "../../../services/factory/baleStatusPolicy";
import { factoryBaleProductionAttributions, factoryBales } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
  ALLOWED,
  assertNoLiveLoadingLinkOutsideLoadingStatusTx,
  assertNotOnFinalizedOrderTx,
  baleWriteErrorResponse,
  deletePreStockBalesTx,
  lockPriorityScanQueueTx,
} from "./baleStatusWriteGuards";
import { registerBalesCrudRoutesPart5 } from "./registerBalesCrudRoutesPart5";

export function registerBalesCrudRoutesPart1(app: Express) {
  registerBalesCrudRoutesPart5(app);

  // Phase 19 C (F3): Admin/Owner; only value-neutral changes (baleStatusPolicy:
  // within finished goods, or within the pre-stock statuses); any other bale in
  // the set refuses the whole change (409, nothing written). One transaction
  // with one audit row per bale changed. DELETED (main #2134) deletes pre-stock
  // bales through the physical-deletion service; REMOVED and any revival of a
  // deleted bale are refused by the policy.
  app.patch(
    "/api/factory/bales/bulk-status",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { ids, status } = req.body;
        if (!Array.isArray(ids) || ids.length === 0)
          return res.status(400).json({ message: "ids must be a non-empty array" });
        if (!status || typeof status !== "string") return res.status(400).json({ message: "status is required" });
        if (!(ALLOWED as readonly string[]).includes(status))
          return res.status(400).json({ message: `Invalid status. Allowed: ${ALLOWED.join(", ")}` });
        const baleIds = [...new Set(ids.map(Number))];
        if (baleIds.some((id) => !Number.isInteger(id) || id <= 0))
          return res.status(400).json({ message: "ids must be bale ids" });
        if (baleIds.length > 200) return res.status(400).json({ message: "Provide 1–200 unique physical bale IDs" });

        const updated = await db.transaction(async (tx) => {
          await lockPriorityScanQueueTx(tx, companyId);
          if (status === "DELETED") {
            const removed = await deletePreStockBalesTx(
              tx,
              req,
              companyId,
              baleIds,
              "Physical bales deleted via bulk status change"
            );
            return removed.length;
          }
          const bales = await tx
            .select({
              id: factoryBales.id,
              status: factoryBales.status,
              deletedAt: factoryBales.deletedAt,
              referenceNumber: factoryBales.referenceNumber,
            })
            .from(factoryBales)
            .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, baleIds)))
            .for("update");
          const refused = bales
            .filter((bale) => !isValueNeutralBaleStatusChange(bale.status, status, bale.deletedAt))
            .map((bale) => ({ id: bale.id, from: bale.status, to: status }));
          if (refused.length > 0) throw new BaleStatusChangeRefusal(FACTORY_BALE_STATUS_CHANGES_VALUE_MESSAGE, refused);
          await assertNotOnFinalizedOrderTx(
            tx,
            companyId,
            status,
            bales.map((bale) => bale.id)
          );
          await assertNoLiveLoadingLinkOutsideLoadingStatusTx(
            tx,
            companyId,
            bales.map((bale) => bale.id),
            status
          );
          const changed = bales.filter((bale) => bale.status !== status);
          if (changed.length === 0) return 0;
          const now = new Date();
          await tx
            .update(factoryBales)
            .set({ status, updatedAt: now })
            .where(
              and(
                eq(factoryBales.companyId, companyId),
                inArray(
                  factoryBales.id,
                  changed.map((bale) => bale.id)
                )
              )
            );
          for (const bale of changed) {
            await writeAuditEvent(
              {
                userId: String(req.session.userId ?? "unknown"),
                username: req.session.username || String(req.session.userId ?? "unknown"),
                companyId,
                action: "update",
                tableName: "factory_bales",
                recordId: bale.id,
                recordIdentifier: bale.referenceNumber || `Bale #${bale.id}`,
                changes: { status: { old: bale.status, new: status }, source: { new: "bulk-status" } },
              },
              tx
            );
          }
          return changed.length;
        });

        res.json({ updated });
      } catch (error: unknown) {
        baleWriteErrorResponse(res, error);
      }
    }
  );

  // PATCH /api/factory/bales/bulk-date — update stock_entry_date for a set of bales
  app.patch("/api/factory/bales/bulk-date", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { ids, stockEntryDate } = req.body;
      if (!Array.isArray(ids) || ids.length === 0)
        return res.status(400).json({ message: "ids must be a non-empty array" });
      if (!stockEntryDate || typeof stockEntryDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stockEntryDate))
        return res.status(400).json({ message: "stockEntryDate must be YYYY-MM-DD" });

      const now = new Date();
      const result = await db.transaction(async (tx) => {
        const updatedBales = await tx
          .update(factoryBales)
          .set({ stockEntryDate, updatedAt: now })
          .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, ids.map(Number))))
          .returning({ id: factoryBales.id });

        const updatedIds = updatedBales.map((bale) => bale.id);
        if (updatedIds.length > 0) {
          await tx
            .update(factoryBaleProductionAttributions)
            .set({ stockEntryDate })
            .where(
              and(
                eq(factoryBaleProductionAttributions.companyId, companyId),
                inArray(factoryBaleProductionAttributions.baleId, updatedIds)
              )
            );
        }

        return updatedBales;
      });

      res.json({ updated: result.length });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
