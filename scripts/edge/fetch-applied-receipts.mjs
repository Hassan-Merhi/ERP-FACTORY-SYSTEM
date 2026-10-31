#!/usr/bin/env node
/**
 * Phase 8: read the cloud's committed apply receipts, match each to the
 * immutable LAN outbox and persist in an independent append-only local table.
 * A staging receipt is NOT proof of cloud business posting.
 */
import { Client } from "pg";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readSenderConfiguration } from "./send-voucher-outbox.mjs";
import { makeStageSignature } from "../../server/edge/edgeSyncStageProtocol.mjs";
import {
  PHASE8_RECEIPT_QUERY_PATH,
  PHASE8_RECEIPT_PROTOCOL,
  PHASE8_RECEIPT_QUERY_PROTOCOL,
} from "../../server/edge/phase8AppliedReceipts.mjs";

const POS = /^[1-9][0-9]{0,18}$/;
const SHA = /^[0-9a-f]{64}$/;

export function verifyAppliedReceiptResponse(response, siteId, originals) {
  if (!response || response.protocol !== PHASE8_RECEIPT_PROTOCOL ||
      response.siteId !== siteId || response.state !== "cloud-applied" ||
      !Array.isArray(response.events) || response.events.length > 25) {
    throw new Error("PHASE8_APPLIED_RECEIPT_INVALID");
  }
  const indexed = new Map(originals.map((row) => [String(row.sequence), row]));
  let previous = 0n;
  return response.events.map((item) => {
    if (!item || typeof item !== "object" || item.state !== "cloud-applied" ||
        typeof item.sequence !== "string" || !POS.test(item.sequence) ||
        BigInt(item.sequence) > 9223372036854775807n ||
        BigInt(item.sequence) <= previous ||
        !Number.isSafeInteger(item.cloudVoucherId) || item.cloudVoucherId <= 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(item.businessDate ?? "") ||
        typeof item.payloadSha256 !== "string" || !SHA.test(item.payloadSha256)) {
      throw new Error("PHASE8_APPLIED_RECEIPT_INVALID");
    }
    previous = BigInt(item.sequence);
    const original = indexed.get(item.sequence);
    if (!original || String(original.operation_id) !== item.operationId ||
        String(original.payload_sha256).trim() !== item.payloadSha256 ||
        Number(original.company_id) !== item.companyId ||
        String(original.actor_user_id) !== item.actorUserId ||
        Number(original.local_voucher_id) !== item.localVoucherId ||
        String(original.business_date).slice(0, 10) !== item.businessDate) {
      throw new Error("PHASE8_APPLIED_RECEIPT_DIVERGENCE");
    }
    return item;
  });
}

export async function persistAppliedReceipts(client, siteId, events) {
  await client.query("BEGIN");
  try {
    for (const item of events) {
      await client.query(`
        INSERT INTO factory_edge_applied_receipts
          (site_id, sequence, operation_id, payload_sha256, company_id,
           local_voucher_id, cloud_voucher_id, business_date, state)
        VALUES ($1::uuid,$2::bigint,$3::uuid,$4,$5,$6,$7,$8::date,'cloud-applied')
        ON CONFLICT (site_id, sequence) DO NOTHING
      `, [siteId, item.sequence, item.operationId, item.payloadSha256, item.companyId,
          item.localVoucherId, item.cloudVoucherId, item.businessDate]);
      const checked = await client.query(`
        SELECT operation_id::text, payload_sha256, company_id, local_voucher_id,
               cloud_voucher_id, business_date::text
        FROM factory_edge_applied_receipts
        WHERE site_id=$1::uuid AND sequence=$2::bigint
      `, [siteId, item.sequence]);
      const old = checked.rows[0];
      if (!old || String(old.operation_id) !== item.operationId ||
          String(old.payload_sha256).trim() !== item.payloadSha256 ||
          Number(old.company_id) !== item.companyId ||
          Number(old.local_voucher_id) !== item.localVoucherId ||
          Number(old.cloud_voucher_id) !== item.cloudVoucherId ||
          String(old.business_date).slice(0, 10) !== item.businessDate) {
        throw new Error("PHASE8_APPLIED_RECEIPT_DIVERGENCE");
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

export async function fetchAppliedReceiptsOnce({ env = process.env, fetcher = fetch } = {}) {
  const config = readSenderConfiguration(env);
  const client = new Client({
    host: env.PGHOST, port: Number(env.PGPORT || 5432),
    user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE,
    ssl: false, connectionTimeoutMillis: 8000,
  });
  await client.connect();
  try {
    const originals = await client.query(`
      SELECT o.sequence::text, o.operation_id::text, o.company_id,
             o.actor_user_id, o.local_voucher_id, o.payload_sha256,
             o.payload->'voucher'->>'voucherDate' AS business_date
      FROM factory_edge_voucher_outbox o
      INNER JOIN factory_edge_stage_receipts staged
        ON staged.site_id=o.site_id AND staged.sequence=o.sequence
      LEFT JOIN factory_edge_applied_receipts applied
        ON applied.site_id=o.site_id AND applied.sequence=o.sequence
      WHERE o.site_id=$1::uuid AND applied.sequence IS NULL
      ORDER BY o.sequence LIMIT 25
    `, [config.siteId]);
    if (!originals.rows.length) return { applied: 0 };
    const query = {
      protocol: PHASE8_RECEIPT_QUERY_PROTOCOL, siteId: config.siteId,
      fromSequence: String(originals.rows[0].sequence),
    };
    const bytes = Buffer.from(JSON.stringify(query));
    const timestamp = String(Math.floor(Date.now()/1000));
    const response = await fetcher(new URL(config.endpoint).origin + PHASE8_RECEIPT_QUERY_PATH, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": "application/json",
        "X-Factory-Sync-Timestamp": timestamp,
        "X-Factory-Sync-Signature": makeStageSignature(bytes, timestamp, config.key),
      },
      body: bytes,
    });
    if (!response.ok) throw new Error("PHASE8_CLOUD_RECEIPTS_UNAVAILABLE_" + response.status);
    const receipt = verifyAppliedReceiptResponse(await response.json(), config.siteId, originals.rows);
    await persistAppliedReceipts(client, config.siteId, receipt);
    return { applied: receipt.length };
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchAppliedReceiptsOnce().then(({ applied }) =>
    console.log(`Verified new cloud-applied receipts: ${applied}`)
  ).catch((error) => {
    console.error("PHASE8_RECEIPT_SYNC_REFUSED", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
