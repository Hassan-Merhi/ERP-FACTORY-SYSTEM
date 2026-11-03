import test from "node:test";
import assert from "node:assert/strict";
import { Phase9PressingRefusal, phase9PressingEnvelope } from "../server/edge/phase9PressingEnvelope.mjs";

const valid = {
  companyId: 5,
  actorUserId: "worker-1",
  localConfirmationId: 13,
  requestId: "e53cdbd1-7c4b-4b5c-9a60-b4f9de710b8c",
  baleId: 100,
  machineId: 4,
  assignmentId: 3,
  referenceNumber: "BALE-100",
  confirmedAt: "2026-10-30T06:45:10.000Z",
  deviceCapturedAt: "2026-10-30T06:40:00.000Z",
  productionDate: "2026-10-30",
  timezoneName: "Asia/Beirut",
};

test("records only physical pressing proof, never financial or stock effects", () => {
  const event = phase9PressingEnvelope(valid);
  assert.equal(event.kind, "pressing.confirmation.v1");
  assert.equal(event.inventoryFinalized, false);
  assert.deepEqual(
    Object.keys(event).sort(),
    [
      "kind",
      "requestId",
      "companyId",
      "actorUserId",
      "localConfirmationId",
      "baleId",
      "machineId",
      "assignmentId",
      "referenceNumber",
      "confirmedAt",
      "deviceCapturedAt",
      "productionDate",
      "timezoneName",
      "inventoryFinalized",
    ].sort()
  );
  assert.equal(phase9PressingEnvelope({ ...valid, deviceCapturedAt: null }).deviceCapturedAt, null);
});

test("rejects forged tenant, reused identity and malformed source receipt data", () => {
  const invalid = [
    { companyId: 0 },
    { companyId: "5" },
    { localConfirmationId: -1 },
    { baleId: 0 },
    { machineId: 0 },
    { assignmentId: 0 },
    { actorUserId: "" },
    { actorUserId: "x".repeat(256) },
    { requestId: "client-request-1" },
    { referenceNumber: "BALE 100" },
    { referenceNumber: "bale-100" },
    { referenceNumber: "" },
    { confirmedAt: "2026-02-30T06:45:10.000Z" },
    { confirmedAt: "2026-10-30" },
    { confirmedAt: "not-date" },
    { deviceCapturedAt: "2026-02-30T06:45:10.000Z" },
    { productionDate: "2026-02-30" },
    { productionDate: "2026-13-01" },
    { timezoneName: "" },
    { stockDelta: 1 },
    { voucher: { amount: 10 } },
    { attachment: { path: "/private.pdf" } },
    { inventoryFinalized: true },
  ];
  for (const change of invalid) {
    assert.throws(
      () => phase9PressingEnvelope({ ...valid, ...change }),
      (error) => error instanceof Phase9PressingRefusal && error.message === "PHASE9_PRESSING_EVIDENCE_INVALID"
    );
  }
});
