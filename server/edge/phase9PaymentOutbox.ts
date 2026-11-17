/**
 * Phase 9: atomic LAN evidence for Payment / Receipt vouchers ("payments"
 * stream): supplier, customer, employee and bank payments and receipts
 * created on the factory LAN server. Schema: migrations/ (never created at runtime).
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../db";
import { toMoney } from "../lib/money";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { hashEvidence } from "./edgeSyncStageProtocol.mjs";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import {
  PHASE9_PAYMENT_KIND,
  phase9PaymentDeleteEnvelope,
  phase9PaymentEditEnvelope,
  type Phase9PaymentDeleteEvidence,
  type Phase9PaymentEditEvidence,
  type Phase9PaymentVoucherRef,
  phase9PaymentEnvelope,
  type Phase9PaymentEvidence,
  type Phase9PaymentVoucherInputs,
} from "./phase9PaymentEnvelope.mjs";

export { phase9PaymentSnapshotTx } from "./phase9PaymentSnapshot";

/** The route's inputs in the evidence's canonical form (decimal strings). */
export function paymentReceiptEvidence(input: {
  voucherType: string;
  voucherDate: string;
  paymentAccountType: string;
  paymentAccountId: number | string;
  entries: Array<{ accountType: string; accountId: number | string; amount: unknown }>;
  notes: string | null;
  optional: boolean;
  currency: string;
  exchangeRate: string | null;
  effectiveDate: string | null;
}): Phase9PaymentVoucherInputs {
  return {
    voucherType: input.voucherType as "Payment" | "Receipt",
    voucherDate: String(input.voucherDate).slice(0, 10),
    paymentAccountType: input.paymentAccountType,
    paymentAccountId: Number(input.paymentAccountId),
    entries: input.entries.map((entry) => ({
      accountType: entry.accountType,
      accountId: Number(entry.accountId),
      amount: toMoney(String(entry.amount ?? "0")).toFixed(),
    })),
    notes: input.notes,
    optional: input.optional,
    currency: String(input.currency || "USD").toUpperCase(),
    exchangeRate: input.exchangeRate === null ? null : toMoney(input.exchangeRate).toFixed(),
    effectiveDate: input.effectiveDate ? String(input.effectiveDate).slice(0, 10) : null,
  };
}

/** Record the committed voucher's inputs in the SAME transaction; no-op off the LAN primary. */
export async function capturePhase9PaymentTx(tx: DbTransaction, evidence: Phase9PaymentEvidence): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  const event = phase9PaymentEnvelope(evidence);
  const hash = hashEvidence(event);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-payment-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_payment_counter (site_id, last_sequence)
      VALUES (${config.siteId}::uuid, 1)
      ON CONFLICT (site_id)
        DO UPDATE SET last_sequence = factory_edge_payment_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_payment_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_voucher_id, operation_kind, payload, payload_sha256)
    SELECT ${config.siteId}::uuid, next_sequence.last_sequence, ${event.requestId}::uuid,
           ${event.companyId}, ${event.actorUserId}, ${event.localVoucherId},
           ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hash}
    FROM next_sequence
  `);
}

/** Plan batch 4: who made an offline edit or delete, with a fresh operation id. */
export function paymentFollowUpActor(req: Pick<Request, "session">) {
  return {
    companyId: Number(req.session.currentCompanyId),
    actorUserId: String(req.session.userId),
    actorUsername: req.session.username || "unknown",
    requestId: randomUUID(),
  };
}

/** How an offline record names a voucher: by its LAN create record if it was made offline, else its shared id. */
export async function phase9PaymentVoucherRefTx(
  tx: DbTransaction,
  voucherId: number
): Promise<Phase9PaymentVoucherRef> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode === "lan" && config.primary && config.siteId) {
    const found = await tx.execute(sql`
      SELECT 1 FROM factory_edge_payment_outbox
       WHERE site_id = ${config.siteId}::uuid AND operation_kind = ${PHASE9_PAYMENT_KIND}
         AND local_voucher_id = ${voucherId}
       LIMIT 1
    `);
    if (found.rows.length) return { origin: "lan", localVoucherId: voucherId };
  }
  return { origin: "cloud", voucherId };
}

async function appendPaymentFollowUpTx(
  tx: DbTransaction,
  event: { kind: string; requestId: string; companyId: number; actorUserId: string; localVoucherId: number }
): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-payment-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_payment_counter (site_id, last_sequence)
      VALUES (${config.siteId}::uuid, 1)
      ON CONFLICT (site_id)
        DO UPDATE SET last_sequence = factory_edge_payment_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_payment_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_voucher_id, operation_kind, payload, payload_sha256)
    SELECT ${config.siteId}::uuid, next_sequence.last_sequence, ${event.requestId}::uuid,
           ${event.companyId}, ${event.actorUserId}, ${event.localVoucherId},
           ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hashEvidence(event)}
    FROM next_sequence
  `);
}

/** Plan batch 4: an offline Payment / Receipt edit, in the edit's own transaction; no-op off the LAN primary. */
export async function capturePhase9PaymentEditTx(
  tx: DbTransaction,
  evidence: Phase9PaymentEditEvidence
): Promise<void> {
  await appendPaymentFollowUpTx(tx, phase9PaymentEditEnvelope(evidence));
}

/** Plan batch 4: an offline Payment / Receipt delete, in the delete's own transaction; no-op off the LAN primary. */
export async function capturePhase9PaymentDeleteTx(
  tx: DbTransaction,
  evidence: Phase9PaymentDeleteEvidence
): Promise<void> {
  await appendPaymentFollowUpTx(tx, phase9PaymentDeleteEnvelope(evidence));
}
