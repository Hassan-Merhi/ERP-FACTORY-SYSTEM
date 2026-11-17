/**
 * Phase 10 operator controls behind the app's buttons: pause / resume of
 * LAN -> cloud delivery and Admin/Developer decisions on held conflicts.
 *
 * The runtime role keeps SELECT-only access to the control tables
 * (factory_edge_sync_control_log, factory_edge_event_conflict_decisions; see
 * deploy/lan/phase7-prepare-restricted-role.sql). The buttons write through two
 * SECURITY DEFINER functions defined by migrations/ and owned by the migrating
 * role. Each function re-checks, in the database, that the
 * named user is ACTIVE and holds an approver role in that company before it
 * records anything, so the app cannot write a pause or a decision for a user
 * who could not make it. The Phase 7 writer fence still applies to the insert.
 */
import { isPhase9EventStream, phase9OverridableConflicts } from "./phase9EventProtocol.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEQUENCE = /^[1-9][0-9]{0,17}$/;
const DECISIONS = new Set(["reject-event", "approve-override"]);

export class Phase10OperatorRefusal extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "Phase10OperatorRefusal";
    this.status = status;
  }
}

function refusalFromDatabase(error) {
  const code = typeof error?.message === "string" ? error.message : "";
  if (/^PHASE(?:9|10)_[A-Z0-9_]+$/.test(code)) {
    const status = code.endsWith("_NOT_AUTHORIZED") ? 403 : code.endsWith("_NOT_FOUND") ? 404 : 409;
    return new Phase10OperatorRefusal(code, status);
  }
  if (error?.code === "23505") return new Phase10OperatorRefusal("PHASE9_CONFLICT_ALREADY_DECIDED", 409);
  return null;
}

export async function recordPhase10OperatorSyncControl(queryable, input) {
  const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
  if (
    !UUID.test(String(input?.siteId ?? "")) ||
    !Number.isSafeInteger(input?.companyId) ||
    input.companyId < 1 ||
    typeof input?.userId !== "string" ||
    (input?.action !== "pause" && input?.action !== "resume") ||
    reason.length < 10 ||
    reason.length > 500
  ) {
    throw new Phase10OperatorRefusal("PHASE10_SYNC_CONTROL_INVALID");
  }
  try {
    await queryable.query("SELECT public.factory_edge_operator_sync_control($1::uuid, $2, $3, $4, $5)", [
      input.siteId,
      input.companyId,
      input.userId,
      input.action,
      reason,
    ]);
  } catch (error) {
    throw refusalFromDatabase(error) ?? error;
  }
}

/** Open (undecided) conflicts of one site and company, newest sequence last. */
export async function listPhase10OpenConflicts(queryable, input) {
  if (!UUID.test(String(input?.siteId ?? "")) || !Number.isSafeInteger(input?.companyId)) {
    throw new Phase10OperatorRefusal("PHASE10_CONFLICT_SCOPE_INVALID");
  }
  const rows = await queryable.query(
    `SELECT k.stream, k.sequence::text AS sequence, k.operation_kind, k.code, k.detail,
            k.detected_at, k.operation_id::text AS operation_id
       FROM factory_edge_event_conflicts k
      WHERE k.site_id = $1::uuid AND k.company_id = $2
        AND NOT EXISTS (SELECT 1 FROM factory_edge_event_conflict_decisions d
                         WHERE d.site_id = k.site_id AND d.stream = k.stream AND d.sequence = k.sequence)
      ORDER BY k.stream, k.sequence
      LIMIT 200`,
    [input.siteId, input.companyId]
  );
  return rows.rows.map((row) => ({
    stream: String(row.stream),
    sequence: String(row.sequence),
    operationId: String(row.operation_id),
    kind: String(row.operation_kind),
    code: String(row.code),
    detail: row.detail && typeof row.detail === "object" ? row.detail : {},
    detectedAt: new Date(row.detected_at).toISOString(),
    canApprove:
      isPhase9EventStream(row.stream) &&
      phase9OverridableConflicts(String(row.stream), String(row.operation_kind)).includes(String(row.code)),
  }));
}

export async function decidePhase10Conflict(queryable, input) {
  const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
  if (
    !UUID.test(String(input?.siteId ?? "")) ||
    !isPhase9EventStream(input?.stream) ||
    !SEQUENCE.test(String(input?.sequence ?? "")) ||
    !DECISIONS.has(input?.decision) ||
    typeof input?.userId !== "string" ||
    reason.length < 10 ||
    reason.length > 500
  ) {
    throw new Phase10OperatorRefusal("PHASE9_CONFLICT_DECISION_INVALID");
  }
  if (input.decision === "approve-override") {
    // The registry decides what may be overridden; the apply re-checks it too.
    const conflict = await queryable.query(
      `SELECT code, operation_kind FROM factory_edge_event_conflicts
        WHERE site_id = $1::uuid AND stream = $2 AND sequence = $3::bigint
        ORDER BY id DESC LIMIT 1`,
      [input.siteId, input.stream, String(input.sequence)]
    );
    const row = conflict.rows[0];
    if (!row) throw new Phase10OperatorRefusal("PHASE9_CONFLICT_NOT_FOUND", 404);
    if (!phase9OverridableConflicts(input.stream, String(row.operation_kind)).includes(String(row.code))) {
      throw new Phase10OperatorRefusal("PHASE9_CONFLICT_NOT_OVERRIDABLE", 409);
    }
  }
  try {
    await queryable.query("SELECT public.factory_edge_operator_decide_conflict($1::uuid, $2, $3::bigint, $4, $5, $6)", [
      input.siteId,
      input.stream,
      String(input.sequence),
      input.decision,
      input.userId,
      reason,
    ]);
  } catch (error) {
    throw refusalFromDatabase(error) ?? error;
  }
  return { stream: input.stream, sequence: String(input.sequence), decision: input.decision };
}
