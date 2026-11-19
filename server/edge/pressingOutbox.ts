/**
 * Phase 9 development: atomic LAN evidence for physical pressing confirmations.
 * Separate sequence/cursor from financial vouchers: a pressing event MUST
 * NOT advance or create gaps in Phase 8's voucher-only replay stream.
 *
 * Delivery is the generic Phase 9 event stream "pressing": the LAN relay
 * (scripts/edge/relay-event-outbox.mjs) stages these rows in the cloud, the
 * operator apply (server/edge/eventStreamOperatorApply.ts) posts them exactly once,
 * and only verified cloud receipts are written to the LAN applied-receipt log.
 * The schema is defined by migrations/ and never created at runtime; without
 * it the LAN write guard refuses the route instead of failing mid-scan.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../db";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { hashEvidence } from "./edgeSyncStageProtocol.mjs";
import { phase9PressingEnvelope, type Phase9PressingEvidence } from "./pressingEnvelope.mjs";

export async function capturePhase9PressingTx(tx: DbTransaction, evidence: Phase9PressingEvidence): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  // Validate before running ANY database statement; invalid evidence must
  // abort the same confirmation transaction, never be stored optimistically.
  const event = phase9PressingEnvelope(evidence);
  const payload = JSON.stringify(event);
  // Canonical (sorted-key) hash: JSONB reorders keys, and the cloud must be
  // able to recompute exactly this digest from the transported payload.
  const hash = hashEvidence(event);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-pressing-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_pressing_counter (site_id, last_sequence)
      VALUES (${config.siteId}::uuid, 1)
      ON CONFLICT (site_id)
        DO UPDATE SET last_sequence = factory_edge_pressing_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_pressing_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_confirmation_id, operation_kind, payload, payload_sha256)
    SELECT ${config.siteId}::uuid, next_sequence.last_sequence, ${event.requestId}::uuid,
           ${event.companyId}, ${event.actorUserId}, ${event.localConfirmationId},
           ${event.kind}, ${payload}::jsonb, ${hash}
    FROM next_sequence
  `);
}
