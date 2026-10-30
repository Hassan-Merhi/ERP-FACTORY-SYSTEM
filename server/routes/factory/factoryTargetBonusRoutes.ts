import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import { resultRows } from "../../lib/queryResult";
import {
  loadTargetBonusRows,
  targetBonusIsValidDate,
  targetBonusValidRange,
  type TargetBonusRow,
} from "../../services/factory/targetBonusReview";

const requireProductionTargets = requireFactoryTabAccess(
  "factory/stock-entry",
  "hide_tab_stockentry_production_targets"
);
const ADMIN_ROLES = new Set(["Admin", "Owner"]);
function company(req: Request): number | undefined {
  return req.session.factoryCompanyId || req.session.currentCompanyId;
}
function canDecide(req: Request): boolean {
  return ADMIN_ROLES.has(String(req.session.currentRole || req.user?.role || ""));
}
function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}
function sendError(res: Response, error: unknown): Response {
  const status = typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status : 500;
  return res.status(status).json({
    message: status === 500 ? "Could not complete production bonus request" : (error as Error).message,
  });
}
type BonusDecision = {
  date: string; workerId: number; decision: "approved" | "rejected";
  expectedAmount: number;
};
function parseDecision(raw: unknown): BonusDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const date = value.date;
  const workerId = Number(value.workerId);
  const expectedAmount = Number(value.expectedAmount);
  if (
    !targetBonusIsValidDate(date) ||
    !Number.isSafeInteger(workerId) || workerId <= 0 ||
    (value.decision !== "approved" && value.decision !== "rejected") ||
    !Number.isFinite(expectedAmount) || expectedAmount < 0
  ) return null;
  return { date, workerId, decision: value.decision, expectedAmount };
}
function decisionKey(date: string, workerId: number): string {
  return date + ":" + workerId;
}
function totals(rows: TargetBonusRow[]) {
  return {
    workers: rows.length,
    extraBales: rows.reduce((value, row) => value + row.extraBales, 0),
    pendingAmount: rows.reduce((value, row) => value + (row.status === "pending" ? row.proposedAmount : 0), 0),
    approvedAmount: rows.reduce((value, row) => value + (row.status === "approved" ? (row.lockedAmount ?? 0) : 0), 0),
    pendingCount: rows.filter((row) => row.status === "pending" && row.extraBales > 0).length,
    approvedCount: rows.filter((row) => row.status === "approved").length,
    rejectedCount: rows.filter((row) => row.status === "rejected").length,
  };
}

export function registerFactoryTargetBonusRoutes(app: Express): void {
  app.get(
    "/api/factory/staff-tracking/production-bonuses",
    requireAuth, requireProductionTargets,
    async (req: Request, res: Response) => {
      try {
        const companyId = company(req);
        if (!companyId) return res.status(400).json({ message: "Factory company required" });
        const start = String(req.query.start || "");
        const end = String(req.query.end || "");
        if (!targetBonusValidRange(start, end)) {
          return res.status(400).json({ message: "Select a valid date range of up to 32 days" });
        }
        // Production targets are visible to staff with that tab, but monetary
        // bonuses and review history are confidential to Owners and Admins.
        if (!canDecide(req)) {
          return res.json({
            start, end, rows: [], totals: totals([]), canDecide: false,
          });
        }
        const rows = await loadTargetBonusRows(db, companyId, start, end);
        return res.json({ start, end, rows, totals: totals(rows), canDecide: canDecide(req) });
      } catch (error: unknown) { return sendError(res, error); }
    }
  );

  // Only an explicit decision, after a user confirmation in the UI, locks a
  // bonus. This endpoint deliberately creates no vouchers, cash payments or
  // payroll records. Accounting posting is a separate later phase.
  app.post(
    "/api/factory/staff-tracking/production-bonuses/decide",
    requireAuth, requireProductionTargets,
    async (req: Request, res: Response) => {
      try {
        const companyId = company(req);
        if (!companyId) return res.status(400).json({ message: "Factory company required" });
        if (!canDecide(req)) return res.status(403).json({ message: "Owner or Admin approval required" });
        const raw: unknown = req.body?.decisions;
        if (!Array.isArray(raw) || raw.length < 1 || raw.length > 200) {
          return res.status(400).json({ message: "Select between 1 and 200 bonuses" });
        }
        const decisions = raw.map(parseDecision);
        if (decisions.some((decision) => decision === null)) {
          return res.status(400).json({ message: "Invalid bonus review selection" });
        }
        const valid = decisions as BonusDecision[];
        const keys = valid.map((decision) => decisionKey(decision.date, decision.workerId));
        if (new Set(keys).size !== keys.length) {
          return res.status(400).json({ message: "A worker/date may only appear once" });
        }
        const sortedDates = valid.map((decision) => decision.date).sort();
        const start = sortedDates[0];
        const end = sortedDates[sortedDates.length - 1];
        if (!targetBonusValidRange(start, end)) {
          return res.status(400).json({ message: "Choose bonuses from a range of up to 32 days" });
        }
        const reviewer = String(req.session.userId || "");
        const result = await db.transaction(async (tx) => {
          // Lock company-wide bonus review changes to prevent duplicate or
          // conflicting approval across simultaneous browser requests.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
          const available = await loadTargetBonusRows(tx, companyId, start, end);
          const index = new Map(available.map((row) => [decisionKey(row.date, row.workerId), row]));
          let saved = 0;
          let unchanged = 0;
          const weeklyModes = new Map<string, string>();

          for (const choice of valid) {
            // Category and legacy worker/day bonus reviews are mutually exclusive.
            // Both routes hold advisory lock 84023 for the company.
            const categoryReview = resultRows(await tx.execute(sql`
              SELECT id FROM factory_target_bonus_category_reviews
              WHERE company_id = ${companyId} AND production_date = ${choice.date}::date
                AND worker_id = ${choice.workerId} LIMIT 1
            `));
            if (categoryReview.length)
              throw httpError(409, "Category-weighted bonus was already reviewed for this worker/day");
            // Reverse guard: a weekly review locks all source days for that worker.
            // This shares company advisory lock 84023 with the weekly decision route.
            const weeklyReview = resultRows(await tx.execute(sql`
              SELECT id FROM factory_target_bonus_weekly_reviews
              WHERE company_id = ${companyId} AND worker_id = ${choice.workerId}
                AND ${choice.date}::date BETWEEN week_start AND week_end LIMIT 1
            `));
            if (weeklyReview.length)
              throw httpError(409, "This worker/week already has a weekly flat bonus review");
            const item = index.get(decisionKey(choice.date, choice.workerId));
            if (!item) throw httpError(409, "No production record for this worker/date");
            if (item.status !== "pending") {
              if (item.status === choice.decision) {
                unchanged++;
                continue; // safe idempotent retry, never duplicate a decision
              }
              throw httpError(409, "This bonus already has an immutable decision");
            }
            // A company-selected weekly-flat method excludes NEW daily per-bale reviews.
            // Already reviewed daily rows may still replay their immutable decision above.
            const monday = mondayOfProductionBonusWeek(choice.date)!;
            let method = weeklyModes.get(monday);
            if (method === undefined) {
              const methodRow = resultRows(await tx.execute(sql`
                SELECT method FROM factory_production_target_bonus_weekly_methods
                WHERE company_id = ${companyId} AND effective_week <= ${monday}::date
                ORDER BY effective_week DESC, id DESC LIMIT 1
              `)) as Array<{ method: string }>;
              method = methodRow[0]?.method ?? 'per_extra_bale';
              weeklyModes.set(monday, method);
            }
            if (method === 'weekly_flat')
              throw httpError(409, 'Weekly flat bonus is selected for this week; daily per-bale reviews are disabled');
            if (Math.round(item.proposedAmount * 100) !== Math.round(choice.expectedAmount * 100)) {
              throw httpError(409, "Bonus amount changed since review; refresh and review again");
            }
            if (choice.decision === "approved" && item.targetConfigured === false)
              throw httpError(409, "Set a valid production target before approving this live bonus");
            if (choice.decision === "approved" && (item.ratePerBale == null || item.ratePerBale <= 0 || item.extraBales <= 0)) {
              throw httpError(409, "Set a positive rate and verify extra bales before approving");
            }
            const inserted = await tx.execute(sql`
              INSERT INTO factory_target_bonus_reviews (
                company_id, production_date, worker_id, target_bales, produced_bales,
                extra_bales, rate_per_bale, bonus_amount, status, reviewed_by, reviewed_at
              ) VALUES (
                ${companyId}, ${choice.date}::date, ${item.workerId}, ${item.targetBales}, ${item.producedBales},
                ${item.extraBales}, ${item.ratePerBale ?? 0}, ${item.proposedAmount}, ${choice.decision},
                ${reviewer}, now()
              )
              ON CONFLICT (company_id, production_date, worker_id) DO NOTHING
              RETURNING id
            `);
            if (resultRows(inserted).length !== 1) throw httpError(409, "Bonus was decided concurrently; refresh");
            saved++;
          }
          return { saved, unchanged };
        });
        return res.json({ success: true, ...result });
      } catch (error: unknown) { return sendError(res, error); }
    }
  );

  // Effective-dated per-worker rate. Existing approved/rejected snapshots
  // cannot be retroactively altered by editing the rate history.
  app.post(
    "/api/factory/staff-tracking/production-bonuses/rate",
    requireAuth, requireProductionTargets,
    async (req: Request, res: Response) => {
      try {
        const companyId = company(req);
        if (!companyId) return res.status(400).json({ message: "Factory company required" });
        if (!canDecide(req)) return res.status(403).json({ message: "Owner or Admin required" });
        const workerId = Number(req.body?.workerId);
        const effectiveFrom: unknown = req.body?.effectiveFrom;
        const rawRate: unknown = req.body?.ratePerBale;
        const rateString = String(rawRate ?? "");
        if (
          !Number.isSafeInteger(workerId) || workerId <= 0 ||
          !targetBonusIsValidDate(effectiveFrom) ||
          !/^(?:\d{1,9})(?:\.\d{1,4})?$/.test(rateString) || Number(rateString) <= 0
        ) return res.status(400).json({ message: "Valid worker, effective date and positive rate (max 4 decimals) required" });

        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
          const worker = await tx.execute(sql`
            SELECT id FROM factory_workers WHERE id = ${workerId} AND company_id = ${companyId} LIMIT 1
          `);
          if (!resultRows(worker).length) throw httpError(404, "Worker not found in this factory");
          const locked = await tx.execute(sql`
            SELECT 1 FROM factory_target_bonus_reviews
            WHERE company_id = ${companyId} AND worker_id = ${workerId}
              AND production_date >= ${effectiveFrom}::date LIMIT 1
          `);
          if (resultRows(locked).length) throw httpError(409, "A reviewed bonus exists on or after this rate date; use a later effective date");
          // Append-only effective-dated rate history; no parallel rate table.
          await tx.execute(sql`
            INSERT INTO factory_production_target_bonus_rates (
              company_id, scope, worker_id, effective_from, enabled,
              rate_per_extra_bale, note, request_key, created_by
            ) VALUES (
              ${companyId}, 'worker', ${workerId}, ${effectiveFrom}::date,
              true, ${rateString}::numeric, 'Worker bonus rate editor',
              ${randomUUID()}, ${String(req.session.userId || "")}
            )
          `);
        });
        return res.json({ success: true });
      } catch (error: unknown) { return sendError(res, error); }
    }
  );
}
