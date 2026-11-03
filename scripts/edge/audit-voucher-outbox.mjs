#!/usr/bin/env node
/**
 * Read-only local evidence health report. Does not contact cloud, modify
 * receipts, decrypt payloads or indicate that vouchers were applied in cloud.
 */
import { Client } from "pg";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function evaluateVoucherOutboxAudit(row) {
  const total = Number(row.total);
  const staged = Number(row.staged);
  const pending = Number(row.pending);
  const lastSequence = BigInt(row.lastSequence);
  const invalidReceipts = Number(row.invalidReceipts);
  const gaps = Number(row.gaps);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(staged) ||
      !Number.isSafeInteger(pending) || !Number.isSafeInteger(invalidReceipts) ||
      !Number.isSafeInteger(gaps) || total < 0 || staged < 0 || pending < 0 ||
      invalidReceipts !== 0 || gaps !== 0 || staged + pending !== total ||
      lastSequence !== BigInt(total)) {
    throw new Error("EDGE_SYNC_OUTBOX_AUDIT_MISMATCH");
  }
  return {
    localVouchers: total,
    stagedEvidence: staged,
    pendingEvidence: pending,
    cloudVouchersApplied: "not-verified",
  };
}

export async function auditVoucherOutbox(env = process.env) {
  if (env.FACTORY_EDGE_MODE !== "lan" ||
      typeof env.FACTORY_EDGE_SITE_ID !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(env.FACTORY_EDGE_SITE_ID) ||
      !["postgres", "db", "localhost", "127.0.0.1", "::1"].includes(env.PGHOST) ||
      env.PGSSLMODE !== "disable") {
    throw new Error("EDGE_SYNC_AUDIT_REQUIRES_LOCAL_FACTORY_DB");
  }
  const client = new Client({
    host: env.PGHOST,
    port: Number(env.PGPORT || 5432),
    user: env.PGUSER,
    password: env.PGPASSWORD,
    database: env.PGDATABASE,
    ssl: false,
    connectionTimeoutMillis: 8000,
  });
  await client.connect();
  try {
    // One read-only snapshot prevents concurrent postings/receipts from making
    // counts appear inconsistent solely due to interleaved commits.
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const results = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM factory_edge_voucher_outbox WHERE site_id = $1::uuid)::text AS total,
        (SELECT COUNT(*) FROM factory_edge_stage_receipts WHERE site_id = $1::uuid)::text AS staged,
        (SELECT COUNT(*) FROM factory_edge_voucher_outbox o
          WHERE site_id = $1::uuid AND NOT EXISTS (
            SELECT 1 FROM factory_edge_stage_receipts r
              WHERE r.site_id = o.site_id AND r.sequence = o.sequence
          ))::text AS pending,
        COALESCE((SELECT last_sequence FROM factory_edge_outbox_counter WHERE site_id = $1::uuid), 0)::text AS "lastSequence",
        (SELECT COUNT(*) FROM factory_edge_stage_receipts r
          LEFT JOIN factory_edge_voucher_outbox o
            ON o.site_id = r.site_id AND o.sequence = r.sequence
          WHERE r.site_id = $1::uuid AND
            (o.sequence IS NULL OR o.operation_id <> r.operation_id OR
             o.payload_sha256 <> r.payload_sha256))::text AS "invalidReceipts",
        (SELECT COUNT(*) FROM (
          SELECT sequence, LAG(sequence, 1, 0) OVER (ORDER BY sequence) AS previous
          FROM factory_edge_voucher_outbox WHERE site_id = $1::uuid
        ) s WHERE s.sequence <> s.previous + 1)::text AS gaps
    `, [env.FACTORY_EDGE_SITE_ID]);
    const audit = evaluateVoucherOutboxAudit(results.rows[0]);
    await client.query("COMMIT");
    return audit;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  auditVoucherOutbox()
    .then((result) => console.log("Factory local voucher evidence audit:", JSON.stringify(result)))
    .catch((error) => {
      console.error("Factory evidence audit FAILED:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
