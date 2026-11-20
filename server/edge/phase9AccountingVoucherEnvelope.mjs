/**
 * Full offline mode: typed, immutable evidence for an accounting Sales or
 * Purchase voucher entered offline on a PC (POST /api/vouchers/with-entries,
 * the protected central path); one kind per voucher type. Only what that path accepts is accepted: an active (not
 * optional) USD voucher of at least two lines, each a debit or a credit with
 * at most two decimals. The cloud posts it through the same service as the
 * live route (server/services/accounting/centralGenericVoucherCreate.ts).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,2})?$/;
const RATE = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,12})?$/;
const MAX_REF = 2147483647;
const LINK_FIELDS = Object.freeze([
  "bankAccountId",
  "customerId",
  "employeeId",
  "factorySupplierId",
  "fixedAssetId",
  "ledgerAccountId",
  "supplierId",
]);

export const PHASE9_SALES_VOUCHER_KIND = "voucher.sales.v1";
export const PHASE9_PURCHASE_VOUCHER_KIND = "voucher.purchase.v1";
/** Voucher type -> its offline kind. */
export const PHASE9_ACCOUNTING_VOUCHER_KINDS = Object.freeze({
  Sales: PHASE9_SALES_VOUCHER_KIND,
  Purchase: PHASE9_PURCHASE_VOUCHER_KIND,
});

const FIELDS = Object.freeze([
  "actorUserId",
  "actorUsername",
  "companyId",
  "entries",
  "localVoucherId",
  "requestId",
  "voucher",
]);
const VOUCHER_FIELDS = Object.freeze(["description", "exchangeRate", "locationId", "voucherDate", "voucherType"]);
const ENTRY_FIELDS = Object.freeze([...LINK_FIELDS, "creditAmount", "debitAmount", "narration"].sort());

export class Phase9AccountingVoucherRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9AccountingVoucherRefusal";
  }
}

const ref = (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_REF;
const text = (value, max) => typeof value === "string" && value.length >= 1 && value.length <= max;
const keys = (value, list) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === list.join(",");

function validDay(date) {
  if (typeof date !== "string" || !DAY.test(date)) return false;
  const value = new Date(date + "T00:00:00.000Z");
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}

function refuse() {
  throw new Phase9AccountingVoucherRefusal("PHASE9_ACCOUNTING_VOUCHER_EVIDENCE_INVALID");
}

function entryOf(entry) {
  if (
    !keys(entry, ENTRY_FIELDS) ||
    typeof entry.debitAmount !== "string" ||
    !MONEY.test(entry.debitAmount) ||
    typeof entry.creditAmount !== "string" ||
    !MONEY.test(entry.creditAmount) ||
    (Number(entry.debitAmount) === 0) === (Number(entry.creditAmount) === 0) ||
    (entry.narration !== null && !text(entry.narration, 1000))
  ) {
    refuse();
  }
  const links = LINK_FIELDS.filter((field) => entry[field] !== null);
  if (links.length < 1 || links.some((field) => !ref(entry[field]))) refuse();
  return Object.fromEntries(ENTRY_FIELDS.map((field) => [field, entry[field]]));
}

/** The canonical voucher evidence of that type, or Phase9AccountingVoucherRefusal. */
function accountingVoucherEnvelope(evidence, voucherType) {
  const v = evidence?.voucher;
  if (
    !keys(evidence, FIELDS) ||
    !ref(evidence.companyId) ||
    !ref(evidence.localVoucherId) ||
    !text(evidence.actorUserId, 255) ||
    !text(evidence.actorUsername, 255) ||
    typeof evidence.requestId !== "string" ||
    !UUID.test(evidence.requestId) ||
    !keys(v, VOUCHER_FIELDS) ||
    v.voucherType !== voucherType ||
    !validDay(v.voucherDate) ||
    (v.description !== null && !text(v.description, 2000)) ||
    (v.locationId !== null && !ref(v.locationId)) ||
    (v.exchangeRate !== null && (typeof v.exchangeRate !== "string" || !RATE.test(v.exchangeRate))) ||
    !Array.isArray(evidence.entries) ||
    evidence.entries.length < 2 ||
    evidence.entries.length > 500
  ) {
    refuse();
  }
  return {
    kind: PHASE9_ACCOUNTING_VOUCHER_KINDS[voucherType],
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    localVoucherId: evidence.localVoucherId,
    voucher: {
      voucherType,
      voucherDate: v.voucherDate,
      description: v.description,
      locationId: v.locationId,
      exchangeRate: v.exchangeRate,
    },
    entries: evidence.entries.map(entryOf),
  };
}

export const phase9SalesVoucherEnvelope = (evidence) => accountingVoucherEnvelope(evidence, "Sales");
export const phase9PurchaseVoucherEnvelope = (evidence) => accountingVoucherEnvelope(evidence, "Purchase");
