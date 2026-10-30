import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { loadTargetBonusRows, type TargetBonusRow } from "./targetBonusReview";
import type { ProductionBonusHistoryLoadQuery } from "../../routes/factory/factoryProductionTargetBonusReportRoutes";
import type { ProductionTargetBonusHistoryRow, ProductionTargetBonusStatus } from "@shared/productionTargetBonusReporting";

type StoredReview = {
  id: number | string; workerId: number | string; date: string;
  name: string; employeeCode: string | null;
  target: string; produced: string; extra: string; rate: string; amount: string;
  decision: "approved" | "rejected"; reviewedAt: string;
  paymentStatus: "POSTED" | "REVERSED" | null; postedAt: string | null;
  verifiedVoucherId: number | string | null; accountName: string | null;
};
function addDays(day: string, offset: number): string {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
const money = (amount: number) => amount.toFixed(2);
const rate = (amount: number) => amount.toFixed(4);

/** Report only verified posted vouchers as paid. Reversed claims stay VOIDED. */
export async function loadProductionTargetBonusHistory({
  companyId, start, end, workerId,
}: ProductionBonusHistoryLoadQuery): Promise<ProductionTargetBonusHistoryRow[]> {
  const response = await db.execute(sql`
    SELECT review.id, review.worker_id AS "workerId",
      review.production_date::text AS date,
      worker.full_name AS name, worker.employee_code AS "employeeCode",
      review.target_bales::text AS target, review.produced_bales::text AS produced,
      review.extra_bales::text AS extra, review.rate_per_bale::text AS rate,
      review.bonus_amount::text AS amount, review.status AS decision,
      review.reviewed_at::text AS "reviewedAt",
      payment.status AS "paymentStatus", payment.posted_at::text AS "postedAt",
      voucher.id AS "verifiedVoucherId", account.name AS "accountName"
    FROM factory_target_bonus_reviews review
    JOIN factory_workers worker
      ON worker.id = review.worker_id AND worker.company_id = review.company_id
    LEFT JOIN factory_target_bonus_payments payment
      ON payment.review_id = review.id AND payment.company_id = review.company_id
    LEFT JOIN vouchers voucher
      ON voucher.id = payment.payment_voucher_id AND voucher.company_id = review.company_id
    LEFT JOIN ledger_accounts account
      ON account.id = payment.cash_ledger_account_id AND account.company_id = review.company_id
    WHERE review.company_id = ${companyId}
      AND review.production_date BETWEEN ${start}::date AND ${end}::date
      AND (${workerId}::integer IS NULL OR review.worker_id = ${workerId})
    ORDER BY review.production_date, review.worker_id
  `);
  const stored = resultRows(response) as StoredReview[];
  const byKey = new Map(stored.map(r => [r.date + ":" + r.workerId, r]));
  const seen = new Set<string>();
  const rows: ProductionTargetBonusHistoryRow[] = [];
  let pendingId = Number.MAX_SAFE_INTEGER;

  function add(current: TargetBonusRow): void {
    if (workerId !== null && current.workerId !== workerId) return;
    const key = current.date + ":" + current.workerId;
    if (seen.has(key)) return;
    seen.add(key);
    const saved = byKey.get(key);
    if (saved?.paymentStatus === "POSTED" &&
      (!saved.verifiedVoucherId || !saved.accountName || !saved.postedAt))
      throw new Error("Posted bonus lacks matching voucher/account evidence");
    const status: ProductionTargetBonusStatus =
      saved?.paymentStatus === "POSTED" ? "POSTED" :
      saved?.paymentStatus === "REVERSED" ? "VOIDED" :
      saved?.decision === "approved" ? "APPROVED" :
      saved?.decision === "rejected" ? "REJECTED" :
      current.extraBales > 0 && (current.ratePerBale ?? 0) > 0 ? "PENDING" : "DRAFT";
    rows.push({
      id: saved ? Number(saved.id) : pendingId--,
      companyId, workerId: current.workerId,
      workerNameSnapshot: saved?.name ?? current.workerName,
      workerCodeSnapshot: saved?.employeeCode ?? null,
      productionDate: current.date, currency: "USD",
      targetBales: saved ? Number(saved.target) : current.targetBales,
      creditedBales: saved ? Number(saved.produced) : current.producedBales,
      excessBales: saved ? Number(saved.extra) : current.extraBales,
      bonusPerExtraBale: rate(saved ? Number(saved.rate) : (current.ratePerBale ?? 0)),
      amount: money(saved ? Number(saved.amount) : current.proposedAmount),
      status,
      approvedAt: saved?.decision === "approved" ? saved.reviewedAt : null,
      postedAt: status === "POSTED" ? saved!.postedAt : null,
      paymentVoucherId: status === "POSTED" ? Number(saved!.verifiedVoucherId) : null,
      paymentVoucherNumber: null,
      paymentAccountNameSnapshot: status === "POSTED" ? saved!.accountName : null,
      productionSnapshotId: companyId + ":" + current.date + ":" + current.workerId,
    });
  }

  // The live review loader works in up-to-32-day windows. Split annual
  // reporting to avoid a second, divergent linked-worker allocation formula.
  for (let cursor = start; cursor <= end;) {
    const maxEnd = addDays(cursor, 31);
    const through = maxEnd > end ? end : maxEnd;
    for (const row of await loadTargetBonusRows(db, companyId, cursor, through)) add(row);
    cursor = addDays(through, 1);
  }
  // A saved review must remain reportable if its operational day row changed.
  for (const saved of stored) {
    if (seen.has(saved.date + ":" + saved.workerId)) continue;
    add({
      date: saved.date, workerId: Number(saved.workerId), workerName: saved.name,
      category: "", linkGroupId: null, targetBales: Number(saved.target),
      producedBales: Number(saved.produced), extraBales: Number(saved.extra),
      ratePerBale: Number(saved.rate), proposedAmount: Number(saved.amount),
      status: saved.decision, reviewedBy: null, reviewedAt: saved.reviewedAt,
      lockedAmount: Number(saved.amount),
    });
  }
  return rows;
}
