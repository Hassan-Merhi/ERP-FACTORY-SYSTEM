import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { requireAuth, requireRole } from "../../auth";
import { validateMigrationPair, pn } from "./spMigrationPhase2Common";
import { getLiveCutover } from "./spMigrationCutoverState";
import { backfillLegacyCutoverStockDeltaKeys, restoreExactCutoverStock } from "./spMigrationPhase4Inventory";
import { restoreUsersToSourceExact } from "./spMigrationPhase4Users";
import { exactCutoverConfirmation } from "./spMigrationPhase4Policy";
import { resultRows, firstRow } from "../../lib/queryResult";
import { installPhase4WriteGuard, invalidatePhase4HoldCache } from "./phase4WriteGuard";
import {
  finalizeCutover,
  loadCutover,
  normalizedVerification,
  prepareCutover,
  targetLiveActivity,
} from "./spMigrationPhase4RoutesFinalizeCutover";

async function rollbackCutover(req: Request, res: Response): Promise<Response | void> {
  const cutoverId = pn(req.body?.cutoverId);
  if (!cutoverId) return res.status(400).json({ message: "cutoverId is required" });
  await backfillLegacyCutoverStockDeltaKeys();
  const cutover = await loadCutover(cutoverId);
  if (!cutover) return res.status(404).json({ message: "Cutover not found" });
  if (cutover.status !== "active")
    return res.status(409).json({ message: "Only an active cutover can be rolled back." });
  const error = exactCutoverConfirmation(
    req.body?.confirmation,
    "ROLLBACK CUTOVER",
    req.body?.companyNameConfirm,
    cutover.source_company_name
  );
  if (error) return res.status(400).json({ message: error });
  if (!cutover.rollback_deadline || new Date(cutover.rollback_deadline).getTime() < Date.now()) {
    return res.status(409).json({ message: "The controlled rollback window has expired." });
  }
  const activity = await targetLiveActivity(pn(cutover.target_company_id), cutover.activated_at);
  if (activity.total > 0) {
    return res.status(409).json({
      message: "Rollback is blocked because the Supplier Partner company has genuine post-cutover activity.",
      activity,
    });
  }
  const users = await restoreUsersToSourceExact(
    cutoverId,
    pn(cutover.source_company_id),
    pn(cutover.target_company_id),
    cutover.source_company_name,
    false
  );
  const stock = await restoreExactCutoverStock(cutoverId, pn(cutover.target_company_id));
  const rolledBack = await db.execute(sql`
    UPDATE sp_migration_cutovers
    SET status = 'rolled_back', rolled_back_by = ${req.session?.userId ?? null}, rolled_back_at = now(),
        target_write_hold = true, recovery_summary = ${JSON.stringify({ users, stock })}::jsonb, updated_at = now()
    WHERE id = ${cutoverId} AND status = 'active'
    RETURNING *
  `);
  invalidatePhase4HoldCache();
  return res.json({
    success: true,
    message: "Cutover rolled back. The source is writable again; the target copy remains read-only for safety.",
    cutover: resultRows(rolledBack)[0],
    users,
    stock,
  });
}

async function cancelPreparedCutover(req: Request, res: Response): Promise<Response | void> {
  const cutoverId = pn(req.body?.cutoverId);
  if (!cutoverId) return res.status(400).json({ message: "cutoverId is required" });
  await backfillLegacyCutoverStockDeltaKeys();
  const cutover = await loadCutover(cutoverId);
  if (!cutover) return res.status(404).json({ message: "Cutover not found" });
  if (cutover.status !== "prepared")
    return res.status(409).json({ message: "Only a prepared cutover can be cancelled." });
  const error = exactCutoverConfirmation(
    req.body?.confirmation,
    "CANCEL CUTOVER",
    req.body?.companyNameConfirm,
    cutover.source_company_name
  );
  if (error) return res.status(400).json({ message: error });

  const changedResult = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM sp_migration_cutover_stock_deltas WHERE cutover_id = ${cutoverId})::int AS stock_count,
      (SELECT COUNT(*) FROM sp_migration_cutover_role_changes WHERE cutover_id = ${cutoverId})::int AS role_count
  `);
  const changed = firstRow(changedResult) ?? {};
  const hadFinalizationChanges =
    pn(changed.stock_count) > 0 || pn(changed.role_count) > 0 || Boolean(cutover.delta_summary);
  const users = await restoreUsersToSourceExact(
    cutoverId,
    pn(cutover.source_company_id),
    pn(cutover.target_company_id),
    cutover.source_company_name,
    true
  );
  const stock = await restoreExactCutoverStock(cutoverId, pn(cutover.target_company_id));
  const cancelled = await db.execute(sql`
    UPDATE sp_migration_cutovers
    SET status = 'cancelled', cancelled_at = now(), finalize_started_at = NULL,
        target_write_hold = ${hadFinalizationChanges},
        recovery_summary = ${JSON.stringify({ users, stock })}::jsonb,
        updated_at = now()
    WHERE id = ${cutoverId} AND status = 'prepared'
    RETURNING *
  `);
  invalidatePhase4HoldCache();
  return res.json({
    success: true,
    message: hadFinalizationChanges
      ? "Prepared cutover cancelled. The target remains read-only because finalization had already changed its migration copy."
      : "Prepared cutover cancelled and both temporary locks were removed.",
    cutover: resultRows(cancelled)[0],
    users,
    stock,
  });
}

async function releaseTargetHold(req: Request, res: Response): Promise<Response | void> {
  const cutoverId = pn(req.body?.cutoverId);
  if (!cutoverId) return res.status(400).json({ message: "cutoverId is required" });
  await backfillLegacyCutoverStockDeltaKeys();
  const cutover = await loadCutover(cutoverId);
  if (!cutover) return res.status(404).json({ message: "Cutover not found" });
  const error = exactCutoverConfirmation(
    req.body?.confirmation,
    "RELEASE TARGET HOLD",
    req.body?.companyNameConfirm,
    cutover.source_company_name
  );
  if (error) return res.status(400).json({ message: error });
  if (!["rolled_back", "cancelled", "failed"].includes(String(cutover.status)) || !cutover.target_write_hold) {
    return res.status(409).json({ message: "This cutover does not currently hold the target read-only." });
  }
  const latest = await db.execute(sql`
    SELECT id FROM sp_migration_cutovers
    WHERE target_company_id = ${pn(cutover.target_company_id)}
    ORDER BY id DESC LIMIT 1
  `);
  if (pn(firstRow(latest)?.id) !== cutoverId) {
    return res
      .status(409)
      .json({ message: "A newer cutover exists for this target; its state controls the write lock." });
  }
  const activity = await targetLiveActivity(pn(cutover.target_company_id));
  if (activity.total > 0) {
    return res
      .status(409)
      .json({ message: "Target hold cannot be released while genuine target transactions exist.", activity });
  }
  const released = await db.execute(sql`
    UPDATE sp_migration_cutovers
    SET target_write_hold = false, updated_at = now()
    WHERE id = ${cutoverId}
    RETURNING *
  `);
  invalidatePhase4HoldCache();
  return res.json({ success: true, cutover: resultRows(released)[0] });
}

async function statusCutover(req: Request, res: Response): Promise<Response | void> {
  const pair = await validateMigrationPair(req, res, false);
  if (!pair) return;
  await backfillLegacyCutoverStockDeltaKeys();
  const live = await getLiveCutover(pair.sourceId, pair.targetId);
  const latestResult = await db.execute(sql`
    SELECT * FROM sp_migration_cutovers
    WHERE source_company_id = ${pair.sourceId} AND target_company_id = ${pair.targetId}
    ORDER BY id DESC LIMIT 1
  `);
  return res.json({
    liveCutover: live,
    latestCutover: firstRow(latestResult) ?? null,
    verification: await normalizedVerification(pair.sourceId, pair.targetId, !live || live.status === "prepared"),
  });
}

async function finalVerification(req: Request, res: Response): Promise<Response | void> {
  const pair = await validateMigrationPair(req, res, false);
  if (!pair) return;
  const live = await getLiveCutover(pair.sourceId, pair.targetId);
  return res.json(await normalizedVerification(pair.sourceId, pair.targetId, !live || live.status === "prepared"));
}

export function registerSpMigrationPhase4Routes(app: Express): void {
  installPhase4WriteGuard(app);
  void backfillLegacyCutoverStockDeltaKeys().catch((error) => {
    logger.warn("[SP Phase 4] Legacy stock-delta key backfill deferred", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const developer = [requireAuth, requireRole("Developer")] as const;

  app.get("/api/sp/migration/final-verification", ...developer, finalVerification);
  app.get("/api/sp/migration/cutover", ...developer, statusCutover);
  app.get("/api/sp/migration/cutover/status", ...developer, statusCutover);
  app.post("/api/sp/migration/cutover/prepare", ...developer, prepareCutover);
  app.post("/api/sp/migration/cutover/finalize", ...developer, finalizeCutover);
  app.post("/api/sp/migration/cutover/rollback", ...developer, rollbackCutover);
  app.post("/api/sp/migration/cutover/cancel", ...developer, cancelPreparedCutover);
  app.post("/api/sp/migration/cutover/release-target-hold", ...developer, releaseTargetHold);
  app.post("/api/sp/migration/cutover", ...developer, async (req: Request, res: Response) => {
    if (req.body?.action === "prepare") return prepareCutover(req, res);
    if (req.body?.action === "finalize") return finalizeCutover(req, res);
    if (req.body?.action === "rollback") return rollbackCutover(req, res);
    if (req.body?.action === "cancel") return cancelPreparedCutover(req, res);
    if (req.body?.action === "release-target-hold") return releaseTargetHold(req, res);
    return res
      .status(400)
      .json({ message: "action must be prepare, finalize, rollback, cancel, or release-target-hold" });
  });
}
