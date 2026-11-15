// Extracted from ./phase9CloudEventStore.mjs to keep that module under the source-size cap.

export const SEQUENCE = /^[1-9][0-9]{0,18}$/;

export const MAX_SEQUENCE = 9223372036854775807n;

export const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const CODE = /^PHASE9_[A-Z0-9_]{3,80}$/;

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
      UNIQUE (site_id, operation_id)
    )
  `);
  // local_ref is NOT unique per stream: a follow-up record (a sale edit or
  // cancellation, a stock item delete, a transfer edit) names the same LAN row
  // as the record that created it, and a stream may mix kinds whose local
  // references come from different id spaces. Exactly-once rests on the
  // (site_id, operation_id) key and the gapless sequence; one LAN row -> one
  // record is enforced by each LAN outbox. Installs made before 2026-11-05
  // carry the old constraint, which would refuse such a record and stop the
  // stream, so it is dropped here.
  await queryable.query(`
    DO $$
    DECLARE c record;
    BEGIN
      FOR c IN
        SELECT con.conname
          FROM pg_constraint con
         WHERE con.conrelid = 'public.factory_edge_staged_events'::regclass
           AND con.contype = 'u'
           AND (SELECT array_agg(att.attname::text ORDER BY att.attname)
                  FROM unnest(con.conkey) AS k(attnum)
                  JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum)
               = ARRAY['company_id', 'local_ref', 'site_id', 'stream']
      LOOP
        EXECUTE format('ALTER TABLE public.factory_edge_staged_events DROP CONSTRAINT %I', c.conname);
      END LOOP;
    END $$
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
  // One decision per blocked sequence. "reject-event": the cloud keeps its
  // current state and the LAN event is recorded as not applied. Re-applying a
  // corrected event is a NEW operation, never an overwrite. "approve-override"
  // applies the event despite ONE recorded conflict code that its stream
  // declares overridable (for example stock going below zero); every other
  // check still runs.
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_event_conflict_decisions (
      site_id UUID NOT NULL,
      stream TEXT NOT NULL,
      sequence BIGINT NOT NULL CHECK (sequence > 0),
      conflict_id BIGINT NOT NULL REFERENCES factory_edge_event_conflicts(id) ON DELETE RESTRICT,
      decision TEXT NOT NULL CHECK (decision IN ('reject-event', 'approve-override')),
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
  // Phase 9 attachments: verified file bytes, content-addressed per site. A
  // file is accepted only for a staged attachment record with the same
  // SHA-256 (stagePhase9AttachmentFile), and is immutable once stored.
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_staged_files (
      site_id UUID NOT NULL,
      file_sha256 CHAR(64) NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
      byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
      content BYTEA NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, file_sha256),
      CHECK (octet_length(content) = byte_size),
      CHECK (encode(sha256(content), 'hex') = file_sha256)
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
    "factory_edge_staged_files",
  ]) {
    await queryable.query(`DROP TRIGGER IF EXISTS ${table}_no_modify ON ${table}`);
    await queryable.query(`
      CREATE TRIGGER ${table}_no_modify
      BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION factory_edge_event_evidence_immutable()
    `);
  }
}

export function rowEvent(row) {
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

export function sameEvidence(row, event) {
  return (
    String(row.operation_id) === event.operationId &&
    Number(row.company_id) === event.companyId &&
    String(row.actor_user_id) === event.actorUserId &&
    String(row.operation_kind) === event.kind &&
    Number(row.local_ref) === event.localRef &&
    String(row.payload_sha256).trim() === event.payloadSha256
  );
}
