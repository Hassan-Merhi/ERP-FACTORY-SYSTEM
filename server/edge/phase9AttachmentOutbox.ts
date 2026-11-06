/**
 * Phase 9: atomic LAN evidence for files uploaded on the factory LAN server
 * ("attachments" stream). The upload's database row and this record commit
 * together; the relay stages the record, then uploads the file bytes, which
 * the cloud accepts only when their SHA-256 matches the record. The LAN keeps
 * an append-only log of files the cloud acknowledged, so a file is sent once.
 * Schema: reviewed DBA install only (offlineSchemaInstall.ts).
 */
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { DbTransaction } from "../db";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { hashEvidence } from "./edgeSyncStageProtocol.mjs";
import {
  PHASE9_ATTACHMENT_KIND,
  PHASE9_ATTACHMENT_UPDATE_KIND,
  phase9AttachmentEnvelope,
  phase9AttachmentUpdateEnvelope,
  type Phase9AttachmentEvidence,
  type Phase9AttachmentFileRef,
  type Phase9AttachmentUpdateEvidence,
} from "./phase9AttachmentEnvelope.mjs";

export async function ensurePhase9AttachmentOutboxSchema(queryable: Pick<Pool, "query">): Promise<void> {
  if (readFactoryEdgeConfiguration().mode !== "lan") return;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_attachment_counter (
      site_id UUID PRIMARY KEY,
      last_sequence BIGINT NOT NULL CHECK(last_sequence > 0)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_attachment_outbox (
      site_id UUID NOT NULL,
      sequence BIGINT NOT NULL CHECK(sequence > 0),
      operation_id UUID NOT NULL,
      company_id INTEGER NOT NULL CHECK(company_id > 0),
      actor_user_id TEXT NOT NULL CHECK(length(actor_user_id) > 0),
      local_file_id INTEGER NOT NULL CHECK(local_file_id > 0),
      operation_kind TEXT NOT NULL,
      payload JSONB NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, sequence),
      UNIQUE (site_id, operation_id),
      CONSTRAINT factory_edge_attachment_source_fk
        FOREIGN KEY (local_file_id) REFERENCES stored_files(id) ON DELETE RESTRICT
    )
  `);
  // Plan batch 4: renames and moves follow the upload on this stream and name
  // the same file, so only the upload stays one-per-file.
  await queryable.query(
    "ALTER TABLE factory_edge_attachment_outbox DROP CONSTRAINT IF EXISTS factory_edge_attachment_outbox_operation_kind_check"
  );
  await queryable.query(
    `ALTER TABLE factory_edge_attachment_outbox ADD CONSTRAINT factory_edge_attachment_outbox_operation_kind_check
       CHECK (operation_kind IN ('${PHASE9_ATTACHMENT_KIND}', '${PHASE9_ATTACHMENT_UPDATE_KIND}'))`
  );
  for (const name of [
    "factory_edge_attachment_outbox_site_id_local_file_id_key",
    "factory_edge_attachment_outbox_site_id_local_file_id_unique",
  ]) {
    await queryable.query(`ALTER TABLE factory_edge_attachment_outbox DROP CONSTRAINT IF EXISTS ${name}`);
  }
  await queryable.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS factory_edge_attachment_outbox_upload_once
       ON factory_edge_attachment_outbox (site_id, local_file_id) WHERE operation_kind = '${PHASE9_ATTACHMENT_KIND}'`
  );
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_attachment_file_receipts (
      site_id UUID NOT NULL,
      file_sha256 CHAR(64) NOT NULL,
      byte_size INTEGER NOT NULL CHECK(byte_size > 0),
      acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, file_sha256)
    )
  `);
  await queryable.query(`
    CREATE OR REPLACE FUNCTION factory_edge_attachment_outbox_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'PHASE9_ATTACHMENT_OUTBOX_IMMUTABLE' USING ERRCODE = '23514';
    END $$
  `);
  for (const table of ["factory_edge_attachment_outbox", "factory_edge_attachment_file_receipts"]) {
    await queryable.query(`DROP TRIGGER IF EXISTS ${table}_no_mutation ON ${table}`);
    await queryable.query(`
      CREATE TRIGGER ${table}_no_mutation
      BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION factory_edge_attachment_outbox_immutable()
    `);
  }
}

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
