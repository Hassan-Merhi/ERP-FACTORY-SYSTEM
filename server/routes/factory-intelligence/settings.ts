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
import { requireRole } from "../../auth";
import { writeAuditEvent } from "../../services/audit";
import { PRIORITY_SCAN_LOCK_NAMESPACE } from "../factory/customer-orders/priorityScanQueue";
import { factorySettings } from "@shared/schema";

const INITIAL_FACTORY_FEATURES = {
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
} as const;

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


  app.get("/api/factory/non-bale-priority-items", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({message:"No company selected"});
      const [row] = await db.select({extraSettings:factorySettings.extraSettings}).from(factorySettings).where(eq(factorySettings.companyId,companyId));
      const flags = (row?.extraSettings ?? {}) as Record<string, unknown>;
      const productsResult = await db.execute(sql`SELECT id, code, article_code AS "articleCode", name, weight_per_bale_kg AS "weightKg" FROM factory_bale_products WHERE company_id=${companyId} AND deleted_at IS NULL ORDER BY name,id`);
      const products = Array.isArray(productsResult) ? productsResult : (productsResult as {rows:unknown[]}).rows;
      res.set("Cache-Control","private, no-store");
      return res.json({selectedIds: Array.isArray(flags.nonBalePriorityProductIds)?flags.nonBalePriorityProductIds:[], products, canEdit:["Admin","Developer"].includes(req.user?.role ?? "")});
    } catch(error){return res.status(500).json({message:getErrorMessage(error)});}
  });
  app.put("/api/factory/non-bale-priority-items",requireAuth,requireRole("Admin","Owner"),async(req:Request,res:Response)=>{
    try {
      const companyId=req.session.factoryCompanyId||req.session.currentCompanyId;
      if(!companyId)return res.status(400).json({message:"No company selected"});
      const ids=req.body?.selectedIds;
      if(!Array.isArray(ids)||ids.length>20000||ids.some((id:unknown)=>!Number.isSafeInteger(id)||(id as number)<=0))return res.status(400).json({message:"Invalid product IDs"});
      const selectedIds=[...new Set(ids as number[])].sort((a,b)=>a-b);
      const result=await db.transaction(async(tx)=>{
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE},${companyId})`);
        const valid=await tx.execute(sql`SELECT id FROM factory_bale_products WHERE company_id=${companyId} AND deleted_at IS NULL AND id = ANY(ARRAY[${sql.join(selectedIds.map(id=>sql`${id}`),sql`,`)}]::int[])`);
        const found=Array.isArray(valid)?valid:(valid as {rows:unknown[]}).rows;
        if(found.length!==selectedIds.length)return false;
        await tx.insert(factorySettings).values({companyId,extraSettings:{nonBalePriorityProductIds:selectedIds}}).onConflictDoUpdate({target:factorySettings.companyId,set:{extraSettings:sql`COALESCE(${factorySettings.extraSettings},'{}'::jsonb)||jsonb_build_object('nonBalePriorityProductIds',${JSON.stringify(selectedIds)}::jsonb)`}});
        return true;
      });
      if(!result)return res.status(400).json({message:"A selected product was not found for this company"});
      return res.json({selectedIds});
    } catch(error){return res.status(500).json({message:getErrorMessage(error)});}
  });

  // Unlike UI visibility flags, this operational switch can assign physical
  // bales to customer orders. It has a dedicated role-guarded write endpoint,
  // is scoped ONLY to the active session company, and defaults to OFF.
  app.get("/api/factory/automatic-priority-mode", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const [row] = await db
        .select({ extraSettings: factorySettings.extraSettings })
        .from(factorySettings)
        .where(eq(factorySettings.companyId, companyId))
        .limit(1);
      const flags = (row?.extraSettings ?? {}) as Record<string, unknown>;
      res.set("Cache-Control", "private, no-store");
      return res.json({
        enabled: flags.automaticPriorityPrintingEnabled === true,
        // Mirrors who can reach the write: the Factory Settings page owner
        // (accessLevel "admin" = Admin/Developer) in the backend access boundary.
        canEdit: ["Admin", "Developer"].includes(req.user?.role ?? ""),
      });
    } catch (error) {
      logger.error("Error reading automatic priority mode:", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put(
    "/api/factory/automatic-priority-mode",
    requireAuth,
    requireRole("Admin", "Owner"), // Developer is privileged by the shared middleware.
    async (req: Request, res: Response) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const body = req.body as Record<string, unknown> | undefined;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        typeof body.enabled !== "boolean"
      ) {
        return res.status(400).json({ message: "Expected exactly one boolean field: enabled" });
      }
      const enabled = body.enabled;
      try {
        const { changed } = await db.transaction(async (tx) => {
          // Serialize flag changes with Priority Scan allocations. Once disabled,
          // no future transaction can start a new automatic allocation.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
          const [current] = await tx
            .select({
              extraSettings: factorySettings.extraSettings,
            })
            .from(factorySettings)
            .where(eq(factorySettings.companyId, companyId))
            .for("update");

          const previouslyEnabled =
            ((current?.extraSettings ?? {}) as Record<string, unknown>).automaticPriorityPrintingEnabled === true;
          if (previouslyEnabled === enabled) return { changed: false };

          const patch = { automaticPriorityPrintingEnabled: enabled };
          const [saved] = await tx
            .insert(factorySettings)
            .values({ companyId, ...INITIAL_FACTORY_FEATURES, extraSettings: patch, updatedAt: new Date() })
            .onConflictDoUpdate({
              target: factorySettings.companyId,
              set: {
                // Atomic JSONB update prevents concurrent unrelated settings
                // changes from silently overwriting this flag.
                extraSettings: sql`COALESCE(${factorySettings.extraSettings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
                updatedAt: new Date(),
              },
            })
            .returning({ id: factorySettings.id });

          await writeAuditEvent(
            {
              userId: String(req.session.userId),
              username: String(req.session.username || req.session.userId),
              companyId,
              action: "settings_change",
              tableName: "factory_settings",
              recordId: saved.id,
              recordIdentifier: "automaticPriorityPrintingEnabled",
              changes: {
                automaticPriorityPrintingEnabled: { old: previouslyEnabled, new: enabled },
              },
            },
            tx
          );
          return { changed: true };
        });
        cache.del(`factory_settings:${companyId}`);
        res.set("Cache-Control", "private, no-store");
        return res.json({ enabled, changed });
      } catch (error) {
        logger.error("Error updating automatic priority mode:", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

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
