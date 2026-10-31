/**
 * Phase 9 cloud side of the generic LAN business-event streams.
 *
 *  stage  — signed evidence is written to an immutable, gapless per-stream
 *           inbox. A staging receipt NEVER means the business effect exists.
 *  apply  — operator-invoked, exactly-once replay of the next contiguous
 *           staged event, in ONE PostgreSQL transaction together with its
 *           immutable receipt and cursor advance. A lost ACK replays the
 *           stored receipt; divergent replays and gaps are refused.
 *  conflict — a deterministic business disagreement (for example the cloud
 *           already holds a different scan of the same bale) rolls the apply
 *           back, is written to an append-only conflict register, and BLOCKS
 *           the stream. Nothing is silently overwritten or skipped: only a
 *           named DBA/operator decision row can turn that sequence into an
 *           auditable "rejected-conflict" receipt and unblock the stream.
 *
 * Handlers MUST use the same client/transaction they are given.
 */
import { validatePhase8OperatorApproval, hasVerifiedCloudWriterAuthority } from "./phase8ApplyStore.mjs";
import {
  EDGE_EVENT_RECEIPT_PROTOCOL,
  EDGE_EVENT_STAGE_RECEIPT_PROTOCOL,
  EVENT_APPLY_OUTCOMES,
  isPhase9EventStream,
  validatePhase9Event,
  validatePhase9EventStageEnvelope,
  validatePhase9ReceiptQuery,
} from "./phase9EventProtocol.mjs";

const SEQUENCE = /^[1-9][0-9]{0,18}$/;
const MAX_SEQUENCE = 9223372036854775807n;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^PHASE9_[A-Z0-9_]{3,80}$/;

export class Phase9ApplyRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9ApplyRefusal";
  }
}

/** A business disagreement that needs a named human decision. */
export class Phase9EventConflict extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = "Phase9EventConflict";
    this.detail = detail;
  }
}

export class Phase9StageConflict extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9StageConflict";
  }
}

export async function ensurePhase9CloudEventSchema(queryable) {
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_event_stage_cursor (
      site_id UUID NOT NULL,
      stream TEXT NOT NULL CHECK (stream ~ '^[a-z][a-z0-9-]{1,40}$'),
      last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
      PRIMARY KEY (site_id, stream)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_staged_events (
      site_id UUID NOT NULL,
      stream TEXT NOT NULL,
      sequence BIGINT NOT NULL CHECK (sequence > 0),
      operation_id UUID NOT NULL,
      company_id INTEGER NOT NULL CHECK (company_id > 0),
      actor_user_id TEXT NOT NULL CHECK (length(actor_user_id) > 0),
      operation_kind TEXT NOT NULL,
      local_ref INTEGER NOT NULL CHECK (local_ref > 0),
      payload JSONB NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      staged_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, stream, sequence),
      UNIQUE (site_id, operation_id),
      UNIQUE (site_id, stream, company_id, local_ref)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_event_apply_cursor (
      site_id UUID NOT NULL,
      stream TEXT NOT NULL,
      last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
      PRIMARY KEY (site_id, stream)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_event_conflicts (
      id BIGSERIAL PRIMARY KEY,
      site_id UUID NOT NULL,
      stream TEXT NOT NULL,
      sequence BIGINT NOT NULL CHECK (sequence > 0),
      operation_id UUID NOT NULL,
      company_id INTEGER NOT NULL CHECK (company_id > 0),
      operation_kind TEXT NOT NULL,
      code TEXT NOT NULL CHECK (code ~ '^PHASE9_[A-Z0-9_]{3,80}$'),
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      detected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (site_id, stream, sequence, code)
    )
  `);
  // One decision per blocked sequence. Only "reject-event" exists: the cloud
  // keeps its current state and the LAN event is recorded as not applied.
  // Re-applying a corrected event is a NEW operation, never an overwrite.
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_event_conflict_decisions (
      site_id UUID NOT NULL,
      stream TEXT NOT NULL,
      sequence BIGINT NOT NULL CHECK (sequence > 0),
      conflict_id BIGINT NOT NULL REFERENCES factory_edge_event_conflicts(id) ON DELETE RESTRICT,
      decision TEXT NOT NULL CHECK (decision = 'reject-event'),
      decided_by TEXT NOT NULL CHECK (length(btrim(decided_by)) >= 3),
      reason TEXT NOT NULL CHECK (length(btrim(reason)) >= 10),
      decided_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, stream, sequence)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_applied_events (
      site_id UUID NOT NULL,
      stream TEXT NOT NULL,
      sequence BIGINT NOT NULL CHECK (sequence > 0),
      operation_id UUID NOT NULL,
      company_id INTEGER NOT NULL CHECK (company_id > 0),
      actor_user_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL,
      local_ref INTEGER NOT NULL CHECK (local_ref > 0),
      cloud_ref INTEGER CHECK (cloud_ref > 0),
      payload_sha256 CHAR(64) NOT NULL,
      business_date DATE,
      outcome TEXT NOT NULL
        CHECK (outcome IN ('cloud-applied', 'already-present', 'rejected-conflict')),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, stream, sequence),
      UNIQUE (site_id, operation_id),
      CHECK ((outcome = 'rejected-conflict') = (cloud_ref IS NULL)),
      CHECK ((outcome = 'rejected-conflict') = (business_date IS NULL))
    )
  `);
  await queryable.query(`
    CREATE OR REPLACE FUNCTION factory_edge_event_evidence_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'PHASE9_EVENT_EVIDENCE_IMMUTABLE' USING ERRCODE = '23514';
    END $$
  `);
  for (const table of [
    "factory_edge_staged_events",
    "factory_edge_event_conflicts",
    "factory_edge_event_conflict_decisions",
    "factory_edge_applied_events",
  ]) {
    await queryable.query(`DROP TRIGGER IF EXISTS ${table}_no_modify ON ${table}`);
    await queryable.query(`
      CREATE TRIGGER ${table}_no_modify
      BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION factory_edge_event_evidence_immutable()
    `);
  }
}

function rowEvent(row) {
  return {
    sequence: String(row.sequence),
    operationId: String(row.operation_id),
    companyId: Number(row.company_id),
    actorUserId: String(row.actor_user_id),
    kind: String(row.operation_kind),
    localRef: Number(row.local_ref),
    payload: row.payload,
    payloadSha256: String(row.payload_sha256).trim(),
  };
}

function sameEvidence(row, event) {
  return (
    String(row.operation_id) === event.operationId &&
    Number(row.company_id) === event.companyId &&
    String(row.actor_user_id) === event.actorUserId &&
    String(row.operation_kind) === event.kind &&
    Number(row.local_ref) === event.localRef &&
    String(row.payload_sha256).trim() === event.payloadSha256
  );
}

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

function receiptFromRow(row, stream) {
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

const RECEIPT_COLUMNS = `sequence::text, operation_id::text, company_id, actor_user_id, operation_kind,
  local_ref, cloud_ref, payload_sha256, business_date::text, outcome`;

async function recordConflict(queryable, approved, stream, event, conflict) {
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
      `SELECT d.decision, c.operation_id::text AS operation_id
         FROM factory_edge_event_conflict_decisions d
         JOIN factory_edge_event_conflicts c ON c.id = d.conflict_id
        WHERE d.site_id = $1::uuid AND d.stream = $2 AND d.sequence = $3::bigint`,
      [approved.siteId, stream, sequence]
    );
    let result;
    if (decision.rows.length === 1) {
      if (decision.rows[0].decision !== "reject-event" || decision.rows[0].operation_id !== event.operationId) {
        throw new Phase9ApplyRefusal("PHASE9_CONFLICT_DECISION_INVALID");
      }
      result = { outcome: "rejected-conflict", cloudRef: null, businessDate: null };
    } else {
      const handler = Object.prototype.hasOwnProperty.call(handlers, event.kind) ? handlers[event.kind] : null;
      if (!handler) throw new Phase9ApplyRefusal("PHASE9_HANDLER_MISSING");
      await handler.authorize(queryable, event);
      result = await handler.apply(queryable, event);
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
      if (!(await handler.verify(queryable, event, result))) {
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

/** Apply every contiguous staged event, stopping at the first refusal/conflict. */
export async function applyPendingStagedEvents(queryable, input, handlers, limit = 500) {
  const receipts = [];
  for (let index = 0; index < limit; index++) {
    const next = await queryable.query(
      `SELECT (COALESCE(
                 (SELECT last_sequence FROM factory_edge_event_apply_cursor
                   WHERE site_id = $1::uuid AND stream = $2), 0) + 1)::text AS next,
              EXISTS (SELECT 1 FROM factory_edge_staged_events s
                       WHERE s.site_id = $1::uuid AND s.stream = $2
                         AND s.sequence = COALESCE(
                           (SELECT last_sequence FROM factory_edge_event_apply_cursor
                             WHERE site_id = $1::uuid AND stream = $2), 0) + 1) AS staged`,
      [input.siteId, input.stream]
    );
    if (!next.rows[0].staged) break;
    receipts.push(await applyStagedEventOnce(queryable, { ...input, sequence: next.rows[0].next }, handlers));
  }
  return receipts;
}

/**
 * DBA/operator decision for a blocked sequence. Requires an existing,
 * recorded conflict for that exact sequence; the decision itself is immutable.
 */
export async function recordPhase9ConflictDecision(queryable, input) {
  if (
    !input ||
    !isPhase9EventStream(input.stream) ||
    !SEQUENCE.test(String(input.sequence ?? "")) ||
    typeof input.siteId !== "string" ||
    typeof input.decidedBy !== "string" ||
    input.decidedBy.trim().length < 3 ||
    typeof input.reason !== "string" ||
    input.reason.trim().length < 10
  ) {
    throw new Phase9ApplyRefusal("PHASE9_CONFLICT_DECISION_INVALID");
  }
  const conflict = await queryable.query(
    `SELECT id::text FROM factory_edge_event_conflicts
      WHERE site_id = $1::uuid AND stream = $2 AND sequence = $3::bigint
      ORDER BY id DESC LIMIT 1`,
    [input.siteId, input.stream, String(input.sequence)]
  );
  if (conflict.rows.length !== 1) throw new Phase9ApplyRefusal("PHASE9_CONFLICT_NOT_FOUND");
  await queryable.query(
    `INSERT INTO factory_edge_event_conflict_decisions
       (site_id, stream, sequence, conflict_id, decision, decided_by, reason)
     VALUES ($1::uuid, $2, $3::bigint, $4::bigint, 'reject-event', $5, $6)`,
    [
      input.siteId,
      input.stream,
      String(input.sequence),
      conflict.rows[0].id,
      input.decidedBy.trim(),
      input.reason.trim(),
    ]
  );
  return { stream: input.stream, sequence: String(input.sequence), decision: "reject-event" };
}

/** Signed read-only receipt lookup for the LAN. Staging is never returned. */
export async function getPhase9AppliedReceipts(queryable, body, expectedSiteId) {
  const query = validatePhase9ReceiptQuery(body, expectedSiteId);
  const rows = await queryable.query(
    `SELECT ${RECEIPT_COLUMNS} FROM factory_edge_applied_events
      WHERE site_id = $1::uuid AND stream = $2 AND sequence >= $3::bigint
      ORDER BY sequence ASC LIMIT 25`,
    [expectedSiteId, query.stream, query.fromSequence]
  );
  return {
    protocol: EDGE_EVENT_RECEIPT_PROTOCOL,
    siteId: expectedSiteId,
    stream: query.stream,
    events: rows.rows.map((row) => receiptFromRow(row, query.stream)),
  };
}

/** Operator visibility: per-stream staged / applied / blocked counts. */
export async function summarizePhase9CloudStreams(queryable, siteId) {
  const rows = await queryable.query(
    `SELECT s.stream,
            COALESCE(MAX(s.sequence), 0)::text AS staged_through,
            COALESCE((SELECT last_sequence FROM factory_edge_event_apply_cursor c
                       WHERE c.site_id = s.site_id AND c.stream = s.stream), 0)::text AS applied_through,
            (SELECT count(*)::int FROM factory_edge_event_conflicts k
              WHERE k.site_id = s.site_id AND k.stream = s.stream
                AND NOT EXISTS (SELECT 1 FROM factory_edge_event_conflict_decisions d
                                 WHERE d.site_id = k.site_id AND d.stream = k.stream
                                   AND d.sequence = k.sequence)) AS open_conflicts
       FROM factory_edge_staged_events s
      WHERE s.site_id = $1::uuid
      GROUP BY s.site_id, s.stream
      ORDER BY s.stream`,
    [siteId]
  );
  return rows.rows.map((row) => ({
    stream: String(row.stream),
    stagedThrough: String(row.staged_through),
    appliedThrough: String(row.applied_through),
    openConflicts: Number(row.open_conflicts),
  }));
}
