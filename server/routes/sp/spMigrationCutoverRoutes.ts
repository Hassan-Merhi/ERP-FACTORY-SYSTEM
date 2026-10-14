import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { requireAuth, requireRole } from "../../auth";
import { validateMigrationPair, pn } from "./spMigrationPhase2Common";
import { ensureCutoverSchema, installCutoverWriteGuard } from "./spMigrationCutoverState";
import { firstRow } from "../../lib/queryResult";

async function ensureCutoverColumns(): Promise<void> {
  await ensureCutoverSchema();
  await db.execute(
    sql.raw(`
    ALTER TABLE sp_migration_cutovers
      ADD COLUMN IF NOT EXISTS rollback_window_hours INTEGER NOT NULL DEFAULT 72
  `)
  );
  await db.execute(
    sql.raw(`
    ALTER TABLE sp_migration_cutovers
      ADD COLUMN IF NOT EXISTS finalize_started_at TIMESTAMPTZ
  `)
  );
  await db.execute(
    sql.raw(`
    ALTER TABLE sp_migration_cutover_stock_deltas
      ADD COLUMN IF NOT EXISTS created_target_inventory BOOLEAN NOT NULL DEFAULT false
  `)
  );
}

async function mapSuspenseEntry(req: Request, res: Response): Promise<Response | void> {
  const pair = await validateMigrationPair(req, res, false);
  if (!pair) return;
  const targetEntryId = pn(req.params.targetEntryId);
  const targetLedgerAccountId = pn(req.body?.targetLedgerAccountId);
  if (!targetEntryId || !targetLedgerAccountId) {
    return res.status(400).json({ message: "targetEntryId and targetLedgerAccountId are required" });
  }
  const targetAccount = await db.execute(sql`
    SELECT id FROM ledger_accounts
    WHERE id = ${targetLedgerAccountId} AND company_id = ${pair.targetId} AND deleted_at IS NULL
    LIMIT 1
  `);
  if (!firstRow(targetAccount))
    return res.status(400).json({ message: "Target account does not belong to the target company." });

  const updated = await db.execute(sql`
    UPDATE voucher_entries e
    SET ledger_account_id = ${targetLedgerAccountId}
    FROM vouchers v, ledger_accounts suspense
    WHERE e.id = ${targetEntryId}
      AND v.id = e.voucher_id
      AND v.company_id = ${pair.targetId}
      AND suspense.id = e.ledger_account_id
      AND suspense.company_id = ${pair.targetId}
      AND suspense.sub_type = 'gc_mig_suspense'
    RETURNING e.id
  `);
  if (!firstRow(updated))
    return res.status(404).json({ message: "Suspense entry was not found or is already mapped." });
  return res.json({ success: true, targetEntryId, targetLedgerAccountId });
}

async function mapContainerCharge(req: Request, res: Response): Promise<Response | void> {
  const pair = await validateMigrationPair(req, res, false);
  if (!pair) return;
  const chargeId = pn(req.params.chargeId);
  const targetLedgerAccountId = pn(req.body?.targetLedgerAccountId);
  if (!chargeId || !targetLedgerAccountId) {
    return res.status(400).json({ message: "chargeId and targetLedgerAccountId are required" });
  }
  const updated = await db.execute(sql`
    UPDATE sp_migration_container_charges m
    SET target_ledger_account_id = a.id,
        mapping_method = 'manual_approval',
        review_status = 'mapped',
        notes = trim(COALESCE(m.notes, '') || ' Manually approved during cutover review.')
    FROM ledger_accounts a
    WHERE m.id = ${chargeId}
      AND m.source_company_id = ${pair.sourceId}
      AND m.target_company_id = ${pair.targetId}
      AND a.id = ${targetLedgerAccountId}
      AND a.company_id = ${pair.targetId}
      AND a.deleted_at IS NULL
    RETURNING m.id
  `);
  if (!firstRow(updated))
    return res.status(404).json({ message: "Charge review row or target account was not found." });
  return res.json({ success: true, chargeId, targetLedgerAccountId });
}

export function registerSpMigrationCutoverRoutes(app: Express): void {
  installCutoverWriteGuard(app);
  void ensureCutoverColumns().catch((error) => {
    logger.warn("[SP Cutover] Schema setup deferred", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const developer = [requireAuth, requireRole("Developer")] as const;
  // Phase 4 registers and handles all /api/sp/migration/cutover endpoints earlier.
  // Preserve this registrar's write guard, schema setup and unique review mapping
  // endpoints, but do not re-register unreachable older cutover handlers.

  app.post("/api/sp/migration/gc-suspense-review/:targetEntryId/map", ...developer, mapSuspenseEntry);
  app.post("/api/sp/migration/gc-container-charge-review/:chargeId/map", ...developer, mapContainerCharge);
}
