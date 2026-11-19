// Extracted from ./spMigrationFinalCutoverRoutes.ts to keep that module under the source-size cap.
import type { Express, NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { sqlArray } from "../../lib/sqlArray";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { pn } from "./spMigrationCommon";
import { invalidateCutoverLockCache } from "./spMigrationCutoverState";
import { backfillLegacyCutoverStockDeltaKeys } from "./spMigrationInventory";
import { latestCutoverBlocksCompany } from "./spMigrationPolicy";
import { firstRow } from "../../lib/queryResult";

const installedApps = new WeakSet<object>();

let holdCache: { expiresAt: number; byCompany: Map<number, Record<string, unknown> | null> } | null = null;

export function invalidatePhase4HoldCache(): void {
  holdCache = null;
  invalidateCutoverLockCache();
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
  await backfillLegacyCutoverStockDeltaKeys();
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

export function installPhase4WriteGuard(app: Express): void {
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
export type TargetLiveActivity = {
  vouchers: number;
  sales: number;
  offloads: number;
  prepaid: number;
  containers: number;
  total: number;
};

/** A row of sp_migration_cutovers. */
export type CutoverRow = Record<string, unknown> & {
  id: number;
  source_company_id: number;
  target_company_id: number;
  source_company_name: string;
  status: string;
  activated_at: string | null;
  rollback_deadline: string | null;
};

/** The `{ runId }` acknowledgement the delta-import handlers return. */
export type MigrationRunAck = { runId: string | number };

export async function invokeMigrationHandler(handler: MigrationHandler, req: Request, body: unknown): Promise<unknown> {
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
