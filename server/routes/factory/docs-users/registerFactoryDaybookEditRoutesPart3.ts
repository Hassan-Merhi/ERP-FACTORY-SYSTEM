// Extracted from ./daybookEditRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { errorStatus, getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryDaybookEntries } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { bonusSource, reverseBonusFromDaybook } from "./daybookEditPolicy";

export function registerFactoryDaybookEditRoutesPart3(app: Express) {
  // Bonus payments are source-backed financial claims, not disposable daybook text.
  // Delete from Daybook means post an exact offsetting Receipt, mark claim REVERSED,
  // and retain both voucher and daybook audit rows. Never hard-delete either claim.
  // DELETE /api/factory/daybook/entry/:id — non-financial entry deletion, or
  // audited payment reversal for Production Targets bonuses.
  app.delete("/api/factory/daybook/entry/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const session = req.session;
      const companyId = session.factoryCompanyId || session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const role = (session.currentRole || session.role || "").toLowerCase();
      if (!["admin", "owner", "developer"].includes(role)) {
        return res.status(403).json({ message: "Only Admin or Owner can delete bonus payments" });
      }
      const id = Number(req.params.id);
      if (isNaN(id) || id <= 0)
        return res
          .status(400)
          .json({ message: "Invalid entry ID — only real (non-synthetic) entries can be hard deleted" });

      const [entry] = await db
        .select()
        .from(factoryDaybookEntries)
        .where(and(eq(factoryDaybookEntries.id, id), eq(factoryDaybookEntries.companyId, companyId)));
      if (!entry) return res.status(404).json({ message: "Entry not found" });

      if (
        entry.txType === "PRODUCTION_TARGET_BONUS_REVERSAL" ||
        entry.txType === "PRODUCTION_TARGET_WEEKLY_BONUS_REVERSAL"
      ) {
        return res.status(409).json({ message: "Reversal audit entries cannot be deleted" });
      }
      const bonus = bonusSource(entry.referenceTable, entry.referenceId);
      if (bonus) {
        if (role !== "admin" && role !== "owner")
          return res.status(403).json({ message: "Only Admin or Owner can reverse bonuses" });
        const result = await reverseBonusFromDaybook(req, Number(companyId), bonus);
        return res.json({ success: true, retainedAudit: true, ...result });
      }
      if (entry.txType.startsWith("PRODUCTION_TARGET_")) {
        return res.status(409).json({ message: "Production bonus audit entries cannot be hard-deleted" });
      }
      if (entry.referenceTable === "vouchers" && entry.referenceId) {
        return res.status(400).json({ message: "Voucher-backed entries must be voided, not deleted" });
      }
      if (role === "owner")
        return res.status(403).json({
          message: "Only Admin or Developer can permanently delete non-financial entries",
        });

      await db.delete(factoryDaybookEntries).where(eq(factoryDaybookEntries.id, id));
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
