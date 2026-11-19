// Extracted from ./cloudEventStore.mjs to keep that module under the source-size cap.

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
