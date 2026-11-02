/**
 * Phase 9: typed, immutable LAN evidence for a POS cash sale
 * (POST /api/pos/sales) captured while the factory LAN server is the writer.
 *
 * Owner policy (2026-11-01): offline sales are cash only, carry their own
 * LAN invoice series (LAN-<site>-000123), keep the price they were sold at
 * (the last prices synced before the outage) and are replayed in the cloud
 * through the normal sale service, idempotent on the sale's clientSaleId.
 * This version accepts USD sales only; Kwacha sales stay online-only until
 * the LAN rate can be carried as evidence.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
const INVOICE = /^LAN-[0-9A-F]{4}-[0-9]{6,}$/;
const MAX_REF = 2147483647;
const MAX_ITEMS = 200;

export const PHASE9_POS_SALE_KIND = "pos.sale.v1";
export const PHASE9_POS_NEGATIVE_CONFLICT = "PHASE9_POS_STOCK_WOULD_GO_NEGATIVE";
export const PHASE9_POS_CASH_ACCOUNT_CONFLICT = "PHASE9_POS_CASH_ACCOUNT_CHANGED";

const INPUT_FIELDS = Object.freeze([
  "actorUserId",
  "actorUsername",
  "cashAccountId",
  "companyId",
  "currency",
  "items",
  "lanInvoiceNumber",
  "localVoucherId",
  "locationId",
  "notes",
  "requestId",
  "voucherDate",
]);

export class Phase9PosSaleRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9PosSaleRefusal";
  }
}

const ref = (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_REF;

function validDay(date) {
  if (typeof date !== "string" || !DAY.test(date)) return false;
  const value = new Date(date + "T00:00:00.000Z");
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}

function item(line) {
  if (
    !line ||
    typeof line !== "object" ||
    Array.isArray(line) ||
    Object.keys(line).sort().join(",") !== "quantity,rate,stockItemId" ||
    !ref(line.stockItemId) ||
    typeof line.quantity !== "string" ||
    !DECIMAL.test(line.quantity) ||
    !/[1-9]/.test(line.quantity) ||
    typeof line.rate !== "string" ||
    !DECIMAL.test(line.rate)
  ) {
    throw new Phase9PosSaleRefusal("PHASE9_POS_EVIDENCE_INVALID");
  }
  return { stockItemId: line.stockItemId, quantity: line.quantity, rate: line.rate };
}

/** Accept only the values the LAN sale transaction committed. */
export function phase9PosSaleEnvelope(evidence) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== INPUT_FIELDS.join(",") ||
    !ref(evidence.companyId) ||
    !ref(evidence.localVoucherId) ||
    !ref(evidence.locationId) ||
    !ref(evidence.cashAccountId) ||
    typeof evidence.actorUserId !== "string" ||
    evidence.actorUserId.length < 1 ||
    evidence.actorUserId.length > 255 ||
    typeof evidence.actorUsername !== "string" ||
    evidence.actorUsername.length < 1 ||
    evidence.actorUsername.length > 255 ||
    typeof evidence.requestId !== "string" ||
    !UUID.test(evidence.requestId) ||
    typeof evidence.lanInvoiceNumber !== "string" ||
    !INVOICE.test(evidence.lanInvoiceNumber) ||
    evidence.currency !== "USD" ||
    !validDay(evidence.voucherDate) ||
    (evidence.notes !== null && (typeof evidence.notes !== "string" || evidence.notes.length > 500)) ||
    !Array.isArray(evidence.items) ||
    evidence.items.length < 1 ||
    evidence.items.length > MAX_ITEMS
  ) {
    throw new Phase9PosSaleRefusal("PHASE9_POS_EVIDENCE_INVALID");
  }
  return {
    kind: PHASE9_POS_SALE_KIND,
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    localVoucherId: evidence.localVoucherId,
    lanInvoiceNumber: evidence.lanInvoiceNumber,
    locationId: evidence.locationId,
    cashAccountId: evidence.cashAccountId,
    currency: evidence.currency,
    voucherDate: evidence.voucherDate,
    notes: evidence.notes,
    items: evidence.items.map(item),
  };
}

/** LAN invoice number for one site sequence, e.g. LAN-5B0C-000123. */
export function phase9PosInvoiceNumber(siteId, sequence) {
  if (typeof siteId !== "string" || !UUID.test(siteId)) throw new Phase9PosSaleRefusal("PHASE9_POS_SITE_INVALID");
  const n = BigInt(sequence);
  if (n < 1n) throw new Phase9PosSaleRefusal("PHASE9_POS_SEQUENCE_INVALID");
  return `LAN-${siteId.slice(0, 4).toUpperCase()}-${n.toString().padStart(6, "0")}`;
}
