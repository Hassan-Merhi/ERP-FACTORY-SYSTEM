// Extracted from ./phase9StockOutbox.ts
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../db";
import { hashEvidence } from "./edgeSyncStageProtocol.mjs";
import { capturePcLocalEnvelopeTx } from "../offline/pcLocal/pcCapture";

export async function appendStockEventTx(
  tx: DbTransaction,
  siteId: string,
  event: { kind: string; requestId: string; companyId: number; actorUserId: string },
  localRef: number
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-stock-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_stock_counter (site_id, last_sequence)
      VALUES (${siteId}::uuid, 1)
      ON CONFLICT (site_id)
        DO UPDATE SET last_sequence = factory_edge_stock_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_stock_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_movement_id, operation_kind, payload, payload_sha256)
    SELECT ${siteId}::uuid, next_sequence.last_sequence, ${event.requestId}::uuid,
           ${event.companyId}, ${event.actorUserId}, ${localRef},
           ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hashEvidence(event)}
    FROM next_sequence
  `);
}

/**
 * Plan batch 3: a follow-up record whose local reference is its own stream
 * sequence (the transfer or revision it changes is named in the payload), so
 * any number of edits of one transfer each get their own record.
 */
export async function appendStockFollowUpTx<
  T extends { kind: string; requestId: string; companyId: number; actorUserId: string },
>(tx: DbTransaction, siteId: string, build: (localEditId: number) => T): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-stock-outbox-order'))`);
  const counter = await tx.execute(sql`
    INSERT INTO factory_edge_stock_counter (site_id, last_sequence)
    VALUES (${siteId}::uuid, 1)
    ON CONFLICT (site_id)
      DO UPDATE SET last_sequence = factory_edge_stock_counter.last_sequence + 1
    RETURNING last_sequence
  `);
  const sequence = Number((counter.rows[0] as { last_sequence: string | number }).last_sequence);
  const event = build(sequence);
  await tx.execute(sql`
    INSERT INTO factory_edge_stock_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_movement_id, operation_kind, payload, payload_sha256)
    VALUES (${siteId}::uuid, ${sequence}, ${event.requestId}::uuid,
            ${event.companyId}, ${event.actorUserId}, ${sequence},
            ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hashEvidence(event)})
  `);
}

/**
 * A PC in entry mode: a follow-up record goes to the PC's own outbox as a
 * finished envelope, with a local reference from the PC's sequence, in the
 * change's transaction.
 */
export async function pcLocalFollowUpTx<
  T extends { kind: string; requestId: string; companyId: number; actorUserId: string },
>(tx: DbTransaction, build: (localEditId: number) => T): Promise<void> {
  const next = await tx.execute(sql`SELECT nextval('pc_local.local_ref_seq')::integer AS ref`);
  const localEditId = Number((next.rows[0] as { ref: number | string }).ref);
  await capturePcLocalEnvelopeTx(tx, build(localEditId), localEditId);
}
