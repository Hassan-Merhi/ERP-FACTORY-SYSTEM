/**
 * Phase 9 cloud apply handlers for stock items created or deleted on the
 * factory LAN server (plan batch 2, owner-approved 2026-11-05).
 *
 * Create: the cloud creates the item with the code the user typed and records
 * which cloud item the LAN item became (factory_edge_stock_item_map), on the
 * receipt's transaction, so every later offline record naming the LAN item is
 * translated to it. A code the cloud already uses, or a missing stock group /
 * category / grade, can only be rejected. An item with the same name (another
 * code) is held as PHASE9_STOCK_ITEM_NAME_EXISTS: approve keeps both items.
 *
 * Delete: a soft delete, applied only while the cloud item has no inventory
 * rows and no stock movements; otherwise reject-only PHASE9_STOCK_ITEM_IN_USE.
 * The delete names the cloud item already (the apply translated LAN ids).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { stockItems } from "@shared/schema";
import type { DbTransaction } from "../db";
import { logAudit } from "../routes/_helpers";
import { Phase9ApplyRefusal, Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import {
  PHASE9_STOCK_ITEM_NAME_EXISTS_CONFLICT,
  type Phase9StockItemCreateEvidence,
  type Phase9StockItemDeleteEvidence,
} from "./phase9StockItemLifecycleEnvelope.mjs";
import { readPhase9StockItemMapping, recordPhase9StockItemMapping } from "./phase9StockItemMap.mjs";

type Queryable = Pick<PoolClient, "query">;
type Payload<T> = { kind: string } & { [K in keyof T]: T[K] };

interface LifecycleEvent<T> {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  payload: Payload<T>;
  payloadSha256: string;
}

export type Phase9StockItemCreateEvent = LifecycleEvent<Phase9StockItemCreateEvidence>;
export type Phase9StockItemDeleteEvent = LifecycleEvent<Phase9StockItemDeleteEvidence>;

interface Result {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const NOT_PERMITTED_ROLES = new Set(["View Only", "Create Only", "ERP Tester", "POS"]);

/** The live routes are requireNonPOS; re-checked against CURRENT cloud access. */
async function authorize(client: Queryable, event: { actorUserId: string; companyId: number }): Promise<void> {
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

async function assertReferences(client: Queryable, companyId: number, item: Phase9StockItemCreateEvidence["item"]) {
  const checks: Array<[string, number | null]> = [
    ["stock_groups", item.stockGroupId],
    ["stock_categories", item.categoryId],
    ["stock_grades", item.gradeId],
  ];
  for (const [table, id] of checks) {
    if (id === null) continue;
    const found = await client.query(`SELECT 1 FROM ${table} WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (!found.rows.length) throw new Phase9EventConflict("PHASE9_STOCK_ITEM_REFERENCE_MISSING", { table, id });
  }
}

async function applyCreate(
  client: Queryable,
  event: Phase9StockItemCreateEvent,
  context: { readonly overrideConflicts: readonly string[]; readonly siteId?: string } = { overrideConflicts: [] }
): Promise<Result> {
  const p = event.payload;
  if (!context.siteId) throw new Phase9ApplyRefusal("PHASE9_STOCK_ITEM_SITE_MISSING");
  const mapped = await readPhase9StockItemMapping(client, context.siteId, p.localStockItemId);
  if (mapped !== null) return { outcome: "already-present", cloudRef: mapped, businessDate: p.businessDate };

  // Serialise creates per company so two codes cannot race past the check.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('phase9-stock-item-create'), $1)", [event.companyId]);
  const codeTaken = await client.query(
    "SELECT id FROM stock_items WHERE company_id = $1 AND lower(code) = lower($2) LIMIT 1",
    [event.companyId, p.item.code]
  );
  if (codeTaken.rows.length) {
    throw new Phase9EventConflict("PHASE9_STOCK_ITEM_CODE_TAKEN", {
      code: p.item.code,
      cloudStockItemId: Number(codeTaken.rows[0].id),
    });
  }
  await assertReferences(client, event.companyId, p.item);
  if (!context.overrideConflicts.includes(PHASE9_STOCK_ITEM_NAME_EXISTS_CONFLICT)) {
    const sameName = await client.query(
      `SELECT id, code FROM stock_items
        WHERE company_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND deleted_at IS NULL LIMIT 1`,
      [event.companyId, p.item.name]
    );
    if (sameName.rows.length) {
      throw new Phase9EventConflict(PHASE9_STOCK_ITEM_NAME_EXISTS_CONFLICT, {
        name: p.item.name,
        cloudStockItemId: Number(sameName.rows[0].id),
        cloudCode: String(sameName.rows[0].code),
      });
    }
  }

  const tx = drizzle(client as PoolClient) as unknown as DbTransaction;
  const [created] = await tx
    .insert(stockItems)
    .values({ ...p.item, companyId: event.companyId })
    .returning({ id: stockItems.id, name: stockItems.name, code: stockItems.code });
  await recordPhase9StockItemMapping(client, {
    siteId: context.siteId,
    lanItemId: p.localStockItemId,
    cloudItemId: created.id,
    operationId: event.operationId,
  });
  await logAudit(
    {
      userId: event.actorUserId,
      username: p.actorUsername,
      companyId: event.companyId,
      action: "create",
      tableName: "stock_items",
      recordId: created.id,
      recordIdentifier: created.name,
      changes: {
        name: { new: created.name },
        code: { new: created.code },
        offlineLanItemId: { new: p.localStockItemId },
      },
    },
    tx
  );
  return { outcome: "cloud-applied", cloudRef: created.id, businessDate: p.businessDate };
}

async function verifyCreate(client: Queryable, event: Phase9StockItemCreateEvent, result: Result): Promise<boolean> {
  const row = await client.query(
    `SELECT s.code FROM factory_edge_stock_item_map m
       JOIN stock_items s ON s.id = m.cloud_item_id
      WHERE m.lan_item_id = $1 AND m.cloud_item_id = $2 AND s.company_id = $3`,
    [event.payload.localStockItemId, result.cloudRef, event.companyId]
  );
  return row.rows.length === 1 && String(row.rows[0].code) === event.payload.item.code;
}

async function applyDelete(client: Queryable, event: Phase9StockItemDeleteEvent): Promise<Result> {
  const p = event.payload;
  const item = await client.query(
    "SELECT id, code, deleted_at FROM stock_items WHERE id = $1 AND company_id = $2 FOR UPDATE",
    [p.stockItemId, event.companyId]
  );
  const row = item.rows[0];
  if (!row || String(row.code) !== p.code) {
    throw new Phase9EventConflict("PHASE9_STOCK_ITEM_MISSING", { stockItemId: p.stockItemId, code: p.code });
  }
  if (row.deleted_at !== null)
    return { outcome: "already-present", cloudRef: p.stockItemId, businessDate: p.businessDate };
  const usage = await client.query(
    `SELECT (SELECT count(*) FROM inventory WHERE stock_item_id = $1 AND company_id = $2)::int AS inventory_rows,
            (SELECT count(*) FROM canonical_stock_movements
              WHERE stock_item_id = $1 AND company_id = $2)::int AS movements`,
    [p.stockItemId, event.companyId]
  );
  const { inventory_rows: inventoryRows, movements } = usage.rows[0];
  if (inventoryRows > 0 || movements > 0) {
    throw new Phase9EventConflict("PHASE9_STOCK_ITEM_IN_USE", {
      stockItemId: p.stockItemId,
      inventoryRows,
      movements,
    });
  }
  await client.query("UPDATE stock_items SET deleted_at = now() WHERE id = $1 AND company_id = $2", [
    p.stockItemId,
    event.companyId,
  ]);
  return { outcome: "cloud-applied", cloudRef: p.stockItemId, businessDate: p.businessDate };
}

async function verifyDelete(client: Queryable, event: Phase9StockItemDeleteEvent, result: Result) {
  const row = await client.query("SELECT deleted_at FROM stock_items WHERE id = $1 AND company_id = $2", [
    result.cloudRef,
    event.companyId,
  ]);
  return row.rows.length === 1 && row.rows[0].deleted_at !== null;
}

export const phase9StockItemCreateApplyHandler = Object.freeze({
  authorize,
  apply: applyCreate,
  verify: verifyCreate,
});
export const phase9StockItemDeleteApplyHandler = Object.freeze({
  authorize,
  apply: applyDelete,
  verify: verifyDelete,
});
