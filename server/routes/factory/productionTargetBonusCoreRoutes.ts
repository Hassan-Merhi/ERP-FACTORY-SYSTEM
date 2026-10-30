import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import {
  calculateProductionTargetBonusDay,
  resolveProductionTargetBonusRate,
  summarizeProductionTargetBonusDays,
  type ProductionTargetBonusRate,
  type ProductionTargetBonusWorker,
} from "@shared/factoryProductionTargetBonusCore";

/** READ-ONLY previews and append-only settings. No bonuses are posted here. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const companyFor = (req: Request) => Number(req.session.factoryCompanyId || req.session.currentCompanyId) || null;
function hasBonusAccess(req: Request, res: Response): boolean {
  const role = String(req.session.currentRole || req.user?.role || "");
  if (["Admin", "Owner", "Developer"].includes(role) || Number(req.session.factoryAdminOverrideUntil || 0) > Date.now()) return true;
  res.status(403).json({ message: "Admin or owner authorization required" });
  return false;
}
function parseDate(value: unknown): string | null {
  if (typeof value !== "string" || !DATE_RE.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.toISOString().slice(0, 10) === value ? value : null;
}
function todayBeirut() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Beirut", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return part("year") + "-" + part("month") + "-" + part("day");
}
function rangeFrom(query: Request["query"]) {
  const startDate = parseDate(query.startDate);
  const endDate = parseDate(query.endDate);
  if (!startDate || !endDate || startDate > endDate || endDate > todayBeirut()) return null;
  const days: string[] = [];
  for (let day = startDate; day <= endDate;) {
    if (days.length >= 84) return null;
    days.push(day);
    const next = new Date(day + "T12:00:00Z");
    next.setUTCDate(next.getUTCDate() + 1);
    day = next.toISOString().slice(0, 10);
  }
  return { startDate, endDate, days };
}
function parseRate(input: unknown): string | null {
  if (typeof input !== "number" && typeof input !== "string") return null;
  if (!/^\d{1,5}(\.\d{1,4})?$/.test(String(input))) return null;
  const value = new Decimal(String(input));
  return value.greaterThan(10000) ? null : value.toFixed(4);
}
type RawRule = {
  id: number | string; scope: "company" | "worker"; workerId: number | string | null;
  effectiveFrom: string; enabled: boolean; ratePerExtraBale: string;
  note: string | null; createdBy: string | null; createdAt: string;
};
type RateWithHistory = ProductionTargetBonusRate & Pick<RawRule, "note" | "createdBy" | "createdAt">;
async function readRates(companyId: number): Promise<RateWithHistory[]> {
  const found = await db.execute(sql`
    SELECT id, scope, worker_id AS "workerId", effective_from::text AS "effectiveFrom",
           enabled, rate_per_extra_bale::text AS "ratePerExtraBale", note,
           created_by AS "createdBy", created_at::text AS "createdAt"
    FROM factory_production_target_bonus_rates WHERE company_id = ${companyId}
    ORDER BY effective_from DESC, id DESC
  `);
  return (resultRows(found) as RawRule[]).map((row) => ({
    ...row, id: Number(row.id), workerId: row.workerId == null ? null : Number(row.workerId),
  }));
}
type SnapshotRow = {
  date: string; workerId: number | string; workerName: string; employeeCode: string | null;
  category: string | null; status: string; targetBales: string | null; producedBales: string | null;
};
type LinkRow = { id: number | string; fromDate: string; toDate: string | null; workerIds: number[] | string };
export function registerProductionTargetBonusCoreRoutes(app: Express): void {
  app.get("/api/factory/production-target-bonuses/preview", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = companyFor(req);
      if (!companyId) return res.status(400).json({ message: "No factory company selected" });
      if (!hasBonusAccess(req, res)) return;
      const range = rangeFrom(req.query);
      if (!range) return res.status(400).json({ message: "Select past/present dates, up to 84 days" });

      const [closures, source, linkResult, rates] = await Promise.all([
        db.execute(sql`SELECT period_start::text AS date FROM factory_staff_tracking_period_closures
          WHERE company_id = ${companyId} AND page_type = 'production' AND period_type = 'daily'
            AND period_start = period_end AND period_start BETWEEN ${range.startDate}::date AND ${range.endDate}::date`),
        db.execute(sql`
          SELECT e.period_start::text AS date, e.person_id AS "workerId",
                 w.full_name AS "workerName", w.employee_code AS "employeeCode",
                 e.category, e.status, e.target_bales::text AS "targetBales",
                 e.produced_bales::text AS "producedBales"
          FROM factory_staff_tracking_entries e
          JOIN factory_staff_tracking_period_closures c
            ON c.company_id = e.company_id AND c.page_type = 'production'
           AND c.period_type = 'daily' AND c.period_start = e.period_start AND c.period_end = e.period_end
          JOIN factory_workers w ON w.id = e.person_id AND w.company_id = e.company_id
          WHERE e.company_id = ${companyId} AND e.page_type = 'production'
            AND e.period_type = 'daily' AND e.person_type = 'worker'
            AND e.period_start = e.period_end
            AND e.period_start BETWEEN ${range.startDate}::date AND ${range.endDate}::date
          ORDER BY e.period_start, e.person_id
        `),
        db.execute(sql`
          SELECT l.id, l.effective_from::text AS "fromDate", l.effective_to::text AS "toDate",
                 ARRAY_AGG(m.worker_id ORDER BY m.worker_id) AS "workerIds"
          FROM factory_worker_production_links l
          JOIN factory_worker_production_link_members m ON m.link_id = l.id AND m.company_id = l.company_id
          JOIN factory_workers w ON w.id = m.worker_id AND w.company_id = l.company_id
          WHERE l.company_id = ${companyId} AND l.effective_from <= ${range.endDate}::date
            AND (l.effective_to IS NULL OR l.effective_to > ${range.startDate}::date)
          GROUP BY l.id, l.effective_from, l.effective_to
        `),
        readRates(companyId),
      ]);
      const closed = new Set((resultRows(closures) as Array<{ date: string }>).map((row) => row.date));
      const byDay = new Map<string, ProductionTargetBonusWorker[]>();
      for (const row of resultRows(source) as SnapshotRow[]) {
        const list = byDay.get(row.date) ?? [];
        list.push({
          workerId: Number(row.workerId), workerName: row.workerName,
          employeeCode: row.employeeCode, category: row.category,
          status: row.status === "Absent" || row.status === "New" ? row.status : "Present",
          targetBales: row.targetBales == null ? null : Number(row.targetBales),
          producedBales: row.producedBales == null ? null : Number(row.producedBales),
        });
        byDay.set(row.date, list);
      }
      const links = (resultRows(linkResult) as LinkRow[]).map((row) => ({
        id: Number(row.id), fromDate: row.fromDate, toDate: row.toDate,
        workerIds: (Array.isArray(row.workerIds) ? row.workerIds : String(row.workerIds).replace(/[{}]/g, "").split(","))
          .map(Number).filter((id) => Number.isSafeInteger(id) && id > 0),
      }));
      const days = range.days.map((date) => calculateProductionTargetBonusDay({
        date, finalized: closed.has(date),
        workers: byDay.get(date) ?? [],
        links: closed.has(date) ? links.filter(
          (link) => link.fromDate <= date && (!link.toDate || link.toDate > date),
        ).map(({ id, workerIds }) => ({ id, workerIds })) : [],
      }, rates));
      const workers = summarizeProductionTargetBonusDays(days);
      const total = days.reduce((sum, day) => sum.plus(day.proposedBonusUsd), new Decimal(0));
      res.json({
        currency: "USD", calculationVersion: "production-target-bonus-v1",
        startDate: range.startDate, endDate: range.endDate,
        source: "finalized-production-targets-daily",
        proposalOnly: true, canApprove: false, canPost: false,
        totalProposedBonusUsd: total.toFixed(2),
        finalizedDays: days.filter((d) => d.finalized).length,
        blockedDays: days.filter((d) => !d.payoutReady).length,
        days, workers,
      });
    } catch (error: unknown) {
      logger.error("[ProductionTargetBonus] preview failure", { error });
      res.status(500).json({ message: "Could not calculate production bonuses" });
    }
  });

  app.get("/api/factory/production-target-bonuses/settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = companyFor(req);
      if (!companyId) return res.status(400).json({ message: "No factory company selected" });
      if (!hasBonusAccess(req, res)) return;
      const asOf = req.query.asOf ? parseDate(req.query.asOf) : todayBeirut();
      if (!asOf) return res.status(400).json({ message: "Invalid asOf date" });
      const rates = await readRates(companyId);
      const uniqueWorkers = [...new Set(rates.flatMap((rate) => rate.workerId == null ? [] : [rate.workerId]))];
      res.json({
        currency: "USD", asOf,
        companyRate: resolveProductionTargetBonusRate(0, asOf, rates),
        workerRates: uniqueWorkers.map((workerId) => ({
          workerId, effective: resolveProductionTargetBonusRate(workerId, asOf, rates),
        })),
        history: rates.slice(0, 500), historyTruncated: rates.length > 500,
        payoutsEnabled: false,
      });
    } catch (error: unknown) {
      logger.error("[ProductionTargetBonus] settings read failure", { error });
      res.status(500).json({ message: "Could not load production bonus settings" });
    }
  });

  app.post("/api/factory/production-target-bonuses/settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = companyFor(req);
      if (!companyId) return res.status(400).json({ message: "No factory company selected" });
      if (!hasBonusAccess(req, res)) return;
      const scope = String(req.body?.scope ?? "");
      const workerId = scope === "worker" ? Number(req.body?.workerId) : null;
      const effectiveFrom = parseDate(req.body?.effectiveFrom);
      const enabled = req.body?.enabled;
      const rate = parseRate(req.body?.ratePerExtraBale);
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : "";
      const requestKey = String(req.body?.requestKey ?? "").trim();
      if (
        !["company", "worker"].includes(scope) || !effectiveFrom || typeof enabled !== "boolean" ||
        rate === null || !/^[A-Za-z0-9_-]{8,128}$/.test(requestKey) ||
        (scope === "company" && req.body?.workerId != null) ||
        (scope === "worker" && (!Number.isSafeInteger(workerId) || (workerId ?? 0) <= 0))
      ) return res.status(400).json({ message: "Invalid rate setting (scope, workerId, date, enabled, rate or requestKey)" });

      const response = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(7641, ${companyId})`);
        if (workerId != null) {
          const w = await tx.execute(sql`SELECT id FROM factory_workers WHERE company_id = ${companyId} AND id = ${workerId} LIMIT 1`);
          if (!resultRows(w).length) return { status: 404, message: "Worker not found in company" };
        }
        const seen = await tx.execute(sql`
          SELECT id, scope, worker_id AS "workerId", effective_from::text AS "effectiveFrom",
                 enabled, rate_per_extra_bale::text AS "ratePerExtraBale", note
          FROM factory_production_target_bonus_rates
          WHERE company_id = ${companyId} AND request_key = ${requestKey} LIMIT 1
        `);
        const previous = resultRows(seen)[0];
        if (previous) {
          if (!(previous.scope === scope && Number(previous.workerId ?? 0) === (workerId ?? 0)
            && previous.effectiveFrom === effectiveFrom && previous.enabled === enabled
            && new Decimal(String(previous.ratePerExtraBale)).equals(rate)
            && String(previous.note ?? "") === note
          )) return { status: 409, message: "requestKey already used for a different change" };
          return { status: 200, versionId: Number(previous.id), replayed: true };
        }
        const insert = await tx.execute(sql`
          INSERT INTO factory_production_target_bonus_rates
            (company_id, scope, worker_id, effective_from, enabled, rate_per_extra_bale,
             note, request_key, created_by)
          VALUES (${companyId}, ${scope}, ${workerId}, ${effectiveFrom}::date,
                  ${enabled}, ${rate}, ${note || null}, ${requestKey}, ${String(req.session.userId ?? "")})
          RETURNING id
        `);
        return { status: 201, versionId: Number(resultRows(insert)[0]?.id), replayed: false };
      });
      if ("message" in response) return res.status(response.status).json({ message: response.message });
      res.status(response.status).json({ ...response, currency: "USD" });
    } catch (error: unknown) {
      logger.error("[ProductionTargetBonus] settings write failure", { error });
      res.status(500).json({ message: "Could not save production bonus rate" });
    }
  });
}
