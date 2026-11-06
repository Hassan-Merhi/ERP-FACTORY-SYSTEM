/**
 * Phase 9 (owner-approved plan 2026-11-05, batch 2): stock items created or
 * deleted on the factory LAN server during an outage.
 *
 * A LAN-created item gets an id from a range the cloud never uses (at or
 * above PHASE9_LAN_ITEM_ID_BASE; the LAN install moves the item id sequence
 * there), so every other offline record that names it can be translated to
 * the cloud's own id once the cloud has created the item
 * (server/edge/phase9StockItemMap.mjs). The item keeps the code the user
 * typed. Merging and re-coding items stay online-only.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,6})?$/;
const MAX_REF = 2147483647;

export const PHASE9_LAN_ITEM_ID_BASE = 1_000_000_000;
export const PHASE9_STOCK_ITEM_CREATE_KIND = "stock.item-create.v1";
export const PHASE9_STOCK_ITEM_DELETE_KIND = "stock.item-delete.v1";
/** Overridable: an item with the same name exists in the cloud; approve keeps both. */
export const PHASE9_STOCK_ITEM_NAME_EXISTS_CONFLICT = "PHASE9_STOCK_ITEM_NAME_EXISTS";

export class Phase9StockItemLifecycleRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9StockItemLifecycleRefusal";
  }
}

function ref(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_REF;
}

function validDay(date) {
  if (typeof date !== "string" || !DAY.test(date)) return false;
  const value = new Date(date + "T00:00:00.000Z");
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}

function text(value, max) {
  return typeof value === "string" && value.trim().length >= 1 && value.length <= max;
}

function decimalOrNull(value) {
  return value === null || (typeof value === "string" && DECIMAL.test(value) && value !== "-0");
}

function refOrNull(value) {
  return value === null || ref(value);
}

const ACTOR_FIELDS = ["actorUserId", "actorUsername", "businessDate", "companyId", "requestId"];

function validActor(evidence) {
  return (
    ref(evidence.companyId) &&
    text(evidence.actorUserId, 255) &&
    text(evidence.actorUsername, 255) &&
    typeof evidence.requestId === "string" &&
    UUID.test(evidence.requestId) &&
    validDay(evidence.businessDate)
  );
}

const ITEM_FIELDS = [
  "active",
  "categoryId",
  "code",
  "gradeId",
  "name",
  "openingQty",
  "openingRate",
  "openingValue",
  "reorderLevel",
  "sellingPrice",
  "stockGroupId",
  "uom",
];

function item(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== ITEM_FIELDS.join(",") ||
    !text(value.code, 50) ||
    !text(value.name, 500) ||
    !text(value.uom, 50) ||
    !ref(value.stockGroupId) ||
    !refOrNull(value.categoryId) ||
    !refOrNull(value.gradeId) ||
    !decimalOrNull(value.sellingPrice) ||
    !decimalOrNull(value.openingQty) ||
    !decimalOrNull(value.openingRate) ||
    !decimalOrNull(value.openingValue) ||
    !decimalOrNull(value.reorderLevel) ||
    typeof value.active !== "boolean"
  ) {
    return null;
  }
  return Object.fromEntries(ITEM_FIELDS.map((field) => [field, value[field]]));
}

export function phase9StockItemCreateEnvelope(evidence) {
  const fields = [...ACTOR_FIELDS, "item", "localStockItemId"].sort();
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== fields.join(",") ||
    !validActor(evidence) ||
    !ref(evidence.localStockItemId) ||
    evidence.localStockItemId < PHASE9_LAN_ITEM_ID_BASE
  ) {
    throw new Phase9StockItemLifecycleRefusal("PHASE9_STOCK_ITEM_CREATE_EVIDENCE_INVALID");
  }
  const parsed = item(evidence.item);
  if (!parsed) throw new Phase9StockItemLifecycleRefusal("PHASE9_STOCK_ITEM_CREATE_EVIDENCE_INVALID");
  return {
    kind: PHASE9_STOCK_ITEM_CREATE_KIND,
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    businessDate: evidence.businessDate,
    localStockItemId: evidence.localStockItemId,
    item: parsed,
  };
}

export function phase9StockItemDeleteEnvelope(evidence) {
  const fields = [...ACTOR_FIELDS, "code", "stockItemId"].sort();
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== fields.join(",") ||
    !validActor(evidence) ||
    !ref(evidence.stockItemId) ||
    !text(evidence.code, 50)
  ) {
    throw new Phase9StockItemLifecycleRefusal("PHASE9_STOCK_ITEM_DELETE_EVIDENCE_INVALID");
  }
  return {
    kind: PHASE9_STOCK_ITEM_DELETE_KIND,
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    businessDate: evidence.businessDate,
    stockItemId: evidence.stockItemId,
    code: evidence.code,
  };
}
