import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import {
  mondayOfProductionBonusWeek, parseWeeklyFlatBonusUsd,
  type ProductionBonusWeeklyMethodVersion,
  type ProductionBonusMethod,
} from "@shared/productionTargetBonusWeeklyMethod";
import { isBonusCategoryDate } from "@shared/productionTargetBonusCategoryRates";

const guard = requireFactoryTabAccess("factory/stock-entry", "hide_tab_stockentry_production_targets");
const canManage = (req: Request): boolean =>
  ["Admin", "Owner"].includes(String(req.session.currentRole || req.user?.role || ""));
const companyFor = (req: Request): number | null => {
  const id = Number(req.session.factoryCompanyId || req.session.currentCompanyId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
type WeeklyVersion = ProductionBonusWeeklyMethodVersion & {
  note: string | null; createdBy: string; createdAt: string;
};
type VersionRow = Omit<WeeklyVersion, "id"> & { id: number | string };

async function readVersions(companyId: number): Promise<WeeklyVersion[]> {
  const result = await db.execute(sql`
    SELECT id, effective_week::text AS "effectiveWeek", method,
           flat_bonus_usd::text AS "flatBonusUsd", note,
           created_by AS "createdBy", created_at::text AS "createdAt"
    FROM factory_production_target_bonus_weekly_methods
    WHERE company_id = ${companyId}
    ORDER BY effective_week DESC, id DESC
    LIMIT 1000
  `);
  return (resultRows(result) as VersionRow[]).map(row => ({ ...row, id: Number(row.id) }));
}

async function readEffective(companyId: number, weekStart: string): Promise<WeeklyVersion | null> {
  const result = await db.execute(sql`
    SELECT id, effective_week::text AS "effectiveWeek", method,
           flat_bonus_usd::text AS "flatBonusUsd", note,
           created_by AS "createdBy", created_at::text AS "createdAt"
    FROM factory_production_target_bonus_weekly_methods
    WHERE company_id = ${companyId} AND effective_week <= ${weekStart}::date
    ORDER BY effective_week DESC, id DESC
    LIMIT 1
  `);
  const row = (resultRows(result) as VersionRow[])[0];
  return row ? { ...row, id: Number(row.id) } : null;
}

/** Phase 12 ONLY: no weekly bonus calculations, approvals, vouchers or payroll claims. */
export function registerProductionTargetBonusWeeklyMethodRoutes(app: Express): void {
  app.get("/api/factory/production-target-bonuses/weekly-method",
    requireAuth, guard, async (req: Request, res: Response) => {
      if (!canManage(req)) return res.status(403).json({ message: "Admin or Owner required" });
      const companyId = companyFor(req);
      if (!companyId) return res.status(400).json({ message: "Factory company required" });
      const asOf = req.query.asOf;
      if (!isBonusCategoryDate(asOf))
        return res.status(400).json({ message: "Valid asOf production date required" });
      try {
        const weekStart = mondayOfProductionBonusWeek(asOf)!;
        const [history, current] = await Promise.all([
          readVersions(companyId), readEffective(companyId, weekStart),
        ]);
        res.setHeader("Cache-Control", "private, no-store");
        return res.json({
          currency: "USD", weekStartsOn: "Monday", asOf, weekStart,
          effective: current ?? {
            id: null, method: "per_extra_bale", flatBonusUsd: "0.00",
            effectiveWeek: null, default: true,
          },
          history, historyTruncated: history.length >= 1000,
          configuredForPayments: true,
          note: "Effective method settings control new weekly or daily reviews. Approval and Cash/Bank payment remain separate; previously posted entries are not rewritten.",
        });
      } catch (error) {
        logger.error("Failed to load Production Targets weekly bonus method", { error });
        return res.status(500).json({ message: "Cannot load weekly bonus settings" });
      }
    },
  );

  app.post("/api/factory/production-target-bonuses/weekly-method",
    requireAuth, guard, async (req: Request, res: Response) => {
      if (!canManage(req)) return res.status(403).json({ message: "Admin or Owner required" });
      const companyId = companyFor(req);
      if (!companyId) return res.status(400).json({ message: "Factory company required" });
      const method = req.body?.method as ProductionBonusMethod | undefined;
      const effectiveWeek: unknown = req.body?.effectiveWeek;
      const amount = parseWeeklyFlatBonusUsd(req.body?.flatBonusUsd);
      const note: unknown = req.body?.note ?? "";
      const requestKey: unknown = req.body?.requestKey;
      if ((method !== "per_extra_bale" && method !== "weekly_flat") ||
          !isBonusCategoryDate(effectiveWeek) ||
          mondayOfProductionBonusWeek(effectiveWeek) !== effectiveWeek ||
          amount === null ||
          (method === "weekly_flat" && Number(amount) <= 0) ||
          (method === "per_extra_bale" && Number(amount) !== 0) ||
          typeof note !== "string" || note.length > 500 ||
          typeof requestKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(requestKey)) {
        return res.status(400).json({
          message: "Select a Monday, per-extra-bale or weekly-flat method, a valid USD amount and request key",
        });
      }
      try {
        const saved = await db.transaction(async tx => {
          // Order locks consistently with weekly and daily award decisions.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
          await tx.execute(sql`SELECT pg_advisory_xact_lock(7643, ${companyId})`);
          const existing = resultRows(await tx.execute(sql`
            SELECT id, method, effective_week::text AS "effectiveWeek",
                   flat_bonus_usd::text AS "flatBonusUsd", note
            FROM factory_production_target_bonus_weekly_methods
            WHERE company_id = ${companyId} AND request_key = ${requestKey}
            LIMIT 1
          `)) as Array<{
            id: number | string; method: ProductionBonusMethod; effectiveWeek: string;
            flatBonusUsd: string; note: string | null;
          }>;
          const previous = existing[0];
          if (previous) {
            if (previous.method !== method || previous.effectiveWeek !== effectiveWeek ||
                previous.flatBonusUsd !== amount || (previous.note ?? "") !== note)
              return { status: 409, message: "requestKey was already used for another change" };
            return { status: 200, versionId: Number(previous.id), replayed: true };
          }
          // A backdated method version could retroactively change an already
          // reviewed week's choice. Require a future week instead.
          const lockedWeeks = resultRows(await tx.execute(sql`
            SELECT 1 FROM factory_target_bonus_weekly_reviews
            WHERE company_id = ${companyId}
              AND week_start >= ${effectiveWeek}::date LIMIT 1
          `));
          if (lockedWeeks.length)
            return { status: 409, message: "A reviewed weekly bonus exists on or after this date; choose a later effective Monday" };

          const created = resultRows(await tx.execute(sql`
            INSERT INTO factory_production_target_bonus_weekly_methods (
              company_id, effective_week, method, flat_bonus_usd, note, request_key, created_by
            ) VALUES (
              ${companyId}, ${effectiveWeek}::date, ${method}, ${amount},
              ${note || null}, ${requestKey}, ${String(req.session.userId || "")}
            ) RETURNING id
          `)) as Array<{ id: number | string }>;
          return { status: 201, versionId: Number(created[0].id), replayed: false };
        });
        if ("message" in saved) return res.status(saved.status).json({ message: saved.message });
        res.setHeader("Cache-Control", "private, no-store");
        return res.status(saved.status).json({
          ...saved, currency: "USD", method, effectiveWeek, flatBonusUsd: amount,
          configuredForPayments: true, historicalReviewsUnaffected: true,
        });
      } catch (error) {
        logger.error("Failed to save Production Targets weekly bonus method", { error });
        return res.status(500).json({ message: "Cannot save weekly bonus settings" });
      }
    },
  );
}
