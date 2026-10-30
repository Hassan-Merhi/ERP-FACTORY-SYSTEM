/**
 * Phase 8: durable, exactly-once apply journal for already staged vouchers.
 *
 * Operator-invoked ONLY after the LAN writer is frozen and the cloud database
 * has been given a newer, exclusive writer epoch by a DBA. This module never
 * treats a staging ACK as posting authority and contains no auto-apply loop.
 *
 * applyPosting(client, event) MUST execute financial posting on THIS SAME
 * PostgreSQL client/transaction; external calls, independent DB pools, and
 * callbacks that commit their own transaction are forbidden.
 */
import { validateStageEnvelope, EDGE_SYNC_STAGE_VERSION } from "./edgeSyncStageProtocol.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const POSITIVE = /^[1-9][0-9]{0,15}$/;

export class Phase8ApplyRefusal extends Error {
  constructor(code) { super(code); this.name = "Phase8ApplyRefusal"; }
}

export function validatePhase8OperatorApproval(input) {
  if (!input || !UUID.test(input.siteId ?? "") ||
      !Number.isSafeInteger(input.companyId) || input.companyId < 1 ||
      !SHA.test(input.baselineSha256 ?? "") ||
      !POSITIVE.test(String(input.cloudEpoch ?? "")) ||
      !Number.isSafeInteger(Number(input.cloudEpoch)) ||
      input.operatorAck !== "LAN_FROZEN_AND_CLOUD_EPOCH_APPROVED") {
    throw new Phase8ApplyRefusal("PHASE8_OPERATOR_APPROVAL_REQUIRED");
  }
  return input;
}

export async function ensurePhase8ApplySchema(queryable) {
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_apply_cursor (
      site_id UUID PRIMARY KEY,
      last_sequence BIGINT NOT NULL DEFAULT 0 CHECK(last_sequence >= 0)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_applied_vouchers (
      site_id UUID NOT NULL,
      sequence BIGINT NOT NULL CHECK(sequence > 0),
      operation_id UUID NOT NULL,
      company_id INTEGER NOT NULL CHECK(company_id > 0),
      actor_user_id TEXT NOT NULL,
      local_voucher_id INTEGER NOT NULL CHECK(local_voucher_id > 0),
      cloud_voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE RESTRICT CHECK(cloud_voucher_id > 0),
      payload_sha256 CHAR(64) NOT NULL,
      business_date DATE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, sequence),
      UNIQUE (site_id, operation_id),
      UNIQUE (site_id, company_id, local_voucher_id),
      UNIQUE (company_id, cloud_voucher_id)
    )
  `);
  // Never let an app implicitly grant an actor permission to replay money.
  // A DBA can provision approved rows in a reviewed, separately fenced
  // maintenance transaction. No wildcard site/company/user support.
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_apply_approvals (
      site_id UUID NOT NULL,
      company_id INTEGER NOT NULL CHECK(company_id > 0),
      actor_user_id TEXT NOT NULL,
      baseline_sha256 CHAR(64) NOT NULL,
      approved_until TIMESTAMPTZ NOT NULL,
      approved_by TEXT NOT NULL,
      PRIMARY KEY (site_id, company_id, actor_user_id)
    )
  `);
  await queryable.query(`
    CREATE OR REPLACE FUNCTION factory_edge_applied_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'PHASE8_APPLIED_RECEIPT_IMMUTABLE' USING ERRCODE = '23514';
    END $$
  `);
  await queryable.query("DROP TRIGGER IF EXISTS factory_edge_applied_no_modify ON factory_edge_applied_vouchers");
  await queryable.query(`
    CREATE TRIGGER factory_edge_applied_no_modify
    BEFORE UPDATE OR DELETE ON factory_edge_applied_vouchers
    FOR EACH ROW EXECUTE FUNCTION factory_edge_applied_immutable()
  `);
}

function receipt(row) {
  return {
    sequence: String(row.sequence),
    operationId: String(row.operation_id),
    payloadSha256: String(row.payload_sha256).trim(),
    companyId: Number(row.company_id),
    localVoucherId: Number(row.local_voucher_id),
    cloudVoucherId: Number(row.cloud_voucher_id),
    businessDate: String(row.business_date).slice(0, 10),
    state: "cloud-applied",
  };
}

export async function applyStagedVoucherOnce(queryable, input, applyPosting) {
  const approved = validatePhase8OperatorApproval(input);
  if (typeof applyPosting !== "function" || !POSITIVE.test(String(input.sequence ?? ""))) {
    throw new Phase8ApplyRefusal("PHASE8_SEQUENCE_INVALID");
  }
  const sequence = String(input.sequence);
  if (BigInt(sequence) > 9223372036854775807n) throw new Phase8ApplyRefusal("PHASE8_SEQUENCE_INVALID");
  await queryable.query("BEGIN");
  try {
    await queryable.query("SET LOCAL lock_timeout = '5s'");
    await queryable.query(
      "INSERT INTO factory_edge_apply_cursor (site_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING",
      [approved.siteId]
    );
    const cursorResult = await queryable.query(
      "SELECT last_sequence::text FROM factory_edge_apply_cursor WHERE site_id=$1::uuid FOR UPDATE",
      [approved.siteId]
    );
    if (cursorResult.rows.length !== 1) throw new Phase8ApplyRefusal("PHASE8_CURSOR_MISSING");
    const last = BigInt(cursorResult.rows[0].last_sequence);
    const candidate = BigInt(sequence);
    if (candidate > last + 1n) throw new Phase8ApplyRefusal("PHASE8_MISSING_PREDECESSOR");

    const stage = await queryable.query(
      `SELECT sequence::text, operation_id::text, company_id, actor_user_id,
              local_voucher_id, operation_kind, payload, payload_sha256,
              staged_at
         FROM factory_edge_staged_vouchers
         WHERE site_id=$1::uuid AND sequence=$2::bigint`,
      [approved.siteId, sequence]
    );
    if (stage.rows.length !== 1) throw new Phase8ApplyRefusal("PHASE8_STAGED_EVIDENCE_MISSING");
    const row = stage.rows[0];
    const event = {
      sequence, operationId: String(row.operation_id),
      companyId: Number(row.company_id), actorUserId: String(row.actor_user_id),
      localVoucherId: Number(row.local_voucher_id),
      kind: String(row.operation_kind), payload: row.payload,
      payloadSha256: String(row.payload_sha256).trim(),
    };
    validateStageEnvelope({
      protocol: EDGE_SYNC_STAGE_VERSION, siteId: approved.siteId, events: [event],
    }, approved.siteId);
    if (event.companyId !== approved.companyId) throw new Phase8ApplyRefusal("PHASE8_COMPANY_NOT_APPROVED");

    const old = await queryable.query(
      `SELECT sequence::text, operation_id::text, company_id, actor_user_id,
              local_voucher_id, cloud_voucher_id, payload_sha256, business_date::text
         FROM factory_edge_applied_vouchers
         WHERE site_id=$1::uuid AND sequence=$2::bigint`,
      [approved.siteId, sequence]
    );
    if (candidate <= last) {
      if (old.rows.length !== 1 ||
          String(old.rows[0].operation_id) !== event.operationId ||
          String(old.rows[0].payload_sha256).trim() !== event.payloadSha256 ||
          Number(old.rows[0].local_voucher_id) !== event.localVoucherId ||
          Number(old.rows[0].company_id) !== event.companyId ||
          String(old.rows[0].actor_user_id) !== event.actorUserId) {
        throw new Phase8ApplyRefusal("PHASE8_DIVERGENT_REPLAY");
      }
      await queryable.query("COMMIT");
      return { ...receipt(old.rows[0]), replayed: true };
    }
    if (old.rows.length) throw new Phase8ApplyRefusal("PHASE8_CURSOR_RECEIPT_DIVERGED");

    const authority = await queryable.query(`
      SELECT s.mode, s.site_id, s.epoch::text AS epoch,
             s.baseline_sha256,
             NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole)
                AND NOT has_schema_privilege(current_user,'public','CREATE')
                AND NOT has_database_privilege(current_user,current_database(),'CREATE')
                AND NOT pg_has_role(current_user,'pg_write_all_data','MEMBER')
                AND NOT has_table_privilege(current_user,
                  'factory_edge_apply_approvals','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                AND NOT has_table_privilege(current_user,
                  'phase7_writer.state','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                AND NOT EXISTS (
                  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relkind IN ('r','p')
                    AND pg_has_role(current_user,c.relowner,'MEMBER')
                )
                AND EXISTS (SELECT 1 FROM pg_event_trigger
                            WHERE evtname='phase7_writer_guard_ddl' AND evtenabled='O')
                AND NOT EXISTS (
                  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relkind IN ('r','p')
                    AND c.relname <> 'session'
                    AND NOT EXISTS (SELECT 1 FROM pg_trigger t
                      WHERE t.tgrelid=c.oid AND t.tgname='phase7_writer_fence'
                        AND t.tgenabled='O' AND NOT t.tgisinternal)
                )
                AS restricted_role
      FROM phase7_writer.state s
      JOIN pg_roles r ON r.rolname=current_user
      WHERE s.singleton IS TRUE
      -- Read-only authority lookup: the restricted runtime login must NEVER
      -- receive UPDATE privilege on phase7_writer.state. The PostgreSQL
      -- business-table triggers hold the epoch lock through COMMIT instead.
    `);
    const state = authority.rows[0];
    if (authority.rows.length !== 1 || state.mode !== "cloud-primary" ||
        state.site_id !== "cloud" || String(state.epoch) !== String(approved.cloudEpoch) ||
        String(state.baseline_sha256).trim() !== approved.baselineSha256 ||
        state.restricted_role !== true) {
      throw new Phase8ApplyRefusal("PHASE8_CLOUD_WRITER_FENCE_UNVERIFIED");
    }

    const actor = await queryable.query(`
      SELECT 1 FROM factory_edge_apply_approvals a
      JOIN users u ON u.id = a.actor_user_id AND u.active = true
      JOIN user_company_roles role
        ON role.user_id = u.id AND role.company_id = a.company_id
      WHERE a.site_id=$1::uuid AND a.company_id=$2
        AND a.actor_user_id=$3 AND a.baseline_sha256=$4
        AND a.approved_until > clock_timestamp()
        AND role.role NOT IN ('View Only', 'POS', 'POS - Salesman')
      LIMIT 1
    `, [approved.siteId, approved.companyId, event.actorUserId, approved.baselineSha256]);
    if (actor.rows.length !== 1) throw new Phase8ApplyRefusal("PHASE8_ACTOR_NOT_AUTHORIZED");

    const result = await applyPosting(queryable, event);
    if (!result || !Number.isSafeInteger(result.cloudVoucherId) || result.cloudVoucherId < 1 ||
        typeof result.businessDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(result.businessDate)) {
      throw new Phase8ApplyRefusal("PHASE8_POSTING_RESULT_INVALID");
    }
    const existingVoucher = await queryable.query(
      "SELECT id, company_id, voucher_date::text FROM vouchers WHERE id=$1 AND company_id=$2",
      [result.cloudVoucherId, event.companyId]
    );
    if (existingVoucher.rows.length !== 1 ||
        String(existingVoucher.rows[0].voucher_date).slice(0, 10) !== result.businessDate) {
      throw new Phase8ApplyRefusal("PHASE8_POSTING_READ_AFTER_APPLY_FAILED");
    }
    await queryable.query(`
      INSERT INTO factory_edge_applied_vouchers
        (site_id, sequence, operation_id, company_id, actor_user_id,
         local_voucher_id, cloud_voucher_id, payload_sha256, business_date)
      VALUES ($1::uuid,$2::bigint,$3::uuid,$4,$5,$6,$7,$8,$9::date)
    `, [approved.siteId, sequence, event.operationId, event.companyId,
        event.actorUserId, event.localVoucherId, result.cloudVoucherId,
        event.payloadSha256, result.businessDate]);
    await queryable.query(
      "UPDATE factory_edge_apply_cursor SET last_sequence=$2::bigint WHERE site_id=$1::uuid",
      [approved.siteId, sequence]
    );
    await queryable.query("COMMIT");
    return {
      sequence, operationId: event.operationId, payloadSha256: event.payloadSha256,
      companyId: event.companyId, localVoucherId: event.localVoucherId,
      cloudVoucherId: result.cloudVoucherId, businessDate: result.businessDate,
      state: "cloud-applied", replayed: false,
    };
  } catch (error) {
    await queryable.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
