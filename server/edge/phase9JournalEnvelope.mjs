/**
 * Full offline mode: typed, immutable evidence for a Journal voucher entered
 * offline (POST /api/vouchers/journal on a PC). The evidence is the journal's
 * inputs as entered; the cloud posts them through the same service as the
 * live route (server/services/accounting/journalVoucherPosting.ts), at the
 * rate the cloud approves for that date.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,6})?$/;
const RATE = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,12})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_REF = 2147483647;
const ACCOUNT_TYPES = new Set(["ledger", "customer", "bank", "supplier", "factorySupplier", "employee", "fixedAsset"]);

export const PHASE9_JOURNAL_KIND = "voucher.journal.v1";

const FIELDS = Object.freeze(["actorUserId", "actorUsername", "companyId", "journal", "localVoucherId", "requestId"]);
const JOURNAL_FIELDS = Object.freeze([
  "currency",
  "effectiveDate",
  "entries",
  "exchangeRate",
  "notes",
  "optional",
  "voucherDate",
]);
const ENTRY_FIELDS = Object.freeze(["accountId", "accountType", "amount", "narration", "type"]);

export class Phase9JournalRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9JournalRefusal";
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
  throw new Phase9JournalRefusal("PHASE9_JOURNAL_EVIDENCE_INVALID");
}

function journalInputs(journal) {
  if (
    !keys(journal, JOURNAL_FIELDS) ||
    !validDay(journal.voucherDate) ||
    (journal.notes !== null && !text(journal.notes, 2000)) ||
    typeof journal.optional !== "boolean" ||
    typeof journal.currency !== "string" ||
    !CURRENCY.test(journal.currency) ||
    (journal.currency === "USD"
      ? journal.exchangeRate !== null
      : journal.exchangeRate !== null &&
        (typeof journal.exchangeRate !== "string" || !RATE.test(journal.exchangeRate))) ||
    (journal.effectiveDate !== null && !validDay(journal.effectiveDate)) ||
    !Array.isArray(journal.entries) ||
    journal.entries.length < 2 ||
    journal.entries.length > 500
  ) {
    refuse();
  }
  const entries = journal.entries.map((entry) => {
    if (
      !keys(entry, ENTRY_FIELDS) ||
      (entry.type !== "DR" && entry.type !== "CR") ||
      !ACCOUNT_TYPES.has(entry.accountType) ||
      !ref(entry.accountId) ||
      typeof entry.amount !== "string" ||
      !MONEY.test(entry.amount) ||
      (entry.narration !== null && !text(entry.narration, 1000))
    ) {
      refuse();
    }
    return {
      type: entry.type,
      accountType: entry.accountType,
      accountId: entry.accountId,
      amount: entry.amount,
      narration: entry.narration,
    };
  });
  return {
    voucherDate: journal.voucherDate,
    entries,
    notes: journal.notes,
    optional: journal.optional,
    currency: journal.currency,
    exchangeRate: journal.exchangeRate,
    effectiveDate: journal.effectiveDate,
  };
}

/** The canonical journal evidence, or Phase9JournalRefusal. */
export function phase9JournalEnvelope(evidence) {
  if (
    !keys(evidence, FIELDS) ||
    !ref(evidence.companyId) ||
    !ref(evidence.localVoucherId) ||
    !text(evidence.actorUserId, 255) ||
    !text(evidence.actorUsername, 255) ||
    typeof evidence.requestId !== "string" ||
    !UUID.test(evidence.requestId)
  ) {
    refuse();
  }
  return {
    kind: PHASE9_JOURNAL_KIND,
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    localVoucherId: evidence.localVoucherId,
    journal: journalInputs(evidence.journal),
  };
}
