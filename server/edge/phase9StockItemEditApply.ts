/**
 * Phase 9 cloud apply handler for `stock.item-edit.v1` (owner decision
 * 2026-11-02): stock-item master edits made on the factory LAN server.
 *
 * Every change is "field of existing item X (id and code): before -> after".
 * On the SAME transaction as the Phase 9 receipt, the cloud locks each item,
 * and applies a change only while its own value still equals "before"; a value
 * that already equals "after" is left as is (a lost ACK or the same edit made
 * twice). A field the cloud changed meanwhile is held as
 * PHASE9_STOCK_ITEM_CHANGED until an Admin/Developer approves the LAN value
 * (approve-override) or rejects the whole edit. A missing item, a re-coded
 * item, a missing category/group/location or a barcode taken by another item
 * can only be rejected. Nothing is written unless every change can be.
 */
import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import {
  PHASE9_STOCK_ITEM_CHANGED_CONFLICT,
  PHASE9_STOCK_ITEM_EDIT_FIELDS,
  type Phase9StockItemChange,
  type Phase9StockItemEditEvidence,
} from "./phase9StockItemEditEnvelope.mjs";

type Queryable = Pick<PoolClient, "query">;

export interface Phase9StockItemEditEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  payload: { kind: string } & { [K in keyof Phase9StockItemEditEvidence]: Phase9StockItemEditEvidence[K] };
  payloadSha256: string;
}

export interface Phase9StockItemEditApplyResult {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const NOT_PERMITTED_ROLES = new Set(["View Only", "Create Only", "ERP Tester", "POS"]);

/** Column of each whitelisted item field (identifiers from this fixed map only). */
const ITEM_COLUMNS: Record<string, string> = {
  name: "name",
  uom: "uom",
  sellingPrice: "selling_price",
  categoryId: "category_id",
  stockGroupId: "stock_group_id",
  active: "active",
  openingQty: "opening_qty",
  openingRate: "opening_rate",
  openingValue: "opening_value",
};

/** The live routes are requireNonPOS; re-checked against CURRENT cloud access. */
async function authorize(client: Queryable, event: Phase9StockItemEditEvent): Promise<void> {
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
  if (row.pos_view_only === true || NOT_PERMITTED_ROLES.has(String(row.role))) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", {
      actorUserId: event.actorUserId,
      role: String(row.role),
    });
  }
}

function canonical(type: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (type === "decimal") return value === "" ? null : new Decimal(String(value)).toDecimalPlaces(6).toFixed();
  if (type === "boolean") return value === true || value === "true" ? "true" : "false";
  if (type === "ref") return String(Number(value));
  const text = String(value);
  return text === "" ? null : text;
}

function same(type: string, a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return type === "decimal" ? new Decimal(a).equals(new Decimal(b)) : a === b;
}

function fieldType(change: Phase9StockItemChange): string {
  return PHASE9_STOCK_ITEM_EDIT_FIELDS[change.target][change.field];
}

/** The cloud's current value of the changed field (null when there is none). */
async function currentValue(client: Queryable, companyId: number, change: Phase9StockItemChange) {
  if (change.target === "item") {
    const column = ITEM_COLUMNS[change.field];
    const row = await client.query(`SELECT ${column} AS value FROM stock_items WHERE id = $1 AND company_id = $2`, [
      change.stockItemId,
      companyId,
    ]);
    return canonical(fieldType(change), row.rows[0]?.value);
  }
  if (change.target === "location-price") {
    const row = await client.query(
      `SELECT selling_price AS value FROM stock_item_location_prices WHERE stock_item_id = $1 AND location_id = $2`,
      [change.stockItemId, change.locationId]
    );
    return canonical("decimal", row.rows[0]?.value);
  }
  const row = await client.query(
    `SELECT stock_item_id FROM stock_item_code_aliases WHERE company_id = $1 AND lower(alias_code) = lower($2)`,
    [companyId, change.after]
  );
  if (!row.rows.length) return null;
  if (Number(row.rows[0].stock_item_id) !== change.stockItemId) {
    throw new Phase9EventConflict("PHASE9_STOCK_ALIAS_TAKEN", {
      aliasCode: change.after,
      cloudStockItemId: Number(row.rows[0].stock_item_id),
    });
  }
  return change.after;
}

async function assertReference(client: Queryable, companyId: number, change: Phase9StockItemChange) {
  const checks: Array<[string, number]> = [];
  if (change.target === "location-price") checks.push(["locations", Number(change.locationId)]);
  if (change.target === "item" && change.field === "categoryId" && change.after !== null) {
    checks.push(["stock_categories", Number(change.after)]);
  }
  if (change.target === "item" && change.field === "stockGroupId" && change.after !== null) {
    checks.push(["stock_groups", Number(change.after)]);
  }
  for (const [table, id] of checks) {
    const found = await client.query(`SELECT 1 FROM ${table} WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (!found.rows.length) throw new Phase9EventConflict("PHASE9_STOCK_ITEM_REFERENCE_MISSING", { table, id });
  }
}

async function write(client: Queryable, companyId: number, change: Phase9StockItemChange) {
  if (change.target === "item") {
    const column = ITEM_COLUMNS[change.field];
    await client.query(`UPDATE stock_items SET ${column} = $1 WHERE id = $2 AND company_id = $3`, [
      change.after,
      change.stockItemId,
      companyId,
    ]);
  } else if (change.target === "location-price") {
    await client.query(
      `INSERT INTO stock_item_location_prices (stock_item_id, location_id, selling_price)
       VALUES ($1, $2, $3)
       ON CONFLICT (stock_item_id, location_id)
         DO UPDATE SET selling_price = EXCLUDED.selling_price, updated_at = now()`,
      [change.stockItemId, change.locationId, change.after]
    );
  } else {
    await client.query(
      `INSERT INTO stock_item_code_aliases (company_id, stock_item_id, alias_code) VALUES ($1, $2, $3)`,
      [companyId, change.stockItemId, change.after]
    );
  }
}

async function apply(
  client: Queryable,
  event: Phase9StockItemEditEvent,
  context: { readonly overrideConflicts: readonly string[] } = { overrideConflicts: [] }
): Promise<Phase9StockItemEditApplyResult> {
  const p = event.payload;
  const companyId = event.companyId;
  const override = context.overrideConflicts.includes(PHASE9_STOCK_ITEM_CHANGED_CONFLICT);

  // Lock every item in id order; each must still be this company's item with this code.
  const ids = [...new Set(p.changes.map((change) => change.stockItemId))].sort((a, b) => a - b);
  const items = await client.query(
    `SELECT id, code FROM stock_items
      WHERE company_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL
      ORDER BY id FOR UPDATE`,
    [companyId, ids]
  );
  const codes = new Map(items.rows.map((row) => [Number(row.id), String(row.code)]));
  for (const change of p.changes) {
    if (codes.get(change.stockItemId) !== change.code) {
      throw new Phase9EventConflict("PHASE9_STOCK_ITEM_MISSING", {
        stockItemId: change.stockItemId,
        code: change.code,
        cloudCode: codes.get(change.stockItemId) ?? null,
      });
    }
  }

  const pending: Phase9StockItemChange[] = [];
  const changed: Array<{ stockItemId: number; field: string; lan: string | null; cloud: string | null }> = [];
  for (const change of p.changes) {
    await assertReference(client, companyId, change);
    const type = fieldType(change);
    const current = await currentValue(client, companyId, change);
    if (same(type, current, change.after)) continue;
    if (!same(type, current, change.before)) {
      changed.push({ stockItemId: change.stockItemId, field: change.field, lan: change.before, cloud: current });
    }
    pending.push(change);
  }
  if (changed.length && !override) {
    throw new Phase9EventConflict(PHASE9_STOCK_ITEM_CHANGED_CONFLICT, {
      changed: changed.slice(0, 50),
      count: changed.length,
    });
  }
  for (const change of pending) await write(client, companyId, change);
  return {
    outcome: pending.length ? "cloud-applied" : "already-present",
    cloudRef: ids[0],
    businessDate: p.businessDate,
  };
}

async function verify(
  client: Queryable,
  event: Phase9StockItemEditEvent,
  result: Phase9StockItemEditApplyResult
): Promise<boolean> {
  if (result.cloudRef !== Math.min(...event.payload.changes.map((change) => change.stockItemId))) return false;
  for (const change of event.payload.changes) {
    if (!same(fieldType(change), await currentValue(client, event.companyId, change), change.after)) return false;
  }
  return true;
}

export const phase9StockItemEditApplyHandler = Object.freeze({ authorize, apply, verify });
