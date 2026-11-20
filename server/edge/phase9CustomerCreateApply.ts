/**
 * Full offline mode (Phase C1): cloud apply handler for `customer.create.v1`,
 * a customer created offline on a PC.
 *
 * The cloud creates its own customer (and receivable ledger) through the live
 * route's service (createCustomerTx), on the SAME transaction as the receipt,
 * and records which cloud customer and ledger the PC's local ids became, so a
 * replay creates nothing and later entries from that PC naming them resolve
 * (server/edge/phase9PcRecordMap.mjs).
 *
 * Owner decision 2026-11-20: a customer that looks like one the cloud already
 * has (same name, or same phone) is held, never created silently. An Admin or
 * Developer approving PHASE9_CUSTOMER_POSSIBLE_DUPLICATE creates it as a new
 * customer.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import * as schema from "@shared/schema";
import type { DbTransaction } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { createCustomerTx } from "../routes/customers/customerService";
import { CustomerRouteError } from "../routes/customers/customerErrors";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import {
  PHASE9_CUSTOMER_DUPLICATE_CONFLICT,
  type Phase9CustomerCreateFields,
} from "./phase9CustomerCreateEnvelope.mjs";
import {
  PHASE9_PC_RECORD_TYPES,
  readPhase9PcRecordMapping,
  recordPhase9PcRecordMapping,
} from "./phase9PcRecordMap.mjs";

type Queryable = Pick<PoolClient, "query">;

export interface Phase9CustomerCreateEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  payload: {
    requestId: string;
    companyId: number;
    actorUserId: string;
    actorUsername: string;
    businessDate: string;
    localCustomerId: number;
    localLedgerAccountId: number | null;
    customer: Phase9CustomerCreateFields;
  };
  payloadSha256: string;
}

export interface Phase9CustomerCreateResult {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

type Context = { readonly overrideConflicts: readonly string[]; readonly siteId?: string };

// The live route is requireNonPOS with a verified create for Create Only; the
// replay cannot repeat that verification, so Create Only is held as well.
const NOT_PERMITTED_ROLES = new Set(["View Only", "Create Only", "ERP Tester", "POS"]);
const PHONE_DIGITS_MIN = 7;
const PHONE_KEY_DIGITS = 9;

async function authorize(client: Queryable, event: Phase9CustomerCreateEvent): Promise<void> {
  const access = await client.query(
    `SELECT u.active, r.role, r.pos_view_only
       FROM users u
       JOIN user_company_roles r ON r.user_id = u.id AND r.company_id = $2
      WHERE u.id = $1`,
    [event.actorUserId, event.companyId]
  );
  const row = access.rows[0];
  if (!row || row.active !== true) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ACCESS_REVOKED", { actorUserId: event.actorUserId });
  }
  if (row.pos_view_only === true || NOT_PERMITTED_ROLES.has(String(row.role))) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", {
      actorUserId: event.actorUserId,
      role: String(row.role),
    });
  }
}

/**
 * Cloud customers with the same name (ignoring case and spaces), or the same
 * phone: the same last 9 digits, so "+260 977 123 456" matches "0977 123 456".
 */
async function lookalikes(client: Queryable, companyId: number, customer: Phase9CustomerCreateFields) {
  const digits = (customer.phone ?? "").replace(/\D/g, "");
  const phoneKey = digits.length >= PHONE_DIGITS_MIN ? digits.slice(-PHONE_KEY_DIGITS) : "";
  const found = await client.query(
    `SELECT id, code, legal_name, phone FROM customers
      WHERE company_id = $1 AND deleted_at IS NULL
        AND (lower(btrim(legal_name)) = lower(btrim($2))
             OR ($3::text <> '' AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), length($3::text)) = $3::text))
      ORDER BY id LIMIT 5`,
    [companyId, customer.legalName, phoneKey]
  );
  return found.rows.map((row) => ({
    customerId: Number(row.id),
    code: String(row.code),
    legalName: String(row.legal_name),
    phone: row.phone == null ? null : String(row.phone),
  }));
}

async function apply(
  client: Queryable,
  event: Phase9CustomerCreateEvent,
  context: Context = { overrideConflicts: [] }
): Promise<Phase9CustomerCreateResult> {
  const p = event.payload;
  if (!context.siteId) throw new Error("PHASE9_PC_RECORD_SITE_MISSING");
  const mapped = await readPhase9PcRecordMapping(
    client,
    context.siteId,
    PHASE9_PC_RECORD_TYPES.customer,
    p.localCustomerId
  );
  if (mapped !== null) return { outcome: "already-present", cloudRef: mapped, businessDate: p.businessDate };

  // Serialise creates per company so a look-alike and the next code cannot race.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('phase9-customer-create'), $1)", [event.companyId]);
  if (!context.overrideConflicts.includes(PHASE9_CUSTOMER_DUPLICATE_CONFLICT)) {
    const candidates = await lookalikes(client, event.companyId, p.customer);
    if (candidates.length) {
      throw new Phase9EventConflict(PHASE9_CUSTOMER_DUPLICATE_CONFLICT, {
        legalName: p.customer.legalName,
        phone: p.customer.phone,
        candidates,
      });
    }
  }

  const tx = drizzle(client as PoolClient, { schema }) as unknown as DbTransaction;
  const { ledgerAccountId, ...fields } = p.customer;
  let created: schema.Customer;
  try {
    created = await createCustomerTx(
      tx,
      event.companyId,
      { ...fields, ...(ledgerAccountId === null ? {} : { ledgerAccountId }) },
      { userId: event.actorUserId, username: p.actorUsername }
    );
  } catch (error) {
    // A refusal by the customer service (e.g. a linked ledger the cloud does
    // not have) needs a decision; anything else is retried.
    if (error instanceof CustomerRouteError) {
      throw new Phase9EventConflict("PHASE9_CUSTOMER_CREATE_REFUSED", { message: getErrorMessage(error) });
    }
    throw error;
  }
  const mapping = { siteId: context.siteId, companyId: event.companyId, operationId: event.operationId };
  await recordPhase9PcRecordMapping(client, {
    ...mapping,
    recordType: PHASE9_PC_RECORD_TYPES.customer,
    localId: p.localCustomerId,
    cloudId: created.id,
  });
  if (p.localLedgerAccountId !== null) {
    if (created.ledgerAccountId == null) {
      throw new Phase9EventConflict("PHASE9_CUSTOMER_CREATE_REFUSED", { message: "No ledger account was opened" });
    }
    await recordPhase9PcRecordMapping(client, {
      ...mapping,
      recordType: PHASE9_PC_RECORD_TYPES.ledger,
      localId: p.localLedgerAccountId,
      cloudId: created.ledgerAccountId,
    });
  }
  return { outcome: "cloud-applied", cloudRef: created.id, businessDate: p.businessDate };
}

async function verify(
  client: Queryable,
  event: Phase9CustomerCreateEvent,
  result: Phase9CustomerCreateResult
): Promise<boolean> {
  const row = await client.query(
    `SELECT c.legal_name FROM factory_edge_pc_record_map m
       JOIN customers c ON c.id = m.cloud_id
      WHERE m.record_type = 'customer' AND m.local_id = $1 AND m.cloud_id = $2 AND c.company_id = $3`,
    [event.payload.localCustomerId, result.cloudRef, event.companyId]
  );
  return row.rows.length === 1 && String(row.rows[0].legal_name) === event.payload.customer.legalName;
}

export const phase9CustomerCreateApplyHandler = Object.freeze({ authorize, apply, verify });
