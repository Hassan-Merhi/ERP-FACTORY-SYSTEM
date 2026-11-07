/**
 * Phase 9 cloud apply handlers for plan batch 3 (owner-approved 2026-11-05):
 * changes to an existing stock transfer made on the factory LAN server
 * during an outage. They cover:
 * - stock.transfer-edit.v1 (PUT /api/stock-transfers/:id);
 * - stock.transfer-finalize.v1 (finalize / approve);
 * - stock.transfer-revision.v1 (a revision);
 * - stock.transfer-revision-review.v1 (approve or reject a revision).
 *
 * Each replays through the same service code as the live route, on the SAME
 * PostgreSQL client and transaction as the Phase 9 receipt and cursor, so it
 * applies exactly once.
 *
 * Owner rule: a change applies only while the cloud's copy still matches what
 * the factory saw. An edit or finalize of a transfer the cloud changed in the
 * meantime is held as PHASE9_STOCK_TRANSFER_CHANGED; Admin/Developer approve
 * (the factory's change wins) or reject it. A revision whose original
 * quantities no longer match is held with the same code, but can only be
 * rejected: the revision service refuses a stale revision whatever the
 * decision. Every other refusal is reject-only.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import type { DbTransaction } from "../db";
import { buildPermissionMap, canAccess } from "../lib/permissionHelpers";
import { storage } from "../storage";
import {
  approveImmutableStockTransferRevision,
  createImmutableStockTransferRevision,
  rejectImmutableStockTransferRevision,
} from "../services/immutableStockTransferRevisionLifecycle";
import { finalizeOptionalStockTransferTx, saveStockTransferLifecycleTx } from "../services/stockTransferLifecycle";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import {
  PHASE9_STOCK_TRANSFER_CHANGED_CONFLICT,
  PHASE9_STOCK_TRANSFER_REVISION_KIND,
  phase9TransferSnapshot,
  type Phase9RevisionRef,
  type Phase9StockTransferEditEvidence,
  type Phase9StockTransferFinalizeEvidence,
  type Phase9StockTransferRevisionEvidence,
  type Phase9StockTransferRevisionReviewEvidence,
  type Phase9TransferRef,
  type Phase9TransferSnapshot,
} from "./phase9StockTransferWorkflowEnvelope.mjs";
import { throwIfClosedPeriod } from "./phase9ClosedPeriod";

type Queryable = Pick<PoolClient, "query">;
type Context = { readonly overrideConflicts: readonly string[]; readonly siteId: string };

interface Phase9WorkflowEvent<P> {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  payload: { kind: string } & { [K in keyof P]: P[K] };
  payloadSha256: string;
}
export type Phase9StockTransferEditEvent = Phase9WorkflowEvent<Phase9StockTransferEditEvidence>;
export type Phase9StockTransferFinalizeEvent = Phase9WorkflowEvent<Phase9StockTransferFinalizeEvidence>;
export type Phase9StockTransferRevisionEvent = Phase9WorkflowEvent<Phase9StockTransferRevisionEvidence>;
export type Phase9StockTransferRevisionReviewEvent = Phase9WorkflowEvent<Phase9StockTransferRevisionReviewEvidence>;

export interface Phase9StockTransferWorkflowResult {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const READ_ONLY_ROLES = new Set(["View Only", "Create Only", "ERP Tester"]);
const TRANSFER_KINDS = ["Stock Transfer", "StockTransfer", "Transfer"];
const REVISION_STALE_CODES = new Set([
  "STOCK_TRANSFER_REVISION_STALE",
  "STOCK_TRANSFER_INSUFFICIENT_STOCK",
  "STOCK_TRANSFER_DESTINATION_STOCK_CONFLICT",
]);

function txOf(client: Queryable): DbTransaction {
  return drizzle(client as PoolClient) as unknown as DbTransaction;
}

/** The actor's CURRENT cloud access: active, a writing role, and (when the route needs it) the action. */
async function authorizeActor(
  client: Queryable,
  event: { actorUserId: string; companyId: number },
  options: { nonPos: boolean; action?: string }
): Promise<void> {
  const access = await client.query(
    `SELECT u.active, r.role, r.pos_view_only
       FROM users u
       JOIN user_company_roles r ON r.user_id = u.id AND r.company_id = $2
      WHERE u.id = $1`,
    [event.actorUserId, event.companyId]
  );
  const row = access.rows[0];
  if (!row || row.active !== true) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ACCESS_REVOKED", { actorUserId: event.actorUserId });
  }
  const role = String(row.role);
  if (row.pos_view_only === true || READ_ONLY_ROLES.has(role) || (options.nonPos && role === "POS")) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", { actorUserId: event.actorUserId, role });
  }
  if (options.action && role !== "Admin" && role !== "Developer") {
    const permissions = buildPermissionMap(await storage.getRoleFeaturePermissions(event.companyId), role);
    if (!canAccess(role, options.action, permissions)) {
      throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", {
        actorUserId: event.actorUserId,
        role,
        action: options.action,
      });
    }
  }
}

/** The cloud id of a row an earlier record on this stream created (null if that record was rejected). */
async function appliedCloudRef(
  client: Queryable,
  siteId: string,
  companyId: number,
  kind: string,
  localRef: number
): Promise<number | null> {
  const found = await client.query(
    `SELECT cloud_ref FROM factory_edge_applied_events
      WHERE site_id = $1::uuid AND stream = 'stock' AND operation_kind = $2 AND local_ref = $3
        AND company_id = $4 AND outcome <> 'rejected-conflict'`,
    [siteId, kind, localRef, companyId]
  );
  return found.rows.length === 1 ? Number(found.rows[0].cloud_ref) : null;
}

async function cloudTransferId(
  client: Queryable,
  siteId: string,
  companyId: number,
  ref: Phase9TransferRef
): Promise<number> {
  const id =
    ref.origin === "lan"
      ? await appliedCloudRef(client, siteId, companyId, "stock.transfer.v1", ref.localTransferId)
      : ref.transferId;
  const owned =
    id === null
      ? null
      : await client.query(
          `SELECT t.id FROM stock_transfer_vouchers t JOIN vouchers v ON v.id = t.voucher_id
            WHERE t.id = $1 AND v.company_id = $2 AND v.deleted_at IS NULL AND v.voucher_type = ANY($3::text[])`,
          [id, companyId, TRANSFER_KINDS]
        );
  if (id === null || !owned?.rows.length) {
    throw new Phase9EventConflict("PHASE9_STOCK_TRANSFER_MISSING", { transfer: ref });
  }
  return id;
}

async function cloudRevisionId(
  client: Queryable,
  siteId: string,
  companyId: number,
  ref: Phase9RevisionRef
): Promise<number> {
  const id =
    ref.origin === "lan"
      ? await appliedCloudRef(client, siteId, companyId, PHASE9_STOCK_TRANSFER_REVISION_KIND, ref.localRevisionId)
      : ref.revisionId;
  const owned =
    id === null
      ? null
      : await client.query(
          `SELECT r.id FROM stock_transfer_revisions r
             JOIN stock_transfer_vouchers t ON t.id = r.transfer_id JOIN vouchers v ON v.id = t.voucher_id
            WHERE r.id = $1 AND v.company_id = $2`,
          [id, companyId]
        );
  if (id === null || !owned?.rows.length) {
    throw new Phase9EventConflict("PHASE9_STOCK_TRANSFER_REVISION_MISSING", { revision: ref });
  }
  return id;
}

/** The cloud transfer, locked, in the same shape the LAN recorded. */
async function cloudSnapshot(
  client: Queryable,
  companyId: number,
  transferId: number
): Promise<Phase9TransferSnapshot & { voucherId: number }> {
  const header = await client.query(
    `SELECT t.voucher_id AS "voucherId", t.destination_location_id AS "destinationLocationId",
            t.source_location_id AS "headerSourceId", t.inventory_applied AS "inventoryApplied", v.optional
       FROM stock_transfer_vouchers t JOIN vouchers v ON v.id = t.voucher_id
      WHERE t.id = $1 AND v.company_id = $2
      FOR UPDATE OF t, v`,
    [transferId, companyId]
  );
  const row = header.rows[0];
  const lines = await client.query(
    `SELECT COALESCE(source_location_id, $2) AS "sourceLocationId", stock_item_id AS "stockItemId",
            quantity::text AS quantity
       FROM stock_transfer_items WHERE transfer_id = $1`,
    [transferId, row.headerSourceId]
  );
  return { ...phase9TransferSnapshot(row, lines.rows), voucherId: Number(row.voucherId) };
}

function sameSnapshot(left: Phase9TransferSnapshot, right: Phase9TransferSnapshot): boolean {
  return (
    left.destinationLocationId === right.destinationLocationId &&
    left.optional === right.optional &&
    left.inventoryApplied === right.inventoryApplied &&
    JSON.stringify(left.lines) === JSON.stringify(right.lines)
  );
}

function holdIfChanged(before: Phase9TransferSnapshot, current: Phase9TransferSnapshot, context: Context): void {
  if (sameSnapshot(before, current) || context.overrideConflicts.includes(PHASE9_STOCK_TRANSFER_CHANGED_CONFLICT)) {
    return;
  }
  const { destinationLocationId, optional, inventoryApplied, lines } = current;
  throw new Phase9EventConflict(PHASE9_STOCK_TRANSFER_CHANGED_CONFLICT, {
    factorySaw: before,
    cloudHas: { destinationLocationId, optional, inventoryApplied, lines },
  });
}

/** A database failure is retried by the operator run; a business refusal becomes a reject-only conflict. */
function isDatabaseError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
}

function refusal(error: unknown, code: string): never {
  throwIfClosedPeriod(error);
  if (error instanceof Phase9EventConflict || isDatabaseError(error) || !(error instanceof Error)) throw error;
  throw new Phase9EventConflict(code, { reason: error.message });
}

function sortedLines(items: ReadonlyArray<{ sourceLocationId: number; stockItemId: number; quantity: number }>) {
  return phase9TransferSnapshot({ destinationLocationId: 0, optional: false, inventoryApplied: false }, items).lines;
}

// ---- stock.transfer-edit.v1 -------------------------------------------------

async function applyEdit(
  client: Queryable,
  event: Phase9StockTransferEditEvent,
  context: Context
): Promise<Phase9StockTransferWorkflowResult> {
  const p = event.payload;
  const transferId = await cloudTransferId(client, context.siteId, event.companyId, p.transfer);
  holdIfChanged(p.before, await cloudSnapshot(client, event.companyId, transferId), context);
  try {
    await saveStockTransferLifecycleTx(txOf(client), {
      companyId: event.companyId,
      transferId,
      destinationLocationId: p.after.destinationLocationId,
      notes: p.after.notes,
      items: p.after.items,
    });
  } catch (error) {
    refusal(error, "PHASE9_STOCK_TRANSFER_EDIT_REFUSED");
  }
  return { outcome: "cloud-applied", cloudRef: transferId, businessDate: p.businessDate };
}

async function verifyEdit(
  client: Queryable,
  event: Phase9StockTransferEditEvent,
  result: Phase9StockTransferWorkflowResult
): Promise<boolean> {
  const now = await cloudSnapshot(client, event.companyId, result.cloudRef);
  // Lines are merged by (source, item) on save, so compare against the merged target.
  const merged = new Map<string, { sourceLocationId: number; stockItemId: number; quantity: number }>();
  for (const item of event.payload.after.items) {
    const key = `${item.sourceLocationId}:${item.stockItemId}`;
    const prior = merged.get(key);
    merged.set(key, { ...item, quantity: (prior?.quantity ?? 0) + item.quantity });
  }
  return (
    now.destinationLocationId === event.payload.after.destinationLocationId &&
    JSON.stringify(now.lines) === JSON.stringify(sortedLines([...merged.values()]))
  );
}

// ---- stock.transfer-finalize.v1 ---------------------------------------------

async function applyFinalize(
  client: Queryable,
  event: Phase9StockTransferFinalizeEvent,
  context: Context
): Promise<Phase9StockTransferWorkflowResult> {
  const p = event.payload;
  const transferId = await cloudTransferId(client, context.siteId, event.companyId, p.transfer);
  const current = await cloudSnapshot(client, event.companyId, transferId);
  if (!current.optional && current.inventoryApplied) {
    return { outcome: "already-present", cloudRef: transferId, businessDate: p.businessDate };
  }
  holdIfChanged(p.before, current, context);
  try {
    await finalizeOptionalStockTransferTx(txOf(client), event.companyId, current.voucherId);
  } catch (error) {
    refusal(error, "PHASE9_STOCK_TRANSFER_FINALIZE_REFUSED");
  }
  return { outcome: "cloud-applied", cloudRef: transferId, businessDate: p.businessDate };
}

async function verifyFinalize(
  client: Queryable,
  event: Phase9StockTransferFinalizeEvent,
  result: Phase9StockTransferWorkflowResult
): Promise<boolean> {
  const now = await cloudSnapshot(client, event.companyId, result.cloudRef);
  return !now.optional && now.inventoryApplied;
}

// ---- stock.transfer-revision.v1 ---------------------------------------------

function revisionRefusal(error: unknown): never {
  throwIfClosedPeriod(error);
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  if (REVISION_STALE_CODES.has(code)) {
    throw new Phase9EventConflict(PHASE9_STOCK_TRANSFER_CHANGED_CONFLICT, {
      reason: (error as Error).message,
      code,
    });
  }
  if (code === "STOCK_TRANSFER_REVISION_STATUS") {
    throw new Phase9EventConflict("PHASE9_STOCK_TRANSFER_REVISION_STATUS", { reason: (error as Error).message });
  }
  refusal(error, "PHASE9_STOCK_TRANSFER_REVISION_REFUSED");
}

async function applyRevision(
  client: Queryable,
  event: Phase9StockTransferRevisionEvent,
  context: Context
): Promise<Phase9StockTransferWorkflowResult> {
  const p = event.payload;
  const transferId = await cloudTransferId(client, context.siteId, event.companyId, p.transfer);
  let revisionId: number;
  try {
    const created = await createImmutableStockTransferRevision(
      {
        companyId: event.companyId,
        transferId,
        userId: event.actorUserId,
        note: p.revision.note,
        pending: p.revision.pending,
        sourceLocationIdLimit: p.revision.sourceLocationIdLimit,
        items: p.revision.items,
      },
      undefined,
      txOf(client)
    );
    revisionId = created.revisionId;
  } catch (error) {
    revisionRefusal(error);
  }
  return { outcome: "cloud-applied", cloudRef: revisionId, businessDate: p.businessDate };
}

async function verifyRevision(
  client: Queryable,
  event: Phase9StockTransferRevisionEvent,
  result: Phase9StockTransferWorkflowResult
): Promise<boolean> {
  const found = await client.query(
    `SELECT count(*)::int AS lines FROM stock_transfer_revisions r
       JOIN stock_transfer_revision_items i ON i.revision_id = r.id
      WHERE r.id = $1 AND r.created_by = $2`,
    [result.cloudRef, event.actorUserId]
  );
  return Number(found.rows[0]?.lines ?? 0) >= 1;
}

// ---- stock.transfer-revision-review.v1 --------------------------------------

async function applyReview(
  client: Queryable,
  event: Phase9StockTransferRevisionReviewEvent,
  context: Context
): Promise<Phase9StockTransferWorkflowResult> {
  const p = event.payload;
  const revisionId = await cloudRevisionId(client, context.siteId, event.companyId, p.revision);
  let transition: string;
  try {
    const reviewed =
      p.decision === "approve"
        ? await approveImmutableStockTransferRevision(
            event.companyId,
            revisionId,
            event.actorUserId,
            undefined,
            txOf(client)
          )
        : await rejectImmutableStockTransferRevision(
            event.companyId,
            revisionId,
            event.actorUserId,
            p.reason,
            undefined,
            txOf(client)
          );
    transition = reviewed.transition;
  } catch (error) {
    revisionRefusal(error);
  }
  return {
    outcome: transition === "no-op" ? "already-present" : "cloud-applied",
    cloudRef: revisionId,
    businessDate: p.businessDate,
  };
}

async function verifyReview(
  client: Queryable,
  event: Phase9StockTransferRevisionReviewEvent,
  result: Phase9StockTransferWorkflowResult
): Promise<boolean> {
  const found = await client.query("SELECT status FROM stock_transfer_revisions WHERE id = $1", [result.cloudRef]);
  return found.rows[0]?.status === (event.payload.decision === "approve" ? "approved" : "rejected");
}

// The live routes: PUT edit and revision create need an authenticated writing
// member (POS allowed); finalize and revision review are non-POS and need the
// act_transfer_stock action.
export const phase9StockTransferEditApplyHandler = Object.freeze({
  authorize: (client: Queryable, event: Phase9StockTransferEditEvent) =>
    authorizeActor(client, event, { nonPos: false }),
  apply: applyEdit,
  verify: verifyEdit,
});
export const phase9StockTransferFinalizeApplyHandler = Object.freeze({
  authorize: (client: Queryable, event: Phase9StockTransferFinalizeEvent) =>
    authorizeActor(client, event, { nonPos: true, action: "act_transfer_stock" }),
  apply: applyFinalize,
  verify: verifyFinalize,
});
export const phase9StockTransferRevisionApplyHandler = Object.freeze({
  authorize: (client: Queryable, event: Phase9StockTransferRevisionEvent) =>
    authorizeActor(client, event, { nonPos: false }),
  apply: applyRevision,
  verify: verifyRevision,
});
export const phase9StockTransferRevisionReviewApplyHandler = Object.freeze({
  authorize: (client: Queryable, event: Phase9StockTransferRevisionReviewEvent) =>
    authorizeActor(client, event, { nonPos: true, action: "act_transfer_stock" }),
  apply: applyReview,
  verify: verifyReview,
});
