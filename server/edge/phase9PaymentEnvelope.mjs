/**
 * Phase 9: typed, immutable LAN evidence for a Payment / Receipt voucher
 * created on the factory LAN server (POST /api/vouchers/payment-receipt):
 * supplier, customer, employee and bank payments and receipts.
 *
 * Owner policy (2026-11-02): supplier and customer payments and bank
 * movements may be recorded offline. The evidence is the voucher's inputs as
 * entered, with the exchange rate the LAN resolved (the rate the user posted
 * at); the cloud replays them through the same posting code at that rate.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,6})?$/;
const RATE = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,12})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_REF = 2147483647;
const ACCOUNT_TYPES = new Set(["ledger", "customer", "bank", "supplier", "factorySupplier", "employee", "fixedAsset"]);

export const PHASE9_PAYMENT_KIND = "voucher.payment-receipt.v1";

const INPUT_FIELDS = Object.freeze([
  "actorUserId",
  "actorUsername",
  "companyId",
  "localVoucherId",
  "requestId",
  "voucher",
]);
const VOUCHER_FIELDS = Object.freeze([
  "currency",
  "effectiveDate",
  "entries",
  "exchangeRate",
  "notes",
  "optional",
  "paymentAccountId",
  "paymentAccountType",
  "voucherDate",
  "voucherType",
]);

export class Phase9PaymentRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9PaymentRefusal";
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

function voucherInputs(voucher) {
  if (
    !keys(voucher, VOUCHER_FIELDS) ||
    (voucher.voucherType !== "Payment" && voucher.voucherType !== "Receipt") ||
    !validDay(voucher.voucherDate) ||
    !ACCOUNT_TYPES.has(voucher.paymentAccountType) ||
    !ref(voucher.paymentAccountId) ||
    (voucher.notes !== null && !text(voucher.notes, 2000)) ||
    typeof voucher.optional !== "boolean" ||
    typeof voucher.currency !== "string" ||
    !CURRENCY.test(voucher.currency) ||
    (voucher.currency === "USD"
      ? voucher.exchangeRate !== null
      : typeof voucher.exchangeRate !== "string" || !RATE.test(voucher.exchangeRate)) ||
    (voucher.effectiveDate !== null && !validDay(voucher.effectiveDate)) ||
    !Array.isArray(voucher.entries) ||
    voucher.entries.length < 1 ||
    voucher.entries.length > 200
  ) {
    throw new Phase9PaymentRefusal("PHASE9_PAYMENT_EVIDENCE_INVALID");
  }
  const entries = voucher.entries.map((entry) => {
    if (
      !keys(entry, ["accountId", "accountType", "amount"]) ||
      !ACCOUNT_TYPES.has(entry.accountType) ||
      !ref(entry.accountId) ||
      typeof entry.amount !== "string" ||
      !MONEY.test(entry.amount)
    ) {
      throw new Phase9PaymentRefusal("PHASE9_PAYMENT_EVIDENCE_INVALID");
    }
    return { accountType: entry.accountType, accountId: entry.accountId, amount: entry.amount };
  });
  return {
    voucherType: voucher.voucherType,
    voucherDate: voucher.voucherDate,
    paymentAccountType: voucher.paymentAccountType,
    paymentAccountId: voucher.paymentAccountId,
    entries,
    notes: voucher.notes,
    optional: voucher.optional,
    currency: voucher.currency,
    exchangeRate: voucher.exchangeRate,
    effectiveDate: voucher.effectiveDate,
  };
}

export function phase9PaymentEnvelope(evidence) {
  if (
    !keys(evidence, INPUT_FIELDS) ||
    !ref(evidence.companyId) ||
    !ref(evidence.localVoucherId) ||
    !text(evidence.actorUserId, 255) ||
    !text(evidence.actorUsername, 255) ||
    typeof evidence.requestId !== "string" ||
    !UUID.test(evidence.requestId)
  ) {
    throw new Phase9PaymentRefusal("PHASE9_PAYMENT_EVIDENCE_INVALID");
  }
  return {
    kind: PHASE9_PAYMENT_KIND,
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    localVoucherId: evidence.localVoucherId,
    voucher: voucherInputs(evidence.voucher),
  };
}

// ---- Plan batch 4 (owner-approved 2026-11-05): offline edit and delete ----
//
// Each names its voucher by the LAN record that created it ({origin: "lan"})
// or by its shared pre-outage id ({origin: "cloud"}), and carries the SHA-256
// of the voucher as the factory saw it (server/edge/phase9PaymentSnapshot.ts).

export const PHASE9_PAYMENT_EDIT_KIND = "voucher.payment-receipt-edit.v1";
export const PHASE9_PAYMENT_DELETE_KIND = "voucher.payment-receipt-delete.v1";
/** Overridable: the cloud voucher changed after the factory saw it; approve = the factory's change wins. */
export const PHASE9_PAYMENT_CHANGED_CONFLICT = "PHASE9_PAYMENT_CHANGED";

const SHA = /^[0-9a-f]{64}$/;
const FOLLOW_UP_FIELDS = [
  "actorUserId",
  "actorUsername",
  "beforeSha256",
  "companyId",
  "localVoucherId",
  "requestId",
  "voucherRef",
];

function voucherRef(value) {
  if (keys(value, ["localVoucherId", "origin"]) && value.origin === "lan" && ref(value.localVoucherId)) {
    return { origin: "lan", localVoucherId: value.localVoucherId };
  }
  if (keys(value, ["origin", "voucherId"]) && value.origin === "cloud" && ref(value.voucherId)) {
    return { origin: "cloud", voucherId: value.voucherId };
  }
  return null;
}

function followUp(evidence, fields, code) {
  if (
    !keys(evidence, [...fields].sort()) ||
    !ref(evidence.companyId) ||
    !ref(evidence.localVoucherId) ||
    !text(evidence.actorUserId, 255) ||
    !text(evidence.actorUsername, 255) ||
    typeof evidence.requestId !== "string" ||
    !UUID.test(evidence.requestId) ||
    typeof evidence.beforeSha256 !== "string" ||
    !SHA.test(evidence.beforeSha256)
  ) {
    throw new Phase9PaymentRefusal(code);
  }
  const target = voucherRef(evidence.voucherRef);
  if (!target) throw new Phase9PaymentRefusal(code);
  return {
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    localVoucherId: evidence.localVoucherId,
    voucherRef: target,
    beforeSha256: evidence.beforeSha256,
  };
}

export function phase9PaymentEditEnvelope(evidence) {
  const code = "PHASE9_PAYMENT_EDIT_EVIDENCE_INVALID";
  const base = followUp(evidence, [...FOLLOW_UP_FIELDS, "voucher"], code);
  let voucher;
  try {
    voucher = voucherInputs(evidence.voucher);
  } catch {
    throw new Phase9PaymentRefusal(code);
  }
  return { kind: PHASE9_PAYMENT_EDIT_KIND, ...base, voucher };
}

export function phase9PaymentDeleteEnvelope(evidence) {
  return {
    kind: PHASE9_PAYMENT_DELETE_KIND,
    ...followUp(evidence, FOLLOW_UP_FIELDS, "PHASE9_PAYMENT_DELETE_EVIDENCE_INVALID"),
  };
}
