/**
 * Phase 9: atomic LAN evidence for receiving containers against existing
 * purchase orders ("receiving" stream). Captured inside the offload
 * transaction on the factory LAN primary; replayed by the operator apply in
 * the cloud. Schema: migrations/ (never created at runtime).
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../db";
import { resultRows } from "../lib/queryResult";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { hashEvidence } from "./edgeSyncStageProtocol.mjs";
import {
  phase9ReceivingEnvelope,
  phase9ReceivingLineDigest,
  type Phase9ReceivingEvidence,
} from "./phase9ReceivingEnvelope.mjs";

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
