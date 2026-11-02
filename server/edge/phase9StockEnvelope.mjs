/**
 * Phase 9: typed, immutable LAN evidence for an inventory quick adjustment
 * (POST /api/inventory/quick-adjust) captured while the factory LAN server is
 * the writer. The owner-approved policy is that stock movements replay as
 * quantity DELTAS, never as overwritten balances: the cloud re-applies
 * "+/- quantity of item X at location Y" against its own current balance, and
 * a movement that would take cloud stock below zero is held for an
 * Admin/Developer decision instead of being applied or dropped.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Same precision as the canonical stock movement journal (numeric(18,6)).
const QUANTITY = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
const MAX_REF = 2147483647;

export const PHASE9_STOCK_ADJUST_KIND = "stock.quick-adjust.v1";
export const PHASE9_STOCK_NEGATIVE_CONFLICT = "PHASE9_STOCK_WOULD_GO_NEGATIVE";

const INPUT_FIELDS = Object.freeze([
  "actorUserId",
  "actorUsername",
  "businessDate",
  "companyId",
  "direction",
  "localMovementId",
  "locationId",
  "occurredAt",
  "quantity",
  "requestId",
  "stockItemId",
]);

export class Phase9StockRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9StockRefusal";
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

function validInstant(value) {
  return (
    typeof value === "string" &&
    UTC.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validQuantity(value) {
  return typeof value === "string" && QUANTITY.test(value) && /[1-9]/.test(value);
}

/**
 * Accept only the authoritative values the LAN transaction committed. The
 * quantity is a canonical decimal string (no exponent, no sign) so the cloud
 * recomputes exactly the same delta and digest.
 */
export function phase9StockAdjustEnvelope(evidence) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== INPUT_FIELDS.join(",") ||
    !ref(evidence.companyId) ||
    !ref(evidence.localMovementId) ||
    !ref(evidence.stockItemId) ||
    !ref(evidence.locationId) ||
    typeof evidence.actorUserId !== "string" ||
    evidence.actorUserId.length < 1 ||
    evidence.actorUserId.length > 255 ||
    typeof evidence.actorUsername !== "string" ||
    evidence.actorUsername.length < 1 ||
    evidence.actorUsername.length > 255 ||
    typeof evidence.requestId !== "string" ||
    !UUID.test(evidence.requestId) ||
    (evidence.direction !== "add" && evidence.direction !== "subtract") ||
    !validQuantity(evidence.quantity) ||
    !validInstant(evidence.occurredAt) ||
    !validDay(evidence.businessDate) ||
    evidence.occurredAt.slice(0, 10) !== evidence.businessDate
  ) {
    throw new Phase9StockRefusal("PHASE9_STOCK_EVIDENCE_INVALID");
  }
  return {
    kind: PHASE9_STOCK_ADJUST_KIND,
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    localMovementId: evidence.localMovementId,
    stockItemId: evidence.stockItemId,
    locationId: evidence.locationId,
    direction: evidence.direction,
    quantity: evidence.quantity,
    occurredAt: evidence.occurredAt,
    businessDate: evidence.businessDate,
  };
}

export const PHASE9_STOCK_TRANSFER_KIND = "stock.transfer.v1";
const TRANSFER_FIELDS = Object.freeze([
  "actorUserId",
  "actorUsername",
  "allowNegativeInventory",
  "businessDate",
  "companyId",
  "destinationLocationId",
  "items",
  "localTransferId",
  "notes",
  "optional",
  "requestId",
  "sourceLocationId",
]);
const RATE = /^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,6})?$/;

/**
 * A stock transfer created on the factory LAN server (POST /api/stock-transfers),
 * replayed in the cloud through the same transfer code with the same request
 * id (the cloud's idempotency key).
 */
export function phase9StockTransferEnvelope(evidence) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== TRANSFER_FIELDS.join(",") ||
    !ref(evidence.companyId) ||
    !ref(evidence.localTransferId) ||
    !ref(evidence.destinationLocationId) ||
    (evidence.sourceLocationId !== null && !ref(evidence.sourceLocationId)) ||
    typeof evidence.actorUserId !== "string" ||
    evidence.actorUserId.length < 1 ||
    evidence.actorUserId.length > 255 ||
    typeof evidence.actorUsername !== "string" ||
    evidence.actorUsername.length < 1 ||
    evidence.actorUsername.length > 255 ||
    typeof evidence.requestId !== "string" ||
    !UUID.test(evidence.requestId) ||
    !validDay(evidence.businessDate) ||
    (evidence.notes !== null && (typeof evidence.notes !== "string" || evidence.notes.length > 2000)) ||
    typeof evidence.optional !== "boolean" ||
    typeof evidence.allowNegativeInventory !== "boolean" ||
    !Array.isArray(evidence.items) ||
    evidence.items.length < 1 ||
    evidence.items.length > 1000
  ) {
    throw new Phase9StockRefusal("PHASE9_STOCK_EVIDENCE_INVALID");
  }
  const items = evidence.items.map((line) => {
    if (
      !line ||
      typeof line !== "object" ||
      Array.isArray(line) ||
      Object.keys(line).sort().join(",") !== "quantity,rate,sourceLocationId,stockItemId" ||
      !ref(line.sourceLocationId) ||
      !ref(line.stockItemId) ||
      !validQuantity(line.quantity) ||
      typeof line.rate !== "string" ||
      !RATE.test(line.rate)
    ) {
      throw new Phase9StockRefusal("PHASE9_STOCK_EVIDENCE_INVALID");
    }
    return {
      sourceLocationId: line.sourceLocationId,
      stockItemId: line.stockItemId,
      quantity: line.quantity,
      rate: line.rate,
    };
  });
  return {
    kind: PHASE9_STOCK_TRANSFER_KIND,
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    localTransferId: evidence.localTransferId,
    businessDate: evidence.businessDate,
    sourceLocationId: evidence.sourceLocationId,
    destinationLocationId: evidence.destinationLocationId,
    notes: evidence.notes,
    optional: evidence.optional,
    allowNegativeInventory: evidence.allowNegativeInventory,
    items,
  };
}
