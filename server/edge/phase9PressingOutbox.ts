/**
 * Phase 9 development: atomic LAN evidence for physical pressing confirmations.
 * Separate sequence/cursor from financial vouchers: a pressing event MUST
 * NOT advance or create gaps in Phase 8's voucher-only replay stream.
 *
 * Delivery is the generic Phase 9 event stream "pressing": the LAN relay
 * (scripts/edge/relay-event-outbox.mjs) stages these rows in the cloud, the
 * operator apply (server/edge/phase9OperatorApply.ts) posts them exactly once,
 * and only verified cloud receipts are written to the LAN applied-receipt log.
 * The schema below is installed by a reviewed DBA step, never at startup;
 * without it the LAN write guard refuses the route instead of failing mid-scan.
 */
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { DbTransaction } from "../db";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { hashEvidence } from "./edgeSyncStageProtocol.mjs";
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
  // LAN-side receipt logs for every Phase 9 event stream. "staged" and
  // "applied" are separate, append-only facts: staging never implies apply.
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_event_stage_receipts (
      site_id UUID NOT NULL,
      stream TEXT NOT NULL,
      sequence BIGINT NOT NULL CHECK(sequence > 0),
      operation_id UUID NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      state TEXT NOT NULL CHECK(state = 'staged-not-applied'),
      received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, stream, sequence)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_event_applied_receipts (
      site_id UUID NOT NULL,
      stream TEXT NOT NULL,
      sequence BIGINT NOT NULL CHECK(sequence > 0),
      operation_id UUID NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      company_id INTEGER NOT NULL CHECK(company_id > 0),
      local_ref INTEGER NOT NULL CHECK(local_ref > 0),
      cloud_ref INTEGER CHECK(cloud_ref > 0),
      business_date DATE,
      outcome TEXT NOT NULL CHECK(outcome IN ('cloud-applied', 'already-present', 'rejected-conflict')),
      received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, stream, sequence),
      UNIQUE (site_id, operation_id)
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
  for (const table of ["factory_edge_event_stage_receipts", "factory_edge_event_applied_receipts"]) {
    await queryable.query(`DROP TRIGGER IF EXISTS ${table}_no_mutation ON ${table}`);
    await queryable.query(`
      CREATE TRIGGER ${table}_no_mutation
      BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION factory_edge_pressing_outbox_immutable()
    `);
  }
}

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
