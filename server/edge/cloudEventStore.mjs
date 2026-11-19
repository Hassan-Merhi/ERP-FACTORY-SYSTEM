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
import { createHash } from "node:crypto";
import {
  EDGE_EVENT_RECEIPT_PROTOCOL,
  isPhase9EventStream,
  phase9OverridableConflicts,
  validatePhase9ReceiptQuery,
} from "./eventProtocol.mjs";
import { Phase9ApplyRefusal, Phase9StageConflict, SEQUENCE } from "./ensureCloudEventSchema.mjs";
import { RECEIPT_COLUMNS, receiptFromRow } from "./stageEvents.mjs";
import { applyStagedEventOnce } from "./applyStagedEventOnce.mjs";
export { Phase9ApplyRefusal, Phase9EventConflict, Phase9StageConflict } from "./ensureCloudEventSchema.mjs";
export { stagePhase9Events } from "./stageEvents.mjs";
export { applyStagedEventOnce } from "./applyStagedEventOnce.mjs";

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
    input.reason.trim().length < 10 ||
    (input.decision !== undefined && input.decision !== "reject-event" && input.decision !== "approve-override")
  ) {
    throw new Phase9ApplyRefusal("PHASE9_CONFLICT_DECISION_INVALID");
  }
  const decisionKind = input.decision ?? "reject-event";
  const conflict = await queryable.query(
    `SELECT id::text, code, operation_kind FROM factory_edge_event_conflicts
      WHERE site_id = $1::uuid AND stream = $2 AND sequence = $3::bigint
      ORDER BY id DESC LIMIT 1`,
    [input.siteId, input.stream, String(input.sequence)]
  );
  if (conflict.rows.length !== 1) throw new Phase9ApplyRefusal("PHASE9_CONFLICT_NOT_FOUND");
  if (
    decisionKind === "approve-override" &&
    !phase9OverridableConflicts(input.stream, conflict.rows[0].operation_kind).includes(conflict.rows[0].code)
  ) {
    throw new Phase9ApplyRefusal("PHASE9_CONFLICT_NOT_OVERRIDABLE");
  }
  await queryable.query(
    `INSERT INTO factory_edge_event_conflict_decisions
       (site_id, stream, sequence, conflict_id, decision, decided_by, reason)
     VALUES ($1::uuid, $2, $3::bigint, $4::bigint, $5, $6, $7)`,
    [
      input.siteId,
      input.stream,
      String(input.sequence),
      conflict.rows[0].id,
      decisionKind,
      input.decidedBy.trim(),
      input.reason.trim(),
    ]
  );
  return { stream: input.stream, sequence: String(input.sequence), decision: decisionKind };
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

const FILE_HASH = /^[0-9a-f]{64}$/;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Store the verified bytes of a staged attachment record. The caller has
 * authenticated the request; here the body must hash to the declared SHA-256
 * and a staged "attachments" record of this site must reference that digest.
 * Idempotent: the same file sent again is acknowledged without a new row.
 */
export async function stagePhase9AttachmentFile(queryable, siteId, sha256, bytes) {
  // A signed request may still carry a malformed body. Assert the concrete
  // Buffer type before reading its size; never trust an arbitrary .length.
  if (typeof sha256 !== "string" || !FILE_HASH.test(sha256) || !Buffer.isBuffer(bytes)) {
    throw new Phase9StageConflict("PHASE9_FILE_INVALID");
  }
  const byteSize = Buffer.byteLength(bytes);
  if (byteSize < 1 || byteSize > MAX_FILE_BYTES) {
    throw new Phase9StageConflict("PHASE9_FILE_INVALID");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Phase9StageConflict("PHASE9_FILE_HASH_MISMATCH");
  }
  const referenced = await queryable.query(
    `SELECT (payload->>'fileSize')::int AS file_size FROM factory_edge_staged_events
      WHERE site_id = $1::uuid AND stream = 'attachments' AND payload->>'sha256' = $2
      LIMIT 1`,
    [siteId, sha256]
  );
  if (!referenced.rows.length) throw new Phase9StageConflict("PHASE9_FILE_NOT_REFERENCED");
  if (Number(referenced.rows[0].file_size) !== byteSize) throw new Phase9StageConflict("PHASE9_FILE_SIZE_MISMATCH");
  await queryable.query(
    `INSERT INTO factory_edge_staged_files (site_id, file_sha256, byte_size, content)
     VALUES ($1::uuid, $2, $3, $4) ON CONFLICT (site_id, file_sha256) DO NOTHING`,
    [siteId, sha256, byteSize, bytes]
  );
  return { siteId, sha256, byteSize, state: "file-staged" };
}

/** The verified bytes for a staged attachment, or null if not yet received. */
export async function readPhase9StagedFile(queryable, siteId, sha256) {
  const result = await queryable.query(
    "SELECT content FROM factory_edge_staged_files WHERE site_id = $1::uuid AND file_sha256 = $2",
    [siteId, sha256]
  );
  return result.rows[0]?.content ?? null;
}
