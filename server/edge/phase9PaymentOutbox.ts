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
import {
  phase9PaymentEnvelope,
  type Phase9PaymentEvidence,
  type Phase9PaymentVoucherInputs,
} from "./phase9PaymentEnvelope.mjs";

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
      operation_kind TEXT NOT NULL CHECK(operation_kind = 'voucher.payment-receipt.v1'),
      payload JSONB NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, sequence),
      UNIQUE (site_id, operation_id),
      UNIQUE (site_id, local_voucher_id),
      CONSTRAINT factory_edge_payment_source_fk
        FOREIGN KEY (local_voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT
    )
  `);
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
