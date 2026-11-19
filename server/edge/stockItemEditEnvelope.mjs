/**
 * Phase 9 (owner decision 2026-11-02): typed, immutable LAN evidence for
 * stock-item master data edited on the factory LAN server during an outage:
 * bulk edits (prices, names, units, categories), the update-by-code imports
 * (names, categories, opening balances, barcodes) and single-item edits.
 *
 * Each change names an EXISTING item by id and code, one whitelisted field,
 * the value the LAN saw before and the value it set. The cloud applies a change
 * only while its own value still equals "before" (or already equals "after");
 * a field the cloud changed meanwhile is held as PHASE9_STOCK_ITEM_CHANGED
 * until an Admin/Developer approves the LAN value or rejects it. Creating,
 * deleting, merging or re-coding items stays cloud-only: item ids and codes
 * are how every other offline record finds its item in the cloud.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,6})?$/;
const INTEGER = /^[1-9][0-9]{0,9}$/;
const MAX_REF = 2147483647;
const MAX_CHANGES = 5000;

export const PHASE9_STOCK_ITEM_EDIT_KIND = "stock.item-edit.v1";
export const PHASE9_STOCK_ITEM_CHANGED_CONFLICT = "PHASE9_STOCK_ITEM_CHANGED";

/** target -> field -> value type. Anything else is refused on the LAN. */
export const PHASE9_STOCK_ITEM_EDIT_FIELDS = Object.freeze({
  item: Object.freeze({
    name: "text",
    uom: "text",
    sellingPrice: "decimal",
    categoryId: "ref",
    stockGroupId: "ref",
    active: "boolean",
    openingQty: "decimal",
    openingRate: "decimal",
    openingValue: "decimal",
  }),
  "location-price": Object.freeze({ sellingPrice: "decimal" }),
  alias: Object.freeze({ aliasCode: "text" }),
});

export const PHASE9_STOCK_ITEM_EDIT_ROUTES = Object.freeze([
  "POST /api/stock-items/bulk-update-prices",
  "POST /api/stock-items/bulk-assign-category",
  "POST /api/stock-items/bulk-rename",
  "POST /api/stock-items/bulk-update-uom",
  "POST /api/stock-items/update-categories",
  "POST /api/stock-items/update-names-by-code",
  "POST /api/stock-items/import-barcodes",
  "POST /api/stock-items/import-opening-balances",
  "POST /api/stock-items/:id/location-prices",
  "PATCH /api/stock-items/:id",
]);

const FIELDS = Object.freeze([
  "actorUserId",
  "actorUsername",
  "businessDate",
  "changes",
  "companyId",
  "localEditId",
  "requestId",
  "route",
]);

export class Phase9StockItemEditRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9StockItemEditRefusal";
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
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

/** A field value as the LAN committed it: canonical string, or null. */
export function validPhase9StockItemValue(type, value, nullable) {
  if (value === null) return nullable;
  if (typeof value !== "string") return false;
  if (type === "text") return value.length >= 1 && value.length <= 500;
  if (type === "decimal") return DECIMAL.test(value) && value !== "-0";
  if (type === "ref") return INTEGER.test(value) && Number(value) <= MAX_REF;
  if (type === "boolean") return value === "true" || value === "false";
  return false;
}

function change(line) {
  if (!line || typeof line !== "object" || Array.isArray(line)) return null;
  const fields = PHASE9_STOCK_ITEM_EDIT_FIELDS[line.target];
  if (!fields || !Object.prototype.hasOwnProperty.call(fields, line.field)) return null;
  const keys =
    line.target === "location-price"
      ? "after,before,code,field,locationId,stockItemId,target"
      : "after,before,code,field,stockItemId,target";
  if (Object.keys(line).sort().join(",") !== keys) return null;
  if (!ref(line.stockItemId) || !text(line.code, 255)) return null;
  if (line.target === "location-price" && !ref(line.locationId)) return null;
  const type = fields[line.field];
  // Any field may start from nothing (an alias always does); only a category
  // may be cleared.
  const nullableBefore = true;
  const nullableAfter = line.target === "item" && line.field === "categoryId";
  if (!validPhase9StockItemValue(type, line.before, nullableBefore)) return null;
  if (!validPhase9StockItemValue(type, line.after, nullableAfter)) return null;
  if (line.target === "alias" && line.before !== null) return null;
  if (line.before === line.after) return null;
  const out = {
    target: line.target,
    stockItemId: line.stockItemId,
    code: line.code,
    field: line.field,
    before: line.before,
    after: line.after,
  };
  return line.target === "location-price" ? { ...out, locationId: line.locationId } : out;
}

export function phase9StockItemEditEnvelope(evidence) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== FIELDS.join(",") ||
    !ref(evidence.companyId) ||
    !ref(evidence.localEditId) ||
    !text(evidence.actorUserId, 255) ||
    !text(evidence.actorUsername, 255) ||
    typeof evidence.requestId !== "string" ||
    !UUID.test(evidence.requestId) ||
    !validDay(evidence.businessDate) ||
    !PHASE9_STOCK_ITEM_EDIT_ROUTES.includes(evidence.route) ||
    !Array.isArray(evidence.changes) ||
    evidence.changes.length < 1 ||
    evidence.changes.length > MAX_CHANGES
  ) {
    throw new Phase9StockItemEditRefusal("PHASE9_STOCK_ITEM_EDIT_EVIDENCE_INVALID");
  }
  const seen = new Set();
  const changes = evidence.changes.map((line) => {
    const parsed = change(line);
    if (!parsed) throw new Phase9StockItemEditRefusal("PHASE9_STOCK_ITEM_EDIT_EVIDENCE_INVALID");
    const key = `${parsed.target}:${parsed.stockItemId}:${parsed.locationId ?? ""}:${parsed.field}:${
      parsed.target === "alias" ? parsed.after.toLowerCase() : ""
    }`;
    // One change per field per request: the LAN sends the net result.
    if (seen.has(key)) throw new Phase9StockItemEditRefusal("PHASE9_STOCK_ITEM_EDIT_EVIDENCE_INVALID");
    seen.add(key);
    return parsed;
  });
  return {
    kind: PHASE9_STOCK_ITEM_EDIT_KIND,
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    localEditId: evidence.localEditId,
    businessDate: evidence.businessDate,
    route: evidence.route,
    changes,
  };
}
