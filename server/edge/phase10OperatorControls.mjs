/**
 * Phase 10 operator controls behind the app's buttons: pause / resume of
 * LAN -> cloud delivery and Admin/Developer decisions on held conflicts.
 *
 * The runtime role keeps SELECT-only access to the control tables
 * (factory_edge_sync_control_log, factory_edge_event_conflict_decisions; see
 * deploy/lan/phase7-prepare-restricted-role.sql). The buttons write through two
 * SECURITY DEFINER functions installed by the reviewed DBA step and owned by
 * the installing role. Each function re-checks, in the database, that the
 * named user is ACTIVE and holds an approver role in that company before it
 * records anything, so the app cannot write a pause or a decision for a user
 * who could not make it. The Phase 7 writer fence still applies to the insert.
 */
import { isPhase9EventStream, phase9OverridableConflicts } from "./phase9EventProtocol.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEQUENCE = /^[1-9][0-9]{0,17}$/;
const DECISIONS = new Set(["reject-event", "approve-override"]);
const RUNTIME_ROLE = "erp_edge_runtime";

export class Phase10OperatorRefusal extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "Phase10OperatorRefusal";
    this.status = status;
  }
}

async function grantToRuntimeRole(queryable, signature) {
  await queryable.query(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
  const role = await queryable.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [RUNTIME_ROLE]);
  if (role.rows.length) await queryable.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${RUNTIME_ROLE}`);
}

/** LAN: pause / resume as a named Admin/Owner of the company. */
export async function ensurePhase10SyncControlFunction(queryable) {
  await queryable.query(`
    CREATE OR REPLACE FUNCTION public.factory_edge_operator_sync_control(
      p_site uuid, p_company integer, p_user_id text, p_action text, p_reason text)
    RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $fn$
    DECLARE
      v_name text;
      v_id bigint;
    BEGIN
      IF p_action IS NULL OR p_action NOT IN ('pause', 'resume')
         OR length(btrim(coalesce(p_reason, ''))) < 10 THEN
        RAISE EXCEPTION 'PHASE10_SYNC_CONTROL_INVALID' USING ERRCODE = '22023';
      END IF;
      SELECT u.username INTO v_name
        FROM users u
        JOIN user_company_roles r ON r.user_id = u.id AND r.company_id = p_company
       WHERE u.id = p_user_id AND u.active = true AND r.role IN ('Admin', 'Owner')
       LIMIT 1;
      IF v_name IS NULL THEN
        RAISE EXCEPTION 'PHASE10_OPERATOR_NOT_AUTHORIZED' USING ERRCODE = '42501';
      END IF;
      INSERT INTO factory_edge_sync_control_log (site_id, action, operator_name, reason)
      VALUES (p_site, p_action, v_name, btrim(p_reason))
      RETURNING id INTO v_id;
      RETURN v_id;
    END
    $fn$
  `);
  await grantToRuntimeRole(queryable, "public.factory_edge_operator_sync_control(uuid, integer, text, text, text)");
}

/** Cloud: approve or reject a held conflict as a named Admin/Developer of its company. */
export async function ensurePhase10ConflictDecisionFunction(queryable) {
  await queryable.query(`
    CREATE OR REPLACE FUNCTION public.factory_edge_operator_decide_conflict(
      p_site uuid, p_stream text, p_sequence bigint, p_decision text, p_user_id text, p_reason text)
    RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $fn$
    DECLARE
      v_conflict record;
      v_name text;
      v_id bigint;
    BEGIN
      IF p_decision IS NULL OR p_decision NOT IN ('reject-event', 'approve-override')
         OR length(btrim(coalesce(p_reason, ''))) < 10 THEN
        RAISE EXCEPTION 'PHASE9_CONFLICT_DECISION_INVALID' USING ERRCODE = '22023';
      END IF;
      SELECT id, company_id INTO v_conflict
        FROM factory_edge_event_conflicts
       WHERE site_id = p_site AND stream = p_stream AND sequence = p_sequence
       ORDER BY id DESC LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PHASE9_CONFLICT_NOT_FOUND' USING ERRCODE = '02000';
      END IF;
      SELECT u.username INTO v_name
        FROM users u
        JOIN user_company_roles r ON r.user_id = u.id AND r.company_id = v_conflict.company_id
       WHERE u.id = p_user_id AND u.active = true AND r.role IN ('Admin', 'Developer')
       LIMIT 1;
      IF v_name IS NULL THEN
        RAISE EXCEPTION 'PHASE9_REVIEWER_NOT_AUTHORIZED' USING ERRCODE = '42501';
      END IF;
      INSERT INTO factory_edge_event_conflict_decisions
        (site_id, stream, sequence, conflict_id, decision, decided_by, reason)
      VALUES (p_site, p_stream, p_sequence, v_conflict.id, p_decision, v_name, btrim(p_reason))
      RETURNING conflict_id INTO v_id;
      RETURN v_id;
    END
    $fn$
  `);
  await grantToRuntimeRole(
    queryable,
    "public.factory_edge_operator_decide_conflict(uuid, text, bigint, text, text, text)"
  );
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
