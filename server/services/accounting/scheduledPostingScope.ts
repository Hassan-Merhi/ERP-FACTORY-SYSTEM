/**
 * Scope and closed-period rules for scheduled posters (accounting audit wave 18 A,
 * owner decision 1 of 2026-10-10).
 *
 * Every cron tick runs in the maintenance database scope
 * (scheduler/schedulerTickGuard.ts), which the closed-period guard and the
 * opening-balance lock treat as a bypass. A scheduled job may still enumerate
 * companies from that scope, but the work that writes vouchers runs once per
 * company inside that company's tenant scope (app.current_company_id set, the
 * maintenance flag off), so both database guards apply to it like to any
 * request.
 *
 * A scheduled posting dated on or before the company's closed-books date is
 * skipped and reported (PERIOD_CLOSED); it is never forced. The database guard
 * stays the backstop: a closed-period rejection raised while posting is
 * reported the same way.
 */
import { sql } from "drizzle-orm";

import { db, type DatabaseOrTransaction } from "../../db";
import { createTenantDatabaseScope, runWithDatabaseScopeRuntimeContext } from "../security/databaseScopeRuntimeContext";
import { getAuditActorContext, isSystemAuditActor, runAsSystemAuditActor } from "../audit/auditActorContext";

/** A scheduled posting that was not written because its date is in a closed period. */
export interface ScheduledPostingSkip {
  companyId: number;
  /** What would have been posted (recurring journal, payment group, accrual run…). */
  reference: string;
  date: string;
  reason: "PERIOD_CLOSED";
  closedThrough: string | null;
}

const DEFAULT_POSTING_JOB = "company-posting";

/**
 * Runs `run` in the tenant database scope of one company (never maintenance).
 *
 * Phase 21 (A): the audit actor is the signed-in user when a request starts the
 * posting; otherwise (a scheduled tick, boot) `system:<job>` — the tick's job
 * name, or `job` when given. Every voucher and line it writes is audited by the
 * database trigger under that actor.
 */
export function runInCompanyPostingScope<T>(
  companyId: number,
  run: () => Promise<T>,
  job = DEFAULT_POSTING_JOB
): Promise<T> {
  const current = getAuditActorContext();
  const scoped = () =>
    runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(companyId, [], "active-company"), run);
  // A tick already set `system:<its job>`; keep it unless a more specific job is named.
  if (current?.actorId && (!isSystemAuditActor(current.actorId) || job === DEFAULT_POSTING_JOB)) return scoped();
  return runAsSystemAuditActor(job, scoped);
}

/** The company's closed-books date (latest CLOSED period end), or null. */
export async function companyClosedThrough(
  companyId: number,
  executor: DatabaseOrTransaction = db
): Promise<string | null> {
  const result = await executor.execute<{ locked: string | null } & Record<string, unknown>>(
    sql`SELECT max(period_end_date)::text AS locked
          FROM fiscal_period_closures
         WHERE company_id = ${companyId} AND status = 'CLOSED'`
  );
  return result.rows[0]?.locked ?? null;
}

/** True when a voucher dated `date` falls in the closed period. */
export function isDateInClosedPeriod(closedThrough: string | null, date: string): boolean {
  return closedThrough !== null && date.slice(0, 10) <= closedThrough;
}
