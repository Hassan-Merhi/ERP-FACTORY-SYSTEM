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
import { PHASE9_PAYMENT_KIND } from "../../edge/phase9PaymentEnvelope.mjs";
import { PHASE9_STOCK_TRANSFER_KIND } from "../../edge/phase9StockEnvelope.mjs";
import { pcLocalMode } from "./pcLocalMode";

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

/**
 * Entries that keep the id of the row they created as their reference, so
 * later changes naming that row resolve in the cloud: where the id is in the
 * route's answer.
 */
const OWN_ID_KINDS: ReadonlyMap<string, (body: Record<string, unknown>) => unknown> = new Map([
  [PHASE9_STOCK_ITEM_CREATE_KIND, (body) => body.id],
  [PHASE9_PAYMENT_KIND, (body) => (body.voucher as { id?: unknown } | undefined)?.id ?? body.id],
  [PHASE9_STOCK_TRANSFER_KIND, (body) => (body.transfer as { id?: unknown } | undefined)?.id],
]);

/**
 * Changes to records the PC already has. The live route builds the finished
 * envelope in its own transaction: Payment / Receipt edits and deletes, POS
 * sale edits and cancellations (any other voucher is refused here), stock item master edits and deletes
 * (fields the cloud alone may change are refused by the route), and stock
 * transfer edits, finalizes and revisions (finalizing any other voucher is
 * refused here), container offloads, and file uploads, renames and moves.
 */
export const PC_LOCAL_EVIDENCE_ROUTES: readonly RegExp[] = Object.freeze([
  /^PATCH \/api\/vouchers\/\d+\/payment-receipt$/,
  /^(PUT|PATCH) \/api\/vouchers\/\d+\/sales$/,
  /^DELETE \/api\/vouchers\/\d+$/,
  /^(PATCH|DELETE) \/api\/stock-items\/\d+$/,
  /^POST \/api\/stock-items\/\d+\/location-prices$/,
  /^PUT \/api\/stock-transfers\/\d+$/,
  /^POST \/api\/stock-transfers\/\d+\/(approve|revisions)$/,
  /^POST \/api\/stock-transfer-revisions\/\d+\/(approve|reject)$/,
  /^POST \/api\/vouchers\/\d+\/finalize$/,
  /^(POST|PATCH) \/api\/containers\/\d+\/offload$/,
  /^PATCH \/api\/files\/\d+$/,
  /^POST \/api\/files\/upload$/,
  /^POST \/api\/stock-items\/(update-names-by-code|bulk-assign-category|bulk-update-prices|import-opening-balances|bulk-update-uom|bulk-rename|import-barcodes|update-categories)$/,
]);

/**
 * "METHOD /path" -> the offline operation kinds the cloud applies exactly once
 * (several when the route serves several, e.g. Sales and Purchase vouchers).
 */
export const PC_LOCAL_ENTRY_ROUTES: ReadonlyMap<string, readonly string[]> = Object.entries(
  BROWSER_OPERATION_KINDS
).reduce((routes, [kind, def]) => {
  const key = `${def.route.method} ${def.route.path}`;
  return routes.set(key, [...(routes.get(key) ?? []), kind]);
}, new Map<string, string[]>());

export { pcLocalMode } from "./pcLocalMode";

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
/** One database connection, held for the whole request (it carries the entry lock). */
export interface PcLocalConnection {
  query: Query;
  release: () => void;
}
type Connect = () => Promise<PcLocalConnection>;

const PAYMENT_VOUCHER_TYPES: ReadonlySet<string> = new Set(["Payment", "Receipt"]);
/** A delete may also cancel a POS sale (recorded on the sale's stream). */
const DELETE_VOUCHER_TYPES: ReadonlySet<string> = new Set(["Payment", "Receipt", "Sales"]);
const SALE_VOUCHER_TYPES: ReadonlySet<string> = new Set(["Sales"]);
const TRANSFER_VOUCHER_TYPES: ReadonlySet<string> = new Set(["Stock Transfer", "StockTransfer", "Transfer"]);

/** Same as PC_LOCAL_ENTRY_LOCK in scripts/pc-sync/local/localStore.mjs. */
const PC_LOCAL_ENTRY_LOCK = 7314002;

async function defaultConnect(): Promise<PcLocalConnection> {
  const { pool } = await import("../../db");
  const client = await pool.connect();
  return { query: (text, values) => client.query(text, values as unknown[]), release: () => client.release() };
}

function refuse(res: Response, code: string) {
  return res.status(423).json({ code });
}

async function withRetries(work: () => Promise<unknown>, attempts = 3): Promise<void> {
  for (let i = 1; ; i += 1) {
    try {
      await work();
      return;
    } catch (error) {
      if (i >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * i));
    }
  }
}

async function captureEntry(req: Request, res: Response, next: () => void, kind: string | null, connect: Connect) {
  const userId = req.session?.userId == null ? "" : String(req.session.userId);
  const companyId = Number(req.session?.currentCompanyId);
  // Not signed in or no company: the route itself answers; nothing is recorded.
  if (!userId || !Number.isSafeInteger(companyId) || companyId < 1) return next();

  const conn = await connect();
  let held = false;
  const done = async () => {
    if (held) {
      held = false;
      await conn.query("SELECT pg_advisory_unlock_shared($1)", [PC_LOCAL_ENTRY_LOCK]).catch(() => undefined);
    }
    await conn.query("RESET lock_timeout").catch(() => undefined);
    conn.release();
  };
  try {
    // Wait briefly while the sync process undoes local writes and pulls.
    await conn.query("SET lock_timeout = '5s'");
    try {
      await conn.query("SELECT pg_advisory_lock_shared($1)", [PC_LOCAL_ENTRY_LOCK]);
      held = true;
    } catch {
      await done();
      return res.status(503).json({ code: "OFFLINE_PC_LOCAL_SYNC_BUSY" });
    }
    const state = await conn.query("SELECT last_sync_at, copy_complete FROM pc_local.state WHERE id = 1");
    const lastSync = state.rows[0]?.last_sync_at as Date | null | undefined;
    const ageHours = lastSync ? (Date.now() - new Date(lastSync).getTime()) / 3_600_000 : Infinity;
    if (!state.rows[0]?.copy_complete || ageHours >= PC_LOCAL_BLOCK_AFTER_HOURS) {
      await done();
      return refuse(res, "OFFLINE_PC_LOCAL_SYNC_TOO_OLD");
    }
    if (kind === null) {
      // Only Payment / Receipt edits and deletes, POS sale edits and
      // cancellations, and transfer finalizes, can be replayed in the cloud. Several handlers serve these paths, so refuse any
      // other voucher here, before any of them can change it without recording it.
      const target = /^\/api\/vouchers\/(\d+)(\/payment-receipt|\/finalize|\/sales)?$/.exec(
        req.originalUrl.split("?")[0]
      );
      if (target) {
        const found = await conn.query("SELECT voucher_type FROM vouchers WHERE id = $1", [Number(target[1])]);
        const type = String(found.rows[0]?.voucher_type ?? "");
        const allowed =
          target[2] === "/finalize"
            ? TRANSFER_VOUCHER_TYPES
            : target[2] === "/sales"
              ? SALE_VOUCHER_TYPES
              : target[2] === "/payment-receipt"
                ? PAYMENT_VOUCHER_TYPES
                : DELETE_VOUCHER_TYPES;
        if (found.rows.length && !allowed.has(type)) {
          await done();
          return refuse(
            res,
            req.method.toUpperCase() === "DELETE"
              ? "OFFLINE_PC_LOCAL_DELETE_NOT_SUPPORTED"
              : "OFFLINE_PC_LOCAL_CHANGE_NOT_SUPPORTED"
          );
        }
      }
      // The live route writes its own finished envelope in its transaction
      // (pcCapture.ts); the lock only has to cover the request.
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        void done();
      };
      res.on("finish", release);
      res.on("close", release);
      return next();
    }
    const operationId = randomUUID();
    await conn.query(
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
    let settled = false;
    const settle = (finished: boolean) => {
      if (settled) return;
      settled = true;
      // A request cut off before its answer leaves the entry "capturing"; the
      // sync process turns it into "unconfirmed" for a person to decide.
      // A repeat of a save the PC already made (the route answers "replayed")
      // is delivered by the first save's entry, never a second time.
      const replayed = (responseBody as { replayed?: unknown } | null)?.replayed === true;
      const update = !finished
        ? Promise.resolve()
        : res.statusCode >= 200 && res.statusCode < 300 && !replayed
          ? withRetries(() => {
              // New stock items, payments and transfers keep their own local id
              // as the reference, so later entries naming them resolve in the cloud.
              const body = (responseBody ?? {}) as Record<string, unknown>;
              const createdId = Number(OWN_ID_KINDS.get(kind)?.(body));
              const ownId = Number.isSafeInteger(createdId) && createdId >= PC_LOCAL_ID_BASE ? createdId : null;
              return conn.query(
                `UPDATE pc_local.outbox
                    SET status = 'pending', updated_at = now(),
                        local_ref = COALESCE($2::integer, nextval('pc_local.local_ref_seq')::integer)
                  WHERE operation_id = $1::uuid`,
                [operationId, ownId]
              );
            })
          : withRetries(() => conn.query("DELETE FROM pc_local.outbox WHERE operation_id = $1::uuid", [operationId]));
      update
        .catch((error: unknown) =>
          logger.error("[pc-local] outbox update failed", { operationId, error: String(error) })
        )
        .finally(() => done());
    };
    res.on("finish", () => settle(true));
    res.on("close", () => settle(res.writableFinished));
    return next();
  } catch (error) {
    await done();
    throw error;
  }
}

export function makePcLocalReadOnlyGuard(
  env: NodeJS.ProcessEnv = process.env,
  connect: Connect = defaultConnect
): RequestHandler {
  return (req, res, next) => {
    const mode = pcLocalMode(env);
    if (!mode) return next();
    const method = req.method.toUpperCase();
    if (READS.has(method)) return next();
    const path = req.originalUrl.split("?")[0];
    const route = `${method} ${path}`;
    if (!path.startsWith("/api/") || PC_LOCAL_ALLOWED_WRITES.has(route)) return next();
    if (mode !== "entry") return refuse(res, "OFFLINE_PC_LOCAL_READ_ONLY");
    const kinds = PC_LOCAL_ENTRY_ROUTES.get(route);
    let kind: string | null;
    if (kinds) {
      // A route may serve several kinds, and requests the cloud cannot replay
      // (/api/vouchers/with-entries: Sales or Purchase vouchers, nothing else):
      // the kind that accepts this body, else refused here.
      const accepted = kinds.find((k) => BROWSER_OPERATION_KINDS[k]?.pcAccepts?.(req.body) !== false);
      if (!accepted) return refuse(res, "OFFLINE_PC_LOCAL_CHANGE_NOT_SUPPORTED");
      kind = accepted;
    } else if (PC_LOCAL_EVIDENCE_ROUTES.some((pattern) => pattern.test(route))) {
      kind = null;
    } else {
      return refuse(res, "OFFLINE_PC_LOCAL_READ_ONLY");
    }
    captureEntry(req, res, next, kind, connect).catch((error: unknown) => {
      logger.error("[pc-local] could not record an offline entry", { error: String(error) });
      if (!res.headersSent) res.status(503).json({ code: "OFFLINE_PC_LOCAL_CAPTURE_FAILED" });
    });
  };
}
