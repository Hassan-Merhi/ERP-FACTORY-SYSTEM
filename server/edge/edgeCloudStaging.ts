/**
 * Cloud inbox contains evidence only. The transaction neither inserts vouchers
 * nor updates inventory, and its acknowledgements mean "staged", NEVER "applied".
 */
import type { Pool } from "pg";
import { validateStageEnvelope } from "./edgeSyncStageProtocol.mjs";

export class EdgeStageConflict extends Error {
  constructor(code: string) {
    super(code);
    this.name = "EdgeStageConflict";
  }
}

export async function ensureCloudEdgeStageSchema(pool: Pick<Pool, "query">, enabled: boolean): Promise<void> {
  if (!enabled) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_stage_cursor (
      site_id UUID PRIMARY KEY,
      last_sequence BIGINT NOT NULL DEFAULT 0 CHECK(last_sequence >= 0)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_staged_vouchers (
      site_id UUID NOT NULL,
      sequence BIGINT NOT NULL CHECK(sequence > 0),
      operation_id UUID NOT NULL,
      company_id INTEGER NOT NULL CHECK(company_id > 0),
      actor_user_id TEXT NOT NULL,
      local_voucher_id INTEGER NOT NULL CHECK(local_voucher_id > 0),
      operation_kind TEXT NOT NULL CHECK(operation_kind = 'voucher.with-entries.v1'),
      payload JSONB NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      staged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(site_id, sequence),
      UNIQUE(site_id, operation_id),
      UNIQUE(site_id, company_id, local_voucher_id)
    )
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION factory_edge_stage_immutable()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'EDGE_STAGED_VOUCHER_IMMUTABLE' USING ERRCODE = '23514';
    END $$
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS factory_edge_stage_no_modify ON factory_edge_staged_vouchers
  `);
  await pool.query(`
    CREATE TRIGGER factory_edge_stage_no_modify
    BEFORE UPDATE OR DELETE ON factory_edge_staged_vouchers
    FOR EACH ROW EXECUTE FUNCTION factory_edge_stage_immutable()
  `);
}

export async function stageVoucherEvents(pool: Pool, body: unknown, siteId: string) {
  const events = validateStageEnvelope(body, siteId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO factory_edge_stage_cursor(site_id) VALUES($1::uuid) ON CONFLICT DO NOTHING",
      [siteId]
    );
    const cursor = await client.query(
      "SELECT last_sequence::text AS last_sequence FROM factory_edge_stage_cursor WHERE site_id = $1::uuid FOR UPDATE",
      [siteId]
    );
    let last = BigInt(cursor.rows[0].last_sequence);
    for (const e of events) {
      const index = BigInt(e.sequence);
      const existing = await client.query(
        `SELECT operation_id::text AS operation_id, company_id, local_voucher_id,
                operation_kind, actor_user_id, payload_sha256
           FROM factory_edge_staged_vouchers
          WHERE site_id = $1::uuid AND sequence = $2::bigint`,
        [siteId, e.sequence]
      );
      if (existing.rowCount) {
        const old = existing.rows[0];
        if (String(old.operation_id) !== e.operationId ||
            Number(old.company_id) !== e.companyId ||
            Number(old.local_voucher_id) !== e.localVoucherId ||
            String(old.operation_kind) !== e.kind ||
            String(old.actor_user_id) !== e.actorUserId ||
            String(old.payload_sha256).trim() !== e.payloadSha256) {
          throw new EdgeStageConflict("EDGE_SYNC_DIVERGENT_REPLAY");
        }
        continue;
      }
      if (index !== last + 1n) throw new EdgeStageConflict("EDGE_SYNC_MISSING_PREDECESSOR");
      try {
        await client.query(
          `INSERT INTO factory_edge_staged_vouchers
            (site_id, sequence, operation_id, company_id, actor_user_id,
             local_voucher_id, operation_kind, payload, payload_sha256)
           VALUES($1::uuid, $2::bigint, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9)`,
          [siteId, e.sequence, e.operationId, e.companyId, e.actorUserId,
            e.localVoucherId, e.kind, JSON.stringify(e.payload), e.payloadSha256]
        );
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "23505") {
          throw new EdgeStageConflict("EDGE_SYNC_DUPLICATE_OPERATION_ID");
        }
        throw error;
      }
      last = index;
    }
    await client.query("UPDATE factory_edge_stage_cursor SET last_sequence = $2::bigint WHERE site_id = $1::uuid",
      [siteId, last.toString()]);
    await client.query("COMMIT");
    return {
      protocol: "factory-lan-voucher-stage-receipt/v1",
      siteId,
      state: "staged-not-applied" as const,
      lastSequence: last.toString(),
      events: events.map((e) => ({
        sequence: e.sequence,
        operationId: e.operationId,
        payloadSha256: e.payloadSha256,
        state: "staged-not-applied" as const,
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
