/**
 * Phase 4: append-only LAN voucher delivery evidence.
 * Recording the envelope in the same transaction as the voucher makes the
 * source durable; it does NOT authorize applying it against the cloud ledger.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../db";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";

export async function ensureEdgeVoucherOutboxSchema(queryable: Pick<Pool, "query">): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan") return;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_voucher_outbox (
      sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  // This outbox is evidence; the normal application must not rewrite
  // confirmed local operations. Receipts belong to a separate append-only log.
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
  if (!Number.isSafeInteger(evidence.companyId) || evidence.companyId < 1 ||
      !Number.isSafeInteger(evidence.localVoucherId) || evidence.localVoucherId < 1 ||
      !evidence.actorUserId) {
    throw new Error("EDGE_OUTBOX_SCOPE_INVALID");
  }
  const operationId =
    evidence.requestId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(evidence.requestId)
      ? evidence.requestId
      : randomUUID();
  const payload = canonicalEdgeVoucherPayload(evidence.voucher, evidence.entries);
  const hash = createHash("sha256").update(payload, "utf8").digest("hex");
  // Ordered captures serialize to commit in the same order as sequence
  // allocation. A future relay must still use acknowledgements, not simply
  // advance past unconfirmed rows.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-voucher-outbox-order'))`);
  await tx.execute(sql`
    INSERT INTO factory_edge_voucher_outbox
      (site_id, operation_id, company_id, actor_user_id,
       local_voucher_id, payload, payload_sha256)
    VALUES
      (${config.siteId}, ${operationId}, ${evidence.companyId}, ${evidence.actorUserId},
       ${evidence.localVoucherId}, ${payload}::jsonb, ${hash})
  `);
}
