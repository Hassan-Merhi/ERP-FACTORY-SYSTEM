/**
 * Full offline mode: cloud apply handlers for `voucher.sales.v1` and
 * `voucher.purchase.v1`, accounting Sales and Purchase vouchers entered offline
 * on a PC (one handler per voucher type, otherwise identical).
 *
 * Posts it through the same service as the live central route
 * (postCentralGenericVoucherTx), on the SAME transaction as the receipt, with
 * a client request id derived from the operation, so a replay posts nothing.
 * A refusal by the posting code (a closed period, an account or customer
 * missing in the cloud, an unbalanced voucher, a ledger that does not match
 * the customer's linked ledger) is a conflict that can only be rejected; the
 * cloud keeps its state.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import * as schema from "@shared/schema";
import type { DbTransaction } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { getCurrentExchangeRate } from "../routes/_helpers";
import { postCentralGenericVoucherTx } from "../services/accounting/centralGenericVoucherCreate";
import { PostingValidationError } from "../services/accounting/postingValidationError";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import type {
  Phase9AccountingVoucherEntry,
  Phase9AccountingVoucherHeader,
  Phase9AccountingVoucherType,
} from "./phase9AccountingVoucherEnvelope.mjs";
import { throwIfClosedPeriod } from "./phase9ClosedPeriod";

type Queryable = Pick<PoolClient, "query">;

export interface Phase9AccountingVoucherEvent {
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
    localVoucherId: number;
    voucher: Phase9AccountingVoucherHeader;
    entries: Phase9AccountingVoucherEntry[];
  };
  payloadSha256: string;
}

export interface Phase9AccountingVoucherApplyResult {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const NOT_PERMITTED_ROLES = new Set(["View Only", "Create Only", "ERP Tester", "POS"]);

/** The live route is requireNonPOS; re-checked against CURRENT cloud access. */
async function authorize(client: Queryable, event: Phase9AccountingVoucherEvent): Promise<void> {
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

async function apply(
  voucherType: Phase9AccountingVoucherType,
  client: Queryable,
  event: Phase9AccountingVoucherEvent
): Promise<Phase9AccountingVoucherApplyResult> {
  const p = event.payload;
  const tx = drizzle(client as PoolClient, { schema }) as unknown as DbTransaction;
  try {
    // As the live route: the rate entered, else the company's current rate.
    const currentRate = p.voucher.exchangeRate === null ? await getCurrentExchangeRate(event.companyId) : null;
    const { posted } = await postCentralGenericVoucherTx(tx, {
      companyId: event.companyId,
      clientRequestId: `pc-${event.operationId}`,
      voucher: { ...p.voucher, currency: "USD", optional: false },
      entries: p.entries as unknown as Array<Record<string, unknown>>,
      exchangeRate: p.voucher.exchangeRate ?? (currentRate != null ? String(currentRate) : null),
      actor: {
        userId: event.actorUserId,
        username: p.actorUsername,
        reason: `${voucherType} voucher entered offline`,
      },
    });
    return {
      outcome: posted.replayed ? "already-present" : "cloud-applied",
      cloudRef: Number(posted.voucher.id),
      businessDate: p.voucher.voucherDate,
    };
  } catch (error) {
    throwIfClosedPeriod(error);
    // Business refusals need a decision; anything else (a dropped connection,
    // a deadlock) is retried by the next apply run.
    const message = getErrorMessage(error);
    if (error instanceof PostingValidationError || /not found in (current )?company/i.test(message)) {
      throw new Phase9EventConflict(`PHASE9_${voucherType.toUpperCase()}_VOUCHER_REFUSED`, { message });
    }
    throw error;
  }
}

async function verify(
  voucherType: Phase9AccountingVoucherType,
  client: Queryable,
  event: Phase9AccountingVoucherEvent,
  result: Phase9AccountingVoucherApplyResult
): Promise<boolean> {
  const check = await client.query(
    `SELECT 1 FROM vouchers
      WHERE id = $1 AND company_id = $2 AND voucher_type = $4 AND voucher_date = $3::date`,
    [result.cloudRef, event.companyId, result.businessDate, voucherType]
  );
  return check.rows.length === 1;
}

function handlerFor(voucherType: Phase9AccountingVoucherType) {
  return Object.freeze({
    authorize,
    apply: (client: Queryable, event: Phase9AccountingVoucherEvent) => apply(voucherType, client, event),
    verify: (client: Queryable, event: Phase9AccountingVoucherEvent, result: Phase9AccountingVoucherApplyResult) =>
      verify(voucherType, client, event, result),
  });
}

export const phase9SalesVoucherApplyHandler = handlerFor("Sales");
export const phase9PurchaseVoucherApplyHandler = handlerFor("Purchase");
