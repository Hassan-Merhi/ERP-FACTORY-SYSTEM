/**
 * Full offline mode: the ERP server running on a PC against that PC's local
 * copy. Only the desktop app sets OFFLINE_PC_LOCAL_MODE; the cloud never does.
 *
 * - "read-only" (Phase A3): reading works; signing in, out and switching
 *   company work (sessions are local); every other write answers 423
 *   OFFLINE_PC_LOCAL_READ_ONLY.
 * - "entry" (Phase B): as read-only, plus the offline entries the cloud can
 *   apply exactly once (payment/receipt, stock adjustment, stock transfer, new
 *   stock item, POS sale). Each runs against the local copy as usual and is
 *   recorded in pc_local.outbox for the sync agent to deliver. New entries stop
 *   (423 OFFLINE_PC_LOCAL_SYNC_TOO_OLD) once the copy is 2 days old or was never
 *   completed; reading always works.
 *
 * In both modes background jobs are off and the server listens on 127.0.0.1.
 */
import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { BROWSER_OPERATION_KINDS } from "../browserSync/browserOperationKinds";
import { logger } from "../../lib/logger";
import { PHASE9_STOCK_ITEM_CREATE_KIND } from "../../edge/phase9StockItemLifecycleEnvelope.mjs";

const READS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Same rule as scripts/pc-sync/local/syncAgent.mjs (PC_SYNC_BLOCK_AFTER_HOURS). */
export const PC_LOCAL_BLOCK_AFTER_HOURS = 48;
/** Rows the PC creates itself start here (pc_local.use_local_id_range). */
const PC_LOCAL_ID_BASE = 1_000_000_000;

export const PC_LOCAL_ALLOWED_WRITES: ReadonlySet<string> = new Set([
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/auth/set-company",
]);

/** "METHOD /path" -> offline operation kind the cloud applies exactly once. */
export const PC_LOCAL_ENTRY_ROUTES: ReadonlyMap<string, string> = new Map(
  Object.entries(BROWSER_OPERATION_KINDS).map(([kind, def]) => [`${def.route.method} ${def.route.path}`, kind])
);

type PcLocalMode = "read-only" | "entry" | null;

export function pcLocalMode(env: NodeJS.ProcessEnv = process.env): PcLocalMode {
  const mode = env.OFFLINE_PC_LOCAL_MODE;
  return mode === "read-only" || mode === "entry" ? mode : null;
}

export function pcLocalReadOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return pcLocalMode(env) !== null;
}

/**
 * In local mode, switch off every background job before anything starts them.
 * Returns true when local mode is on.
 */
export function applyPcLocalModeEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!pcLocalReadOnly(env)) return false;
  env.ENABLE_SCHEDULERS = "false";
  return true;
}

type Query = (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

async function defaultQuery(text: string, values?: unknown[]) {
  const { pool } = await import("../../db");
  return pool.query(text, values);
}

function refuse(res: Response, code: string) {
  return res.status(423).json({ code });
}

async function captureEntry(req: Request, res: Response, next: () => void, kind: string, query: Query) {
  const userId = req.session?.userId == null ? "" : String(req.session.userId);
  const companyId = Number(req.session?.currentCompanyId);
  // Not signed in or no company: the route itself answers; nothing is recorded.
  if (!userId || !Number.isSafeInteger(companyId) || companyId < 1) return next();

  const state = await query("SELECT last_sync_at, copy_complete FROM pc_local.state WHERE id = 1");
  const lastSync = state.rows[0]?.last_sync_at as Date | null | undefined;
  const ageHours = lastSync ? (Date.now() - new Date(lastSync).getTime()) / 3_600_000 : Infinity;
  if (!state.rows[0]?.copy_complete || ageHours >= PC_LOCAL_BLOCK_AFTER_HOURS) {
    return refuse(res, "OFFLINE_PC_LOCAL_SYNC_TOO_OLD");
  }

  const operationId = randomUUID();
  await query(
    `INSERT INTO pc_local.outbox (operation_id, kind, input, user_id, company_id, status)
     VALUES ($1::uuid, $2, $3::jsonb, $4, $5, 'capturing')`,
    [operationId, kind, JSON.stringify(req.body ?? {}), userId, companyId]
  );
  let responseBody: unknown = null;
  const json = res.json.bind(res);
  res.json = (payload: unknown) => {
    responseBody = payload;
    return json(payload);
  };
  res.on("finish", () => {
    const done =
      res.statusCode >= 200 && res.statusCode < 300
        ? (() => {
            const createdId = Number((responseBody as { id?: unknown } | null)?.id);
            const ownId =
              kind === PHASE9_STOCK_ITEM_CREATE_KIND && Number.isSafeInteger(createdId) && createdId >= PC_LOCAL_ID_BASE
                ? createdId
                : null;
            return query(
              `UPDATE pc_local.outbox
                  SET status = 'pending', updated_at = now(),
                      local_ref = COALESCE($2::integer, nextval('pc_local.local_ref_seq')::integer)
                WHERE operation_id = $1::uuid`,
              [operationId, ownId]
            );
          })()
        : query("DELETE FROM pc_local.outbox WHERE operation_id = $1::uuid", [operationId]);
    done.catch((error: unknown) =>
      logger.error("[pc-local] outbox update failed", { operationId, error: String(error) })
    );
  });
  return next();
}

export function makePcLocalReadOnlyGuard(
  env: NodeJS.ProcessEnv = process.env,
  query: Query = defaultQuery
): RequestHandler {
  return (req, res, next) => {
    const mode = pcLocalMode(env);
    if (!mode) return next();
    const method = req.method.toUpperCase();
    if (READS.has(method)) return next();
    const path = req.originalUrl.split("?")[0];
    const route = `${method} ${path}`;
    if (!path.startsWith("/api/") || PC_LOCAL_ALLOWED_WRITES.has(route)) return next();
    const kind = mode === "entry" ? PC_LOCAL_ENTRY_ROUTES.get(route) : undefined;
    if (!kind) return refuse(res, "OFFLINE_PC_LOCAL_READ_ONLY");
    captureEntry(req, res, next, kind, query).catch((error: unknown) => {
      logger.error("[pc-local] could not record an offline entry", { error: String(error) });
      if (!res.headersSent) res.status(503).json({ code: "OFFLINE_PC_LOCAL_CAPTURE_FAILED" });
    });
  };
}
