import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import { isBonusCategoryDate } from "@shared/productionTargetBonusCategoryRates";
import { previewProductionBonusCategories } from "../../services/factory/productionBonusCategoryCalculator";
import { categoryReviewSnapshotPayload, categoryReviewSnapshotToken }
  from "../../services/factory/categoryBonusReviewSnapshot";

const guard = requireFactoryTabAccess("factory/stock-entry", "hide_tab_stockentry_production_targets");
const canReview = (req: Request): boolean =>
  ["Admin", "Owner"].includes(String(req.session.currentRole || req.user?.role || ""));
const companyIdFor = (req: Request): number | null => {
  const id = Number(req.session.factoryCompanyId || req.session.currentCompanyId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
function sendError(res: Response, error: unknown): Response {
  const raw = error && typeof error === "object" && "status" in error
    ? (error as {status?: unknown}).status : null;
  const status = typeof raw === "number" && raw >= 400 && raw < 500 ? raw : 500;
  if (status === 500) logger.error("Production Targets category review failure", {error});
  return res.status(status).json({
    message: status === 500 ? "Could not complete category bonus review"
      : error instanceof Error ? error.message : "Invalid category bonus review",
  });
}
type StoredReview = {
  id: string | number; workerId: string | number; status: "approved" | "rejected";
  amount: string; snapshotHash: string; snapshot: unknown; reviewedBy: string;
  reviewedAt: string; note: string | null; date: string;
};

function parseRequest(body: unknown): {
  date: string; workerId: number; decision: "approved" | "rejected";
  expectedAmount: string; reviewToken: string; note: string;
} | null {
  if (!body || typeof body !== "object") return null;
  const input = body as Record<string, unknown>;
  const workerId = input.workerId;
  if (input.confirm !== true || !isBonusCategoryDate(input.date) ||
      typeof workerId !== "number" || !Number.isSafeInteger(workerId) || workerId <= 0 ||
      (input.decision !== "approved" && input.decision !== "rejected") ||
      typeof input.expectedAmount !== "string" ||
      !/^(?:0|[1-9]\d{0,11})\.\d{2}$/.test(input.expectedAmount) ||
      typeof input.reviewToken !== "string" || !/^[a-f0-9]{64}$/.test(input.reviewToken) ||
      (input.note !== undefined && typeof input.note !== "string")) return null;
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > 500) return null;
  return {
    date: input.date, workerId, decision: input.decision,
    expectedAmount: input.expectedAmount, reviewToken: input.reviewToken, note,
  };
}

export function registerProductionBonusCategoryReviewRoutes(app: Express): void {
  app.get("/api/factory/production-target-bonuses/category-reviews",
    requireAuth, guard, async (req: Request, res: Response) => {
      if (!canReview(req)) return res.status(403).json({message:"Admin or Owner required"});
      const companyId = companyIdFor(req);
      if (!companyId) return res.status(400).json({message:"Factory company required"});
      const date = req.query.date;
      if (!isBonusCategoryDate(date)) return res.status(400).json({message:"Valid production date required"});
      try {
        const results = await db.execute(sql`
          SELECT id, worker_id AS "workerId", status, bonus_amount::text AS amount,
                 snapshot_hash AS "snapshotHash", snapshot_json AS snapshot,
                 reviewed_by AS "reviewedBy", reviewed_at::text AS "reviewedAt",
                 review_note AS note, production_date::text AS date
          FROM factory_target_bonus_category_reviews
          WHERE company_id = ${companyId} AND production_date = ${date}::date
          ORDER BY worker_id
        `);
        res.setHeader("Cache-Control", "private, no-store");
        return res.json({
          date, currency: "USD", approvalDoesNotPost: true,
          reviews: (resultRows(results) as StoredReview[]).map(row => ({
            ...row, id: Number(row.id), workerId: Number(row.workerId),
          })),
        });
      } catch (error) { return sendError(res, error); }
    },
  );

  app.post("/api/factory/production-target-bonuses/category-reviews/decide",
    requireAuth, guard, async (req: Request, res: Response) => {
      if (!canReview(req)) return res.status(403).json({message:"Admin or Owner required"});
      const companyId = companyIdFor(req);
      if (!companyId) return res.status(400).json({message:"Factory company required"});
      const command = parseRequest(req.body);
      if (!command) return res.status(400).json({
        message: "Confirm worker/day, status, exact USD amount and refreshed review token",
      });
      const reviewer = String(req.session.userId || "");
      if (!reviewer) return res.status(401).json({message:"Reviewer sign-in required"});
      try {
        const outcome = await db.transaction(async tx => {
          // Shared with legacy reviews, payroll/daybook payments and Phase 9
          // allocations; incompatible reviews for one worker/date cannot race.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);

          const prior = resultRows(await tx.execute(sql`
            SELECT id, status, bonus_amount::text AS amount,
                   snapshot_hash AS "snapshotHash", review_note AS note
            FROM factory_target_bonus_category_reviews
            WHERE company_id = ${companyId} AND production_date = ${command.date}::date
              AND worker_id = ${command.workerId}
          `)) as Array<{id: string|number; status:string; amount:string; snapshotHash:string; note:string|null}>;
          if (prior.length) {
            const row = prior[0];
            if (row.status !== command.decision || row.snapshotHash !== command.reviewToken ||
                row.amount !== command.expectedAmount ||
                (row.note ?? "") !== command.note) {
              fail(409,"Category bonus already has a different immutable decision");
            }
            return {replayed:true, reviewId:Number(row.id), status:row.status, amount:row.amount};
          }
          const legacy = resultRows(await tx.execute(sql`
            SELECT id FROM factory_target_bonus_reviews
            WHERE company_id = ${companyId} AND production_date = ${command.date}::date
              AND worker_id = ${command.workerId} LIMIT 1
          `));
          if (legacy.length) fail(409,"Legacy worker/day bonus was already reviewed; cannot approve it again");

          const weekly = resultRows(await tx.execute(sql`
            SELECT id FROM factory_target_bonus_weekly_reviews
            WHERE company_id = ${companyId} AND worker_id = ${command.workerId}
              AND ${command.date}::date BETWEEN week_start AND week_end
            LIMIT 1
          `));
          if (weekly.length) fail(409, "This worker/week already has a weekly flat bonus review");

          const proposal = await previewProductionBonusCategories(companyId, command.date, tx);
          const worker = proposal.workers.find(item => item.workerId === command.workerId);
          if (!worker || worker.blocked || !proposal.finalized || !proposal.evidenceVerified ||
              worker.lines.length === 0 || worker.proposedBonusUsd === "0.00" ||
              worker.extraBales === "0.00") {
            fail(409,"Bonus evidence, category rate or target allocation is not eligible for review");
          }
          const payload = categoryReviewSnapshotPayload(proposal.calculationVersion, worker);
          const token = categoryReviewSnapshotToken(payload);
          if (worker.proposedBonusUsd !== command.expectedAmount ||
              token !== command.reviewToken) {
            fail(409,"Category bonus changed since preview; refresh before confirming");
          }
          const set = resultRows(await tx.execute(sql`
            SELECT id, daily_target_bales::text AS "dailyTarget"
            FROM factory_target_bonus_category_allocation_sets
            WHERE company_id = ${companyId} AND production_date = ${command.date}::date
              AND worker_id = ${command.workerId} LIMIT 1 FOR UPDATE
          `)) as Array<{id:string|number;dailyTarget:string}>;
          if (set.length !== 1 || Number(set[0].dailyTarget) !== Number(worker.targetBales))
            fail(409,"Reviewed category target allocation is missing or changed");

          // Even a recorded approval is blocked if payroll has already claimed
          // this production date. Rejection is a non-payable audit decision.
          if (command.decision === "approved") {
            const collision = resultRows(await tx.execute(sql`
              SELECT 1 AS blocked FROM factory_production_bonus_allocations a
              JOIN factory_production_bonus_runs run ON run.id = a.run_id
              WHERE a.company_id = ${companyId} AND run.company_id = ${companyId}
                AND a.worker_id = ${command.workerId}
                AND run.production_date = ${command.date}::date
                AND (a.decision_status = 'APPROVED' OR a.payroll_id IS NOT NULL)
                AND a.amount > 0 LIMIT 1
            `));
            const paidSalary = resultRows(await tx.execute(sql`
              SELECT 1 AS blocked FROM factory_payrolls p
              WHERE p.company_id = ${companyId} AND p.worker_id = ${command.workerId}
                AND ${command.date}::date BETWEEN p.period_start AND p.period_end
                AND p.status IN ('APPROVED','PAID') LIMIT 1
            `));
            if (collision.length || paidSalary.length)
              fail(409,"Payroll already contains a worker/day bonus claim; reconcile first");
          }
          const inserted = resultRows(await tx.execute(sql`
            INSERT INTO factory_target_bonus_category_reviews (
              company_id, production_date, worker_id, allocation_set_id,
              calculation_version, currency_code, target_bales, credited_bales,
              extra_bales, bonus_amount, status, snapshot_json, snapshot_hash,
              reviewed_by, review_note
            ) VALUES (
              ${companyId}, ${command.date}::date, ${command.workerId},
              ${Number(set[0].id)}, ${proposal.calculationVersion}, 'USD',
              ${worker.targetBales}, ${worker.creditedBales}, ${worker.extraBales},
              ${worker.proposedBonusUsd}, ${command.decision},
              ${JSON.stringify(payload)}::jsonb, ${token}, ${reviewer}, ${command.note || null}
            )
            ON CONFLICT (company_id, production_date, worker_id) DO NOTHING
            RETURNING id
          `)) as Array<{id:string|number}>;
          if (inserted.length !== 1) fail(409,"Review submitted concurrently; refresh");
          return {
            replayed:false, reviewId:Number(inserted[0].id),
            status:command.decision, amount:worker.proposedBonusUsd,
          };
        });
        if (outcome.replayed) res.setHeader("X-Idempotent-Replay", "true");
        return res.status(outcome.replayed ? 200 : 201).json({
          success:true, ...outcome, date:command.date, workerId:command.workerId,
          currency:"USD", accountingPosted:false, paymentEnabled:false,
        });
      } catch (error) { return sendError(res, error); }
    },
  );
}
