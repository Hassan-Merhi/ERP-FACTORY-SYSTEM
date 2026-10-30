#!/usr/bin/env node
/**
 * Phase 10/11 LAN operator preflight and monitoring report (read-only).
 *
 *   status    print per-stream evidence counts as JSON (for monitoring)
 *   handover  exit 0 ONLY when every LAN-captured operation, in every stream,
 *             has a verified cloud receipt (applied or operator-rejected).
 *             Run after freezing the LAN (read-only) and before returning
 *             write authority to the cloud or retiring the factory server.
 *
 * Stopping or restarting the LAN server is always data-safe: evidence is
 * committed in PostgreSQL with the business write. This check is about
 * whether the CLOUD has caught up, never about local durability.
 */
import { Client } from "pg";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readPhase10SyncControl } from "../../server/edge/phase10SyncControl.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STREAMS = Object.freeze([
  {
    stream: "vouchers",
    sql: `SELECT count(*)::int AS captured,
                 count(s.sequence)::int AS staged,
                 count(a.sequence)::int AS applied,
                 0::int AS rejected,
                 COALESCE(max(o.sequence), 0)::text AS last_sequence
            FROM factory_edge_voucher_outbox o
            LEFT JOIN factory_edge_stage_receipts s ON s.site_id = o.site_id AND s.sequence = o.sequence
            LEFT JOIN factory_edge_applied_receipts a
              ON a.site_id = o.site_id AND a.sequence = o.sequence AND a.operation_id = o.operation_id
                 AND btrim(a.payload_sha256) = btrim(o.payload_sha256)
           WHERE o.site_id = $1::uuid`,
  },
  {
    stream: "pressing",
    sql: `SELECT count(*)::int AS captured,
                 count(s.sequence)::int AS staged,
                 count(a.sequence) FILTER (WHERE a.outcome IN ('cloud-applied', 'already-present'))::int AS applied,
                 count(a.sequence) FILTER (WHERE a.outcome = 'rejected-conflict')::int AS rejected,
                 COALESCE(max(o.sequence), 0)::text AS last_sequence
            FROM factory_edge_pressing_outbox o
            LEFT JOIN factory_edge_event_stage_receipts s
              ON s.site_id = o.site_id AND s.stream = 'pressing' AND s.sequence = o.sequence
            LEFT JOIN factory_edge_event_applied_receipts a
              ON a.site_id = o.site_id AND a.stream = 'pressing' AND a.sequence = o.sequence
                 AND a.operation_id = o.operation_id AND btrim(a.payload_sha256) = btrim(o.payload_sha256)
           WHERE o.site_id = $1::uuid`,
  },
]);

export async function summarizeLanEvidence(client, siteId) {
  if (!UUID.test(siteId ?? "")) throw new Error("EDGE_SITE_ID_INVALID");
  const streams = [];
  for (const { stream, sql } of STREAMS) {
    try {
      const row = (await client.query(sql, [siteId])).rows[0];
      const pending = row.captured - row.applied - row.rejected;
      streams.push({
        stream,
        installed: true,
        captured: row.captured,
        notStaged: row.captured - row.staged,
        stagedNotApplied: pending - (row.captured - row.staged),
        applied: row.applied,
        rejectedByOperator: row.rejected,
        pending,
        lastSequence: row.last_sequence,
      });
    } catch (error) {
      if (error && error.code === "42P01") {
        streams.push({ stream, installed: false, captured: 0, pending: 0 });
        continue;
      }
      throw error;
    }
  }
  let control;
  try {
    control = await readPhase10SyncControl(client, siteId);
  } catch (error) {
    if (!error || error.code !== "42P01") throw error;
    control = { paused: false, operatorName: null, reason: null, recordedAt: null };
  }
  const pending = streams.reduce((sum, s) => sum + s.pending, 0);
  return {
    siteId,
    generatedAt: new Date().toISOString(),
    relayPaused: control.paused,
    relayControl: control,
    streams,
    pendingTotal: pending,
    handoverReady: pending === 0,
  };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const mode = process.argv[2];
  if (!["status", "handover"].includes(mode) || process.argv.length !== 3) {
    console.error("Usage: node scripts/edge/factory-handover-preflight.mjs status|handover");
    process.exitCode = 2;
  } else {
    const client = new Client({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      ssl: false,
      connectionTimeoutMillis: 8000,
    });
    client
      .connect()
      .then(() => summarizeLanEvidence(client, process.env.FACTORY_EDGE_SITE_ID))
      .then((report) => {
        console.log(JSON.stringify(report, null, 2));
        if (mode === "handover" && !report.handoverReady) {
          console.error(`HANDOVER_BLOCKED: ${report.pendingTotal} LAN operation(s) lack a verified cloud receipt`);
          process.exitCode = 1;
        }
      })
      .catch((error) => {
        console.error("PREFLIGHT_FAILED", error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      })
      .finally(() => client.end().catch(() => undefined));
  }
}
