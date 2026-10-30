import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import { isBonusCategoryDate } from "@shared/productionTargetBonusCategoryRates";
import { mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";
import { loadWeeklyFlatBonusProposal } from "./productionTargetBonusWeeklyPreviewRoutes";
import { weeklyBonusReviewSnapshot, weeklyBonusReviewToken } from "../../services/factory/weeklyBonusReviewSnapshot";

const guard = requireFactoryTabAccess("factory/stock-entry", "hide_tab_stockentry_production_targets");
const allowed = (req: Request): boolean =>
  ["Admin", "Owner"].includes(String(req.session.currentRole || req.user?.role || ""));
const companyFor = (req: Request): number | null => {
  const id = Number(req.session.factoryCompanyId || req.session.currentCompanyId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
function errorResponse(res: Response, error: unknown): Response {
  const code = error && typeof error === "object" && "status" in error &&
    typeof error.status === "number" ? error.status : 500;
  if (code >= 500) logger.error("Production Targets weekly review failed", { error });
  return res.status(code).json({
    message: code >= 500 ? "Could not process weekly Production Targets review" :
      error instanceof Error ? error.message : "Invalid weekly bonus review",
  });
}
interface WeeklyDecision {
  weekStart: string;
  workerId: number;
  decision: "approved" | "rejected";
  expectedAmount: string;
  reviewToken: string;
  note: string;
}
function parseDecision(body: unknown): WeeklyDecision | null {
  if (!body || typeof body !== "object") return null;
  const v = body as Record<string, unknown>;
  if (v.confirm !== true ||
      !isBonusCategoryDate(v.weekStart) ||
      mondayOfProductionBonusWeek(v.weekStart) !== v.weekStart ||
      typeof v.workerId !== "number" || !Number.isSafeInteger(v.workerId) || v.workerId <= 0 ||
      (v.decision !== "approved" && v.decision !== "rejected") ||
      typeof v.expectedAmount !== "string" ||
      !/^(?:0|[1-9]\d{0,5})\.\d{2}$/.test(v.expectedAmount) ||
      Number(v.expectedAmount) <= 0 ||
      typeof v.reviewToken !== "string" || !/^[a-f0-9]{64}$/.test(v.reviewToken) ||
      (v.note !== undefined && typeof v.note !== "string")) return null;
  const note = typeof v.note === "string" ? v.note.trim() : "";
  if (note.length > 500) return null;
  return {
    weekStart: v.weekStart, workerId: v.workerId,
    decision: v.decision, expectedAmount: v.expectedAmount,
    reviewToken: v.reviewToken, note,
  };
}
interface StoredReview {
  id: number | string; workerId: number | string; status: "approved" | "rejected";
  amount: string; snapshotHash: string; snapshot: unknown;
  methodVersionId: number | string; reviewedAt: string; reviewedBy: string;
  note: string | null; weekStart: string; weekEnd: string;
}

/** Phase 14: immutable review decisions only; no claims or payment endpoint. */
export function registerProductionTargetBonusWeeklyReviewRoutes(app: Express): void {
  app.get("/api/factory/production-target-bonuses/weekly-reviews",
    requireAuth, guard, async (req: Request, res: Response) => {
      if (!allowed(req)) return res.status(403).json({ message: "Admin or Owner required" });
      const companyId = companyFor(req);
      if (!companyId) return res.status(400).json({ message: "Factory company required" });
      if (!isBonusCategoryDate(req.query.weekOf))
        return res.status(400).json({ message: "Valid weekOf date required" });
      const weekStart = mondayOfProductionBonusWeek(req.query.weekOf)!;
      try {
        const rows = resultRows(await db.execute(sql`
          SELECT id, worker_id AS "workerId", status, bonus_amount::text AS amount,
            snapshot_hash AS "snapshotHash", snapshot_json AS snapshot,
            method_version_id AS "methodVersionId",
            reviewed_at::text AS "reviewedAt", reviewed_by AS "reviewedBy",
            review_note AS note, week_start::text AS "weekStart", week_end::text AS "weekEnd"
          FROM factory_target_bonus_weekly_reviews
          WHERE company_id = ${companyId} AND week_start = ${weekStart}::date
          ORDER BY worker_id
        `)) as StoredReview[];
        res.setHeader("Cache-Control", "private, no-store");
        return res.json({
          weekStart, currency: "USD", approvalDoesNotPost: true, paymentEnabled: false,
          reviews: rows.map(row => ({
            ...row, id: Number(row.id), workerId: Number(row.workerId),
            methodVersionId: Number(row.methodVersionId),
          })),
        });
      } catch (error) { return errorResponse(res, error); }
    },
  );

  app.post("/api/factory/production-target-bonuses/weekly-reviews/decide",
    requireAuth, guard, async (req: Request, res: Response) => {
      if (!allowed(req)) return res.status(403).json({ message: "Admin or Owner required" });
      const companyId = companyFor(req);
      if (!companyId) return res.status(400).json({ message: "Factory company required" });
      const command = parseDecision(req.body);
      if (!command) return res.status(400).json({
        message: "Confirm the Monday, worker, decision, exact USD amount and review token",
      });
      const reviewer = String(req.session.userId ?? "");
      if (!reviewer) return res.status(401).json({ message: "Reviewer sign-in required" });
      try {
        const result = await db.transaction(async tx => {
          // Shared lock with legacy/category approvals and bonus payment claims.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
          const saved = resultRows(await tx.execute(sql`
            SELECT id, status, bonus_amount::text AS amount,
              snapshot_hash AS "snapshotHash", review_note AS note
            FROM factory_target_bonus_weekly_reviews
            WHERE company_id = ${companyId} AND week_start = ${command.weekStart}::date
              AND worker_id = ${command.workerId}
            LIMIT 1
          `)) as Array<{
            id: number | string; status: "approved" | "rejected";
            amount: string; snapshotHash: string; note: string | null;
          }>;
          if (saved.length) {
            const previous = saved[0];
            if (previous.status !== command.decision || previous.amount !== command.expectedAmount ||
                previous.snapshotHash !== command.reviewToken || (previous.note ?? "") !== command.note)
              fail(409, "Weekly bonus already has a different immutable decision");
            return { replayed: true, reviewId: Number(previous.id), amount: previous.amount,
              status: previous.status };
          }

          const proposal = await loadWeeklyFlatBonusProposal(companyId, command.weekStart, tx);
          const worker = proposal.workers.find(row => row.workerId === command.workerId);
          if (!proposal.completeWeek || proposal.globalIssues.length || proposal.method !== "weekly_flat" ||
              !proposal.methodVersionId || !worker || !worker.eligible || worker.blocked ||
              worker.proposedBonusUsd === "0.00")
            fail(409, "This worker's completed weekly production is not eligible for review");
          const snapshot = weeklyBonusReviewSnapshot(companyId, proposal, worker);
          const fingerprint = weeklyBonusReviewToken(snapshot);
          if (fingerprint !== command.reviewToken || worker.proposedBonusUsd !== command.expectedAmount)
            fail(409, "Weekly bonus amount, method or production changed; refresh before confirming");

          const belongs = resultRows(await tx.execute(sql`
            SELECT id FROM factory_workers
            WHERE company_id = ${companyId} AND id = ${command.workerId} LIMIT 1
          `));
          if (!belongs.length) fail(409, "Worker does not belong to the selected factory");

          // Salary/payroll period overlaps are checked independently of daily bonus
          // claim rows. No second bonus is approved against an already paid payroll.
          const payroll = resultRows(await tx.execute(sql`
            SELECT id FROM factory_payrolls
            WHERE company_id = ${companyId} AND worker_id = ${command.workerId}
              AND period_start <= ${proposal.weekEnd}::date
              AND period_end >= ${proposal.weekStart}::date
              AND status IN ('APPROVED','PAID') LIMIT 1
          `));
          if (payroll.length) fail(409, "Payroll already covers this worker's week; reconcile first");

          const inserted = resultRows(await tx.execute(sql`
            INSERT INTO factory_target_bonus_weekly_reviews (
              company_id, week_start, week_end, worker_id, method_version_id,
              calculation_version, currency_code, worker_name_snapshot,
              target_bales, credited_bales, extra_bales, bonus_amount,
              status, snapshot_json, snapshot_hash, reviewed_by, review_note
            ) VALUES (
              ${companyId}, ${proposal.weekStart}::date, ${proposal.weekEnd}::date,
              ${command.workerId}, ${proposal.methodVersionId},
              ${proposal.calculationVersion}, 'USD', ${worker.workerName},
              ${worker.targetBales}, ${worker.creditedBales}, ${worker.extraBales},
              ${worker.proposedBonusUsd}, ${command.decision},
              ${JSON.stringify(snapshot)}::jsonb, ${fingerprint},
              ${reviewer}, ${command.note || null}
            )
            ON CONFLICT (company_id, week_start, worker_id) DO NOTHING RETURNING id
          `)) as Array<{ id: number | string }>;
          if (inserted.length !== 1) fail(409, "Weekly bonus was reviewed concurrently; refresh");
          return { replayed: false, reviewId: Number(inserted[0].id), amount: worker.proposedBonusUsd,
            status: command.decision };
        });
        if (result.replayed) res.setHeader("X-Idempotent-Replay", "true");
        return res.status(result.replayed ? 200 : 201).json({
          ...result, success: true, weekStart: command.weekStart, workerId: command.workerId,
          currency: "USD", accountingPosted: false, paymentEnabled: false,
        });
      } catch (error) { return errorResponse(res, error); }
    },
  );
}
