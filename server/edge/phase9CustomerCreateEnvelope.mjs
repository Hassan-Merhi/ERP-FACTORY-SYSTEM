/**
 * Full offline mode (Phase C1): typed, immutable evidence for a customer
 * created offline on a PC (POST /api/customers).
 *
 * The PC gives the customer, and the ledger account it opens for it, local ids
 * (at or above PHASE9_PC_RECORD_ID_BASE). The cloud creates its own customer
 * through the live route's service and records which cloud customer and ledger
 * each local id became (server/edge/phase9PcRecordMap.mjs), so later entries
 * naming them resolve. Owner decision 2026-11-20: a customer that looks like
 * one the cloud already has is held for an Admin or Developer.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,2})?$/;
const MAX_REF = 2147483647;

export const PHASE9_PC_RECORD_ID_BASE = 1_000_000_000;
export const PHASE9_CUSTOMER_CREATE_KIND = "customer.create.v1";
/** Held when the cloud already has a customer with the same name or phone; approving creates it anyway. */
export const PHASE9_CUSTOMER_DUPLICATE_CONFLICT = "PHASE9_CUSTOMER_POSSIBLE_DUPLICATE";

const FIELDS = Object.freeze(
  [
    "actorUserId",
    "actorUsername",
    "businessDate",
    "companyId",
    "customer",
    "localCustomerId",
    "localLedgerAccountId",
    "requestId",
  ].sort()
);
const CUSTOMER_FIELDS = Object.freeze(
  [
    "active",
    "ledgerAccountId",
    "legalName",
    "openingBalance",
    "openingBalanceSide",
    "paymentTermsDays",
    "phone",
    "statementNote",
  ].sort()
);

export class Phase9CustomerCreateRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9CustomerCreateRefusal";
  }
}

const ref = (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_REF;
const localRef = (value) => ref(value) && value >= PHASE9_PC_RECORD_ID_BASE;
const text = (value, max) => typeof value === "string" && value.trim().length >= 1 && value.length <= max;
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
  throw new Phase9CustomerCreateRefusal("PHASE9_CUSTOMER_CREATE_EVIDENCE_INVALID");
}

/** The canonical evidence of a customer created on a PC, or Phase9CustomerCreateRefusal. */
export function phase9CustomerCreateEnvelope(evidence) {
  const c = evidence?.customer;
  if (
    !keys(evidence, FIELDS) ||
    !ref(evidence.companyId) ||
    !localRef(evidence.localCustomerId) ||
    (evidence.localLedgerAccountId !== null && !localRef(evidence.localLedgerAccountId)) ||
    !text(evidence.actorUserId, 255) ||
    !text(evidence.actorUsername, 255) ||
    typeof evidence.requestId !== "string" ||
    !UUID.test(evidence.requestId) ||
    !validDay(evidence.businessDate) ||
    !keys(c, CUSTOMER_FIELDS) ||
    !text(c.legalName, 500) ||
    (c.phone !== null && !text(c.phone, 100)) ||
    typeof c.openingBalance !== "string" ||
    !MONEY.test(c.openingBalance) ||
    (c.openingBalanceSide !== "Dr" && c.openingBalanceSide !== "Cr") ||
    typeof c.active !== "boolean" ||
    (c.statementNote !== null && !text(c.statementNote, 2000)) ||
    (c.paymentTermsDays !== null &&
      (!Number.isSafeInteger(c.paymentTermsDays) || c.paymentTermsDays < 1 || c.paymentTermsDays > 3650)) ||
    // Only a ledger the cloud already has: the PC opens no standalone ledgers.
    (c.ledgerAccountId !== null && (!ref(c.ledgerAccountId) || c.ledgerAccountId >= PHASE9_PC_RECORD_ID_BASE))
  ) {
    refuse();
  }
  return {
    kind: PHASE9_CUSTOMER_CREATE_KIND,
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    businessDate: evidence.businessDate,
    localCustomerId: evidence.localCustomerId,
    localLedgerAccountId: evidence.localLedgerAccountId,
    customer: Object.fromEntries(CUSTOMER_FIELDS.map((field) => [field, c[field]])),
  };
}
