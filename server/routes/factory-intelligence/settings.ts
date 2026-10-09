/**
 * factoryIntelligenceRoutes: FactorySettings endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import type { AppDb, AuthMiddleware } from "../routeBoundaryTypes";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { cache } from "../../lib/simpleCache";
import { eq, sql } from "drizzle-orm";
import { PRIORITY_SCAN_LOCK_NAMESPACE } from "../factory/customer-orders/priorityScanQueue";
import { factorySettings } from "@shared/schema";

export function registerFactorySettingsRoutes(app: Express, requireAuth: AuthMiddleware, db: AppDb) {
  // ───────────────────────────────────────────────
  // 1. Settings CRUD
  // ───────────────────────────────────────────────

  app.get("/api/factory/settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const result = await cache(`factory_settings:${companyId}`, 30_000, async () => {
        let [settings] = await db.select().from(factorySettings).where(eq(factorySettings.companyId, companyId));

        if (!settings) {
          [settings] = await db
            .insert(factorySettings)
            .values({
              companyId,
              dashboardEnabled: true,
              kpisEnabled: true,
              profitabilityEnabled: true,
              alertsEnabled: true,
              supplierScoringEnabled: true,
              mixOptimizerEnabled: true,
              traceabilityEnabled: true,
              balePhotosEnabled: true,
              wasteTrackingEnabled: true,
              cashflowEnabled: true,
              rolesEnabled: true,
              netProfitEnabled: true,
              productionSummaryEnabled: true,
              supplierReportEnabled: true,
              supplierStatementEnabled: true,
            })
            .returning();
        }

        // Spread extraSettings so clients see all flags as top-level fields
        const extra = settings.extraSettings ?? {};
        return { ...settings, ...extra };
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching factory settings:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Dedicated, company-scoped operational switch. Unlike ordinary UI visibility
  // flags, changing this one affects allocation and must be serialized with
  // Priority Scan writers. OFF never reverses allocations already recorded.
  app.get("/api/factory/automatic-priority-mode", requireAuth, async (req: Request, res: Response) => {
    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    const [row] = await db.select({ extraSettings: factorySettings.extraSettings })
      .from(factorySettings).where(eq(factorySettings.companyId, companyId));
    const flags = (row?.extraSettings || {}) as Record<string, unknown>;
    res.set("Cache-Control", "private, no-store");
    return res.json({ enabled: flags.automaticPriorityPrintingEnabled === true });
  });

  app.put("/api/factory/automatic-priority-mode", requireAuth, async (req: Request, res: Response) => {
    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    const role = String(req.session.currentRole || req.session.role || req.user?.role || "").toLowerCase();
    if (!["admin", "owner", "developer"].includes(role)) return res.status(403).json({ message: "Access denied" });
    if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ message: "enabled must be boolean" });
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
        const [row] = await tx.select({ extraSettings: factorySettings.extraSettings })
          .from(factorySettings).where(eq(factorySettings.companyId, companyId)).for("update");
        const extraSettings = { ...((row?.extraSettings || {}) as Record<string, unknown>),
          automaticPriorityPrintingEnabled: req.body.enabled };
        await tx.insert(factorySettings).values({ companyId, extraSettings, updatedAt: new Date() })
          .onConflictDoUpdate({ target: factorySettings.companyId, set: { extraSettings, updatedAt: new Date() } });
      });
      cache.del(`factory_settings:${companyId}`);
      return res.json({ enabled: req.body.enabled });
    } catch (error) {
      logger.error("Error updating automatic priority mode:", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Known DB columns — everything else goes into extraSettings JSONB
  const KNOWN_SETTINGS_COLUMNS = new Set([
    "companyId",
    "dashboardEnabled",
    "kpisEnabled",
    "profitabilityEnabled",
    "alertsEnabled",
    "supplierScoringEnabled",
    "mixOptimizerEnabled",
    "traceabilityEnabled",
    "balePhotosEnabled",
    "wasteTrackingEnabled",
    "cashflowEnabled",
    "rolesEnabled",
    "netProfitEnabled",
    "productionSummaryEnabled",
    "supplierReportEnabled",
    "supplierStatementEnabled",
    "laborCostPerKg",
    "overheadPerKg",
    "hideSellingPrice",
    "hideAvgCost",
  ]);

  app.put("/api/factory/settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "automaticPriorityPrintingEnabled")) {
        return res.status(403).json({ message: "Use the protected Automatic Priority Mode endpoint." });
      }
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const {
        dashboardEnabled,
        kpisEnabled,
        profitabilityEnabled,
        alertsEnabled,
        supplierScoringEnabled,
        mixOptimizerEnabled,
        traceabilityEnabled,
        balePhotosEnabled,
        wasteTrackingEnabled,
        cashflowEnabled,
        rolesEnabled,
        netProfitEnabled,
        productionSummaryEnabled,
        supplierReportEnabled,
        supplierStatementEnabled,
        laborCostPerKg,
        overheadPerKg,
        hideSellingPrice,
        hideAvgCost,
      } = req.body;

      const updateData: Partial<typeof factorySettings.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
      if (dashboardEnabled !== undefined) updateData.dashboardEnabled = dashboardEnabled;
      if (kpisEnabled !== undefined) updateData.kpisEnabled = kpisEnabled;
      if (profitabilityEnabled !== undefined) updateData.profitabilityEnabled = profitabilityEnabled;
      if (alertsEnabled !== undefined) updateData.alertsEnabled = alertsEnabled;
      if (supplierScoringEnabled !== undefined) updateData.supplierScoringEnabled = supplierScoringEnabled;
      if (mixOptimizerEnabled !== undefined) updateData.mixOptimizerEnabled = mixOptimizerEnabled;
      if (traceabilityEnabled !== undefined) updateData.traceabilityEnabled = traceabilityEnabled;
      if (balePhotosEnabled !== undefined) updateData.balePhotosEnabled = balePhotosEnabled;
      if (wasteTrackingEnabled !== undefined) updateData.wasteTrackingEnabled = wasteTrackingEnabled;
      if (cashflowEnabled !== undefined) updateData.cashflowEnabled = cashflowEnabled;
      if (rolesEnabled !== undefined) updateData.rolesEnabled = rolesEnabled;
      if (netProfitEnabled !== undefined) updateData.netProfitEnabled = netProfitEnabled;
      if (productionSummaryEnabled !== undefined) updateData.productionSummaryEnabled = productionSummaryEnabled;
      if (supplierReportEnabled !== undefined) updateData.supplierReportEnabled = supplierReportEnabled;
      if (supplierStatementEnabled !== undefined) updateData.supplierStatementEnabled = supplierStatementEnabled;
      if (laborCostPerKg !== undefined) updateData.laborCostPerKg = String(laborCostPerKg);
      if (overheadPerKg !== undefined) updateData.overheadPerKg = String(overheadPerKg);
      if (hideSellingPrice !== undefined) updateData.hideSellingPrice = hideSellingPrice;
      if (hideAvgCost !== undefined) updateData.hideAvgCost = hideAvgCost;

      // Collect any extra boolean/string settings into extraSettings JSONB
      const extraKeys = Object.keys(req.body).filter(
        (k) => !KNOWN_SETTINGS_COLUMNS.has(k) && k !== "id" && k !== "updatedAt" && k !== "extraSettings"
      );
      if (extraKeys.length > 0) {
        // Fetch current extraSettings to merge
        const [current] = await db
          .select({ extraSettings: factorySettings.extraSettings })
          .from(factorySettings)
          .where(eq(factorySettings.companyId, companyId));
        const currentExtra = (current?.extraSettings ?? {}) as Record<string, unknown>;
        const newExtra: Record<string, unknown> = { ...currentExtra };
        for (const key of extraKeys) {
          if (req.body[key] !== undefined) newExtra[key] = req.body[key];
        }
        updateData.extraSettings = newExtra;
      }

      const [result] = await db
        .insert(factorySettings)
        .values({ companyId, ...updateData })
        .onConflictDoUpdate({
          target: factorySettings.companyId,
          set: updateData,
        })
        .returning();

      const resultExtra = result.extraSettings ?? {};
      cache.del(`factory_settings:${companyId}`);
      res.json({ ...result, ...resultExtra });
    } catch (error: unknown) {
      logger.error("Error updating factory settings:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 2. Dashboard
  // ───────────────────────────────────────────────
}
