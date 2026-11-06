/**
 * Phase 9: atomic LAN evidence for Payment / Receipt vouchers ("payments"
 * stream): supplier, customer, employee and bank payments and receipts
 * created on the factory LAN server. Schema: reviewed DBA install only.
 */
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { DbTransaction } from "../db";
import { toMoney } from "../lib/money";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { hashEvidence } from "./edgeSyncStageProtocol.mjs";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import {
  PHASE9_PAYMENT_DELETE_KIND,
  PHASE9_PAYMENT_EDIT_KIND,
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

const PAYMENT_OUTBOX_KINDS = [PHASE9_PAYMENT_KIND, PHASE9_PAYMENT_EDIT_KIND, PHASE9_PAYMENT_DELETE_KIND] as const;

export { phase9PaymentSnapshotTx } from "./phase9PaymentSnapshot";

export async function ensurePhase9PaymentOutboxSchema(queryable: Pick<Pool, "query">): Promise<void> {
  if (readFactoryEdgeConfiguration().mode !== "lan") return;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_payment_counter (
      site_id UUID PRIMARY KEY,
      last_sequence BIGINT NOT NULL CHECK(last_sequence > 0)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_payment_outbox (
      site_id UUID NOT NULL,
      sequence BIGINT NOT NULL CHECK(sequence > 0),
      operation_id UUID NOT NULL,
      company_id INTEGER NOT NULL CHECK(company_id > 0),
      actor_user_id TEXT NOT NULL CHECK(length(actor_user_id) > 0),
      local_voucher_id INTEGER NOT NULL CHECK(local_voucher_id > 0),
      operation_kind TEXT NOT NULL,
      payload JSONB NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, sequence),
      UNIQUE (site_id, operation_id),
      CONSTRAINT factory_edge_payment_source_fk
        FOREIGN KEY (local_voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT
    )
  `);
  // Plan batch 4: edits and deletes follow the create on this stream and name
  // the same voucher, so one voucher may have several records. Only the create
  // stays one-per-voucher. Existing installs lose the old one-row constraints.
  await queryable.query(
    "ALTER TABLE factory_edge_payment_outbox DROP CONSTRAINT IF EXISTS factory_edge_payment_outbox_operation_kind_check"
  );
  await queryable.query(
    `ALTER TABLE factory_edge_payment_outbox ADD CONSTRAINT factory_edge_payment_outbox_operation_kind_check
       CHECK (operation_kind IN (${PAYMENT_OUTBOX_KINDS.map((kind) => `'${kind}'`).join(", ")}))`
  );
  for (const name of [
    "factory_edge_payment_outbox_site_id_local_voucher_id_key",
    "factory_edge_payment_outbox_site_id_local_voucher_id_unique",
  ]) {
    await queryable.query(`ALTER TABLE factory_edge_payment_outbox DROP CONSTRAINT IF EXISTS ${name}`);
  }
  await queryable.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS factory_edge_payment_outbox_create_once
       ON factory_edge_payment_outbox (site_id, local_voucher_id) WHERE operation_kind = '${PHASE9_PAYMENT_KIND}'`
  );
  await queryable.query(`
    CREATE OR REPLACE FUNCTION factory_edge_payment_outbox_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'PHASE9_PAYMENT_OUTBOX_IMMUTABLE' USING ERRCODE = '23514';
    END $$
  `);
  await queryable.query(
    `DROP TRIGGER IF EXISTS factory_edge_payment_outbox_no_mutation ON factory_edge_payment_outbox`
  );
  await queryable.query(`
    CREATE TRIGGER factory_edge_payment_outbox_no_mutation
    BEFORE UPDATE OR DELETE ON factory_edge_payment_outbox
    FOR EACH ROW EXECUTE FUNCTION factory_edge_payment_outbox_immutable()
  `);
}

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
