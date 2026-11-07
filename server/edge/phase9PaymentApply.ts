/**
 * Phase 9 cloud apply handler for `voucher.payment-receipt.v1`.
 *
 * Replays a factory LAN Payment / Receipt (supplier, customer, employee or
 * bank) through the same posting code as the live route
 * (postPaymentReceiptVoucherTx), on the SAME transaction as the Phase 9
 * receipt, at the exchange rate the LAN posted at. Any refusal by the posting
 * code (a closed period, a party or account missing in the cloud, an invalid
 * amount) is a conflict that can only be rejected; the cloud keeps its state.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import * as schema from "@shared/schema";
import type { DbTransaction } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import {
  PaymentReceiptInputError,
  postPaymentReceiptVoucherTx,
} from "../services/accounting/paymentReceiptVoucherPosting";
import { PostingValidationError } from "../services/accounting/postingValidationError";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import type { Phase9PaymentVoucherInputs } from "./phase9PaymentEnvelope.mjs";
import { throwIfClosedPeriod } from "./phase9ClosedPeriod";

type Queryable = Pick<PoolClient, "query">;

export interface Phase9PaymentEvent {
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
    voucher: Phase9PaymentVoucherInputs;
  };
  payloadSha256: string;
}

export interface Phase9PaymentApplyResult {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const NOT_PERMITTED_ROLES = new Set(["View Only", "Create Only", "ERP Tester", "POS"]);

/** The live route is requireNonPOS; re-checked against CURRENT cloud access. */
async function authorize(client: Queryable, event: Phase9PaymentEvent): Promise<void> {
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

async function apply(client: Queryable, event: Phase9PaymentEvent): Promise<Phase9PaymentApplyResult> {
  const v = event.payload.voucher;
  const tx = drizzle(client as PoolClient, { schema }) as unknown as DbTransaction;
  try {
    const posted = await postPaymentReceiptVoucherTx(tx, {
      companyId: event.companyId,
      voucherType: v.voucherType,
      voucherDate: v.voucherDate,
      paymentAccountType: v.paymentAccountType,
      paymentAccountId: v.paymentAccountId,
      entries: v.entries,
      notes: v.notes,
      optional: v.optional,
      currency: v.currency,
      exchangeRate: v.exchangeRate,
      effectiveDate: v.effectiveDate,
      sourceId: `${event.companyId}:edge-${event.operationId}`,
      actor: { userId: event.actorUserId, username: event.payload.actorUsername },
      reason: `${v.voucherType} replayed from the factory LAN server`,
    });
    return {
      outcome: posted.replayed ? "already-present" : "cloud-applied",
      cloudRef: Number(posted.voucher.id),
      businessDate: v.voucherDate,
    };
  } catch (error) {
    throwIfClosedPeriod(error);
    // Business refusals need a decision; anything else (a dropped connection,
    // a deadlock) is retried by the next apply run.
    const message = getErrorMessage(error);
    if (
      error instanceof PostingValidationError ||
      error instanceof PaymentReceiptInputError ||
      /not found in current company/i.test(message)
    ) {
      throw new Phase9EventConflict("PHASE9_PAYMENT_REFUSED", { message });
    }
    throw error;
  }
}

async function verify(
  client: Queryable,
  event: Phase9PaymentEvent,
  result: Phase9PaymentApplyResult
): Promise<boolean> {
  const check = await client.query(
    `SELECT 1 FROM vouchers
      WHERE id = $1 AND company_id = $2 AND voucher_type = $3 AND voucher_date = $4::date`,
    [result.cloudRef, event.companyId, event.payload.voucher.voucherType, result.businessDate]
  );
  return check.rows.length === 1;
}

export const phase9PaymentApplyHandler = Object.freeze({ authorize, apply, verify });
