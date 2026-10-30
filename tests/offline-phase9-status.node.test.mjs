import assert from "node:assert/strict";
import { test } from "node:test";
import { readPhase9OperationStatus, validPhase9OperationScope } from "../server/edge/phase9OperationStatus.mjs";

const scope = {
  siteId: "027d7472-4a29-4bb3-a4aa-5b30e4ad631f",
  operationId: "e53cdbd1-7c4b-4b5c-9a60-b4f9de710b8c",
  companyId: 42,
  actorUserId: "worker-7",
};
const original = {
  sequence: "9",
  operation_id: scope.operationId,
  company_id: 42,
  local_voucher_id: 107,
  payload_sha256: "a".repeat(64),
  business_date: "2026-10-30",
  stage_operation_id: null,
  stage_payload_sha256: null,
  stage_state: null,
  applied_operation_id: null,
  applied_payload_sha256: null,
  applied_company_id: null,
  applied_local_voucher_id: null,
  applied_business_date: null,
  cloud_voucher_id: null,
  applied_state: null,
};
const stage = {
  stage_operation_id: scope.operationId,
  stage_payload_sha256: "a".repeat(64),
  stage_state: "staged-not-applied",
};
const apply = {
  applied_operation_id: scope.operationId,
  applied_payload_sha256: "a".repeat(64),
  applied_company_id: 42,
  applied_local_voucher_id: 107,
  applied_business_date: "2026-10-30",
  cloud_voucher_id: 908,
  applied_state: "cloud-applied",
};
function fixture(row) {
  const calls = [];
  const queryable = {
    query: async (sql, args) => {
      calls.push({ sql, args });
      return { rows: row ? [row] : [] };
    },
  };
  return { queryable, calls };
}
test("status SQL is scoped to site, operation, company and actor; unknown is not disclosed", async () => {
  const { queryable, calls } = fixture(null);
  assert.equal(await readPhase9OperationStatus(queryable, scope), null);
  assert.deepEqual(calls[0].args, [scope.siteId, scope.operationId, 42, "worker-7"]);
  assert.match(calls[0].sql, /o\.company_id=\$3 AND o\.actor_user_id=\$4/);
  assert.doesNotMatch(calls[0].sql, /SELECT\s+\*/);
});
test("local-only, staged, cloud-applied require separate durable receipt evidence", async () => {
  for (const [row, expected] of [
    [original, "local-only"],
    [{ ...original, ...stage }, "staged"],
    [{ ...original, ...stage, ...apply }, "cloud-applied"],
  ]) {
    const status = await readPhase9OperationStatus(fixture(row).queryable, scope);
    assert.equal(status.state, expected);
    assert.equal(status.operationId, scope.operationId);
    assert.equal(status.companyId, 42);
    assert.equal("cloudVoucherId" in status, false);
  }
});
test("forged or divergent stage/apply receipts cannot become cloud-applied", async () => {
  for (const corrupted of [
    { ...original, ...apply },
    { ...original, ...stage, stage_payload_sha256: "b".repeat(64) },
    { ...original, ...stage, stage_state: "cloud-applied" },
    { ...original, ...stage, ...apply, applied_payload_sha256: "b".repeat(64) },
    { ...original, ...stage, ...apply, applied_company_id: 24 },
    { ...original, ...stage, ...apply, applied_local_voucher_id: 108 },
    { ...original, ...stage, ...apply, applied_business_date: "2026-10-29" },
    { ...original, ...stage, ...apply, cloud_voucher_id: null },
    { ...original, ...stage, ...apply, applied_operation_id: scope.siteId },
    { ...original, ...stage, ...apply, applied_state: "staged-not-applied" },
  ]) {
    assert.equal((await readPhase9OperationStatus(fixture(corrupted).queryable, scope)).state, "conflict");
  }
});
test("invalid actor and UUID cannot reach the database", async () => {
  assert.equal(validPhase9OperationScope({ ...scope, companyId: 0 }), false);
  assert.equal(validPhase9OperationScope({ ...scope, actorUserId: "" }), false);
  assert.equal(validPhase9OperationScope({ ...scope, operationId: "' OR 1=1" }), false);
  const { queryable, calls } = fixture(original);
  await assert.rejects(
    readPhase9OperationStatus(queryable, { ...scope, actorUserId: "" }),
    /PHASE9_STATUS_SCOPE_INVALID/
  );
  assert.equal(calls.length, 0);
});
