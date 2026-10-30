import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { logger } from "../../lib/logger";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import {
  isBonusCategoryDate, normalizeBonusCategory, parseBonusCategoryRate,
  resolveBonusCategoryRate, type ProductionBonusCategoryRateVersion,
} from "@shared/productionTargetBonusCategoryRates";

const guard = requireFactoryTabAccess("factory/stock-entry", "hide_tab_stockentry_production_targets");
const companyFor = (req: Request) => Number(req.session.factoryCompanyId || req.session.currentCompanyId) || null;
const allowed = (req: Request) =>
  ["Admin", "Owner"].includes(String(req.session.currentRole || req.user?.role || ""));

type StoredCategoryRate = ProductionBonusCategoryRateVersion & {
  note: string | null; requestKey: string; createdBy: string | null; createdAt: string;
};

type DbRate = {
  id: number | string; categoryKey: string; categoryLabel: string;
  effectiveFrom: string; enabled: boolean; ratePerExtraBale: string;
  note: string | null; requestKey: string; createdBy: string | null; createdAt: string;
};

async function readVersions(companyId: number): Promise<StoredCategoryRate[]> {
  const found = await db.execute(sql`
    SELECT id, category_key AS "categoryKey", category_label AS "categoryLabel",
           effective_from::text AS "effectiveFrom", enabled,
           rate_per_extra_bale::text AS "ratePerExtraBale",
           note, request_key AS "requestKey", created_by AS "createdBy",
           created_at::text AS "createdAt"
    FROM factory_production_target_bonus_category_rates
    WHERE company_id = ${companyId}
    ORDER BY effective_from DESC, id DESC
    LIMIT 3000
  `);
  return (resultRows(found) as DbRate[]).map(row => ({ ...row, id: Number(row.id) }));
}

export function registerProductionTargetBonusCategoryRateRoutes(app: Express): void {
  // This is settings-only. No worker-day/category attribution or payment logic
  // is changed until audited Phase 9–13 integration.
  app.get("/api/factory/production-target-bonuses/category-rates",
    requireAuth, guard, async (req: Request, res: Response) => {
      if (!allowed(req)) return res.status(403).json({ message: "Admin or Owner required" });
      const companyId = companyFor(req);
      if (!companyId) return res.status(400).json({ message: "Factory company required" });
      const asOf = req.query.asOf;
      if (!isBonusCategoryDate(asOf)) return res.status(400).json({ message: "Valid asOf date required" });
      try {
        const [versions, known] = await Promise.all([
          readVersions(companyId),
          db.execute(sql`
            -- Show the categories resolved for the selected Production
            -- Targets date, not every obsolete historic category ever used.
            WITH latest_defaults AS (
              SELECT DISTINCT ON (worker_id)
                worker_id, category
              FROM factory_worker_production_target_defaults
              WHERE company_id=${companyId} AND effective_from <= ${asOf}::date
              ORDER BY worker_id,effective_from DESC,id DESC
            ), assigned AS (
              SELECT COALESCE(
                CASE WHEN e.category_overridden THEN NULLIF(BTRIM(e.category),'') END,
                d.category,
                NULLIF(BTRIM(e.category),''),
                NULLIF(BTRIM(w.position),''),
                NULLIF(BTRIM(w.department),'')
              ) AS category
              FROM factory_workers w
              LEFT JOIN latest_defaults d ON d.worker_id=w.id
              LEFT JOIN factory_staff_tracking_entries e
                ON e.company_id=w.company_id AND e.person_id=w.id
                AND e.person_type='worker' AND e.page_type='production'
                AND e.period_type='daily' AND e.period_start=${asOf}::date
                AND e.period_end=${asOf}::date
              WHERE w.company_id=${companyId}
                AND (w.active=TRUE OR e.person_id IS NOT NULL)
            )
            SELECT DISTINCT category FROM assigned
            WHERE category IS NOT NULL AND BTRIM(category)<>''
            ORDER BY category LIMIT 1000
          `),
        ]);
        const catalog = new Map<string, string>();
        for (const row of resultRows(known) as Array<{ category: string }>) {
          const parsed = normalizeBonusCategory(row.category);
          if (parsed && !catalog.has(parsed.key)) catalog.set(parsed.key, parsed.label);
        }
        const categories = [...catalog].map(([key, label]) => ({
          categoryKey: key, categoryLabel: label,
          effective: resolveBonusCategoryRate(key, asOf, versions),
        })).sort((a, b) => a.categoryLabel.localeCompare(b.categoryLabel));
        res.setHeader("Cache-Control", "private, no-store");
        return res.json({
          currency: "USD", asOf, categories,
          history: versions, historyTruncated: versions.length >= 3000,
          configuredForPayments: false,
        });
      } catch (error) {
        logger.error("Cannot load Production Targets category rates", { error });
        return res.status(500).json({ message: "Cannot load category bonus rate settings" });
      }
    },
  );

  app.post("/api/factory/production-target-bonuses/category-rates",
    requireAuth, guard, async (req: Request, res: Response) => {
      if (!allowed(req)) return res.status(403).json({ message: "Admin or Owner required" });
      const companyId = companyFor(req);
      if (!companyId) return res.status(400).json({ message: "Factory company required" });
      const category = normalizeBonusCategory(req.body?.category);
      const effectiveFrom = req.body?.effectiveFrom;
      const enabled = req.body?.enabled;
      const rate = parseBonusCategoryRate(req.body?.ratePerExtraBale);
      const requestKey = req.body?.requestKey;
      const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
      if (!category || !isBonusCategoryDate(effectiveFrom) || typeof enabled !== "boolean" ||
          rate === null || (enabled && Number(rate) <= 0) ||
          typeof requestKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(requestKey) ||
          note.length > 500) {
        return res.status(400).json({ message: "Invalid category, date, rate, note or request key" });
      }
      try {
        const result = await db.transaction(async tx => {
          // Serialize rate changes with bonus payment/approval posting.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
          await tx.execute(sql`SELECT pg_advisory_xact_lock(7642, ${companyId})`);
          // Category rates may only be set for categories explicitly used by
          // Production Targets. Worker groups and arbitrary new labels are not rates.
          const knownCategories = resultRows(await tx.execute(sql`
            SELECT category FROM factory_staff_tracking_entries
            WHERE company_id=${companyId} AND page_type='production'
              AND category IS NOT NULL AND BTRIM(category)<>''
            UNION
            SELECT category FROM factory_worker_production_target_defaults
            WHERE company_id=${companyId} AND category IS NOT NULL AND BTRIM(category)<>''
          `)) as Array<{category:string}>;
          if (!knownCategories.some(row => normalizeBonusCategory(row.category)?.key === category.key))
            return {status:409,message:"Select an existing category from Production Targets"};
          const prior = resultRows(await tx.execute(sql`
            SELECT id, category_key AS "categoryKey",
                   effective_from::text AS "effectiveFrom", enabled,
                   rate_per_extra_bale::text AS "ratePerExtraBale", note
            FROM factory_production_target_bonus_category_rates
            WHERE company_id = ${companyId} AND request_key = ${requestKey}
            LIMIT 1
          `)) as Array<{
            id: number | string; categoryKey: string; effectiveFrom: string;
            enabled: boolean; ratePerExtraBale: string; note: string | null;
          }>;
          const previous = prior[0];
          if (previous) {
            if (previous.categoryKey !== category.key || previous.effectiveFrom !== effectiveFrom ||
                previous.enabled !== enabled || Number(previous.ratePerExtraBale) !== Number(rate) ||
                (previous.note ?? "") !== note) {
              return { status: 409, message: "requestKey already belongs to a different rate change" };
            }
            return { status: 200, versionId: Number(previous.id), replayed: true };
          }
          const inserted = resultRows(await tx.execute(sql`
            INSERT INTO factory_production_target_bonus_category_rates (
              company_id, category_key, category_label, effective_from,
              enabled, rate_per_extra_bale, note, request_key, created_by
            ) VALUES (
              ${companyId}, ${category.key}, ${category.label},
              ${effectiveFrom}::date, ${enabled}, ${rate},
              ${note || null}, ${requestKey}, ${String(req.session.userId ?? "")}
            ) RETURNING id
          `)) as Array<{ id: number | string }>;
          return { status: 201, versionId: Number(inserted[0].id), replayed: false };
        });
        if ("message" in result) return res.status(result.status).json({ message: result.message });
        return res.status(result.status).json({
          ...result, currency: "USD", category: category.label,
          appliedToHistoricalApprovals: false, configuredForPayments: false,
        });
      } catch (error) {
        logger.error("Cannot save Production Targets category rate", { error });
        return res.status(500).json({ message: "Cannot save category bonus rate" });
      }
    },
  );
}
