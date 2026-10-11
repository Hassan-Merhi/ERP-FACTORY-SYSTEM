/**
 * adminRepairRoutes: AdminEquityRepair endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireRole } from "../../../auth";
import { computeRawBalance } from "../userManagementRoutes";
import { systemSettings } from "@shared/schema";
import { eq } from "drizzle-orm";
import { toMoney } from "../../../lib/money";

export function registerAdminEquityRepairRoutes(app: Express) {
  app.post("/api/admin/recalculate-equity-adjustment", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Compute raw balance server-side using the canonical formula.
      // Formula: newAdjustment = -rawBalance  →  rawBalance + newAdjustment = 0
      const rawBalance = await computeRawBalance(companyId);

      // Get current equity adjustment for the "previous" value in the response
      const settingKey = `equity_adjustment_${companyId}`;
      const existingAdjustment = await db.select().from(systemSettings).where(eq(systemSettings.key, settingKey));
      const currentAdjustment = existingAdjustment.length > 0 ? toMoney(existingAdjustment[0].value).toNumber() : 0;

      const newAdjustment = -rawBalance;

      // Atomic upsert — avoids race conditions and duplicate key errors
      await db
        .insert(systemSettings)
        .values({ key: settingKey, value: newAdjustment.toFixed(2) })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: newAdjustment.toFixed(2), updatedAt: new Date() },
        });

      res.json({
        success: true,
        message: `Equity adjustment updated. The import cycle balance should now be $0.`,
        previousAdjustment: currentAdjustment.toFixed(2),
        newAdjustment: newAdjustment.toFixed(2),
        balanceZeroed: rawBalance.toFixed(2),
      });
    } catch (error: unknown) {
      logger.error("Recalculate equity adjustment error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Recalculate equity adjustment for ALL companies in one operation.
  // Uses the identical formula as /api/stats/import-cycle-balance so each company
  // gets the exact same precision as the single-company endpoint.
  app.post("/api/admin/recalculate-equity-adjustment-all", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const allCompanies = await storage.getAllCompanies();

      // computeRawBalance is defined at module scope above — shared with single-company endpoint.
      // Kept as a placeholder comment for readability only.

      const results: Array<{
        companyId: number;
        companyName: string;
        rawBalance: number;
        newAdjustment: number | null;
        skipped: boolean;
      }> = [];

      for (const company of allCompanies) {
        const rawBalance = await computeRawBalance(company.id);
        const skipped = Math.abs(rawBalance) <= 0.01;
        const newAdjustment = skipped ? null : -rawBalance;

        if (!skipped) {
          const settingKey = `equity_adjustment_${company.id}`;
          await db
            .insert(systemSettings)
            .values({ key: settingKey, value: newAdjustment!.toFixed(2) })
            .onConflictDoUpdate({
              target: systemSettings.key,
              set: { value: newAdjustment!.toFixed(2), updatedAt: new Date() },
            });
        }

        results.push({ companyId: company.id, companyName: company.name, rawBalance, newAdjustment, skipped });
      }

      const adjustedCount = results.filter((r) => !r.skipped).length;
      const skippedCount = results.filter((r) => r.skipped).length;

      res.json({
        success: true,
        message: `Processed ${results.length} ${results.length === 1 ? "company" : "companies"} — ${adjustedCount} adjusted, ${skippedCount} already balanced.`,
        results,
      });
    } catch (error: unknown) {
      logger.error("Recalculate equity adjustment all error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
