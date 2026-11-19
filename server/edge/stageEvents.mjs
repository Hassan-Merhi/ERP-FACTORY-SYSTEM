// Extracted from ./cloudEventStore.mjs to keep that module under the source-size cap.
import { EDGE_EVENT_STAGE_RECEIPT_PROTOCOL, validatePhase9EventStageEnvelope } from "./eventProtocol.mjs";
import { CODE, Phase9StageConflict, sameEvidence } from "./ensureCloudEventSchema.mjs";

/** Stage a signed, validated batch. Idempotent for identical replays. */
export async function stagePhase9Events(pool, body, siteId) {
  const events = validatePhase9EventStageEnvelope(body, siteId);
  const stream = body.stream;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO factory_edge_event_stage_cursor (site_id, stream) VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING",
      [siteId, stream]
    );
    const cursor = await client.query(
      `SELECT last_sequence::text AS last_sequence FROM factory_edge_event_stage_cursor
        WHERE site_id = $1::uuid AND stream = $2 FOR UPDATE`,
      [siteId, stream]
    );
    let last = BigInt(cursor.rows[0].last_sequence);
    for (const event of events) {
      const existing = await client.query(
        `SELECT operation_id::text AS operation_id, company_id, actor_user_id, operation_kind,
                local_ref, payload_sha256
           FROM factory_edge_staged_events
          WHERE site_id = $1::uuid AND stream = $2 AND sequence = $3::bigint`,
        [siteId, stream, event.sequence]
      );
      if (existing.rowCount) {
        if (!sameEvidence(existing.rows[0], event)) throw new Phase9StageConflict("EDGE_EVENT_DIVERGENT_REPLAY");
        continue;
      }
      if (BigInt(event.sequence) !== last + 1n) throw new Phase9StageConflict("EDGE_EVENT_MISSING_PREDECESSOR");
      try {
        await client.query(
          `INSERT INTO factory_edge_staged_events
             (site_id, stream, sequence, operation_id, company_id, actor_user_id,
              operation_kind, local_ref, payload, payload_sha256)
           VALUES ($1::uuid, $2, $3::bigint, $4::uuid, $5, $6, $7, $8, $9::jsonb, $10)`,
          [
            siteId,
            stream,
            event.sequence,
            event.operationId,
            event.companyId,
            event.actorUserId,
            event.kind,
            event.localRef,
            JSON.stringify(event.payload),
            event.payloadSha256,
          ]
        );
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505") {
          throw new Phase9StageConflict("EDGE_EVENT_DUPLICATE_OPERATION");
        }
        throw error;
      }
      last = BigInt(event.sequence);
    }
    await client.query(
      "UPDATE factory_edge_event_stage_cursor SET last_sequence = $3::bigint WHERE site_id = $1::uuid AND stream = $2",
      [siteId, stream, last.toString()]
    );
    await client.query("COMMIT");
    return {
      protocol: EDGE_EVENT_STAGE_RECEIPT_PROTOCOL,
      siteId,
      stream,
      state: "staged-not-applied",
      lastSequence: last.toString(),
      events: events.map((event) => ({
        sequence: event.sequence,
        operationId: event.operationId,
        payloadSha256: event.payloadSha256,
        state: "staged-not-applied",
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function receiptFromRow(row, stream) {
  return {
    stream,
    sequence: String(row.sequence),
    operationId: String(row.operation_id),
    companyId: Number(row.company_id),
    actorUserId: String(row.actor_user_id),
    kind: String(row.operation_kind),
    localRef: Number(row.local_ref),
    cloudRef: row.cloud_ref === null ? null : Number(row.cloud_ref),
    payloadSha256: String(row.payload_sha256).trim(),
    businessDate: row.business_date === null ? null : String(row.business_date).slice(0, 10),
    outcome: String(row.outcome),
  };
}

export const RECEIPT_COLUMNS = `sequence::text, operation_id::text, company_id, actor_user_id, operation_kind,
  local_ref, cloud_ref, payload_sha256, business_date::text, outcome`;

export async function recordConflict(queryable, approved, stream, event, conflict) {
  const code = CODE.test(conflict.message) ? conflict.message : "PHASE9_CONFLICT_UNCLASSIFIED";
  await queryable.query("BEGIN");
  try {
    await queryable.query(
      `INSERT INTO factory_edge_event_conflicts
         (site_id, stream, sequence, operation_id, company_id, operation_kind, code, detail)
       VALUES ($1::uuid, $2, $3::bigint, $4::uuid, $5, $6, $7, $8::jsonb)
       ON CONFLICT (site_id, stream, sequence, code) DO NOTHING`,
      [
        approved.siteId,
        stream,
        event.sequence,
        event.operationId,
        event.companyId,
        event.kind,
        code,
        JSON.stringify(conflict.detail ?? {}),
      ]
    );
    await queryable.query("COMMIT");
  } catch (error) {
    await queryable.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
