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
import { factorySettings } from "@shared/schema";
import { registerFactorySettingsRoutesPart1, INITIAL_FACTORY_FEATURES } from "./registerFactorySettingsRoutesPart1";
export { INITIAL_FACTORY_FEATURES } from "./registerFactorySettingsRoutesPart1";

const UNSAFE_SETTINGS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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
          // Another request may create the settings row at the same time.
          // Do not overwrite the operational flag if that happens.
          const [created] = await db
            .insert(factorySettings)
            .values({
              companyId,
              ...INITIAL_FACTORY_FEATURES,
            })
            .onConflictDoNothing()
            .returning();
          settings =
            created ?? (await db.select().from(factorySettings).where(eq(factorySettings.companyId, companyId)))[0];
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

  registerFactorySettingsRoutesPart1(app, requireAuth, db);

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
      if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "monthlyProductionRowOrder")) {
        return res.status(403).json({ message: "Use the Monthly Production Matrix order endpoint." });
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
        // Build the patch from own entries (never bracket writes keyed by user
        // input) and drop prototype-shaped keys entirely.
        const allowedExtraKeys = new Set(extraKeys);
        updateData.extraSettings = Object.fromEntries(
          Object.entries(req.body as Record<string, unknown>).filter(
            ([key, value]) => allowedExtraKeys.has(key) && value !== undefined && !UNSAFE_SETTINGS_KEYS.has(key)
          )
        );
      }

      const [result] = await db
        .insert(factorySettings)
        .values({ companyId, ...updateData })
        .onConflictDoUpdate({
          target: factorySettings.companyId,
          set:
            extraKeys.length > 0
              ? {
                  ...updateData,
                  // Merge only supplied keys against the CURRENT DB row, not a
                  // stale prefetched copy. Keep the protected flag untouched.
                  extraSettings: sql`COALESCE(${factorySettings.extraSettings}, '{}'::jsonb) || ${JSON.stringify(updateData.extraSettings)}::jsonb`,
                }
              : updateData,
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
