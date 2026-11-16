import type { Express, NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { resultRows, firstRow } from "../../lib/queryResult";

export type ActiveCutoverLock = {
  id: number;
  sourceCompanyId: number;
  targetCompanyId: number;
  status: "prepared" | "active";
  preparedAt: string | null;
  activatedAt: string | null;
  rollbackDeadline: string | null;
};

let guardInstalled = false;
let lockCache: { expiresAt: number; locks: ActiveCutoverLock[] } | null = null;

export function invalidateCutoverLockCache(): void {
  lockCache = null;
}

async function loadActiveLocks(): Promise<ActiveCutoverLock[]> {
  if (lockCache && lockCache.expiresAt > Date.now()) return lockCache.locks;
  const result = await db.execute(sql`
    SELECT id, source_company_id, target_company_id, status,
           prepared_at, activated_at, rollback_deadline
    FROM sp_migration_cutovers
    WHERE status IN ('prepared', 'active')
    ORDER BY id DESC
  `);
  const locks = resultRows(result).map((row) => ({
    id: Number(row.id),
    sourceCompanyId: Number(row.source_company_id),
    targetCompanyId: Number(row.target_company_id),
    status: row.status,
    preparedAt: row.prepared_at ?? null,
    activatedAt: row.activated_at ?? null,
    rollbackDeadline: row.rollback_deadline ?? null,
  })) as ActiveCutoverLock[];
  lockCache = { expiresAt: Date.now() + 3000, locks };
  return locks;
}

export async function getCompanyCutoverLock(companyId: number): Promise<ActiveCutoverLock | null> {
  const locks = await loadActiveLocks();
  return (
    locks.find(
      (lock) => lock.sourceCompanyId === companyId || (lock.status === "prepared" && lock.targetCompanyId === companyId)
    ) ?? null
  );
}

async function cutoverWriteGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const method = req.method.toUpperCase();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return next();
    if (!req.path.startsWith("/api")) return next();

    // Authentication must remain usable so users can leave the old company,
    // log out, or confirm their password. Migration control endpoints are the
    // only allowed write path while a source/target pair is prepared.
    if (
      req.path.startsWith("/api/auth/") ||
      req.path.startsWith("/api/sp/migration/") ||
      req.path === "/api/csrf-token" ||
      req.path.startsWith("/api/health")
    ) {
      return next();
    }

    const companyId = Number(req.session?.currentCompanyId ?? 0);
    if (!companyId) return next();
    const lock = await getCompanyCutoverLock(companyId);
    if (!lock) return next();

    const isSource = lock.sourceCompanyId === companyId;
    const isPreparedTarget = lock.status === "prepared" && lock.targetCompanyId === companyId;
    if (!isSource && !isPreparedTarget) return next();

    res.status(423).json({
      message: isSource
        ? "This ERP company is read-only because Supplier Partner cutover is in progress or active."
        : "This Supplier Partner company is temporarily locked while final cutover synchronization runs.",
      code: isSource ? "SP_SOURCE_READ_ONLY" : "SP_TARGET_CUTOVER_LOCKED",
      cutoverId: lock.id,
      sourceCompanyId: lock.sourceCompanyId,
      targetCompanyId: lock.targetCompanyId,
      status: lock.status,
    });
  } catch (error) {
    logger.error("[SP Cutover Guard] Failed to evaluate company lock", { error });
    // Fail closed for authenticated company-scoped writes. A guard failure must
    // never silently permit a write during a production cutover.
    res.status(503).json({
      message: "Cutover safety status could not be verified. Write request blocked.",
      code: "SP_CUTOVER_GUARD_UNAVAILABLE",
    });
  }
}

/**
 * Registers the write guard and moves its Express layer immediately before the
 * first route. registerSpRoutes is called late in routes.ts, so a normal app.use
 * would miss earlier ERP handlers. Moving only this middleware layer preserves
 * all global body/session/CSRF middleware while guaranteeing full route coverage.
 */
export function installCutoverWriteGuard(app: Express): void {
  if (guardInstalled) return;
  guardInstalled = true;
  app.use(cutoverWriteGuard);

  const expressApp = app as unknown as {
    router?: { stack?: Array<{ route?: unknown }> };
    _router?: { stack?: Array<{ route?: unknown }> };
  };
  const routerStack = expressApp.router?.stack ?? expressApp._router?.stack;
  if (!routerStack?.length) {
    logger.warn("[SP Cutover Guard] Express router stack was unavailable; guard remained at registration order");
    return;
  }
  const guardLayer = routerStack.pop();
  const firstRouteIndex = routerStack.findIndex((layer) => Boolean(layer.route));
  if (!guardLayer || firstRouteIndex < 0) {
    if (guardLayer) routerStack.push(guardLayer);
    logger.warn("[SP Cutover Guard] Could not reposition guard before the first route");
    return;
  }
  routerStack.splice(firstRouteIndex, 0, guardLayer);
  logger.info("[SP Cutover Guard] Global source/target write protection installed");
}

export async function getLiveCutover(
  sourceId: number,
  targetId: number
): Promise<Record<string, unknown> | null> {
  const result = await db.execute(sql`
    SELECT * FROM sp_migration_cutovers
    WHERE source_company_id = ${sourceId}
      AND target_company_id = ${targetId}
      AND status IN ('prepared', 'active')
    ORDER BY id DESC
    LIMIT 1
  `);
  return firstRow(result) ?? null;
}
