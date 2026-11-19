// Extracted from ./phase9StockTransferWorkflowApply.ts
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import type { DbTransaction } from "../db";
import { buildPermissionMap, canAccess } from "../lib/permissionHelpers";
import { storage } from "../storage";
import { saveStockTransferLifecycleTx } from "../services/stockTransferLifecycle";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import {
  PHASE9_STOCK_TRANSFER_CHANGED_CONFLICT,
  phase9TransferSnapshot,
  type Phase9StockTransferEditEvidence,
  type Phase9StockTransferFinalizeEvidence,
  type Phase9StockTransferRevisionEvidence,
  type Phase9StockTransferRevisionReviewEvidence,
  type Phase9TransferRef,
  type Phase9TransferSnapshot,
} from "./phase9StockTransferWorkflowEnvelope.mjs";
import { throwIfClosedPeriod } from "./phase9ClosedPeriod";

export type Queryable = Pick<PoolClient, "query">;

export type Context = { readonly overrideConflicts: readonly string[]; readonly siteId: string };

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

export const REVISION_STALE_CODES = new Set([
  "STOCK_TRANSFER_REVISION_STALE",
  "STOCK_TRANSFER_INSUFFICIENT_STOCK",
  "STOCK_TRANSFER_DESTINATION_STOCK_CONFLICT",
]);

export function txOf(client: Queryable): DbTransaction {
  return drizzle(client as PoolClient) as unknown as DbTransaction;
}

/** The actor's CURRENT cloud access: active, a writing role, and (when the route needs it) the action. */
export async function authorizeActor(
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
export async function appliedCloudRef(
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

export async function cloudTransferId(
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

/** The cloud transfer, locked, in the same shape the LAN recorded. */
export async function cloudSnapshot(
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

export function holdIfChanged(before: Phase9TransferSnapshot, current: Phase9TransferSnapshot, context: Context): void {
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

export function refusal(error: unknown, code: string): never {
  throwIfClosedPeriod(error);
  if (error instanceof Phase9EventConflict || isDatabaseError(error) || !(error instanceof Error)) throw error;
  throw new Phase9EventConflict(code, { reason: error.message });
}

export async function applyEdit(
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
