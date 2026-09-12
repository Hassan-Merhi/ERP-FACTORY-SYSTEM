import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { requireSpCompany } from "./spHelpers";
import { resultRows, firstRow } from "../../lib/queryResult";

const REQUIRED_STABILIZATION_CHECKS = [
  "daily_sales_stock",
  "container_offload_postings",
  "supplier_statement_ledger",
  "sales_form_profit_split",
  "source_write_lock",
  "production_logs",
  "supplier_links",
  "migration_suspense",
] as const;

const CUTOVER_EVIDENCE_TYPES = [
  "database_backup",
  "final_verification",
  "delta_sync",
  "production_smoke",
  "rollback_available",
  "migration_archive",
] as const;

const ALL_EVIDENCE_TYPES = new Set<string>([...REQUIRED_STABILIZATION_CHECKS, ...CUTOVER_EVIDENCE_TYPES]);

function username(req: Request): string | null {
  return String(req.user?.username ?? req.session.username ?? "") || null;
}

async function latestActiveCutover(companyId: number): Promise<Record<string, unknown> | null> {
  const result = await db.execute(sql`
    SELECT * FROM sp_migration_cutovers
    WHERE target_company_id = ${companyId} AND status = 'active'
    ORDER BY id DESC LIMIT 1
  `);
  return firstRow(result) ?? null;
}

export type SpProductionClosureCheck = {
  type: string;
  status: string;
  detail: unknown;
  recorded_by: unknown;
  recorded_at: unknown;
};

export type SpProductionClosureFailure = {
  type: string;
  status: string;
  sourceWriteCount?: number;
  migrationSuspenseEntryCount?: number;
};

export type SpProductionClosureStatus =
  | { status: "BLOCKED"; blocker: string; cutover: null; checks: SpProductionClosureCheck[] }
  | {
      status: "PASS" | "FAIL";
      cutover: Record<string, unknown>;
      checks: SpProductionClosureCheck[];
      sourceWriteCount: number;
      migrationSuspenseEntryCount: number;
      failureCount: number;
      failures: SpProductionClosureFailure[];
      completionRecord: Record<string, unknown> | null;
    };

export async function buildSpProductionClosureStatus(companyId: number): Promise<SpProductionClosureStatus> {
  const cutover = await latestActiveCutover(companyId);
  if (!cutover) {
    return {
      status: "BLOCKED",
      blocker: "No active Supplier Partner cutover exists.",
      cutover: null,
      checks: [],
    };
  }

  const cutoverId = Number(cutover.id);
  const evidenceResult = await db.execute(sql`
    SELECT evidence_type, status, detail, recorded_by, recorded_at, updated_at
    FROM sp_production_evidence
    WHERE company_id = ${companyId} AND cutover_id = ${cutoverId}
    ORDER BY evidence_type
  `);
  const evidence = resultRows(evidenceResult);
  const evidenceMap = new Map(evidence.map((row: Record<string, unknown>) => [row.evidence_type, row]));
  const checks = REQUIRED_STABILIZATION_CHECKS.map((type) => ({
    type,
    status: "MISSING",
    detail: null,
    recorded_by: null,
    recorded_at: null,
    ...((evidenceMap.get(type) ?? {}) as {
      status?: string;
      detail?: unknown;
      recorded_by?: unknown;
      recorded_at?: unknown;
    }),
  }));

  const sourceWrites = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM vouchers
    WHERE company_id = ${Number(cutover.source_company_id)}
      AND deleted_at IS NULL
      AND created_at > ${cutover.activated_at}
  `);
  const sourceWriteCount = Number(firstRow(sourceWrites)?.count ?? 0);

  const suspense = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM ledger_accounts la
    JOIN voucher_entries ve ON ve.ledger_account_id = la.id
    JOIN vouchers v ON v.id = ve.voucher_id
    WHERE la.company_id = ${companyId}
      AND v.company_id = ${companyId}
      AND v.deleted_at IS NULL
      AND (la.name ILIKE '%migration suspense%' OR la.sub_type = 'migration_suspense')
      AND ABS(
        COALESCE(ve.debit_amount, '0')::numeric - COALESCE(ve.credit_amount, '0')::numeric
      ) > 0.0001
  `);
  const migrationSuspenseEntryCount = Number(firstRow(suspense)?.count ?? 0);

  const failures: {
    type: string;
    status: string;
    sourceWriteCount?: number;
    migrationSuspenseEntryCount?: number;
  }[] = checks.filter((check) => check.status !== "PASS");
  if (sourceWriteCount > 0) {
    failures.push({ type: "source_write_lock_database", status: "FAIL", sourceWriteCount });
  }
  if (migrationSuspenseEntryCount > 0) {
    failures.push({
      type: "migration_suspense_database",
      status: "FAIL",
      migrationSuspenseEntryCount,
    });
  }

  const completion = await db.execute(sql`
    SELECT * FROM sp_completion_records
    WHERE company_id = ${companyId} AND cutover_id = ${cutoverId}
    LIMIT 1
  `);

  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    cutover,
    checks,
    sourceWriteCount,
    migrationSuspenseEntryCount,
    failureCount: failures.length,
    failures,
    completionRecord: firstRow(completion) ?? null,
  };
}

export function registerSpProductionClosureRoutes(app: Express): void {
  app.get("/api/sp/production/closure-status", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = Number(await requireSpCompany(req, res));
      if (!companyId) return;
      res.json(await buildSpProductionClosureStatus(companyId));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/sp/production/evidence", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = Number(await requireSpCompany(req, res));
      if (!companyId) return;
      const cutover = await latestActiveCutover(companyId);
      if (!cutover) {
        return res.status(409).json({ message: releaseDebtEnglish("No active Supplier Partner cutover exists.") });
      }

      const evidenceType = String(req.body?.evidenceType ?? "").trim();
      const status = String(req.body?.status ?? "").toUpperCase();
      if (!ALL_EVIDENCE_TYPES.has(evidenceType)) {
        return res.status(400).json({ message: releaseDebtEnglish("Unknown production evidence type.") });
      }
      if (!["PASS", "FAIL", "RECORDED"].includes(status)) {
        return res.status(400).json({ message: releaseDebtEnglish("status must be PASS, FAIL, or RECORDED.") });
      }

      const result = await db.execute(sql`
        INSERT INTO sp_production_evidence(
          company_id, cutover_id, evidence_type, status, detail, recorded_by
        ) VALUES (
          ${companyId}, ${Number(cutover.id)}, ${evidenceType}, ${status},
          ${JSON.stringify(req.body?.detail ?? {})}::jsonb, ${username(req)}
        )
        ON CONFLICT (company_id, cutover_id, evidence_type)
        DO UPDATE SET
          status = EXCLUDED.status,
          detail = EXCLUDED.detail,
          recorded_by = EXCLUDED.recorded_by,
          recorded_at = now(),
          updated_at = now()
        RETURNING *
      `);
      res.json({ success: true, evidence: firstRow(result) });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/sp/production/close-rollback-window", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = Number(await requireSpCompany(req, res));
      if (!companyId) return;
      const status = await buildSpProductionClosureStatus(companyId);
      if (status.status !== "PASS") {
        return res.status(409).json({ message: releaseDebtEnglish("Stabilization checks are not all PASS."), status });
      }

      const cutoverId = Number(status.cutover.id);
      const reason = String(req.body.reason).trim();
      const completion = await db.transaction(async (tx) => {
        const updated = await tx.execute(sql`
          UPDATE sp_migration_cutovers
          SET status = 'completed', rollback_deadline = now(), updated_at = now()
          WHERE id = ${cutoverId}
            AND target_company_id = ${companyId}
            AND status = 'active'
          RETURNING id
        `);
        if (resultRows(updated).length !== 1) {
          throw new Error(releaseDebtEnglish("Cutover is no longer active."));
        }

        const inserted = await tx.execute(sql`
          INSERT INTO sp_completion_records(
            company_id, cutover_id, completion_snapshot, reason, approved_by
          ) VALUES (
            ${companyId}, ${cutoverId}, ${JSON.stringify(status)}::jsonb,
            ${reason}, ${username(req)}
          )
          ON CONFLICT (company_id, cutover_id) DO NOTHING
          RETURNING *
        `);
        const row = firstRow(inserted);
        if (!row) {
          throw new Error(releaseDebtEnglish("Supplier Partner cutover completion was already recorded."));
        }
        return row;
      });

      res.json({
        success: true,
        message: releaseDebtEnglish(
          "Supplier Partner stabilization is closed and the rollback window is no longer available."
        ),
        completion,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
