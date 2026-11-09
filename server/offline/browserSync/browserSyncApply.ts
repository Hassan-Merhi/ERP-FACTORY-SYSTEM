/**
 * Standalone browser offline mode (Phase 14): applies one operation a laptop's
 * browser recorded while offline, directly in the cloud, exactly once.
 *
 * It reuses the Phase 9 replay machinery unchanged: the evidence envelope and
 * its validator, the per-kind handlers (authorize → apply → verify) and the
 * immutable receipt table `factory_edge_applied_events`. The browser device id
 * takes the place of a factory site id, so records the browser created offline
 * (local ids from 1,000,000,000) are resolved through their own receipts, as
 * LAN records are.
 *
 * Rules:
 * - the signed-in user and company are the actor; the browser cannot name them;
 * - the same operation id returns its stored receipt (lost acknowledgement),
 *   and a different payload under that id is refused;
 * - a device id belongs to one user in one company, and never to a factory site;
 * - a cloud disagreement rolls back and is reported as a conflict: the cloud is
 *   never overwritten. Only an Admin or Developer may approve a conflict code
 *   the kind declares overridable; anything else is discarded by the user;
 * - every write runs in one transaction with its receipt.
 */
import type { PoolClient } from "pg";
import { pool } from "../../db";
import { hashEvidence } from "../../edge/edgeSyncStageProtocol.mjs";
import { phase9OverridableConflicts, validatePhase9Event } from "../../edge/phase9EventProtocol.mjs";
import { Phase9EventConflict } from "../../edge/phase9CloudEventStore.mjs";
import { Phase9StockItemNotYetSynced, translatePhase9LanStockItems } from "../../edge/phase9StockItemMap.mjs";
import { PHASE9_HANDLERS } from "../../edge/phase9OperatorApply";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../../services/security/databaseScopeRuntimeContext";
import {
  BROWSER_LOCAL_REF_BASE,
  BROWSER_LOCAL_REF_MAX,
  BrowserOperationRefusal,
  browserOperationKind,
  type BrowserActor,
} from "./browserOperationKinds";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const REVIEWER_ROLES = new Set(["Admin", "Developer"]);
/** A laptop's clock may run a little ahead; anything further is refused. */
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;

export interface BrowserOperationRequest {
  deviceId: string;
  operationId: string;
  kind: string;
  localRef: number;
  capturedAt: string;
  input: unknown;
  /** A conflict code the user (Admin/Developer) approves, the factory's version winning. */
  override?: string | null;
}

export interface BrowserReceipt {
  operationId: string;
  kind: string;
  outcome: "cloud-applied" | "already-present" | "rejected-conflict";
  cloudRef: number | null;
  businessDate: string | null;
  replayed: boolean;
}

export type BrowserApplyResult =
  | { status: "applied"; receipt: BrowserReceipt }
  | { status: "conflict"; code: string; overridable: boolean; detail: Record<string, unknown> }
  | { status: "waiting"; code: string }
  | { status: "invalid"; code: string };

export class BrowserSyncRefusal extends Error {
  constructor(
    code: string,
    readonly status: number
  ) {
    super(code);
    this.name = "BrowserSyncRefusal";
  }
}

interface PreparedOperation {
  stream: string;
  event: {
    sequence: string;
    operationId: string;
    companyId: number;
    actorUserId: string;
    kind: string;
    localRef: number;
    payload: Record<string, unknown>;
    payloadSha256: string;
  };
}

/** Build and validate the evidence envelope; refusals are the browser's input being wrong. */
export function prepareBrowserOperation(actor: BrowserActor, request: BrowserOperationRequest): PreparedOperation {
  if (
    typeof request.deviceId !== "string" ||
    !UUID.test(request.deviceId) ||
    typeof request.operationId !== "string" ||
    !UUID.test(request.operationId) ||
    !Number.isSafeInteger(request.localRef) ||
    request.localRef < BROWSER_LOCAL_REF_BASE ||
    request.localRef > BROWSER_LOCAL_REF_MAX ||
    typeof request.capturedAt !== "string" ||
    !INSTANT.test(request.capturedAt)
  ) {
    throw new BrowserOperationRefusal("OFFLINE_BROWSER_REQUEST_INVALID");
  }
  const captured = Date.parse(request.capturedAt);
  if (!Number.isFinite(captured) || captured > Date.now() + MAX_CLOCK_SKEW_MS) {
    throw new BrowserOperationRefusal("OFFLINE_BROWSER_CLOCK_AHEAD");
  }
  const kind = browserOperationKind(request.kind);
  if (!kind) throw new BrowserOperationRefusal("OFFLINE_BROWSER_KIND_NOT_SUPPORTED");
  const capturedAt = new Date(captured).toISOString();
  let payload: Record<string, unknown>;
  try {
    payload = kind.build(request.input as Record<string, unknown>, {
      actor,
      deviceId: request.deviceId.toLowerCase(),
      operationId: request.operationId.toLowerCase(),
      localRef: request.localRef,
      capturedAt,
    }) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BrowserOperationRefusal) throw error;
    // The envelope builders refuse malformed evidence with their own codes.
    throw new BrowserOperationRefusal(
      error instanceof Error && error.message ? error.message : "OFFLINE_BROWSER_INPUT_INVALID"
    );
  }
  const event = {
    sequence: "1",
    operationId: request.operationId.toLowerCase(),
    companyId: actor.companyId,
    actorUserId: actor.userId,
    kind: request.kind,
    localRef: request.localRef,
    payload,
    payloadSha256: hashEvidence(payload),
  };
  try {
    validatePhase9Event(kind.stream, event);
  } catch (error) {
    throw new BrowserOperationRefusal(error instanceof Error ? error.message : "OFFLINE_BROWSER_INPUT_INVALID");
  }
  return { stream: kind.stream, event };
}

async function inTenantTransaction<T>(companyId: number, run: (client: PoolClient) => Promise<T>): Promise<T> {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(companyId), async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function browserSyncInstalled(client: Pick<PoolClient, "query"> = pool): Promise<boolean> {
  const found = await client.query(
    `SELECT to_regclass('public.factory_edge_applied_events') IS NOT NULL
        AND to_regclass('public.factory_edge_stock_item_map') IS NOT NULL AS ready`
  );
  return found.rows[0]?.ready === true;
}

/** Serialise one device, and keep its id away from other users, companies and factory sites. */
async function lockDevice(client: PoolClient, actor: BrowserActor, deviceId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('offline-browser-device:' || $1))", [deviceId]);
  const other = await client.query(
    `SELECT 1 FROM factory_edge_applied_events
      WHERE site_id = $1::uuid AND (company_id <> $2 OR actor_user_id <> $3) LIMIT 1`,
    [deviceId, actor.companyId, actor.userId]
  );
  const site = await client
    .query(
      `SELECT 1 WHERE to_regclass('public.factory_edge_event_stage_cursor') IS NOT NULL
        AND EXISTS (SELECT 1 FROM factory_edge_event_stage_cursor WHERE site_id = $1::uuid)`,
      [deviceId]
    )
    .catch(() => ({ rows: [] }));
  if (other.rows.length || site.rows.length) throw new BrowserSyncRefusal("OFFLINE_BROWSER_DEVICE_BOUND", 403);
}

function receiptOf(row: Record<string, unknown>, replayed: boolean): BrowserReceipt {
  return {
    operationId: String(row.operation_id),
    kind: String(row.operation_kind),
    outcome: row.outcome as BrowserReceipt["outcome"],
    cloudRef: row.cloud_ref == null ? null : Number(row.cloud_ref),
    businessDate: row.business_date == null ? null : String(row.business_date).slice(0, 10),
    replayed,
  };
}

const RECEIPT_COLUMNS = `operation_id::text AS operation_id, operation_kind, outcome, cloud_ref,
  business_date::text AS business_date, payload_sha256, local_ref`;

/** The stored outcome of this operation, or a refusal if the id was reused with different content. */
async function priorReceipt(
  client: PoolClient,
  actor: BrowserActor,
  deviceId: string,
  prepared: PreparedOperation
): Promise<BrowserReceipt | null> {
  const prior = await client.query(
    `SELECT ${RECEIPT_COLUMNS} FROM factory_edge_applied_events
      WHERE site_id = $1::uuid AND operation_id = $2::uuid AND company_id = $3`,
    [deviceId, prepared.event.operationId, actor.companyId]
  );
  if (!prior.rows.length) return null;
  const row = prior.rows[0];
  if (
    row.payload_sha256 !== prepared.event.payloadSha256 ||
    row.operation_kind !== prepared.event.kind ||
    Number(row.local_ref) !== prepared.event.localRef
  ) {
    throw new BrowserSyncRefusal("OFFLINE_BROWSER_DIVERGENT_REPLAY", 409);
  }
  return receiptOf(row, true);
}

async function insertReceipt(
  client: PoolClient,
  deviceId: string,
  prepared: PreparedOperation,
  result: { outcome: BrowserReceipt["outcome"]; cloudRef: number | null; businessDate: string | null }
): Promise<BrowserReceipt> {
  const next = await client.query(
    `SELECT COALESCE(max(sequence), 0) + 1 AS next FROM factory_edge_applied_events
      WHERE site_id = $1::uuid AND stream = $2`,
    [deviceId, prepared.stream]
  );
  const e = prepared.event;
  const inserted = await client.query(
    `INSERT INTO factory_edge_applied_events
       (site_id, stream, sequence, operation_id, company_id, actor_user_id, operation_kind,
        local_ref, cloud_ref, payload_sha256, business_date, outcome)
     VALUES ($1::uuid, $2, $3::bigint, $4::uuid, $5, $6, $7, $8, $9, $10, $11::date, $12)
     RETURNING ${RECEIPT_COLUMNS}`,
    [
      deviceId,
      prepared.stream,
      String(next.rows[0].next),
      e.operationId,
      e.companyId,
      e.actorUserId,
      e.kind,
      e.localRef,
      result.cloudRef,
      e.payloadSha256,
      result.businessDate,
      result.outcome,
    ]
  );
  return receiptOf(inserted.rows[0], false);
}

async function reviewerRole(client: PoolClient, actor: BrowserActor): Promise<boolean> {
  const found = await client.query(
    `SELECT r.role FROM user_company_roles r JOIN users u ON u.id = r.user_id
      WHERE r.user_id = $1 AND r.company_id = $2 AND u.active = true`,
    [actor.userId, actor.companyId]
  );
  return found.rows.some((row) => REVIEWER_ROLES.has(String(row.role)));
}

export async function applyBrowserOperation(
  actor: BrowserActor,
  request: BrowserOperationRequest
): Promise<BrowserApplyResult> {
  let prepared: PreparedOperation;
  try {
    prepared = prepareBrowserOperation(actor, request);
  } catch (error) {
    if (error instanceof BrowserOperationRefusal) return { status: "invalid", code: error.message };
    throw error;
  }
  const deviceId = request.deviceId.toLowerCase();
  try {
    return await inTenantTransaction(actor.companyId, async (client) => {
      await lockDevice(client, actor, deviceId);
      const prior = await priorReceipt(client, actor, deviceId, prepared);
      if (prior) return { status: "applied" as const, receipt: prior };

      const override = typeof request.override === "string" && request.override ? request.override : null;
      if (override) {
        const allowed = phase9OverridableConflicts(prepared.stream, prepared.event.kind).includes(override);
        if (!allowed || !(await reviewerRole(client, actor))) {
          throw new BrowserSyncRefusal("OFFLINE_BROWSER_OVERRIDE_NOT_ALLOWED", 403);
        }
      }
      const handler = (PHASE9_HANDLERS as Record<string, (typeof PHASE9_HANDLERS)[keyof typeof PHASE9_HANDLERS]>)[
        prepared.event.kind
      ];
      if (!handler) throw new BrowserSyncRefusal("OFFLINE_BROWSER_KIND_NOT_SUPPORTED", 400);
      const handled = await translatePhase9LanStockItems(client, deviceId, prepared.event);
      await handler.authorize(client, handled as never);
      const result = (await handler.apply(
        client,
        handled as never,
        {
          overrideConflicts: override ? [override] : [],
          siteId: deviceId,
        } as never
      )) as { outcome: "cloud-applied" | "already-present"; cloudRef: number; businessDate: string };
      if (
        !result ||
        !["cloud-applied", "already-present"].includes(result.outcome) ||
        !Number.isSafeInteger(result.cloudRef) ||
        result.cloudRef < 1 ||
        typeof result.businessDate !== "string"
      ) {
        throw new BrowserSyncRefusal("OFFLINE_BROWSER_APPLY_RESULT_INVALID", 500);
      }
      // Never trust the write: read it back before the receipt commits.
      if (!(await handler.verify(client, handled as never, result as never))) {
        throw new BrowserSyncRefusal("OFFLINE_BROWSER_READ_AFTER_APPLY_FAILED", 500);
      }
      const receipt = await insertReceipt(client, deviceId, prepared, result);
      return { status: "applied" as const, receipt };
    });
  } catch (error) {
    if (error instanceof Phase9EventConflict) {
      return {
        status: "conflict",
        code: error.message,
        overridable: phase9OverridableConflicts(prepared.stream, prepared.event.kind).includes(error.message),
        detail: ((error as unknown as { detail?: Record<string, unknown> }).detail ?? {}) as Record<string, unknown>,
      };
    }
    if (error instanceof Phase9StockItemNotYetSynced) return { status: "waiting", code: error.message };
    throw error;
  }
}

/**
 * The user gives up a held operation: it is recorded as rejected so records
 * that depend on it fail cleanly instead of applying against nothing. The
 * cloud data is untouched.
 */
export async function discardBrowserOperation(
  actor: BrowserActor,
  request: BrowserOperationRequest
): Promise<BrowserReceipt> {
  const prepared = prepareBrowserOperation(actor, request);
  const deviceId = request.deviceId.toLowerCase();
  return inTenantTransaction(actor.companyId, async (client) => {
    await lockDevice(client, actor, deviceId);
    const prior = await priorReceipt(client, actor, deviceId, prepared);
    if (prior) return prior;
    return insertReceipt(client, deviceId, prepared, {
      outcome: "rejected-conflict",
      cloudRef: null,
      businessDate: null,
    });
  });
}

/** Receipts this user's device already has: recovers acknowledgements lost in transit. */
export async function listBrowserReceipts(
  actor: BrowserActor,
  deviceId: string,
  operationIds: string[]
): Promise<BrowserReceipt[]> {
  if (!UUID.test(deviceId) || operationIds.length > 500 || operationIds.some((id) => !UUID.test(id))) {
    throw new BrowserSyncRefusal("OFFLINE_BROWSER_REQUEST_INVALID", 400);
  }
  if (operationIds.length === 0) return [];
  const found = await pool.query(
    `SELECT ${RECEIPT_COLUMNS} FROM factory_edge_applied_events
      WHERE site_id = $1::uuid AND company_id = $2 AND actor_user_id = $3 AND operation_id = ANY($4::uuid[])`,
    [deviceId.toLowerCase(), actor.companyId, actor.userId, operationIds.map((id) => id.toLowerCase())]
  );
  return found.rows.map((row) => receiptOf(row, true));
}
