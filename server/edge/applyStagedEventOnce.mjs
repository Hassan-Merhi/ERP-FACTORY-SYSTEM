// Extracted from ./phase9CloudEventStore.mjs to keep that module under the source-size cap.
import { translatePhase9LanStockItems } from "./phase9StockItemMap.mjs";
import { hasVerifiedCloudWriterAuthority, validatePhase8OperatorApproval } from "./phase8ApplyStore.mjs";
import {
  EVENT_APPLY_OUTCOMES,
  isPhase9EventStream,
  phase9OverridableConflicts,
  validatePhase9Event,
} from "./phase9EventProtocol.mjs";
import {
  DAY,
  MAX_SEQUENCE,
  Phase9ApplyRefusal,
  Phase9EventConflict,
  SEQUENCE,
  rowEvent,
  sameEvidence,
} from "./ensurePhase9CloudEventSchema.mjs";
import { RECEIPT_COLUMNS, receiptFromRow, recordConflict } from "./stagePhase9Events.mjs";

/**
 * Apply exactly one staged event. `handlers[kind]` provides
 *   authorize(client, event)      — throws Phase9EventConflict if the actor
 *                                   lost access since capture
 *   apply(client, event)          — { cloudRef, businessDate, outcome }
 *   verify(client, event, result) — read-after-apply proof, returns boolean
 */
export async function applyStagedEventOnce(queryable, input, handlers) {
  const approved = validatePhase8OperatorApproval(input);
  const stream = input.stream;
  if (!isPhase9EventStream(stream)) throw new Phase9ApplyRefusal("PHASE9_STREAM_INVALID");
  if (!SEQUENCE.test(String(input.sequence ?? "")) || BigInt(input.sequence) > MAX_SEQUENCE) {
    throw new Phase9ApplyRefusal("PHASE9_SEQUENCE_INVALID");
  }
  if (!handlers || typeof handlers !== "object") throw new Phase9ApplyRefusal("PHASE9_HANDLERS_MISSING");
  const sequence = String(input.sequence);
  let event = null;
  await queryable.query("BEGIN");
  try {
    await queryable.query("SET LOCAL lock_timeout = '5s'");
    await queryable.query(
      "INSERT INTO factory_edge_event_apply_cursor (site_id, stream) VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING",
      [approved.siteId, stream]
    );
    const cursor = await queryable.query(
      `SELECT last_sequence::text FROM factory_edge_event_apply_cursor
        WHERE site_id = $1::uuid AND stream = $2 FOR UPDATE`,
      [approved.siteId, stream]
    );
    if (cursor.rows.length !== 1) throw new Phase9ApplyRefusal("PHASE9_CURSOR_MISSING");
    const last = BigInt(cursor.rows[0].last_sequence);
    const candidate = BigInt(sequence);
    if (candidate > last + 1n) throw new Phase9ApplyRefusal("PHASE9_MISSING_PREDECESSOR");

    const staged = await queryable.query(
      `SELECT sequence::text, operation_id::text, company_id, actor_user_id, operation_kind,
              local_ref, payload, payload_sha256
         FROM factory_edge_staged_events
        WHERE site_id = $1::uuid AND stream = $2 AND sequence = $3::bigint`,
      [approved.siteId, stream, sequence]
    );
    if (staged.rows.length !== 1) throw new Phase9ApplyRefusal("PHASE9_STAGED_EVIDENCE_MISSING");
    event = rowEvent(staged.rows[0]);
    // Revalidate stored evidence: a staged row is never trusted blindly.
    try {
      validatePhase9Event(stream, event);
    } catch {
      throw new Phase9ApplyRefusal("PHASE9_STAGED_EVIDENCE_INVALID");
    }
    if (event.companyId !== approved.companyId) throw new Phase9ApplyRefusal("PHASE9_COMPANY_NOT_APPROVED");

    const prior = await queryable.query(
      `SELECT ${RECEIPT_COLUMNS} FROM factory_edge_applied_events
        WHERE site_id = $1::uuid AND stream = $2 AND sequence = $3::bigint`,
      [approved.siteId, stream, sequence]
    );
    if (candidate <= last) {
      // Lost acknowledgement: return the stored receipt, never re-apply.
      if (prior.rows.length !== 1 || !sameEvidence(prior.rows[0], event)) {
        throw new Phase9ApplyRefusal("PHASE9_DIVERGENT_REPLAY");
      }
      await queryable.query("COMMIT");
      return { ...receiptFromRow(prior.rows[0], stream), replayed: true };
    }
    if (prior.rows.length) throw new Phase9ApplyRefusal("PHASE9_CURSOR_RECEIPT_DIVERGED");

    if (!(await hasVerifiedCloudWriterAuthority(queryable, approved))) {
      throw new Phase9ApplyRefusal("PHASE9_CLOUD_WRITER_FENCE_UNVERIFIED");
    }

    const decision = await queryable.query(
      `SELECT d.decision, c.operation_id::text AS operation_id, c.code, c.operation_kind
         FROM factory_edge_event_conflict_decisions d
         JOIN factory_edge_event_conflicts c ON c.id = d.conflict_id
        WHERE d.site_id = $1::uuid AND d.stream = $2 AND d.sequence = $3::bigint`,
      [approved.siteId, stream, sequence]
    );
    let result;
    const decided = decision.rows.length === 1 ? decision.rows[0] : null;
    if (decided && decided.operation_id !== event.operationId) {
      throw new Phase9ApplyRefusal("PHASE9_CONFLICT_DECISION_INVALID");
    }
    if (decided && decided.decision === "reject-event") {
      result = { outcome: "rejected-conflict", cloudRef: null, businessDate: null };
    } else {
      let overrideConflicts = [];
      if (decided) {
        // Re-check against the registry at apply time, not only when recorded.
        if (
          decided.decision !== "approve-override" ||
          decided.operation_kind !== event.kind ||
          !phase9OverridableConflicts(stream, event.kind).includes(decided.code)
        ) {
          throw new Phase9ApplyRefusal("PHASE9_CONFLICT_DECISION_INVALID");
        }
        overrideConflicts = [decided.code];
      }
      const handler = Object.prototype.hasOwnProperty.call(handlers, event.kind) ? handlers[event.kind] : null;
      if (!handler) throw new Phase9ApplyRefusal("PHASE9_HANDLER_MISSING");
      // Plan batch 2: items created on the LAN are named by their LAN id; the
      // handler sees the cloud item instead (or the apply waits for its create).
      const handled = await translatePhase9LanStockItems(queryable, approved.siteId, event);
      await handler.authorize(queryable, handled);
      result = await handler.apply(queryable, handled, Object.freeze({ overrideConflicts, siteId: approved.siteId }));
      if (
        !result ||
        !["cloud-applied", "already-present"].includes(result.outcome) ||
        !Number.isSafeInteger(result.cloudRef) ||
        result.cloudRef < 1 ||
        typeof result.businessDate !== "string" ||
        !DAY.test(result.businessDate)
      ) {
        throw new Phase9ApplyRefusal("PHASE9_APPLY_RESULT_INVALID");
      }
      if (!(await handler.verify(queryable, handled, result))) {
        throw new Phase9ApplyRefusal("PHASE9_READ_AFTER_APPLY_FAILED");
      }
    }
    if (!EVENT_APPLY_OUTCOMES.includes(result.outcome)) throw new Phase9ApplyRefusal("PHASE9_APPLY_RESULT_INVALID");
    const inserted = await queryable.query(
      `INSERT INTO factory_edge_applied_events
         (site_id, stream, sequence, operation_id, company_id, actor_user_id, operation_kind,
          local_ref, cloud_ref, payload_sha256, business_date, outcome)
       VALUES ($1::uuid, $2, $3::bigint, $4::uuid, $5, $6, $7, $8, $9, $10, $11::date, $12)
       RETURNING ${RECEIPT_COLUMNS}`,
      [
        approved.siteId,
        stream,
        sequence,
        event.operationId,
        event.companyId,
        event.actorUserId,
        event.kind,
        event.localRef,
        result.cloudRef,
        event.payloadSha256,
        result.businessDate,
        result.outcome,
      ]
    );
    await queryable.query(
      "UPDATE factory_edge_event_apply_cursor SET last_sequence = $3::bigint WHERE site_id = $1::uuid AND stream = $2",
      [approved.siteId, stream, sequence]
    );
    await queryable.query("COMMIT");
    return { ...receiptFromRow(inserted.rows[0], stream), replayed: false };
  } catch (error) {
    await queryable.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Phase9EventConflict && event) {
      // The business transaction is gone; persist WHY the stream is blocked.
      await recordConflict(queryable, approved, stream, event, error);
    }
    throw error;
  }
}
