// Extracted from ./settings.ts
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

export const INITIAL_FACTORY_FEATURES = {
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

export function registerFactorySettingsRoutesPart1(app: Express, requireAuth: AuthMiddleware, db: AppDb) {
  app.get("/api/factory/non-bale-priority-items", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const [row] = await db
        .select({ extraSettings: factorySettings.extraSettings })
        .from(factorySettings)
        .where(eq(factorySettings.companyId, companyId));
      const flags = (row?.extraSettings ?? {}) as Record<string, unknown>;
      const productsResult = await db.execute(
        sql`SELECT id, code, article_code AS "articleCode", name, weight_per_bale_kg AS "weightKg" FROM factory_bale_products WHERE company_id=${companyId} AND deleted_at IS NULL ORDER BY name,id`
      );
      const products = Array.isArray(productsResult) ? productsResult : (productsResult as { rows: unknown[] }).rows;
      res.set("Cache-Control", "private, no-store");
      return res.json({
        selectedIds: Array.isArray(flags.nonBalePriorityProductIds) ? flags.nonBalePriorityProductIds : [],
        products,
        canEdit: ["Admin", "Developer"].includes(req.user?.role ?? ""),
      });
    } catch (error) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
  app.put(
    "/api/factory/non-bale-priority-items",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const ids = req.body?.selectedIds;
        if (
          !Array.isArray(ids) ||
          ids.length > 20000 ||
          ids.some((id: unknown) => !Number.isSafeInteger(id) || (id as number) <= 0)
        )
          return res.status(400).json({ message: "Invalid product IDs" });
        const selectedIds = [...new Set(ids as number[])].sort((a, b) => a - b);
        const result = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE},${companyId})`);
          const valid = await tx.execute(
            sql`SELECT id FROM factory_bale_products WHERE company_id=${companyId} AND deleted_at IS NULL AND id = ANY(ARRAY[${sql.join(
              selectedIds.map((id) => sql`${id}`),
              sql`,`
            )}]::int[])`
          );
          const found = Array.isArray(valid) ? valid : (valid as { rows: unknown[] }).rows;
          if (found.length !== selectedIds.length) return false;
          await tx
            .insert(factorySettings)
            .values({ companyId, extraSettings: { nonBalePriorityProductIds: selectedIds } })
            .onConflictDoUpdate({
              target: factorySettings.companyId,
              set: {
                extraSettings: sql`COALESCE(${factorySettings.extraSettings},'{}'::jsonb)||jsonb_build_object('nonBalePriorityProductIds',${JSON.stringify(selectedIds)}::jsonb)`,
              },
            });
          return true;
        });
        if (!result) return res.status(400).json({ message: "A selected product was not found for this company" });
        return res.json({ selectedIds });
      } catch (error) {
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

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
}
