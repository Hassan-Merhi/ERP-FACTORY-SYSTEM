/**
 * Phase 9 cloud apply handlers for plan batch 4 (owner-approved 2026-11-05):
 * Payment / Receipt vouchers edited or deleted on the factory LAN server
 * (voucher.payment-receipt-edit.v1, voucher.payment-receipt-delete.v1).
 *
 * Each finds its cloud voucher in one of two ways: through the applied receipt
 * of the offline record that created it, or by its shared id when it existed
 * before the outage. It applies only while the voucher is still what the
 * factory saw (the same SHA-256 the LAN recorded), then runs the same code as
 * the live route on the Phase 9 transaction. The edit reposts at the
 * factory's rate.
 *
 * A record is never applied silently:
 * - a voucher changed in the cloud is held as PHASE9_PAYMENT_CHANGED; an
 *   Admin/Developer approves (the factory's change wins) or rejects it;
 * - a reconciled voucher (PHASE9_PAYMENT_RECONCILED), an intercompany
 *   transfer leg (PHASE9_PAYMENT_INTERCOMPANY), a closed period, or any other
 *   refusal of the posting code can only be rejected.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import * as schema from "@shared/schema";
import type { DbTransaction } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { applyPaymentReceiptEditTx, paymentReceiptEditPlan } from "../services/accounting/paymentReceiptVoucherEdit";
import { deleteVoucherTx } from "../routes/voucher-entries/delete";
import { intercompanyTransferOfVoucher } from "../services/accounting/intercompanyTransferLegGuard";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import {
  PHASE9_PAYMENT_CHANGED_CONFLICT,
  PHASE9_PAYMENT_KIND,
  type Phase9PaymentDeleteEvidence,
  type Phase9PaymentEditEvidence,
  type Phase9PaymentVoucherRef,
} from "./phase9PaymentEnvelope.mjs";
import { phase9PaymentReconciledTx, phase9PaymentSnapshotTx } from "./phase9PaymentSnapshot";
import { throwIfClosedPeriod } from "./phase9ClosedPeriod";

type Queryable = Pick<PoolClient, "query">;
type Context = { readonly overrideConflicts: readonly string[]; readonly siteId: string };

interface FollowUpEvent<P> {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  payload: { kind: string } & { [K in keyof P]: P[K] };
  payloadSha256: string;
}
export type Phase9PaymentEditEvent = FollowUpEvent<Phase9PaymentEditEvidence>;
export type Phase9PaymentDeleteEvent = FollowUpEvent<Phase9PaymentDeleteEvidence>;

interface Result {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const NOT_PERMITTED_ROLES = new Set(["View Only", "Create Only", "ERP Tester", "POS"]);

function txOf(client: Queryable): DbTransaction {
  return drizzle(client as PoolClient, { schema }) as unknown as DbTransaction;
}

/**
 * CURRENT cloud access: the edit route is non-POS, the delete route is Admin
 * only. A user who lost that access during the outage is refused.
 */
async function authorizeActor(
  client: Queryable,
  event: { actorUserId: string; companyId: number },
  adminOnly: boolean
) {
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
  const role = String(row.role);
  const permitted = adminOnly ? role === "Admin" : !NOT_PERMITTED_ROLES.has(role) && row.pos_view_only !== true;
  if (!permitted) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", { actorUserId: event.actorUserId, role });
  }
}

/** The cloud voucher id: through the create's receipt (offline voucher) or the shared id. */
async function cloudVoucherId(
  client: Queryable,
  siteId: string,
  companyId: number,
  ref: Phase9PaymentVoucherRef
): Promise<number> {
  if (ref.origin === "cloud") return ref.voucherId;
  const created = await client.query(
    `SELECT cloud_ref FROM factory_edge_applied_events
      WHERE site_id = $1::uuid AND stream = 'payments' AND operation_kind = $2 AND local_ref = $3
        AND company_id = $4 AND outcome <> 'rejected-conflict'`,
    [siteId, PHASE9_PAYMENT_KIND, ref.localVoucherId, companyId]
  );
  if (created.rows.length !== 1) throw new Phase9EventConflict("PHASE9_PAYMENT_MISSING", { voucher: ref });
  return Number(created.rows[0].cloud_ref);
}

/** Lock the voucher and hold the record unless the cloud copy is what the factory saw (or the decision says so). */
async function holdUnlessUnchanged(
  client: Queryable,
  event: { companyId: number; payload: { voucherRef: Phase9PaymentVoucherRef; beforeSha256: string } },
  voucherId: number,
  context: Context
): Promise<void> {
  const tx = txOf(client);
  const current = await phase9PaymentSnapshotTx(tx, event.companyId, voucherId);
  if (current === null) {
    throw new Phase9EventConflict("PHASE9_PAYMENT_MISSING", { voucher: event.payload.voucherRef, voucherId });
  }
  if (await intercompanyTransferOfVoucher(voucherId, tx)) {
    throw new Phase9EventConflict("PHASE9_PAYMENT_INTERCOMPANY", { voucherId });
  }
  if (await phase9PaymentReconciledTx(tx, event.companyId, voucherId)) {
    throw new Phase9EventConflict("PHASE9_PAYMENT_RECONCILED", { voucherId });
  }
  if (current !== event.payload.beforeSha256 && !context.overrideConflicts.includes(PHASE9_PAYMENT_CHANGED_CONFLICT)) {
    throw new Phase9EventConflict(PHASE9_PAYMENT_CHANGED_CONFLICT, {
      voucherId,
      factorySaw: event.payload.beforeSha256,
      cloudHas: current,
    });
  }
}

/** A refusal by the posting code needs a decision; a database failure is retried by the next run. */
function refusal(error: unknown, code: string): never {
  if (error instanceof Phase9EventConflict) throw error;
  throwIfClosedPeriod(error);
  const sqlState = (error as { code?: unknown } | null)?.code;
  if (typeof sqlState === "string" && /^[0-9A-Z]{5}$/.test(sqlState)) throw error;
  if (!(error instanceof Error)) throw error;
  throw new Phase9EventConflict(code, { message: getErrorMessage(error) });
}

async function voucherRow(client: Queryable, companyId: number, voucherId: number) {
  const found = await client.query(
    `SELECT id, voucher_type AS "voucherType", voucher_date::text AS "voucherDate", optional,
            currency, exchange_rate AS "exchangeRate", deleted_at AS "deletedAt"
       FROM vouchers WHERE id = $1 AND company_id = $2`,
    [voucherId, companyId]
  );
  return found.rows[0] as
    | {
        id: number;
        voucherType: string;
        voucherDate: string;
        optional: boolean;
        currency: string | null;
        exchangeRate: string | null;
        deletedAt: Date | null;
      }
    | undefined;
}

// ---- voucher.payment-receipt-edit.v1 ----------------------------------------

async function applyEdit(client: Queryable, event: Phase9PaymentEditEvent, context: Context): Promise<Result> {
  const p = event.payload;
  const voucherId = await cloudVoucherId(client, context.siteId, event.companyId, p.voucherRef);
  await holdUnlessUnchanged(client, event, voucherId, context);
  const prior = await voucherRow(client, event.companyId, voucherId);
  try {
    const plan = prior ? paymentReceiptEditPlan(prior, p.voucher) : null;
    if (!plan) throw new Error("Invalid amount");
    await applyPaymentReceiptEditTx(txOf(client), {
      companyId: event.companyId,
      voucherId,
      body: p.voucher,
      plan,
      actor: { userId: event.actorUserId, username: p.actorUsername },
    });
  } catch (error) {
    refusal(error, "PHASE9_PAYMENT_EDIT_REFUSED");
  }
  return { outcome: "cloud-applied", cloudRef: voucherId, businessDate: p.voucher.voucherDate };
}

async function verifyEdit(client: Queryable, event: Phase9PaymentEditEvent, result: Result): Promise<boolean> {
  const row = await voucherRow(client, event.companyId, result.cloudRef);
  const v = event.payload.voucher;
  return (
    !!row &&
    row.deletedAt === null &&
    row.voucherType === v.voucherType &&
    row.voucherDate === v.voucherDate &&
    row.optional === v.optional
  );
}

// ---- voucher.payment-receipt-delete.v1 --------------------------------------

async function applyDelete(client: Queryable, event: Phase9PaymentDeleteEvent, context: Context): Promise<Result> {
  const p = event.payload;
  const voucherId = await cloudVoucherId(client, context.siteId, event.companyId, p.voucherRef);
  const prior = await voucherRow(client, event.companyId, voucherId);
  if (!prior) throw new Phase9EventConflict("PHASE9_PAYMENT_MISSING", { voucher: p.voucherRef, voucherId });
  // Deleted in the cloud as well: nothing more to do.
  if (prior.deletedAt !== null)
    return { outcome: "already-present", cloudRef: voucherId, businessDate: prior.voucherDate };
  await holdUnlessUnchanged(client, event, voucherId, context);
  const voucher = await txOf(client).query.vouchers.findFirst({
    where: (table, { and, eq }) => and(eq(table.id, voucherId), eq(table.companyId, event.companyId)),
  });
  try {
    if (!voucher) throw new Error("Voucher not found");
    const occurredAt = new Date().toISOString();
    await deleteVoucherTx(txOf(client), {
      companyId: event.companyId,
      voucher,
      occurredAt,
      asOfDate: occurredAt.slice(0, 10),
      actor: { userId: event.actorUserId, username: p.actorUsername },
      retirementActor: { userId: event.actorUserId, username: p.actorUsername },
    });
  } catch (error) {
    refusal(error, "PHASE9_PAYMENT_DELETE_REFUSED");
  }
  return { outcome: "cloud-applied", cloudRef: voucherId, businessDate: prior.voucherDate };
}

async function verifyDelete(client: Queryable, event: Phase9PaymentDeleteEvent, result: Result): Promise<boolean> {
  const row = await voucherRow(client, event.companyId, result.cloudRef);
  return !!row && row.deletedAt !== null;
}

export const phase9PaymentEditApplyHandler = Object.freeze({
  authorize: (client: Queryable, event: Phase9PaymentEditEvent) => authorizeActor(client, event, false),
  apply: applyEdit,
  verify: verifyEdit,
});
export const phase9PaymentDeleteApplyHandler = Object.freeze({
  authorize: (client: Queryable, event: Phase9PaymentDeleteEvent) => authorizeActor(client, event, true),
  apply: applyDelete,
  verify: verifyDelete,
});
