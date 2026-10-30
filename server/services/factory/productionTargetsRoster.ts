/**
 * One roster contract for the Production Targets day table and its bonus
 * checkout. A worker is eligible for the bonus *listing* only when that
 * worker appears in Production Targets for the checkout's selected date.
 *
 * Historical paid claims remain in the separate bonus payment history; they
 * must not make an unrelated/inactive worker appear in today's roster.
 */
import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";

export interface ProductionTargetsRosterEligibility {
  finalized: boolean;
  savedForPeriod: boolean;
  plannerAssigned: boolean;
  linkedForPeriod: boolean;
  active: boolean;
  joinedByPeriodEnd: boolean;
}

/** Mirrors includedWorkers in GET /api/factory/staff-tracking?page=production. */
export function isProductionTargetsRosterWorker(row: ProductionTargetsRosterEligibility): boolean {
  if (row.finalized) return row.savedForPeriod;
  return row.plannerAssigned &&
    (row.savedForPeriod || row.linkedForPeriod ||
      (row.active && row.joinedByPeriodEnd));
}

type Candidate = {
  workerId: number | string;
  active: boolean;
  dateJoined: string | null;
  finalized: boolean;
  savedForPeriod: boolean;
  plannerAssigned: boolean;
  linkedForPeriod: boolean;
};

/**
 * Reproduce the server's Production Targets roster for one day (not a union
 * of people who happened to have production during a selected date range).
 * The operation runs on the SAME transaction as bonus approval/payments.
 */
export async function loadProductionTargetsRosterIds(
  tx: DatabaseOrTransaction, companyId: number, date: string,
): Promise<Set<number>> {
  const result = await tx.execute(sql`
    SELECT w.id AS "workerId", w.active,
      w.date_joined::text AS "dateJoined",
      EXISTS (
        SELECT 1 FROM factory_staff_tracking_period_closures c
        WHERE c.company_id=w.company_id AND c.page_type='production'
          AND c.period_type='daily' AND c.period_start=${date}::date
          AND c.period_end=${date}::date
      ) AS finalized,
      EXISTS (
        SELECT 1 FROM factory_staff_tracking_entries e
        WHERE e.company_id=w.company_id AND e.page_type='production'
          AND e.period_type='daily' AND e.period_start=${date}::date
          AND e.period_end=${date}::date AND e.person_type='worker'
          AND e.person_id=w.id
      ) AS "savedForPeriod",
      EXISTS (
        SELECT 1 FROM factory_worker_categories planner
        WHERE planner.company_id=w.company_id
          AND (
            planner.worker_ids @> jsonb_build_array(w.id)
            OR planner.worker_ids @> jsonb_build_array(w.id::text)
          )
      ) AS "plannerAssigned",
      EXISTS (
        SELECT 1 FROM factory_worker_production_links l
        JOIN factory_worker_production_link_members lm
          ON lm.company_id=l.company_id AND lm.link_id=l.id
        WHERE l.company_id=w.company_id AND lm.worker_id=w.id
          AND l.effective_from<=${date}::date
          AND (l.effective_to IS NULL OR l.effective_to>${date}::date)
      ) AS "linkedForPeriod"
    FROM factory_workers w
    WHERE w.company_id=${companyId}
  `);
  const candidates=resultRows(result) as Candidate[];
  return new Set(candidates.filter(row=>isProductionTargetsRosterWorker({
    finalized:row.finalized===true,
    savedForPeriod:row.savedForPeriod===true,
    plannerAssigned:row.plannerAssigned===true,
    linkedForPeriod:row.linkedForPeriod===true,
    active:row.active===true,
    joinedByPeriodEnd:row.dateJoined===null || row.dateJoined<=date,
  })).map(row=>Number(row.workerId)));
}
