// Extracted from ./spFullReconciliationRoutes.ts to keep that module under the source-size cap.
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { resultRows } from "../../lib/queryResult";
import { buildFinalMigrationVerification } from "./spMigrationPhase4Verification";

export function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

type Tolerance = { absolute?: number; relative?: number };

type EvidenceStatus = "PASS" | "WARN" | "FAIL" | "NOT_APPLICABLE" | "UNAVAILABLE";

/**
 * Two independently computed totals agree when they are within tolerance.
 *
 * `absolute` covers decimal rounding; `relative` covers the cases where the two
 * sides are legitimately computed on different bases (an ERP weighted average
 * rate against SP's per-lot final cost, for example) and only a proportional
 * drift is a real mismatch.
 */
export function close(left: number, right: number, tolerance: Tolerance = {}): boolean {
  const absolute = tolerance.absolute ?? 0.01;
  const relative = tolerance.relative ?? 0;
  const allowed = Math.max(absolute, relative * Math.max(Math.abs(left), Math.abs(right)));
  return Math.abs(left - right) <= allowed;
}

export type Surface = {
  key: string;
  databaseValue: number;
  reportValue: number;
  pass: boolean;
  /** The two independent sources being compared, so a FAIL can be judged. */
  basis: string;
  /** Used when a surface has evidence semantics beyond a simple numeric pass/fail. */
  evidenceStatus?: EvidenceStatus;
  detail?: string;
};

type MigrationEvidence = {
  pass: boolean;
  status: EvidenceStatus;
  issueCount: number;
  detail: string;
};

/**
 * Migration verification must never silently pass because a query failed.
 *
 * The old closeout queried sp_migration_verification_results, a table no current
 * migration path writes, and converted every query failure into 0 failures. We
 * now discover the latest real rehearsal run and invoke the same final verifier
 * used by Phase 4. A company with no migration history is explicitly N/A; a
 * schema/query failure is UNAVAILABLE and makes the report NOT_VERIFIED.
 */
export async function loadMigrationEvidence(companyId: number): Promise<MigrationEvidence> {
  try {
    const runs = await db.execute(sql`
      SELECT source_company_id, action, status
      FROM sp_migration_rehearsal_runs
      WHERE target_company_id = ${companyId}
        AND status <> 'rolled_back'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const latest = resultRows(runs)[0];
    if (!latest) {
      return {
        pass: true,
        status: "NOT_APPLICABLE",
        issueCount: 0,
        detail: "No non-rolled-back migration rehearsal exists for this target company.",
      };
    }

    const sourceCompanyId = num(latest.source_company_id);
    const runStatus = String(latest.status ?? "").toLowerCase();
    if (!sourceCompanyId || runStatus !== "completed") {
      return {
        pass: false,
        status: "FAIL",
        issueCount: 1,
        detail: `Latest migration rehearsal action ${String(latest.action ?? "unknown")} is ${runStatus || "unknown"}.`,
      };
    }

    const verification = await buildFinalMigrationVerification(sourceCompanyId, companyId);
    const blockerCount = verification.blockers?.length ?? 0;
    const deltaCount = verification.deltas?.length ?? 0;
    const status = verification.overall as "PASS" | "WARN" | "FAIL";
    return {
      pass: status === "PASS",
      status,
      issueCount: blockerCount + deltaCount,
      detail: `Phase 4 final verification for source ${sourceCompanyId}: ${blockerCount} blocker(s), ${deltaCount} delta(s).`,
    };
  } catch (error: unknown) {
    return {
      pass: false,
      status: "UNAVAILABLE",
      issueCount: 1,
      detail: `Migration evidence unavailable: ${getErrorMessage(error)}`,
    };
  }
}
