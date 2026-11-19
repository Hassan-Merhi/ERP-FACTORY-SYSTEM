/**
 * Phase 9 (plan batch 2): the cloud's record of which cloud stock item each
 * LAN-created item became, and the translation every offline record goes
 * through before its handler runs.
 *
 * Ids at or above PHASE9_LAN_ITEM_ID_BASE were handed out by a factory LAN
 * server. Any `stockItemId` in an event at or above it is replaced by the
 * cloud item that site's create produced. One the cloud has not created yet
 * makes the apply wait (Phase9StockItemNotYetSynced, no conflict recorded):
 * apply the stock stream, which carries the create, and the record follows.
 */
import { PHASE9_LAN_ITEM_ID_BASE } from "./stockItemLifecycleEnvelope.mjs";

export class Phase9StockItemNotYetSynced extends Error {
  constructor(lanItemIds) {
    super("PHASE9_STOCK_ITEM_NOT_YET_SYNCED");
    this.name = "Phase9StockItemNotYetSynced";
    this.lanItemIds = lanItemIds;
  }
}

export function isPhase9LanItemId(value) {
  return Number.isSafeInteger(value) && value >= PHASE9_LAN_ITEM_ID_BASE;
}

function collect(value, out) {
  if (Array.isArray(value)) {
    for (const entry of value) collect(entry, out);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "stockItemId" && isPhase9LanItemId(entry)) out.add(entry);
      else collect(entry, out);
    }
  }
}

function replace(value, map) {
  if (Array.isArray(value)) return value.map((entry) => replace(entry, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "stockItemId" && isPhase9LanItemId(entry) ? map.get(entry) : replace(entry, map),
      ])
    );
  }
  return value;
}

/** The event as the handler sees it: LAN item ids replaced by the cloud's. */
export async function translatePhase9LanStockItems(queryable, siteId, event) {
  const ids = new Set();
  collect(event.payload, ids);
  if (!ids.size) return event;
  const rows = await queryable.query(
    `SELECT lan_item_id, cloud_item_id FROM factory_edge_stock_item_map
      WHERE site_id = $1::uuid AND lan_item_id = ANY($2::int[])`,
    [siteId, [...ids]]
  );
  const map = new Map(rows.rows.map((row) => [Number(row.lan_item_id), Number(row.cloud_item_id)]));
  const missing = [...ids].filter((id) => !map.has(id));
  if (missing.length) throw new Phase9StockItemNotYetSynced(missing);
  return { ...event, payload: replace(event.payload, map) };
}

export async function readPhase9StockItemMapping(queryable, siteId, lanItemId) {
  const row = await queryable.query(
    "SELECT cloud_item_id FROM factory_edge_stock_item_map WHERE site_id = $1::uuid AND lan_item_id = $2",
    [siteId, lanItemId]
  );
  return row.rows.length ? Number(row.rows[0].cloud_item_id) : null;
}

export async function recordPhase9StockItemMapping(queryable, input) {
  await queryable.query(
    `INSERT INTO factory_edge_stock_item_map (site_id, lan_item_id, cloud_item_id, operation_id)
     VALUES ($1::uuid, $2, $3, $4::uuid)`,
    [input.siteId, input.lanItemId, input.cloudItemId, input.operationId]
  );
}
