/**
 * Phase 9: typed, immutable LAN evidence for a POS cash sale
 * (POST /api/pos/sales) captured while the factory LAN server is the writer.
 *
 * Owner policy (2026-11-01, extended 2026-11-02): offline sales may be cash,
 * bank or credit, in USD or another accepted currency at the exchange rate the
 * cashier entered. They carry their own LAN invoice series (LAN-<site>-000123),
 * keep the price they were sold at, and are replayed in the cloud through the
 * normal sale service at the same rate, idempotent on the sale's clientSaleId.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
const INVOICE = /^LAN-[0-9A-F]{4}-[0-9]{6,}$/;
const RATE = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,12})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const PAYMENT_TYPES = new Set(["cash", "bank", "credit"]);
const MAX_REF = 2147483647;
const MAX_ITEMS = 200;

export const PHASE9_POS_SALE_KIND = "pos.sale.v1";
export const PHASE9_POS_NEGATIVE_CONFLICT = "PHASE9_POS_STOCK_WOULD_GO_NEGATIVE";
export const PHASE9_POS_CASH_ACCOUNT_CONFLICT = "PHASE9_POS_CASH_ACCOUNT_CHANGED";

const INPUT_FIELDS = Object.freeze([
  "actorUserId",
  "actorUsername",
  "companyId",
  "currency",
  "exchangeRate",
  "items",
  "lanInvoiceNumber",
  "localVoucherId",
  "locationId",
  "notes",
  "paymentAccountId",
  "paymentAccountType",
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
    Object.keys(line).sort().join(",") !== "originalCurrencyRate,quantity,rate,stockItemId" ||
    (line.originalCurrencyRate !== null &&
      (typeof line.originalCurrencyRate !== "string" || !DECIMAL.test(line.originalCurrencyRate))) ||
    !ref(line.stockItemId) ||
    typeof line.quantity !== "string" ||
    !DECIMAL.test(line.quantity) ||
    !/[1-9]/.test(line.quantity) ||
    typeof line.rate !== "string" ||
    !DECIMAL.test(line.rate)
  ) {
    throw new Phase9PosSaleRefusal("PHASE9_POS_EVIDENCE_INVALID");
  }
  return {
    stockItemId: line.stockItemId,
    quantity: line.quantity,
    rate: line.rate,
    originalCurrencyRate: line.originalCurrencyRate,
  };
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
    !PAYMENT_TYPES.has(evidence.paymentAccountType) ||
    !ref(evidence.paymentAccountId) ||
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
    typeof evidence.currency !== "string" ||
    !CURRENCY.test(evidence.currency) ||
    (evidence.currency === "USD"
      ? evidence.exchangeRate !== null
      : typeof evidence.exchangeRate !== "string" || !RATE.test(evidence.exchangeRate)) ||
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
    paymentAccountType: evidence.paymentAccountType,
    paymentAccountId: evidence.paymentAccountId,
    currency: evidence.currency,
    exchangeRate: evidence.exchangeRate,
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

export const PHASE9_POS_SALE_EDIT_KIND = "pos.sale-edit.v1";
const EDIT_FIELDS = Object.freeze([
  "actorUserId",
  "actorUsername",
  "businessDate",
  "companyId",
  "edit",
  "localVoucherId",
  "requestId",
  "voucherRef",
]);
const EDIT_BODY_FIELDS = Object.freeze([
  "description",
  "isCreditSale",
  "items",
  "locationId",
  "paymentAccountId",
  "paymentAccountType",
  "voucherDate",
]);

function editLine(line) {
  if (
    !line ||
    typeof line !== "object" ||
    Array.isArray(line) ||
    Object.keys(line).sort().join(",") !== "existing,quantity,sellingPrice,stockItemId" ||
    typeof line.existing !== "boolean" ||
    !ref(line.stockItemId) ||
    typeof line.quantity !== "string" ||
    !DECIMAL.test(line.quantity) ||
    !/[1-9]/.test(line.quantity) ||
    typeof line.sellingPrice !== "string" ||
    !DECIMAL.test(line.sellingPrice)
  ) {
    throw new Phase9PosSaleRefusal("PHASE9_POS_EVIDENCE_INVALID");
  }
  return {
    existing: line.existing,
    stockItemId: line.stockItemId,
    quantity: line.quantity,
    sellingPrice: line.sellingPrice,
  };
}

/**
 * A POS sale edit (a return or correction of an existing sale) recorded on
 * the factory LAN server. `voucherRef` identifies the sale in the cloud: its
 * client sale id when it has one (offline sales always do), otherwise the
 * voucher id, which is the same in the cloud for sales made before the
 * outage. `existing` marks lines that were already on the sale, so the cloud
 * keeps their original cost.
 */
export function phase9PosSaleEditEnvelope(evidence) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== EDIT_FIELDS.join(",") ||
    !ref(evidence.companyId) ||
    !ref(evidence.localVoucherId) ||
    typeof evidence.actorUserId !== "string" ||
    evidence.actorUserId.length < 1 ||
    evidence.actorUserId.length > 255 ||
    typeof evidence.actorUsername !== "string" ||
    evidence.actorUsername.length < 1 ||
    evidence.actorUsername.length > 255 ||
    typeof evidence.requestId !== "string" ||
    !UUID.test(evidence.requestId) ||
    !validDay(evidence.businessDate) ||
    !evidence.voucherRef ||
    typeof evidence.voucherRef !== "object" ||
    Object.keys(evidence.voucherRef).sort().join(",") !== "clientSaleId,voucherId" ||
    (evidence.voucherRef.clientSaleId !== null &&
      (typeof evidence.voucherRef.clientSaleId !== "string" || !UUID.test(evidence.voucherRef.clientSaleId))) ||
    !ref(evidence.voucherRef.voucherId)
  ) {
    throw new Phase9PosSaleRefusal("PHASE9_POS_EVIDENCE_INVALID");
  }
  const edit = evidence.edit;
  if (
    !edit ||
    typeof edit !== "object" ||
    Array.isArray(edit) ||
    Object.keys(edit).sort().join(",") !== EDIT_BODY_FIELDS.join(",") ||
    (edit.description !== null && (typeof edit.description !== "string" || edit.description.length > 2000)) ||
    typeof edit.isCreditSale !== "boolean" ||
    (edit.locationId !== null && !ref(edit.locationId)) ||
    (edit.paymentAccountId !== null && !ref(edit.paymentAccountId)) ||
    (edit.paymentAccountType !== null && !PAYMENT_TYPES.has(edit.paymentAccountType)) ||
    (edit.voucherDate !== null && !validDay(edit.voucherDate)) ||
    !Array.isArray(edit.items) ||
    edit.items.length < 1 ||
    edit.items.length > MAX_ITEMS
  ) {
    throw new Phase9PosSaleRefusal("PHASE9_POS_EVIDENCE_INVALID");
  }
  return {
    kind: PHASE9_POS_SALE_EDIT_KIND,
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    localVoucherId: evidence.localVoucherId,
    businessDate: evidence.businessDate,
    voucherRef: { clientSaleId: evidence.voucherRef.clientSaleId, voucherId: evidence.voucherRef.voucherId },
    edit: {
      description: edit.description,
      isCreditSale: edit.isCreditSale,
      locationId: edit.locationId,
      paymentAccountId: edit.paymentAccountId,
      paymentAccountType: edit.paymentAccountType,
      voucherDate: edit.voucherDate,
      items: edit.items.map(editLine),
    },
  };
}
