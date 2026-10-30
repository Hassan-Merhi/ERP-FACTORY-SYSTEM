#!/usr/bin/env node
/**
 * LAN-only HTTPS relay. Sends durable voucher evidence to the cloud staging
 * inbox with a signed request and records "staged" receipts, never "applied".
 *
 * Safe to rerun after WAN loss. Requires opt-in, a trusted HTTPS origin, and a
 * dedicated 48+ byte shared secret. Does not mutate any business ledger.
 */
import { Client } from "pg";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  EDGE_SYNC_STAGE_PATH,
  EDGE_SYNC_STAGE_VERSION,
  EDGE_SYNC_STAGE_LIMIT,
  hashEvidence,
  makeStageSignature,
} from "../../server/edge/edgeSyncStageProtocol.mjs";
import { readPhase10SyncControl } from "../../server/edge/phase10SyncControl.mjs";

export function readSenderConfiguration(env = process.env) {
  if (env.FACTORY_EDGE_MODE !== "lan" || env.FACTORY_SYNC_SENDER_ENABLED !== "1") {
    throw new Error("EDGE_SYNC_SENDER_NOT_ENABLED");
  }
  const url = new URL(env.FACTORY_SYNC_CLOUD_URL ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || url.port || !url.hostname.includes(".") ||
      isIP(url.hostname) || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".internal")) {
    throw new Error("EDGE_SYNC_CLOUD_URL_INVALID");
  }
  if (typeof env.FACTORY_EDGE_SITE_ID !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(env.FACTORY_EDGE_SITE_ID)) {
    throw new Error("EDGE_SYNC_SITE_INVALID");
  }
  if (typeof env.FACTORY_SYNC_HMAC_KEY !== "string" ||
      env.FACTORY_SYNC_HMAC_KEY.length < 48 || /^REPLACE/i.test(env.FACTORY_SYNC_HMAC_KEY)) {
    throw new Error("EDGE_SYNC_KEY_INVALID");
  }
  if (!["postgres", "db", "localhost", "127.0.0.1", "::1"].includes(env.PGHOST) ||
      !env.PGUSER || !env.PGPASSWORD || !env.PGDATABASE || env.PGSSLMODE !== "disable") {
    throw new Error("EDGE_SYNC_DATABASE_NOT_LOCAL");
  }
  return Object.freeze({
    endpoint: url.origin + EDGE_SYNC_STAGE_PATH,
    siteId: env.FACTORY_EDGE_SITE_ID,
    key: env.FACTORY_SYNC_HMAC_KEY,
  });
}

export function stagedEnvelope(rows, siteId) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > EDGE_SYNC_STAGE_LIMIT) {
    throw new Error("EDGE_SYNC_BATCH_SIZE_INVALID");
  }
  return {
    protocol: EDGE_SYNC_STAGE_VERSION,
    siteId,
    events: rows.map((row) => {
      const event = {
        sequence: String(row.sequence),
        operationId: String(row.operation_id),
        companyId: Number(row.company_id),
        actorUserId: String(row.actor_user_id),
        localVoucherId: Number(row.local_voucher_id),
        kind: String(row.operation_kind),
        payload: row.payload,
        payloadSha256: String(row.payload_sha256).trim(),
      };
      if (hashEvidence(event.payload) !== event.payloadSha256) {
        throw new Error("EDGE_SYNC_LOCAL_EVIDENCE_CHANGED");
      }
      return event;
    }),
  };
}

export function verifyStageReceipt(response, envelope) {
  if (!response || response.protocol !== "factory-lan-voucher-stage-receipt/v1" ||
      response.siteId !== envelope.siteId || response.state !== "staged-not-applied" ||
      !Array.isArray(response.events) || response.events.length !== envelope.events.length) {
    throw new Error("EDGE_SYNC_RECEIPT_INVALID");
  }
  for (let index = 0; index < envelope.events.length; index++) {
    const event = envelope.events[index];
    const confirmed = response.events[index];
    if (!confirmed || confirmed.state !== "staged-not-applied" ||
        confirmed.sequence !== event.sequence ||
        confirmed.operationId !== event.operationId ||
        confirmed.payloadSha256 !== event.payloadSha256) {
      throw new Error("EDGE_SYNC_RECEIPT_MISMATCH");
    }
  }
  return response.events;
}

async function persistStageReceipts(client, siteId, events) {
  await client.query("BEGIN");
  try {
    for (const e of events) {
      const existing = await client.query(
        `SELECT operation_id::text AS operation_id, payload_sha256
           FROM factory_edge_stage_receipts
          WHERE site_id = $1::uuid AND sequence = $2::bigint FOR UPDATE`,
        [siteId, e.sequence]
      );
      if (existing.rowCount) {
        const saved = existing.rows[0];
        if (saved.operation_id !== e.operationId || String(saved.payload_sha256).trim() !== e.payloadSha256) {
          throw new Error("EDGE_SYNC_RECEIPT_DIVERGENCE");
        }
        continue;
      }
      await client.query(
        `INSERT INTO factory_edge_stage_receipts
           (site_id, sequence, operation_id, payload_sha256, state)
         VALUES($1::uuid, $2::bigint, $3::uuid, $4, 'staged-not-applied')`,
        [siteId, e.sequence, e.operationId, e.payloadSha256]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function sendVoucherOutboxOnce({
  env = process.env,
  fetcher = fetch,
  maxBatches = 20,
} = {}) {
  const config = readSenderConfiguration(env);
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
  let confirmed = 0;
  try {
    // Phase 10: an operator pause stops transmission without touching evidence.
    const control = await readPhase10SyncControl(client, config.siteId).catch((error) => {
      if (error && error.code === "42P01") return { paused: false };
      throw error;
    });
    if (control.paused) return { staged: 0, applied: 0, paused: true };
    for (let page = 0; page < maxBatches; page++) {
      const result = await client.query(
        `SELECT o.sequence::text AS sequence, o.operation_id::text AS operation_id,
                o.company_id, o.actor_user_id, o.local_voucher_id,
                o.operation_kind, o.payload, o.payload_sha256
           FROM factory_edge_voucher_outbox o
          WHERE o.site_id = $1::uuid
            AND NOT EXISTS (
              SELECT 1 FROM factory_edge_stage_receipts r
               WHERE r.site_id = o.site_id AND r.sequence = o.sequence
            )
          ORDER BY o.sequence
          LIMIT $2`,
        [config.siteId, EDGE_SYNC_STAGE_LIMIT]
      );
      if (!result.rows.length) break;
      const envelope = stagedEnvelope(result.rows, config.siteId);
      const bytes = Buffer.from(JSON.stringify(envelope));
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await fetcher(config.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: {
          "Content-Type": "application/json",
          "X-Factory-Sync-Timestamp": timestamp,
          "X-Factory-Sync-Signature": makeStageSignature(bytes, timestamp, config.key),
        },
        body: bytes,
      });
      if (!response.ok) throw new Error("EDGE_SYNC_CLOUD_STAGING_REJECTED_" + response.status);
      const receipt = await response.json();
      const events = verifyStageReceipt(receipt, envelope);
      await persistStageReceipts(client, config.siteId, events);
      confirmed += events.length;
    }
    return { staged: confirmed, applied: 0 };
  } finally {
    await client.end();
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  sendVoucherOutboxOnce()
    .then(({ staged }) => console.log(`LAN voucher evidence staged: ${staged}; cloud business postings: 0`))
    .catch((error) => {
      console.error("LAN evidence transmission failed:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
