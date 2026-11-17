/**
 * Phase 9: atomic LAN evidence for files uploaded on the factory LAN server
 * ("attachments" stream). The upload's database row and this record commit
 * together; the relay stages the record, then uploads the file bytes, which
 * the cloud accepts only when their SHA-256 matches the record. The LAN keeps
 * an append-only log of files the cloud acknowledged, so a file is sent once.
 * Schema: migrations/ (never created at runtime).
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../db";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { hashEvidence } from "./edgeSyncStageProtocol.mjs";
import {
  PHASE9_ATTACHMENT_KIND,
  phase9AttachmentEnvelope,
  phase9AttachmentUpdateEnvelope,
  type Phase9AttachmentEvidence,
  type Phase9AttachmentFileRef,
  type Phase9AttachmentUpdateEvidence,
} from "./attachmentEnvelope.mjs";

/** Record the committed upload in the SAME transaction; no-op off the LAN primary. */
export async function capturePhase9AttachmentTx(tx: DbTransaction, evidence: Phase9AttachmentEvidence): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  const event = phase9AttachmentEnvelope(evidence);
  const hash = hashEvidence(event);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-attachment-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_attachment_counter (site_id, last_sequence)
      VALUES (${config.siteId}::uuid, 1)
      ON CONFLICT (site_id)
        DO UPDATE SET last_sequence = factory_edge_attachment_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_attachment_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_file_id, operation_kind, payload, payload_sha256)
    SELECT ${config.siteId}::uuid, next_sequence.last_sequence, ${event.requestId}::uuid,
           ${event.companyId}, ${event.actorUserId}, ${event.localFileId},
           ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hash}
    FROM next_sequence
  `);
}

/** Plan batch 4: how an offline record names a file: by its LAN upload record if uploaded offline, else its shared id. */
export async function phase9AttachmentFileRefTx(tx: DbTransaction, fileId: number): Promise<Phase9AttachmentFileRef> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode === "lan" && config.primary && config.siteId) {
    const found = await tx.execute(sql`
      SELECT 1 FROM factory_edge_attachment_outbox
       WHERE site_id = ${config.siteId}::uuid AND operation_kind = ${PHASE9_ATTACHMENT_KIND} AND local_file_id = ${fileId}
       LIMIT 1
    `);
    if (found.rows.length) return { origin: "lan", localFileId: fileId };
  }
  return { origin: "cloud", fileId };
}

/** Plan batch 4: an offline rename / move, in the change's own transaction; no-op off the LAN primary. */
export async function capturePhase9AttachmentUpdateTx(
  tx: DbTransaction,
  evidence: Phase9AttachmentUpdateEvidence
): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  const event = phase9AttachmentUpdateEnvelope(evidence);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-attachment-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_attachment_counter (site_id, last_sequence)
      VALUES (${config.siteId}::uuid, 1)
      ON CONFLICT (site_id)
        DO UPDATE SET last_sequence = factory_edge_attachment_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_attachment_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_file_id, operation_kind, payload, payload_sha256)
    SELECT ${config.siteId}::uuid, next_sequence.last_sequence, ${event.requestId}::uuid,
           ${event.companyId}, ${event.actorUserId}, ${event.localFileId},
           ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hashEvidence(event)}
    FROM next_sequence
  `);
}
