import type { Express, NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { sqlArray } from "../../lib/sqlArray";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { requireAuth, requireRole } from "../../auth";
import { validateMigrationPair, pn } from "./spMigrationPhase2Common";
import { importHistoricalSales } from "./spMigrationPhase2Sales";
import { importContainers } from "./spMigrationPhase2Containers";
import { getLiveCutover, invalidateCutoverLockCache } from "./spMigrationCutoverState";
import { ensureCutoverHardening } from "./spMigrationCutoverHardening";
import {
  ensurePhase4CutoverSchema,
  restoreExactCutoverStock,
  synchronizeExactCutoverStock,
} from "./spMigrationPhase4Inventory";
import { moveUsersToTargetExact, restoreUsersToSourceExact } from "./spMigrationPhase4Users";
import { reconcileHistoricalSalesCopy, reconcileMigrationOwnedContainers } from "./spMigrationPhase4Reconcile";
import { buildFinalMigrationVerification } from "./spMigrationPhase4Verification";
import {
  classifyFinalVerification,
  exactCutoverConfirmation,
  latestCutoverBlocksCompany,
} from "./spMigrationPhase4Policy";
import { repairSpSupplierVoucherLinks } from "./spSupplierVoucherSync";
import { resultRows, firstRow } from "../../lib/queryResult";

const installedApps = new WeakSet<object>();
let holdCache: { expiresAt: number; byCompany: Map<number, Record<string, unknown> | null> } | null = null;
let phase4RouteSchemaPromise: Promise<void> | null = null;

function invalidatePhase4HoldCache(): void {
  holdCache = null;
  invalidateCutoverLockCache();
}

function ensurePhase4Schema(): Promise<void> {
  if (!phase4RouteSchemaPromise) {
    phase4RouteSchemaPromise = (async () => {
      await Promise.all([ensurePhase4CutoverSchema(), ensureCutoverHardening()]);
      await db.execute(
        sql.raw(`
        ALTER TABLE sp_migration_cutovers
          ADD COLUMN IF NOT EXISTS rollback_window_hours INTEGER NOT NULL DEFAULT 72,
          ADD COLUMN IF NOT EXISTS finalize_started_at TIMESTAMPTZ
      `)
      );
    })().catch((error) => {
      phase4RouteSchemaPromise = null;
      throw error;
    });
  }
  return phase4RouteSchemaPromise;
}

function collectCompanyIds(req: Request): number[] {
  const values = [
    req.session?.currentCompanyId,
    req.body?.companyId,
    req.body?.sourceCompanyId,
    req.body?.targetCompanyId,
    req.query?.companyId,
    req.query?.sourceCompanyId,
    req.query?.targetCompanyId,
    req.params?.companyId,
  ];
  return Array.from(
    new Set(
      values
        .map((value) => Number.parseInt(String(value ?? ""), 10))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

async function loadLatestCutoversForCompanies(
  companyIds: number[]
): Promise<Map<number, Record<string, unknown> | null>> {
  await ensurePhase4Schema();
  if (holdCache && holdCache.expiresAt > Date.now() && companyIds.every((id) => holdCache!.byCompany.has(id))) {
    return holdCache.byCompany;
  }
  const byCompany = holdCache?.byCompany ?? new Map();
  for (const companyId of companyIds) {
    const result = await db.execute(sql`
      SELECT *
      FROM sp_migration_cutovers
      WHERE source_company_id = ${companyId} OR target_company_id = ${companyId}
      ORDER BY id DESC
      LIMIT 1
    `);
    byCompany.set(companyId, firstRow(result) ?? null);
  }
  holdCache = { expiresAt: Date.now() + 3000, byCompany };
  return byCompany;
}

async function phase4WriteGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const method = req.method.toUpperCase();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return next();
    if (!req.path.startsWith("/api")) return next();
    if (req.path.startsWith("/api/auth/") || req.path.startsWith("/api/health") || req.path === "/api/csrf-token") {
      return next();
    }

    if (req.path.startsWith("/api/sp/migration/")) {
      const allowedMigrationWrite =
        req.path.startsWith("/api/sp/migration/cutover") ||
        req.path.startsWith("/api/sp/migration/gc-suspense-review/") ||
        req.path.startsWith("/api/sp/migration/gc-container-charge-review/");
      if (allowedMigrationWrite) return next();

      const migrationCompanyIds = collectCompanyIds(req);
      const runId = String(req.body?.runId ?? "").trim();
      if (runId) {
        const run = await db.execute(sql`
          SELECT source_company_id, target_company_id
          FROM sp_migration_rehearsal_runs
          WHERE id = ${runId}
          LIMIT 1
        `);
        const row = firstRow(run);
        if (row) {
          migrationCompanyIds.push(pn(row.source_company_id), pn(row.target_company_id));
        }
      }
      const uniqueMigrationCompanyIds = Array.from(new Set(migrationCompanyIds.filter(Boolean)));
      if (uniqueMigrationCompanyIds.length > 0) {
        const active = await db.execute(sql`
          SELECT id, source_company_id, target_company_id, status
          FROM sp_migration_cutovers
          WHERE status IN ('prepared', 'active')
            AND (
              source_company_id = ANY(${sqlArray(uniqueMigrationCompanyIds)}) OR
              target_company_id = ANY(${sqlArray(uniqueMigrationCompanyIds)})
            )
          ORDER BY id DESC
          LIMIT 1
        `);
        const cutover = firstRow(active);
        if (cutover) {
          return void res.status(423).json({
            message:
              "This migration step is blocked while production cutover is prepared or active. Use only cutover controls and review mappings.",
            code: "SP_MIGRATION_WRITE_LOCKED",
            cutoverId: pn(cutover.id),
            status: cutover.status,
          });
        }
      }
      return next();
    }

    const companyIds = collectCompanyIds(req);
    if (companyIds.length === 0) return next();
    const latest = await loadLatestCutoversForCompanies(companyIds);
    for (const companyId of companyIds) {
      const cutover = latest.get(companyId);
      if (!cutover) continue;
      const decision = latestCutoverBlocksCompany({
        companyId,
        sourceCompanyId: pn(cutover.source_company_id),
        targetCompanyId: pn(cutover.target_company_id),
        status: String(cutover.status),
        targetWriteHold: Boolean(cutover.target_write_hold),
      });
      if (!decision.blocked) continue;
      return void res.status(423).json({
        message:
          decision.code === "SP_TARGET_POST_ROLLBACK_HOLD"
            ? "This Supplier Partner company is held read-only after a cancelled or rolled-back cutover. Start a new cutover or explicitly release the hold after review."
            : decision.code === "SP_TARGET_CUTOVER_LOCKED"
              ? "This Supplier Partner company is locked while final synchronization runs."
              : "This ERP company is read-only because Supplier Partner cutover is prepared or active.",
        code: decision.code,
        cutoverId: pn(cutover.id),
        sourceCompanyId: pn(cutover.source_company_id),
        targetCompanyId: pn(cutover.target_company_id),
        status: cutover.status,
      });
    }
    next();
  } catch (error) {
    logger.error("[SP Phase 4 Guard] Failed to evaluate cutover state", { error });
    res.status(503).json({
      message: "Cutover safety status could not be verified. Write request blocked.",
      code: "SP_CUTOVER_GUARD_UNAVAILABLE",
    });
  }
}

function installPhase4WriteGuard(app: Express): void {
  if (installedApps.has(app)) return;
  installedApps.add(app);
  app.use(phase4WriteGuard);
  const expressApp = app as unknown as {
    router?: { stack?: Array<{ route?: unknown }> };
    _router?: { stack?: Array<{ route?: unknown }> };
  };
  const stack = expressApp.router?.stack ?? expressApp._router?.stack;
  if (!stack?.length) return;
  const layer = stack.pop();
  const firstRouteIndex = stack.findIndex((entry) => Boolean(entry.route));
  if (!layer || firstRouteIndex < 0) {
    if (layer) stack.push(layer);
    return;
  }
  stack.splice(firstRouteIndex, 0, layer);
}

/** The slice of the Express response API the migration handlers reach for. */
type CapturedResponse = {
  status(code: number): CapturedResponse;
  json(value: unknown): CapturedResponse;
  send(value: unknown): CapturedResponse;
};

/** A migration endpoint handler, reused both as a route and programmatically. */
type MigrationHandler = (req: Request, res: Response) => Promise<Response | void>;

/** Counts of genuine (non-migration) activity already present in the target company. */
type TargetLiveActivity = {
  vouchers: number;
  sales: number;
  offloads: number;
  prepaid: number;
  containers: number;
  total: number;
};

/** A row of sp_migration_cutovers. */
type CutoverRow = Record<string, unknown> & {
  id: number;
  source_company_id: number;
  target_company_id: number;
  source_company_name: string;
  status: string;
  activated_at: string | null;
  rollback_deadline: string | null;
};

/** The `{ runId }` acknowledgement the delta-import handlers return. */
type MigrationRunAck = { runId: string | number };

async function invokeMigrationHandler(handler: MigrationHandler, req: Request, body: unknown): Promise<unknown> {
  let statusCode = 200;
  let payload: unknown = null;
  const response: CapturedResponse = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      payload = value;
      return this;
    },
    send(value: unknown) {
      payload = value;
      return this;
    },
  };
  // The handlers only read `body` off the request and only call the three
  // response methods captured above, so a shallow clone and this recorder
  // stand in for the real Express pair.
  await handler({ ...req, body } as Request, response as unknown as Response);
  if (statusCode >= 400) {
    const message = (payload as { message?: string } | null)?.message;
    throw new Error(message ?? `Migration handler failed with status ${statusCode}`);
  }
  return payload;
}

async function targetLiveActivity(targetId: number, activatedAt?: string | null): Promise<TargetLiveActivity> {
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

async function normalizedVerification(sourceId: number, targetId: number, requireUnusedTarget = true) {
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

async function loadCutover(cutoverId: number): Promise<CutoverRow | null> {
  const result = await db.execute(sql`SELECT * FROM sp_migration_cutovers WHERE id = ${cutoverId} LIMIT 1`);
  return firstRow<CutoverRow>(result) ?? null;
}

async function prepareCutover(req: Request, res: Response): Promise<Response | void> {
  const pair = await validateMigrationPair(req, res, false);
  if (!pair) return;
  const error = exactCutoverConfirmation(
    req.body?.confirmation,
    "PREPARE CUTOVER",
    req.body?.companyNameConfirm,
    pair.sourceCompany.name
  );
  if (error) return res.status(400).json({ message: error });
  await ensurePhase4Schema();
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

async function finalizeCutover(req: Request, res: Response): Promise<Response | void> {
  const pair = await validateMigrationPair(req, res, false);
  if (!pair) return;
  const error = exactCutoverConfirmation(
    req.body?.confirmation,
    "FINALIZE CUTOVER",
    req.body?.companyNameConfirm,
    pair.sourceCompany.name
  );
  if (error) return res.status(400).json({ message: error });
  await ensurePhase4Schema();
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
    const supplierLinksRepaired = await repairSpSupplierVoucherLinks(pair.targetId);
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

async function rollbackCutover(req: Request, res: Response): Promise<Response | void> {
  const cutoverId = pn(req.body?.cutoverId);
  if (!cutoverId) return res.status(400).json({ message: "cutoverId is required" });
  await ensurePhase4Schema();
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
  await ensurePhase4Schema();
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
  await ensurePhase4Schema();
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
  await ensurePhase4Schema();
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
  void ensurePhase4Schema().catch((error) => {
    logger.warn("[SP Phase 4] Schema setup deferred", {
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
