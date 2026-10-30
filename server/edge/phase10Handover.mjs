/**
 * Phase 10/11 read-only LAN evidence report: per-stream captured / staged /
 * applied / operator-rejected / pending counts and the relay pause state.
 * Shared by the operator CLI and the Admin/Owner status endpoint.
 */
import { readPhase10SyncControl } from "./phase10SyncControl.mjs";

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
