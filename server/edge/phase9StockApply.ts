/**
 * Phase 9 cloud apply handler for `stock.quick-adjust.v1`.
 *
 * Replays a factory LAN stock movement as a quantity DELTA through the same
 * implementation the live route uses (applyQuickAdjustmentCoreTx), on the
 * SAME PostgreSQL client/transaction as the Phase 9 receipt and cursor. The
 * owner-approved policy: a movement that would take cloud stock below zero
 * is held as PHASE9_STOCK_WOULD_GO_NEGATIVE until an Admin/Developer approves
 * (approve-override) or rejects it. Missing items/locations, revoked access
 * or a diverged replay can only be rejected.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import type { DbTransaction } from "../db";
import { buildPermissionMap, canAccess } from "../lib/permissionHelpers";
import { toMoney } from "../lib/money";
import {
  applyQuickAdjustmentCoreTx,
  QuickAdjustmentNegativeStockError,
  quickAdjustmentIdempotencyKey,
} from "../routes/inventory/inventoryQuickAdjustCore";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import { PHASE9_STOCK_NEGATIVE_CONFLICT } from "./phase9StockEnvelope.mjs";
import { throwIfClosedPeriod } from "./phase9ClosedPeriod";

type Queryable = Pick<PoolClient, "query">;

export interface Phase9StockEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  payload: {
    requestId: string;
    companyId: number;
    actorUserId: string;
    actorUsername: string;
    localMovementId: number;
    stockItemId: number;
    locationId: number;
    direction: "add" | "subtract";
    quantity: string;
    occurredAt: string;
    businessDate: string;
  };
  payloadSha256: string;
}

export interface Phase9StockApplyResult {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const READ_ONLY_ROLES = new Set(["View Only", "ERP Tester"]);
const ACTION_KEY = "act_adjust_stock";

/** The live route's rule (act_adjust_stock), against CURRENT cloud access. */
async function authorize(client: Queryable, event: Phase9StockEvent): Promise<void> {
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
  if (row.pos_view_only === true || READ_ONLY_ROLES.has(role)) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", { actorUserId: event.actorUserId, role });
  }
  const permissions = await client.query(
    `SELECT role, feature_key AS "featureKey", enabled
       FROM role_feature_permissions WHERE company_id = $1 AND role = $2 AND feature_key = $3`,
    [event.companyId, role, ACTION_KEY]
  );
  if (!canAccess(role, ACTION_KEY, buildPermissionMap(permissions.rows, role))) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", {
      actorUserId: event.actorUserId,
      role,
      action: ACTION_KEY,
    });
  }
}

function expectedDelta(p: Phase9StockEvent["payload"]) {
  const quantity = toMoney(p.quantity);
  return p.direction === "add" ? quantity : quantity.negated();
}

async function apply(
  client: Queryable,
  event: Phase9StockEvent,
  context: { readonly overrideConflicts: readonly string[] } = { overrideConflicts: [] }
): Promise<Phase9StockApplyResult> {
  const p = event.payload;
  const companyId = event.companyId;
  const idempotencyKey = quickAdjustmentIdempotencyKey(companyId, event.operationId);

  // Lost apply ACK or a cloud that already has this exact movement.
  const prior = await client.query(
    `SELECT id, stock_item_id, location_id, quantity_delta::text AS quantity_delta
       FROM canonical_stock_movements
      WHERE company_id = $1 AND idempotency_key = $2
      ORDER BY id LIMIT 1`,
    [companyId, idempotencyKey]
  );
  if (prior.rows.length) {
    const row = prior.rows[0];
    const same =
      Number(row.stock_item_id) === p.stockItemId &&
      Number(row.location_id) === p.locationId &&
      toMoney(row.quantity_delta).equals(expectedDelta(p));
    if (!same) {
      throw new Phase9EventConflict("PHASE9_STOCK_REQUEST_ID_DIVERGED", { cloudMovementId: Number(row.id) });
    }
    return { outcome: "already-present", cloudRef: Number(row.id), businessDate: p.businessDate };
  }

  const item = await client.query("SELECT id, code FROM stock_items WHERE id = $1 AND company_id = $2", [
    p.stockItemId,
    companyId,
  ]);
  if (!item.rows.length) throw new Phase9EventConflict("PHASE9_STOCK_ITEM_MISSING", { stockItemId: p.stockItemId });
  const location = await client.query("SELECT id, name FROM locations WHERE id = $1 AND company_id = $2", [
    p.locationId,
    companyId,
  ]);
  if (!location.rows.length) {
    throw new Phase9EventConflict("PHASE9_STOCK_LOCATION_MISSING", { locationId: p.locationId });
  }

  // Lock the balance row so the negative check and the delta see the same value.
  const balance = await client.query(
    `SELECT quantity::text AS quantity FROM inventory
      WHERE company_id = $1 AND stock_item_id = $2 AND location_id = $3 FOR UPDATE`,
    [companyId, p.stockItemId, p.locationId]
  );
  const available = toMoney(balance.rows[0]?.quantity ?? "0");
  const allowNegative = context.overrideConflicts.includes(PHASE9_STOCK_NEGATIVE_CONFLICT);
  if (available.plus(expectedDelta(p)).isNegative() && !allowNegative) {
    throw new Phase9EventConflict(PHASE9_STOCK_NEGATIVE_CONFLICT, {
      stockItemId: p.stockItemId,
      locationId: p.locationId,
      available: available.toFixed(),
      requested: p.quantity,
    });
  }

  let applied;
  try {
    applied = await applyQuickAdjustmentCoreTx(drizzle(client as PoolClient) as unknown as DbTransaction, {
      companyId,
      stockItem: { id: p.stockItemId, code: String(item.rows[0].code) },
      location: { id: p.locationId, name: String(location.rows[0].name) },
      direction: p.direction,
      quantity: p.quantity,
      actor: { userId: event.actorUserId, username: p.actorUsername },
      operationId: event.operationId,
      occurredAt: p.occurredAt,
      allowNegative,
    });
  } catch (error) {
    throwIfClosedPeriod(error);
    if (error instanceof QuickAdjustmentNegativeStockError) {
      throw new Phase9EventConflict(PHASE9_STOCK_NEGATIVE_CONFLICT, {
        stockItemId: p.stockItemId,
        locationId: p.locationId,
        available: String(error.available),
        requested: p.quantity,
      });
    }
    throw error;
  }
  return { outcome: "cloud-applied", cloudRef: applied.movementId, businessDate: p.businessDate };
}

async function verify(client: Queryable, event: Phase9StockEvent, result: Phase9StockApplyResult): Promise<boolean> {
  const p = event.payload;
  const check = await client.query(
    `SELECT quantity_delta::text AS quantity_delta FROM canonical_stock_movements
      WHERE id = $1 AND company_id = $2 AND idempotency_key = $3
        AND stock_item_id = $4 AND location_id = $5`,
    [
      result.cloudRef,
      event.companyId,
      quickAdjustmentIdempotencyKey(event.companyId, event.operationId),
      p.stockItemId,
      p.locationId,
    ]
  );
  return check.rows.length === 1 && toMoney(check.rows[0].quantity_delta).equals(expectedDelta(p));
}

export const phase9StockApplyHandler = Object.freeze({ authorize, apply, verify });
