/**
 * Full offline mode (Phase C1): the cloud's record of which cloud customer and
 * ledger account each record a PC created offline became, and the translation
 * every later entry from that PC goes through before its handler runs.
 *
 * A PC gives the rows it creates ids at or above PHASE9_PC_RECORD_ID_BASE. In
 * an entry from that PC, such an id is replaced by the cloud's where it names
 * a customer (`customerId`, or an `accountType: "customer"` account) or a
 * ledger account (`ledgerAccountId`, an `accountType: "ledger"` account, or a
 * POS sale's `credit` / `cash` payment account, which are ledger accounts).
 * One the cloud has not created yet makes the apply wait
 * (Phase9PcRecordNotYetSynced, no conflict recorded); the customer's own create
 * comes first on the same stream.
 *
 * The map is filed per PC (`site_id`: the PC's record key, shared by everyone
 * using it, or the delivery device id without one) and always read for one
 * company only, so one company's rows never translate another's entries.
 */
import { Phase9ApplyRefusal } from "./ensurePhase9CloudEventSchema.mjs";
import { PHASE9_PC_RECORD_ID_BASE } from "./phase9CustomerCreateEnvelope.mjs";

export const PHASE9_PC_RECORD_TYPES = Object.freeze({ customer: "customer", ledger: "ledger_account" });

const ID_KEYS = Object.freeze({ customerId: "customer", ledgerAccountId: "ledger_account" });
const ACCOUNT_PAIRS = Object.freeze([
  ["accountType", "accountId"],
  ["paymentAccountType", "paymentAccountId"],
]);
// POS sales pay into a ledger account for "cash" and "credit" (a customer's
// receivable); "bank" names a bank account, which a PC does not create.
const ACCOUNT_TYPES = Object.freeze({
  customer: "customer",
  ledger: "ledger_account",
  cash: "ledger_account",
  credit: "ledger_account",
});

export class Phase9PcRecordNotYetSynced extends Error {
  constructor(missing) {
    super("PHASE9_PC_RECORD_NOT_YET_SYNCED");
    this.name = "Phase9PcRecordNotYetSynced";
    this.missing = missing;
  }
}

const isLocal = (value) => Number.isSafeInteger(value) && value >= PHASE9_PC_RECORD_ID_BASE;
const mapKey = (type, id) => `${type}:${id}`;

/** Every [record type, field] of this object that names a PC-made record. */
function localFields(object) {
  const found = [];
  for (const [field, type] of Object.entries(ID_KEYS)) {
    if (isLocal(object[field])) found.push([type, field]);
  }
  for (const [typeField, idField] of ACCOUNT_PAIRS) {
    const type = ACCOUNT_TYPES[object[typeField]];
    if (type && isLocal(object[idField])) found.push([type, idField]);
  }
  return found;
}

/**
 * The PC's own records an entry names, as "customer:<id>" / "ledger_account:<id>",
 * in its finished envelope or in the person's input: a POS sale's input names
 * its ledger as `cashAccountId`, or as `paymentAccountId` of a credit sale.
 */
export function phase9PcRecordReferences(value) {
  const out = new Map();
  collect(value, out);
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (isLocal(node.cashAccountId)) out.set(mapKey("ledger_account", node.cashAccountId), null);
    if (node.isCreditSale === true && isLocal(node.paymentAccountId)) {
      out.set(mapKey("ledger_account", node.paymentAccountId), null);
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  return new Set(out.keys());
}

function collect(value, out) {
  if (Array.isArray(value)) {
    for (const entry of value) collect(entry, out);
  } else if (value && typeof value === "object") {
    for (const [type, field] of localFields(value)) out.set(mapKey(type, value[field]), [type, value[field]]);
    for (const entry of Object.values(value)) collect(entry, out);
  }
}

function replace(value, map) {
  if (Array.isArray(value)) return value.map((entry) => replace(entry, map));
  if (!value || typeof value !== "object") return value;
  const swapped = Object.fromEntries(
    localFields(value).map(([type, field]) => [field, map.get(mapKey(type, value[field]))])
  );
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, key in swapped ? swapped[key] : replace(entry, map)])
  );
}

/** The event as the handler sees it: this PC's local customer and ledger ids replaced by the cloud's. */
export async function translatePhase9PcRecords(queryable, siteId, event) {
  const wanted = new Map();
  collect(event.payload, wanted);
  if (!wanted.size) return event;
  const rows = await queryable.query(
    `SELECT record_type, local_id, cloud_id FROM factory_edge_pc_record_map
      WHERE site_id = $1::uuid AND company_id = $2 AND local_id = ANY($3::int[])`,
    [siteId, event.companyId, [...new Set([...wanted.values()].map(([, id]) => id))]]
  );
  const map = new Map(rows.rows.map((row) => [mapKey(row.record_type, Number(row.local_id)), Number(row.cloud_id)]));
  const missing = [...wanted.keys()].filter((key) => !map.has(key));
  if (missing.length) throw new Phase9PcRecordNotYetSynced(missing);
  return { ...event, payload: replace(event.payload, map) };
}

/**
 * The cloud id a PC's local record became, or null. A row filed under the same
 * key by another company is never answered: it is refused, as the key is not
 * that company's.
 */
export async function readPhase9PcRecordMapping(queryable, siteId, companyId, recordType, localId) {
  const row = await queryable.query(
    `SELECT cloud_id, company_id FROM factory_edge_pc_record_map
      WHERE site_id = $1::uuid AND record_type = $2 AND local_id = $3`,
    [siteId, recordType, localId]
  );
  if (!row.rows.length) return null;
  if (Number(row.rows[0].company_id) !== companyId) throw new Phase9ApplyRefusal("PHASE9_PC_RECORD_KEY_FOREIGN");
  return Number(row.rows[0].cloud_id);
}

export async function recordPhase9PcRecordMapping(queryable, input) {
  await queryable.query(
    `INSERT INTO factory_edge_pc_record_map (site_id, record_type, local_id, cloud_id, company_id, operation_id)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid)`,
    [input.siteId, input.recordType, input.localId, input.cloudId, input.companyId, input.operationId]
  );
}
