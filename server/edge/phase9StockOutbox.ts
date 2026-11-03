/**
 * Phase 9: atomic LAN evidence for stock movements (inventory quick adjust).
 * Its own gapless sequence and cloud cursors ("stock" stream), separate from
 * vouchers and pressing, so a held stock movement never blocks other streams.
 *
 * Delivery is the generic Phase 9 event stream: the LAN relay
 * (scripts/edge/relay-event-outbox.mjs) stages these rows in the cloud and the
 * operator apply (server/edge/phase9OperatorApply.ts) replays each movement
 * exactly once as a quantity delta. The schema is installed by the reviewed
 * DBA step (server/edge/offlineSchemaInstall.ts), never at startup; without it
 * the LAN write guard refuses the route instead of failing mid-adjustment.
 */
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { DbTransaction } from "../db";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { hashEvidence } from "./edgeSyncStageProtocol.mjs";
import {
  phase9StockAdjustEnvelope,
  phase9StockTransferEnvelope,
  type Phase9StockAdjustEvidence,
  type Phase9StockTransferEvidence,
} from "./phase9StockEnvelope.mjs";
import { phase9StockItemEditEnvelope, type Phase9StockItemEditEvidence } from "./phase9StockItemEditEnvelope.mjs";

/**
 * local_movement_id is the LAN source row: a canonical stock movement (quick
 * adjust), a stock transfer (transfer) or the edit's own stream sequence (item
 * edit); unique per kind.
 */
export async function ensurePhase9StockOutboxSchema(queryable: Pick<Pool, "query">): Promise<void> {
  if (readFactoryEdgeConfiguration().mode !== "lan") return;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_stock_counter (
      site_id UUID PRIMARY KEY,
      last_sequence BIGINT NOT NULL CHECK(last_sequence > 0)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_stock_outbox (
      site_id UUID NOT NULL,
      sequence BIGINT NOT NULL CHECK(sequence > 0),
      operation_id UUID NOT NULL,
      company_id INTEGER NOT NULL CHECK(company_id > 0),
      actor_user_id TEXT NOT NULL CHECK(length(actor_user_id) > 0),
      local_movement_id BIGINT NOT NULL CHECK(local_movement_id > 0 AND local_movement_id <= 2147483647),
      operation_kind TEXT NOT NULL CHECK(operation_kind IN ('stock.quick-adjust.v1', 'stock.transfer.v1', 'stock.item-edit.v1')),
      payload JSONB NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, sequence),
      UNIQUE (site_id, operation_id),
      UNIQUE (site_id, operation_kind, local_movement_id)
    )
  `);
  // Shared with the pressing install; both are idempotent.
  await queryable.query(`
    CREATE OR REPLACE FUNCTION factory_edge_stock_outbox_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'PHASE9_STOCK_OUTBOX_IMMUTABLE' USING ERRCODE = '23514';
    END $$
  `);
  await queryable.query(`DROP TRIGGER IF EXISTS factory_edge_stock_outbox_no_mutation ON factory_edge_stock_outbox`);
  await queryable.query(`
    CREATE TRIGGER factory_edge_stock_outbox_no_mutation
    BEFORE UPDATE OR DELETE ON factory_edge_stock_outbox
    FOR EACH ROW EXECUTE FUNCTION factory_edge_stock_outbox_immutable()
  `);
}

/** Record the committed movement in the SAME transaction; no-op off the LAN primary. */
export async function capturePhase9StockAdjustTx(
  tx: DbTransaction,
  evidence: Phase9StockAdjustEvidence
): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  // Validate before any statement: invalid evidence aborts the adjustment.
  const event = phase9StockAdjustEnvelope(evidence);
  const payload = JSON.stringify(event);
  const hash = hashEvidence(event);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-stock-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_stock_counter (site_id, last_sequence)
      VALUES (${config.siteId}::uuid, 1)
      ON CONFLICT (site_id)
        DO UPDATE SET last_sequence = factory_edge_stock_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_stock_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_movement_id, operation_kind, payload, payload_sha256)
    SELECT ${config.siteId}::uuid, next_sequence.last_sequence, ${event.requestId}::uuid,
           ${event.companyId}, ${event.actorUserId}, ${event.localMovementId},
           ${event.kind}, ${payload}::jsonb, ${hash}
    FROM next_sequence
  `);
}

/** Record a committed stock transfer on the same "stock" stream; no-op off the LAN primary. */
export async function capturePhase9StockTransferTx(
  tx: DbTransaction,
  evidence: Phase9StockTransferEvidence
): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  const event = phase9StockTransferEnvelope(evidence);
  const hash = hashEvidence(event);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-stock-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_stock_counter (site_id, last_sequence)
      VALUES (${config.siteId}::uuid, 1)
      ON CONFLICT (site_id)
        DO UPDATE SET last_sequence = factory_edge_stock_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_stock_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_movement_id, operation_kind, payload, payload_sha256)
    SELECT ${config.siteId}::uuid, next_sequence.last_sequence, ${event.requestId}::uuid,
           ${event.companyId}, ${event.actorUserId}, ${event.localTransferId},
           ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hash}
    FROM next_sequence
  `);
}

/**
 * Record stock-item master edits (one event per call) on the "stock" stream.
 * The edit's local reference is its own stream sequence, taken under the
 * outbox order lock. No-op off the LAN primary.
 */
export async function capturePhase9StockItemEditTx(
  tx: DbTransaction,
  evidence: Omit<Phase9StockItemEditEvidence, "localEditId">
): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-stock-outbox-order'))`);
  const counter = await tx.execute(sql`
    INSERT INTO factory_edge_stock_counter (site_id, last_sequence)
    VALUES (${config.siteId}::uuid, 1)
    ON CONFLICT (site_id)
      DO UPDATE SET last_sequence = factory_edge_stock_counter.last_sequence + 1
    RETURNING last_sequence
  `);
  const sequence = Number((counter.rows[0] as { last_sequence: string | number }).last_sequence);
  const event = phase9StockItemEditEnvelope({ ...evidence, localEditId: sequence });
  await tx.execute(sql`
    INSERT INTO factory_edge_stock_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_movement_id, operation_kind, payload, payload_sha256)
    VALUES (${config.siteId}::uuid, ${sequence}, ${event.requestId}::uuid,
            ${event.companyId}, ${event.actorUserId}, ${event.localEditId},
            ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hashEvidence(event)})
  `);
}
