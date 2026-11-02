/**
 * Phase 9: atomic LAN evidence for receiving containers against existing
 * purchase orders ("receiving" stream). Captured inside the offload
 * transaction on the factory LAN primary; replayed by the operator apply in
 * the cloud. Schema: reviewed DBA install only (offlineSchemaInstall.ts).
 */
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { DbTransaction } from "../db";
import { resultRows } from "../lib/queryResult";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { hashEvidence } from "./edgeSyncStageProtocol.mjs";
import {
  phase9ReceivingEnvelope,
  phase9ReceivingLineDigest,
  type Phase9ReceivingEvidence,
} from "./phase9ReceivingEnvelope.mjs";

export async function ensurePhase9ReceivingOutboxSchema(queryable: Pick<Pool, "query">): Promise<void> {
  if (readFactoryEdgeConfiguration().mode !== "lan") return;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_receiving_counter (
      site_id UUID PRIMARY KEY,
      last_sequence BIGINT NOT NULL CHECK(last_sequence > 0)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_receiving_outbox (
      site_id UUID NOT NULL,
      sequence BIGINT NOT NULL CHECK(sequence > 0),
      operation_id UUID NOT NULL,
      company_id INTEGER NOT NULL CHECK(company_id > 0),
      actor_user_id TEXT NOT NULL CHECK(length(actor_user_id) > 0),
      local_offload_id INTEGER NOT NULL CHECK(local_offload_id > 0),
      operation_kind TEXT NOT NULL CHECK(operation_kind = 'receiving.container-offload.v1'),
      payload JSONB NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, sequence),
      UNIQUE (site_id, operation_id),
      UNIQUE (site_id, local_offload_id),
      CONSTRAINT factory_edge_receiving_source_fk
        FOREIGN KEY (local_offload_id) REFERENCES container_offloads(id) ON DELETE RESTRICT
    )
  `);
  await queryable.query(`
    CREATE OR REPLACE FUNCTION factory_edge_receiving_outbox_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'PHASE9_RECEIVING_OUTBOX_IMMUTABLE' USING ERRCODE = '23514';
    END $$
  `);
  await queryable.query(
    `DROP TRIGGER IF EXISTS factory_edge_receiving_outbox_no_mutation ON factory_edge_receiving_outbox`
  );
  await queryable.query(`
    CREATE TRIGGER factory_edge_receiving_outbox_no_mutation
    BEFORE UPDATE OR DELETE ON factory_edge_receiving_outbox
    FOR EACH ROW EXECUTE FUNCTION factory_edge_receiving_outbox_immutable()
  `);
}

/** Quantities (no prices) on the container's purchase orders, as one digest. */
export async function phase9ReceivingLineDigestTx(
  tx: Pick<DbTransaction, "execute">,
  companyId: number,
  containerId: number
): Promise<string> {
  const result = await tx.execute(sql`
    SELECT li.stock_item_id, li.quantity::text AS quantity
      FROM po_line_items li
      JOIN purchase_orders po ON po.id = li.po_id
     WHERE po.company_id = ${companyId} AND po.container_id = ${containerId}
  `);
  return phase9ReceivingLineDigest(
    resultRows<{ stock_item_id: number; quantity: string }>(result).map((row) => ({
      stockItemId: row.stock_item_id,
      quantity: row.quantity,
    }))
  );
}

/** Record the committed offload in the SAME transaction; no-op off the LAN primary. */
export async function capturePhase9ReceivingTx(tx: DbTransaction, evidence: Phase9ReceivingEvidence): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  const event = phase9ReceivingEnvelope(evidence);
  const hash = hashEvidence(event);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-receiving-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_receiving_counter (site_id, last_sequence)
      VALUES (${config.siteId}::uuid, 1)
      ON CONFLICT (site_id)
        DO UPDATE SET last_sequence = factory_edge_receiving_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_receiving_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_offload_id, operation_kind, payload, payload_sha256)
    SELECT ${config.siteId}::uuid, next_sequence.last_sequence, ${event.requestId}::uuid,
           ${event.companyId}, ${event.actorUserId}, ${event.localOffloadId},
           ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hash}
    FROM next_sequence
  `);
}
