/**
 * Phase 9: atomic LAN evidence for POS cash sales ("pos" stream).
 *
 * On the LAN primary each sale first allocates the next LAN invoice number
 * (LAN-<site>-000123) from this stream's gapless counter, posts the sale under
 * that number, and records the committed sale in the same transaction. The
 * LAN invoice series can never collide with the cloud's SV- numbers; the cloud
 * replay keeps the LAN number on the cloud voucher for cross-reference.
 * Schema: reviewed DBA install only (server/edge/offlineSchemaInstall.ts).
 */
import { EdgeRefusal } from "./edgeRefusal";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { DbTransaction } from "../db";
import { resultRows } from "../lib/queryResult";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { hashEvidence } from "./edgeSyncStageProtocol.mjs";
import {
  phase9PosInvoiceNumber,
  phase9PosSaleCancelEnvelope,
  phase9PosSaleEditEnvelope,
  phase9PosSaleEnvelope,
  type Phase9PosSaleCancelEvidence,
  type Phase9PosSaleEditEvidence,
  type Phase9PosSaleEvidence,
} from "./phase9PosSaleEnvelope.mjs";

export interface Phase9PosInvoice {
  siteId: string;
  sequence: string;
  number: string;
}

/** True only on the factory LAN server while it is the acknowledged writer. */
export function isPhase9LanPrimary(): boolean {
  const config = readFactoryEdgeConfiguration();
  return config.mode === "lan" && config.primary === true;
}

export async function ensurePhase9PosOutboxSchema(queryable: Pick<Pool, "query">): Promise<void> {
  if (readFactoryEdgeConfiguration().mode !== "lan") return;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_pos_counter (
      site_id UUID PRIMARY KEY,
      last_sequence BIGINT NOT NULL CHECK(last_sequence > 0)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_pos_outbox (
      site_id UUID NOT NULL,
      sequence BIGINT NOT NULL CHECK(sequence > 0),
      operation_id UUID NOT NULL,
      company_id INTEGER NOT NULL CHECK(company_id > 0),
      actor_user_id TEXT NOT NULL CHECK(length(actor_user_id) > 0),
      local_voucher_id INTEGER NOT NULL CHECK(local_voucher_id > 0),
      lan_invoice_number TEXT,
      operation_kind TEXT NOT NULL CHECK(operation_kind IN ('pos.sale.v1', 'pos.sale-edit.v1', 'pos.sale-cancel.v1')),
      payload JSONB NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, sequence),
      UNIQUE (site_id, operation_id),
      UNIQUE (site_id, lan_invoice_number),
      -- A sale has a LAN invoice number; an edit of it does not.
      CHECK ((operation_kind = 'pos.sale.v1') = (lan_invoice_number IS NOT NULL)),
      CONSTRAINT factory_edge_pos_source_fk
        FOREIGN KEY (local_voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT
    )
  `);
  await queryable.query(`
    CREATE OR REPLACE FUNCTION factory_edge_pos_outbox_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'PHASE9_POS_OUTBOX_IMMUTABLE' USING ERRCODE = '23514';
    END $$
  `);
  await queryable.query(`DROP TRIGGER IF EXISTS factory_edge_pos_outbox_no_mutation ON factory_edge_pos_outbox`);
  await queryable.query(`
    CREATE TRIGGER factory_edge_pos_outbox_no_mutation
    BEFORE UPDATE OR DELETE ON factory_edge_pos_outbox
    FOR EACH ROW EXECUTE FUNCTION factory_edge_pos_outbox_immutable()
  `);
}

/** Reserve the next LAN invoice number inside the sale transaction. */
export async function allocatePhase9PosInvoiceTx(tx: DbTransaction): Promise<Phase9PosInvoice> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary || !config.siteId) {
    throw new EdgeRefusal("PHASE9_POS_LAN_PRIMARY_REQUIRED");
  }
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-pos-outbox-order'))`);
  const result = await tx.execute(sql`
    INSERT INTO factory_edge_pos_counter (site_id, last_sequence)
    VALUES (${config.siteId}::uuid, 1)
    ON CONFLICT (site_id) DO UPDATE SET last_sequence = factory_edge_pos_counter.last_sequence + 1
    RETURNING last_sequence::text AS sequence
  `);
  const sequence = resultRows<{ sequence: string }>(result)[0]?.sequence;
  if (!sequence) throw new EdgeRefusal("PHASE9_POS_SEQUENCE_UNAVAILABLE");
  return { siteId: config.siteId, sequence, number: phase9PosInvoiceNumber(config.siteId, sequence) };
}

/** Record the committed sale under the reserved sequence, in the same transaction. */
export async function capturePhase9PosSaleTx(
  tx: DbTransaction,
  invoice: Phase9PosInvoice,
  evidence: Phase9PosSaleEvidence
): Promise<void> {
  if (evidence.lanInvoiceNumber !== invoice.number) throw new EdgeRefusal("PHASE9_POS_INVOICE_MISMATCH");
  const event = phase9PosSaleEnvelope(evidence);
  const hash = hashEvidence(event);
  await tx.execute(sql`
    INSERT INTO factory_edge_pos_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id, local_voucher_id,
       lan_invoice_number, operation_kind, payload, payload_sha256)
    VALUES (${invoice.siteId}::uuid, ${invoice.sequence}::bigint, ${event.requestId}::uuid,
            ${event.companyId}, ${event.actorUserId}, ${event.localVoucherId},
            ${event.lanInvoiceNumber}, ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hash})
  `);
}

/** Record a committed sale edit (return/correction) on the same "pos" stream. */
export async function capturePhase9PosSaleEditTx(
  tx: DbTransaction,
  evidence: Phase9PosSaleEditEvidence
): Promise<void> {
  await insertPosFollowUpTx(tx, phase9PosSaleEditEnvelope(evidence));
}

/** Record a committed sale cancellation (voucher delete) on the same "pos" stream. */
export async function capturePhase9PosSaleCancelTx(
  tx: DbTransaction,
  evidence: Phase9PosSaleCancelEvidence
): Promise<void> {
  await insertPosFollowUpTx(tx, phase9PosSaleCancelEnvelope(evidence));
}

/** An edit or cancellation of a sale: next pos sequence, no LAN invoice number. */
async function insertPosFollowUpTx(
  tx: DbTransaction,
  event: { kind: string; requestId: string; companyId: number; actorUserId: string; localVoucherId: number }
): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary || !config.siteId) return;
  const hash = hashEvidence(event);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-pos-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_pos_counter (site_id, last_sequence)
      VALUES (${config.siteId}::uuid, 1)
      ON CONFLICT (site_id) DO UPDATE SET last_sequence = factory_edge_pos_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_pos_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id, local_voucher_id,
       lan_invoice_number, operation_kind, payload, payload_sha256)
    SELECT ${config.siteId}::uuid, next_sequence.last_sequence, ${event.requestId}::uuid,
           ${event.companyId}, ${event.actorUserId}, ${event.localVoucherId},
           NULL, ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hash}
    FROM next_sequence
  `);
}
