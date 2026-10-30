/**
 * Phase 9 development: atomic LAN evidence for physical pressing confirmations.
 * Separate sequence/cursor from financial vouchers: a pressing event MUST
 * NOT advance or create gaps in Phase 8's voucher-only replay stream.
 *
 * No cloud receiver/apply/ack path is authorized here. The LAN admission fence
 * continues to reject POST /api/factory/pressing-machines/confirm.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { DbTransaction } from "../db";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { phase9PressingEnvelope, type Phase9PressingEvidence } from "./phase9PressingEnvelope.mjs";

export async function ensurePhase9PressingOutboxSchema(queryable: Pick<Pool, "query">): Promise<void> {
  if (readFactoryEdgeConfiguration().mode !== "lan") return;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_pressing_counter (
      site_id UUID PRIMARY KEY,
      last_sequence BIGINT NOT NULL CHECK(last_sequence > 0)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_pressing_outbox (
      site_id UUID NOT NULL,
      sequence BIGINT NOT NULL CHECK(sequence > 0),
      operation_id UUID NOT NULL,
      company_id INTEGER NOT NULL CHECK(company_id > 0),
      actor_user_id TEXT NOT NULL CHECK(length(actor_user_id) > 0),
      local_confirmation_id INTEGER NOT NULL CHECK(local_confirmation_id > 0),
      operation_kind TEXT NOT NULL CHECK(operation_kind = 'pressing.confirmation.v1'),
      payload JSONB NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, sequence),
      UNIQUE (site_id, operation_id),
      UNIQUE (site_id, company_id, local_confirmation_id),
      CONSTRAINT factory_edge_pressing_source_fk
        FOREIGN KEY (company_id, local_confirmation_id)
        REFERENCES factory_pressing_confirmations(company_id, id)
        ON DELETE RESTRICT
    )
  `);
  await queryable.query(`
    CREATE OR REPLACE FUNCTION factory_edge_pressing_outbox_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'PHASE9_PRESSING_OUTBOX_IMMUTABLE' USING ERRCODE = '23514';
    END $$
  `);
  await queryable.query(`
    DROP TRIGGER IF EXISTS factory_edge_pressing_outbox_no_mutation
      ON factory_edge_pressing_outbox
  `);
  await queryable.query(`
    CREATE TRIGGER factory_edge_pressing_outbox_no_mutation
    BEFORE UPDATE OR DELETE ON factory_edge_pressing_outbox
    FOR EACH ROW EXECUTE FUNCTION factory_edge_pressing_outbox_immutable()
  `);
}

export async function capturePhase9PressingTx(tx: DbTransaction, evidence: Phase9PressingEvidence): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  // Validate before running ANY database statement; invalid evidence must
  // abort the same confirmation transaction, never be stored optimistically.
  const event = phase9PressingEnvelope(evidence);
  const payload = JSON.stringify(event);
  const hash = createHash("sha256").update(payload, "utf8").digest("hex");
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
