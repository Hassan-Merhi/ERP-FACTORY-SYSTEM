// Extracted from ./spMigrationPhase4Routes.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { inventoryCutoverRefusal } from "../../services/accounting/perpetualInventory/cutoverRefusal";
import { logger } from "../../lib/logger";
import { pn, validateMigrationPair } from "./spMigrationPhase2Common";
import { importHistoricalSales } from "./spMigrationPhase2Sales";
import { importContainers } from "./spMigrationPhase2Containers";
import { getLiveCutover } from "./spMigrationCutoverState";
import {
  backfillLegacyCutoverStockDeltaKeys,
  restoreExactCutoverStock,
  synchronizeExactCutoverStock,
} from "./spMigrationPhase4Inventory";
import { moveUsersToTargetExact, restoreUsersToSourceExact } from "./spMigrationPhase4Users";
import { reconcileHistoricalSalesCopy, reconcileMigrationOwnedContainers } from "./spMigrationPhase4Reconcile";
import { buildFinalMigrationVerification } from "./spMigrationPhase4Verification";
import { classifyFinalVerification, exactCutoverConfirmation } from "./spMigrationPhase4Policy";
import { repairSpSupplierVoucherLinks } from "./spSupplierVoucherSync";
import { firstRow, resultRows } from "../../lib/queryResult";
import {
  invalidatePhase4HoldCache,
  invokeMigrationHandler,
  type CutoverRow,
  type MigrationRunAck,
  type TargetLiveActivity,
} from "./phase4WriteGuard";

export async function targetLiveActivity(targetId: number, activatedAt?: string | null): Promise<TargetLiveActivity> {
  const vouchers = await db.execute(
    activatedAt
      ? sql`
    SELECT COUNT(*)::int AS count FROM vouchers v
    WHERE v.company_id = ${targetId}
      AND v.deleted_at IS NULL
      AND v.created_at > ${activatedAt}
      AND COALESCE(v.source_module, 'ERP') NOT IN ('SP_MIGRATION', 'SP_MIGRATION_READONLY')
      AND v.voucher_number NOT LIKE ${`OB-${targetId}-%`}
      AND v.voucher_number NOT LIKE 'GC-PROFIT-OPN-%'
  `
      : sql`
    SELECT COUNT(*)::int AS count FROM vouchers v
    WHERE v.company_id = ${targetId}
      AND v.deleted_at IS NULL
      AND COALESCE(v.source_module, 'ERP') NOT IN ('SP_MIGRATION', 'SP_MIGRATION_READONLY')
      AND v.voucher_number NOT LIKE ${`OB-${targetId}-%`}
      AND v.voucher_number NOT LIKE 'GC-PROFIT-OPN-%'
  `
  );
  const sales = await db.execute(
    activatedAt
      ? sql`
    SELECT COUNT(*)::int AS count FROM sp_sales s
    WHERE s.company_id = ${targetId} AND s.created_at > ${activatedAt}
  `
      : sql`SELECT COUNT(*)::int AS count FROM sp_sales s WHERE s.company_id = ${targetId}`
  );
  const offloads = await db.execute(
    activatedAt
      ? sql`
    SELECT COUNT(*)::int AS count FROM sp_offloads o
    WHERE o.company_id = ${targetId} AND o.created_at > ${activatedAt}
  `
      : sql`SELECT COUNT(*)::int AS count FROM sp_offloads o WHERE o.company_id = ${targetId}`
  );
  const prepaid = await db.execute(
    activatedAt
      ? sql`
    SELECT COUNT(*)::int AS count FROM sp_prepaid_charges p
    WHERE p.company_id = ${targetId} AND p.created_at > ${activatedAt}
  `
      : sql`SELECT COUNT(*)::int AS count FROM sp_prepaid_charges p WHERE p.company_id = ${targetId}`
  );
  const containers = await db.execute(
    activatedAt
      ? sql`
    SELECT COUNT(*)::int AS count FROM sp_containers c
    WHERE c.company_id = ${targetId}
      AND c.created_at > ${activatedAt}
      AND COALESCE(c.notes, '') NOT ILIKE '%migrated from%erp container%'
  `
      : sql`
    SELECT COUNT(*)::int AS count FROM sp_containers c
    WHERE c.company_id = ${targetId}
      AND COALESCE(c.notes, '') NOT ILIKE '%migrated from%erp container%'
  `
  );
  const counts = {
    vouchers: pn(firstRow(vouchers)?.count),
    sales: pn(firstRow(sales)?.count),
    offloads: pn(firstRow(offloads)?.count),
    prepaid: pn(firstRow(prepaid)?.count),
    containers: pn(firstRow(containers)?.count),
  };
  return { ...counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) };
}

export async function normalizedVerification(sourceId: number, targetId: number, requireUnusedTarget = true) {
  const verification = await buildFinalMigrationVerification(sourceId, targetId);
  verification.blockers = (verification.blockers ?? []).filter(
    (issue: { code: string }) => issue.code !== "TARGET_ALREADY_LIVE"
  );
  const activity = await targetLiveActivity(targetId);
  if (requireUnusedTarget && activity.total > 0) {
    verification.blockers.push({
      code: "TARGET_ALREADY_LIVE",
      message: `Target contains ${activity.total} genuine non-migration transaction(s).`,
      count: activity.total,
      detail: activity,
    });
  }
  verification.counts.targetLiveActivity = activity.total;
  verification.overall = classifyFinalVerification(verification.blockers, verification.deltas ?? []);
  verification.canPrepare = verification.blockers.length === 0;
  verification.canFinalize = verification.blockers.length === 0 && (verification.deltas ?? []).length === 0;
  return verification;
}

export async function loadCutover(cutoverId: number): Promise<CutoverRow | null> {
  const result = await db.execute(sql`SELECT * FROM sp_migration_cutovers WHERE id = ${cutoverId} LIMIT 1`);
  return firstRow<CutoverRow>(result) ?? null;
}

export async function prepareCutover(req: Request, res: Response): Promise<Response | void> {
  const pair = await validateMigrationPair(req, res, false);
  if (!pair) return;
  const error = exactCutoverConfirmation(
    req.body?.confirmation,
    "PREPARE CUTOVER",
    req.body?.companyNameConfirm,
    pair.sourceCompany.name
  );
  if (error) return res.status(400).json({ message: error });
  await backfillLegacyCutoverStockDeltaKeys();
  const existing = await getLiveCutover(pair.sourceId, pair.targetId);
  if (existing)
    return res
      .status(409)
      .json({ message: `Cutover ${existing.id} is already ${existing.status}.`, cutover: existing });
  const verification = await normalizedVerification(pair.sourceId, pair.targetId);
  if (!verification.canPrepare) {
    return res
      .status(409)
      .json({ message: "Cutover preparation is blocked. Resolve all FAIL items first.", verification });
  }
  const rollbackWindowHours = Math.min(168, Math.max(1, pn(req.body?.rollbackWindowHours) || 72));
  const inserted = await db.execute(sql`
    INSERT INTO sp_migration_cutovers
      (source_company_id, target_company_id, status, prepared_by,
       source_company_name, target_company_name, readiness_snapshot,
       verification_snapshot, rollback_window_hours, target_write_hold, notes)
    VALUES
      (${pair.sourceId}, ${pair.targetId}, 'prepared', ${req.session?.userId ?? null},
       ${pair.sourceCompany.name}, ${pair.targetCompany.name}, ${JSON.stringify(verification)}::jsonb,
       ${JSON.stringify(verification)}::jsonb, ${rollbackWindowHours}, false, ${req.body?.notes ?? null})
    RETURNING *
  `);
  invalidatePhase4HoldCache();
  return res.json({
    success: true,
    message: "Source and target are locked. Review WARN deltas, then finalize to synchronize them.",
    cutover: resultRows(inserted)[0],
    verification,
  });
}

export async function finalizeCutover(req: Request, res: Response): Promise<Response | void> {
  const pair = await validateMigrationPair(req, res, false);
  if (!pair) return;
  // Wave 11: the migration rewrites stock with no journal: refused once either
  // company has its perpetual-inventory cut-over applied.
  const inventoryRefusal =
    (await inventoryCutoverRefusal(db, pair.targetId, "sp-migration-cutover")) ??
    (await inventoryCutoverRefusal(db, pair.sourceId, "sp-migration-cutover"));
  if (inventoryRefusal) return res.status(inventoryRefusal.status).json(inventoryRefusal.body);
  const error = exactCutoverConfirmation(
    req.body?.confirmation,
    "FINALIZE CUTOVER",
    req.body?.companyNameConfirm,
    pair.sourceCompany.name
  );
  if (error) return res.status(400).json({ message: error });
  await backfillLegacyCutoverStockDeltaKeys();
  const live = await getLiveCutover(pair.sourceId, pair.targetId);
  if (!live || live.status !== "prepared") {
    return res.status(409).json({ message: "Prepare and lock this source/target pair before finalizing." });
  }
  const cutoverId = pn(live.id);
  const claimed = await db.execute(sql`
    UPDATE sp_migration_cutovers
    SET finalize_started_at = now(), failure_message = NULL, updated_at = now()
    WHERE id = ${cutoverId} AND status = 'prepared' AND finalize_started_at IS NULL
    RETURNING id
  `);
  if (!firstRow(claimed)) {
    return res.status(409).json({ message: "Cutover finalization is already running or awaiting recovery." });
  }

  const partialDeltaSummary: Record<string, unknown> = {};
  try {
    const migrationBody = {
      sourceCompanyId: pair.sourceId,
      targetCompanyId: pair.targetId,
      companyNameConfirm: pair.sourceCompany.name,
      confirmation: "MIGRATE",
    };
    const salesDelta = (await invokeMigrationHandler(importHistoricalSales, req, migrationBody)) as MigrationRunAck;
    partialDeltaSummary.salesDelta = salesDelta;
    const salesRepair = await reconcileHistoricalSalesCopy({
      runId: String(salesDelta.runId),
      sourceId: pair.sourceId,
      targetId: pair.targetId,
    });
    partialDeltaSummary.salesRepair = salesRepair;
    const containerDelta = (await invokeMigrationHandler(importContainers, req, migrationBody)) as MigrationRunAck;
    partialDeltaSummary.containerDelta = containerDelta;
    const containerRepair = await reconcileMigrationOwnedContainers({
      runId: String(containerDelta.runId),
      sourceId: pair.sourceId,
      targetId: pair.targetId,
      sourceCompanyName: pair.sourceCompany.name,
    });
    partialDeltaSummary.containerRepair = containerRepair;
    const stockDelta = await synchronizeExactCutoverStock(cutoverId, pair.sourceId, pair.targetId);
    partialDeltaSummary.stockDelta = stockDelta;
    // Wave 16 (A): the audited, company-scoped apply (closed periods left as they are).
    const supplierLinksRepaired = await repairSpSupplierVoucherLinks(pair.targetId, {
      userId: req.session.userId ?? "unknown",
      username: req.session.username || "unknown",
    });
    partialDeltaSummary.supplierLinksRepaired = supplierLinksRepaired;

    const repairBlockers = [...(salesRepair.blockers ?? []), ...(containerRepair.blockers ?? [])];
    const verification = await normalizedVerification(pair.sourceId, pair.targetId);
    if (repairBlockers.length > 0 || !verification.canFinalize) {
      await db.execute(sql`
        UPDATE sp_migration_cutovers
        SET finalize_started_at = NULL,
            failure_message = ${
              repairBlockers.length
                ? `Phase 4 repair blockers: ${repairBlockers.slice(0, 5).join(" | ")}`
                : "Final verification did not pass after delta synchronization"
            },
            delta_summary = ${JSON.stringify({ salesDelta, salesRepair, containerDelta, containerRepair, stockDelta, supplierLinksRepaired })}::jsonb,
            final_readiness_snapshot = ${JSON.stringify(verification)}::jsonb,
            verification_snapshot = ${JSON.stringify(verification)}::jsonb,
            updated_at = now()
        WHERE id = ${cutoverId}
      `);
      return res.status(409).json({
        message: "Final synchronization completed, but verification is not PASS. Both companies remain locked.",
        cutoverId,
        repairBlockers,
        deltaSummary: { salesDelta, salesRepair, containerDelta, containerRepair, stockDelta, supplierLinksRepaired },
        verification,
      });
    }

    const roleSummary = await moveUsersToTargetExact(cutoverId, pair.sourceId, pair.targetId, pair.targetCompany.name);
    const rollbackWindowHours = pn(live.rollback_window_hours) || 72;
    const activated = await db.execute(sql`
      UPDATE sp_migration_cutovers
      SET status = 'active', activated_by = ${req.session?.userId ?? null}, activated_at = now(),
          rollback_deadline = now() + (${rollbackWindowHours} || ' hours')::interval,
          delta_summary = ${JSON.stringify({ salesDelta, salesRepair, containerDelta, containerRepair, stockDelta, supplierLinksRepaired })}::jsonb,
          role_summary = ${JSON.stringify(roleSummary)}::jsonb,
          final_readiness_snapshot = ${JSON.stringify(verification)}::jsonb,
          verification_snapshot = ${JSON.stringify(verification)}::jsonb,
          finalize_started_at = NULL, failure_message = NULL, target_write_hold = false, updated_at = now()
      WHERE id = ${cutoverId} AND status = 'prepared'
      RETURNING *
    `);
    if (!firstRow(activated)) throw new Error("Cutover activation state changed before the final commit.");
    invalidatePhase4HoldCache();
    return res.json({
      success: true,
      message: "Supplier Partner cutover is active and final verification is PASS.",
      cutover: resultRows(activated)[0],
      deltaSummary: { salesDelta, salesRepair, containerDelta, containerRepair, stockDelta, supplierLinksRepaired },
      roleSummary,
      verification,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    const recovery: Record<string, unknown> = {};
    try {
      recovery.users = await restoreUsersToSourceExact(
        cutoverId,
        pair.sourceId,
        pair.targetId,
        pair.sourceCompany.name,
        true
      );
    } catch (restoreError) {
      recovery.userRestoreError = restoreError instanceof Error ? restoreError.message : String(restoreError);
    }
    try {
      recovery.stock = await restoreExactCutoverStock(cutoverId, pair.targetId);
    } catch (restoreError) {
      recovery.stockRestoreError = restoreError instanceof Error ? restoreError.message : String(restoreError);
    }
    await db
      .execute(
        sql`
      UPDATE sp_migration_cutovers
      SET finalize_started_at = NULL, failure_message = ${message},
          delta_summary = ${JSON.stringify(partialDeltaSummary)}::jsonb,
          recovery_summary = ${JSON.stringify(recovery)}::jsonb, updated_at = now()
      WHERE id = ${cutoverId}
    `
      )
      .catch(() => undefined);
    invalidatePhase4HoldCache();
    logger.error("[SP Phase 4] Cutover finalization failed and recovery was attempted", {
      error: caught,
      cutoverId,
      recovery,
    });
    return res.status(500).json({
      message: `Cutover finalization failed: ${message}`,
      cutoverId,
      recovery,
    });
  }
}
