/**
 * Phase 9 read-only status projection for one authenticated actor's LAN voucher.
 * A browser HTTP 2xx is not proof of cloud application, nor is a stage ACK.
 * Only durable receipts verified against the LOCAL immutable outbox count.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class Phase9StatusRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9StatusRefusal";
  }
}

export function validPhase9OperationScope(scope) {
  return !!scope && UUID.test(scope.siteId ?? "") &&
    UUID.test(scope.operationId ?? "") &&
    Number.isSafeInteger(scope.companyId) && scope.companyId > 0 &&
    typeof scope.actorUserId === "string" &&
    scope.actorUserId.length > 0 && scope.actorUserId.length <= 255;
}

/** All selectors are parameterized; source identity limits receipt joins. */
export async function readPhase9OperationStatus(queryable, scope) {
  if (!validPhase9OperationScope(scope)) {
    throw new Phase9StatusRefusal("PHASE9_STATUS_SCOPE_INVALID");
  }
  const { rows } = await queryable.query(
    [
      "SELECT o.sequence::text AS sequence,",
      "o.operation_id::text AS operation_id,",
      "o.company_id, o.local_voucher_id, btrim(o.payload_sha256) AS payload_sha256,",
      "o.payload->'voucher'->>'voucherDate' AS business_date,",
      "s.operation_id::text AS stage_operation_id,",
      "btrim(s.payload_sha256) AS stage_payload_sha256, s.state AS stage_state,",
      "a.operation_id::text AS applied_operation_id,",
      "btrim(a.payload_sha256) AS applied_payload_sha256,",
      "a.company_id AS applied_company_id, a.local_voucher_id AS applied_local_voucher_id,",
      "a.business_date::text AS applied_business_date,",
      "a.cloud_voucher_id, a.state AS applied_state",
      "FROM factory_edge_voucher_outbox o",
      "LEFT JOIN factory_edge_stage_receipts s",
      "ON s.site_id=o.site_id AND s.sequence=o.sequence",
      "LEFT JOIN factory_edge_applied_receipts a",
      "ON a.site_id=o.site_id AND a.sequence=o.sequence",
      "WHERE o.site_id=$1::uuid AND o.operation_id=$2::uuid",
      "AND o.company_id=$3 AND o.actor_user_id=$4",
      "LIMIT 1",
    ].join("\n"),
    [scope.siteId, scope.operationId, scope.companyId, scope.actorUserId]
  );
  const row = rows[0];
  if (!row) return null;
  // A mismatched or impossible receipt is a conflict, NEVER proof of apply.
  const originalValid = String(row.operation_id).toLowerCase() === scope.operationId.toLowerCase() &&
    Number(row.company_id) === scope.companyId &&
    Number.isSafeInteger(Number(row.local_voucher_id)) && Number(row.local_voucher_id) > 0 &&
    SHA.test(String(row.payload_sha256 ?? ""));
  const stagePresent = row.stage_operation_id != null || row.stage_state != null ||
    row.stage_payload_sha256 != null;
  const stageValid = !stagePresent ||
    (row.stage_state === "staged-not-applied" &&
     String(row.stage_operation_id).toLowerCase() === scope.operationId.toLowerCase() &&
     row.stage_payload_sha256 === row.payload_sha256);
  const appliedPresent = row.applied_operation_id != null || row.applied_state != null ||
    row.applied_payload_sha256 != null;
  const appliedValid = !appliedPresent ||
    (stagePresent && stageValid && row.applied_state === "cloud-applied" &&
     String(row.applied_operation_id).toLowerCase() === scope.operationId.toLowerCase() &&
     row.applied_payload_sha256 === row.payload_sha256 &&
     Number(row.applied_company_id) === scope.companyId &&
     Number(row.applied_local_voucher_id) === Number(row.local_voucher_id) &&
     Number.isSafeInteger(Number(row.cloud_voucher_id)) && Number(row.cloud_voucher_id) > 0 &&
     ISO_DATE.test(String(row.business_date ?? "")) &&
     row.applied_business_date === row.business_date);
  const state = !originalValid || !stageValid || !appliedValid
    ? "conflict" : appliedPresent ? "cloud-applied" : stagePresent ? "staged" : "local-only";
  return {
    operationId: scope.operationId,
    companyId: scope.companyId,
    state,
    evidence: state === "cloud-applied" ? "verified-local-cloud-receipt"
      : state === "staged" ? "lan-staging-receipt"
        : state === "conflict" ? "receipt-mismatch" : "lan-outbox",
  };
}
