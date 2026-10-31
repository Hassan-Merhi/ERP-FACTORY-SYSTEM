#!/usr/bin/env node
/**
 * Phase 9 LAN relay for business EVENT streams (currently: pressing).
 *
 *  1. Stage: send unstaged immutable outbox rows, in sequence order, to the
 *     signed cloud inbox, and persist a "staged-not-applied" receipt ONLY when
 *     the cloud echoes the exact sequence / operation / payload hash.
 *  2. Receipts: fetch cloud apply receipts through the signed read-only query
 *     and persist one ONLY when it matches the local outbox row exactly
 *     (operation, company, actor, local reference, payload hash).
 *
 * Safe to rerun at any time (WAN loss, lost ACK, restart): every step is
 * idempotent and divergent evidence aborts instead of overwriting. It never
 * posts business effects anywhere and honours the Phase 10 pause switch.
 */
import { Client } from "pg";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { EVENT_STAGE_SIGNATURE_DOMAIN, hashEvidence, makeStageSignature } from "../../server/edge/edgeSyncStageProtocol.mjs";
import {
  EDGE_EVENT_RECEIPT_PROTOCOL,
  EDGE_EVENT_RECEIPT_QUERY_PATH,
  EDGE_EVENT_RECEIPT_QUERY_PROTOCOL,
  EDGE_EVENT_STAGE_LIMIT,
  EDGE_EVENT_STAGE_PATH,
  EDGE_EVENT_STAGE_PROTOCOL,
  EDGE_EVENT_STAGE_RECEIPT_PROTOCOL,
  EVENT_APPLY_OUTCOMES,
  validatePhase9Event,
} from "../../server/edge/phase9EventProtocol.mjs";
import { readPhase10SyncControl } from "../../server/edge/phase10SyncControl.mjs";
import { readSenderConfiguration } from "./send-voucher-outbox.mjs";

/** Each stream names its immutable LAN outbox and local reference column. */
export const STREAM_SOURCES = Object.freeze({
  pressing: Object.freeze({
    table: "factory_edge_pressing_outbox",
    localRef: "local_confirmation_id",
    // The cloud must post the scan on the LAN's shift production day.
    businessDate: (payload) => payload?.productionDate,
  }),
});

function source(stream) {
  if (!Object.prototype.hasOwnProperty.call(STREAM_SOURCES, stream)) throw new Error("EDGE_EVENT_STREAM_INVALID");
  return STREAM_SOURCES[stream];
}

export function readRelayConfiguration(env = process.env) {
  const base = readSenderConfiguration(env);
  const origin = new URL(base.endpoint).origin;
  return Object.freeze({
    siteId: base.siteId,
    key: base.key,
    stageEndpoint: origin + EDGE_EVENT_STAGE_PATH,
    receiptEndpoint: origin + EDGE_EVENT_RECEIPT_QUERY_PATH,
  });
}

export function eventEnvelope(rows, siteId, stream) {
  source(stream);
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > EDGE_EVENT_STAGE_LIMIT) {
    throw new Error("EDGE_EVENT_BATCH_SIZE_INVALID");
  }
  return {
    protocol: EDGE_EVENT_STAGE_PROTOCOL,
    siteId,
    stream,
    events: rows.map((row) => {
      const event = {
        sequence: String(row.sequence),
        operationId: String(row.operation_id),
        companyId: Number(row.company_id),
        actorUserId: String(row.actor_user_id),
        kind: String(row.operation_kind),
        localRef: Number(row.local_ref),
        payload: row.payload,
        payloadSha256: String(row.payload_sha256).trim(),
      };
      // Refuse to transmit evidence that no longer matches its own digest.
      if (hashEvidence(event.payload) !== event.payloadSha256) throw new Error("EDGE_EVENT_LOCAL_EVIDENCE_CHANGED");
      validatePhase9Event(stream, event);
      return event;
    }),
  };
}

export function verifyEventStageReceipt(response, envelope) {
  if (
    !response ||
    response.protocol !== EDGE_EVENT_STAGE_RECEIPT_PROTOCOL ||
    response.siteId !== envelope.siteId ||
    response.stream !== envelope.stream ||
    response.state !== "staged-not-applied" ||
    !Array.isArray(response.events) ||
    response.events.length !== envelope.events.length
  ) {
    throw new Error("EDGE_EVENT_STAGE_RECEIPT_INVALID");
  }
  envelope.events.forEach((event, index) => {
    const echoed = response.events[index];
    if (
      !echoed ||
      echoed.state !== "staged-not-applied" ||
      echoed.sequence !== event.sequence ||
      echoed.operationId !== event.operationId ||
      echoed.payloadSha256 !== event.payloadSha256
    ) {
      throw new Error("EDGE_EVENT_STAGE_RECEIPT_MISMATCH");
    }
  });
  return response.events;
}

/**
 * A cloud apply receipt is accepted only if it is internally consistent and
 * matches the LOCAL immutable outbox row for the same sequence exactly.
 */
export function verifyAppliedEventReceipts(response, { siteId, stream }, localBySequence) {
  if (
    !response ||
    response.protocol !== EDGE_EVENT_RECEIPT_PROTOCOL ||
    response.siteId !== siteId ||
    response.stream !== stream ||
    !Array.isArray(response.events) ||
    response.events.length > 25
  ) {
    throw new Error("EDGE_EVENT_APPLIED_RECEIPTS_INVALID");
  }
  const { businessDate } = source(stream);
  return response.events.map((receipt) => {
    const local = localBySequence.get(String(receipt?.sequence));
    const rejected = receipt?.outcome === "rejected-conflict";
    if (
      !local ||
      !EVENT_APPLY_OUTCOMES.includes(receipt.outcome) ||
      receipt.stream !== stream ||
      receipt.operationId !== String(local.operation_id) ||
      receipt.companyId !== Number(local.company_id) ||
      receipt.actorUserId !== String(local.actor_user_id) ||
      receipt.kind !== String(local.operation_kind) ||
      receipt.localRef !== Number(local.local_ref) ||
      receipt.payloadSha256 !== String(local.payload_sha256).trim() ||
      (rejected
        ? receipt.cloudRef !== null || receipt.businessDate !== null
        : !Number.isSafeInteger(receipt.cloudRef) ||
          receipt.cloudRef < 1 ||
          typeof receipt.businessDate !== "string" ||
          receipt.businessDate !== businessDate(local.payload))
    ) {
      throw new Error("EDGE_EVENT_APPLIED_RECEIPT_MISMATCH");
    }
    return receipt;
  });
}

async function postSigned(fetcher, url, body, key) {
  const bytes = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetcher(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      "Content-Type": "application/json",
      "X-Factory-Sync-Timestamp": timestamp,
      "X-Factory-Sync-Signature": makeStageSignature(bytes, timestamp, key, EVENT_STAGE_SIGNATURE_DOMAIN),
    },
    body: bytes,
  });
  if (!response.ok) throw new Error("EDGE_EVENT_CLOUD_REJECTED_" + response.status);
  return response.json();
}

function selectOutbox(stream) {
  const { table, localRef } = source(stream);
  return `SELECT o.sequence::text AS sequence, o.operation_id::text AS operation_id,
                 o.company_id, o.actor_user_id, o.${localRef} AS local_ref,
                 o.operation_kind, o.payload, o.payload_sha256
            FROM ${table} o`;
}

async function insertOnce(client, existingSql, existingArgs, same, insertSql, insertArgs, divergence) {
  const existing = await client.query(existingSql, existingArgs);
  if (existing.rowCount) {
    if (!same(existing.rows[0])) throw new Error(divergence);
    return false;
  }
  await client.query(insertSql, insertArgs);
  return true;
}

export async function relayEventStreamOnce({ client, config, stream, fetcher = fetch, maxBatches = 20 }) {
  const control = await readPhase10SyncControl(client, config.siteId).catch((error) => {
    // A missing control table means the reviewed schema predates Phase 10.
    if (error && error.code === "42P01") return { paused: false };
    throw error;
  });
  if (control.paused) return { stream, paused: true, staged: 0, receipts: 0 };

  let staged = 0;
  for (let page = 0; page < maxBatches; page++) {
    const pending = await client.query(
      `${selectOutbox(stream)}
        WHERE o.site_id = $1::uuid
          AND NOT EXISTS (SELECT 1 FROM factory_edge_event_stage_receipts r
                           WHERE r.site_id = o.site_id AND r.stream = $2 AND r.sequence = o.sequence)
        ORDER BY o.sequence LIMIT $3`,
      [config.siteId, stream, EDGE_EVENT_STAGE_LIMIT]
    );
    if (!pending.rows.length) break;
    const envelope = eventEnvelope(pending.rows, config.siteId, stream);
    const echoed = verifyEventStageReceipt(
      await postSigned(fetcher, config.stageEndpoint, envelope, config.key),
      envelope
    );
    await client.query("BEGIN");
    try {
      for (const event of echoed) {
        const inserted = await insertOnce(
          client,
          `SELECT operation_id::text AS operation_id, payload_sha256 FROM factory_edge_event_stage_receipts
            WHERE site_id = $1::uuid AND stream = $2 AND sequence = $3::bigint FOR UPDATE`,
          [config.siteId, stream, event.sequence],
          (row) => row.operation_id === event.operationId && String(row.payload_sha256).trim() === event.payloadSha256,
          `INSERT INTO factory_edge_event_stage_receipts (site_id, stream, sequence, operation_id, payload_sha256, state)
           VALUES ($1::uuid, $2, $3::bigint, $4::uuid, $5, 'staged-not-applied')`,
          [config.siteId, stream, event.sequence, event.operationId, event.payloadSha256],
          "EDGE_EVENT_STAGE_RECEIPT_DIVERGENCE"
        );
        if (inserted) staged++;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  let receipts = 0;
  for (let page = 0; page < maxBatches; page++) {
    const from = await client.query(
      `SELECT (COALESCE(MAX(sequence), 0) + 1)::text AS next
         FROM factory_edge_event_applied_receipts WHERE site_id = $1::uuid AND stream = $2`,
      [config.siteId, stream]
    );
    const response = await postSigned(
      fetcher,
      config.receiptEndpoint,
      {
        protocol: EDGE_EVENT_RECEIPT_QUERY_PROTOCOL,
        siteId: config.siteId,
        stream,
        fromSequence: from.rows[0].next,
      },
      config.key
    );
    const sequences = Array.isArray(response?.events) ? response.events.map((e) => String(e?.sequence)) : [];
    if (!sequences.length) break;
    const local = await client.query(`${selectOutbox(stream)} WHERE o.site_id = $1::uuid AND o.sequence = ANY($2::bigint[])`, [
      config.siteId,
      sequences,
    ]);
    const bySequence = new Map(local.rows.map((row) => [String(row.sequence), row]));
    const verified = verifyAppliedEventReceipts(response, { siteId: config.siteId, stream }, bySequence);
    await client.query("BEGIN");
    try {
      for (const receipt of verified) {
        const inserted = await insertOnce(
          client,
          `SELECT operation_id::text AS operation_id, payload_sha256, outcome FROM factory_edge_event_applied_receipts
            WHERE site_id = $1::uuid AND stream = $2 AND sequence = $3::bigint FOR UPDATE`,
          [config.siteId, stream, receipt.sequence],
          (row) =>
            row.operation_id === receipt.operationId &&
            String(row.payload_sha256).trim() === receipt.payloadSha256 &&
            row.outcome === receipt.outcome,
          `INSERT INTO factory_edge_event_applied_receipts
             (site_id, stream, sequence, operation_id, payload_sha256, company_id, local_ref,
              cloud_ref, business_date, outcome)
           VALUES ($1::uuid, $2, $3::bigint, $4::uuid, $5, $6, $7, $8, $9::date, $10)`,
          [
            config.siteId,
            stream,
            receipt.sequence,
            receipt.operationId,
            receipt.payloadSha256,
            receipt.companyId,
            receipt.localRef,
            receipt.cloudRef,
            receipt.businessDate,
            receipt.outcome,
          ],
          "EDGE_EVENT_APPLIED_RECEIPT_DIVERGENCE"
        );
        if (inserted) receipts++;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    if (verified.length < 25) break;
  }
  return { stream, paused: false, staged, receipts };
}

export async function relayAllEventStreams({ env = process.env, fetcher = fetch } = {}) {
  const config = readRelayConfiguration(env);
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
    const results = [];
    for (const stream of Object.keys(STREAM_SOURCES)) {
      results.push(await relayEventStreamOnce({ client, config, stream, fetcher }));
    }
    return results;
  } finally {
    await client.end();
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  relayAllEventStreams()
    .then((results) => console.log(JSON.stringify({ phase: 9, relay: results })))
    .catch((error) => {
      console.error("LAN event relay failed:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
