/**
 * Phase 4: append-only LAN voucher delivery evidence.
 * Recording the envelope in the same transaction as the voucher makes the
 * source durable; it does NOT authorize applying it against the cloud ledger.
 */
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../db";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { EdgeRefusal } from "./edgeRefusal";

export async function ensureEdgeVoucherOutboxSchema(queryable: Pick<Pool, "query">): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan") return;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_outbox_counter (
      site_id UUID PRIMARY KEY,
      last_sequence BIGINT NOT NULL CHECK(last_sequence > 0)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_voucher_outbox (
      sequence BIGINT NOT NULL PRIMARY KEY CHECK(sequence > 0),
      site_id UUID NOT NULL,
      operation_id UUID NOT NULL,
      company_id INTEGER NOT NULL,
      actor_user_id TEXT NOT NULL,
      local_voucher_id INTEGER NOT NULL,
      operation_kind TEXT NOT NULL DEFAULT 'voucher.with-entries.v1',
      payload JSONB NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT factory_edge_voucher_outbox_id UNIQUE (site_id, operation_id),
      CONSTRAINT factory_edge_voucher_outbox_voucher UNIQUE (site_id, company_id, local_voucher_id),
      CONSTRAINT factory_edge_voucher_outbox_kind
        CHECK (operation_kind = 'voucher.with-entries.v1')
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_stage_receipts (
      site_id UUID NOT NULL,
      sequence BIGINT NOT NULL CHECK(sequence > 0),
      operation_id UUID NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      state TEXT NOT NULL CHECK(state = 'staged-not-applied'),
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(site_id, sequence)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_applied_receipts (
      site_id UUID NOT NULL,
      sequence BIGINT NOT NULL CHECK(sequence > 0),
      operation_id UUID NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      company_id INTEGER NOT NULL CHECK(company_id > 0),
      local_voucher_id INTEGER NOT NULL CHECK(local_voucher_id > 0),
      cloud_voucher_id INTEGER NOT NULL CHECK(cloud_voucher_id > 0),
      business_date DATE NOT NULL,
      state TEXT NOT NULL CHECK(state = 'cloud-applied'),
      received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, sequence),
      UNIQUE (site_id, operation_id)
    )
  `);
  // This outbox is evidence; the normal application must not rewrite
  // confirmed local operations. Receipts belong to separate append-only logs.
  await queryable.query(`
    CREATE OR REPLACE FUNCTION factory_edge_voucher_outbox_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'EDGE_OUTBOX_IMMUTABLE' USING ERRCODE = '23514';
    END $$;
  `);
  await queryable.query(`
    DROP TRIGGER IF EXISTS factory_edge_voucher_outbox_no_mutation
    ON factory_edge_voucher_outbox
  `);
  await queryable.query(`
    CREATE TRIGGER factory_edge_voucher_outbox_no_mutation
    BEFORE UPDATE OR DELETE ON factory_edge_voucher_outbox
    FOR EACH ROW EXECUTE FUNCTION factory_edge_voucher_outbox_immutable()
  `);
  await queryable.query(`
    DROP TRIGGER IF EXISTS factory_edge_stage_receipt_no_mutation
    ON factory_edge_stage_receipts
  `);
  await queryable.query(`
    CREATE TRIGGER factory_edge_stage_receipt_no_mutation
    BEFORE UPDATE OR DELETE ON factory_edge_stage_receipts
    FOR EACH ROW EXECUTE FUNCTION factory_edge_voucher_outbox_immutable()
  `);
  await queryable.query(`
    DROP TRIGGER IF EXISTS factory_edge_applied_receipt_no_mutation
    ON factory_edge_applied_receipts
  `);
  await queryable.query(`
    CREATE TRIGGER factory_edge_applied_receipt_no_mutation
    BEFORE UPDATE OR DELETE ON factory_edge_applied_receipts
    FOR EACH ROW EXECUTE FUNCTION factory_edge_voucher_outbox_immutable()
  `);
}

/** Stable object-key order for comparing a JSONB record after remote transport. */
export function canonicalEdgeVoucherPayload(voucher: unknown, entries: readonly unknown[]): string {
  const source: unknown = JSON.parse(JSON.stringify({ voucher, entries }));
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => left.localeCompare(right, "en"))
          .map(([key, value]) => [key, sort(value)])
      );
    }
    return input;
  };
  return JSON.stringify(sort(source));
}

export interface EdgeVoucherEvidence {
  companyId: number;
  actorUserId: string;
  localVoucherId: number;
  requestId?: string | null;
  voucher: unknown;
  entries: readonly unknown[];
}

export async function captureEdgeVoucherTx(tx: DbTransaction, evidence: EdgeVoucherEvidence): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  if (
    !Number.isSafeInteger(evidence.companyId) ||
    evidence.companyId < 1 ||
    !Number.isSafeInteger(evidence.localVoucherId) ||
    evidence.localVoucherId < 1 ||
    !evidence.actorUserId
  ) {
    throw new EdgeRefusal("EDGE_OUTBOX_SCOPE_INVALID");
  }
  // Never invent a different operation ID after the voucher has posted:
  // a broken/missing request identity must roll back this SAME transaction.
  if (
    typeof evidence.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(evidence.requestId)
  ) {
    throw new EdgeRefusal("EDGE_OUTBOX_OPERATION_ID_INVALID");
  }
  const operationId = evidence.requestId;
  const payload = canonicalEdgeVoucherPayload(evidence.voucher, evidence.entries);
  const hash = createHash("sha256").update(payload, "utf8").digest("hex");
  // Ordered captures serialize to commit in the same order as sequence
  // allocation. A future relay must still use acknowledgements, not simply
  // advance past unconfirmed rows.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-voucher-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_outbox_counter(site_id, last_sequence)
      VALUES (${config.siteId}::uuid, 1)
      ON CONFLICT (site_id)
        DO UPDATE SET last_sequence = factory_edge_outbox_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_voucher_outbox
      (sequence, site_id, operation_id, company_id, actor_user_id,
       local_voucher_id, payload, payload_sha256)
    SELECT next_sequence.last_sequence, ${config.siteId}::uuid, ${operationId}::uuid,
      ${evidence.companyId}, ${evidence.actorUserId},
      ${evidence.localVoucherId}, ${payload}::jsonb, ${hash}
    FROM next_sequence
  `);
}
