import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVENT_STAGE_SIGNATURE_DOMAIN,
  hashEvidence,
  makeStageSignature,
  verifyStageSignature,
} from "../server/edge/edgeSyncStageProtocol.mjs";
import {
  EDGE_EVENT_STAGE_PROTOCOL,
  validatePhase9Event,
  validatePhase9EventStageEnvelope,
  validatePhase9ReceiptQuery,
} from "../server/edge/phase9EventProtocol.mjs";
import { phase9PressingEnvelope } from "../server/edge/phase9PressingEnvelope.mjs";
import {
  eventEnvelope,
  verifyAppliedEventReceipts,
  verifyEventStageReceipt,
} from "../scripts/edge/relay-event-outbox.mjs";

const SITE = "027d7472-4a29-4bb3-a4aa-5b30e4ad631f";
const KEY = "unit-test-only-hmac-key-".repeat(3);
const payload = phase9PressingEnvelope({
  companyId: 5,
  localConfirmationId: 13,
  baleId: 100,
  machineId: 4,
  assignmentId: 3,
  actorUserId: "worker-1",
  requestId: "e53cdbd1-7c4b-4b5c-9a60-b4f9de710b8c",
  referenceNumber: "BALE-100",
  confirmedAt: "2026-10-30T06:45:10.000Z",
  deviceCapturedAt: null,
  productionDate: "2026-10-30",
  timezoneName: "Asia/Beirut",
});
const row = {
  sequence: "1",
  operation_id: payload.requestId,
  company_id: 5,
  actor_user_id: "worker-1",
  local_ref: 13,
  operation_kind: "pressing.confirmation.v1",
  // JSONB returns keys in its own order; validation must not depend on it.
  payload: Object.fromEntries(Object.entries(payload).reverse()),
  payload_sha256: hashEvidence(payload),
};

test("event signatures are domain-separated from voucher staging signatures", () => {
  const body = Buffer.from("{}");
  const ts = String(Math.floor(Date.now() / 1000));
  const voucherSig = makeStageSignature(body, ts, KEY);
  const eventSig = makeStageSignature(body, ts, KEY, EVENT_STAGE_SIGNATURE_DOMAIN);
  assert.notEqual(voucherSig, eventSig);
  verifyStageSignature(body, ts, eventSig, KEY, Date.now() / 1000, EVENT_STAGE_SIGNATURE_DOMAIN);
  assert.throws(
    () => verifyStageSignature(body, ts, voucherSig, KEY, Date.now() / 1000, EVENT_STAGE_SIGNATURE_DOMAIN),
    /EDGE_SYNC_SIGNATURE_INVALID/
  );
  assert.throws(() => makeStageSignature(body, ts, KEY, "OTHER"), /EDGE_SYNC_SIGNATURE_DOMAIN_INVALID/);
});

test("envelope accepts exact LAN evidence regardless of JSON key order", () => {
  const envelope = eventEnvelope([row], SITE, "pressing");
  assert.equal(envelope.protocol, EDGE_EVENT_STAGE_PROTOCOL);
  assert.equal(validatePhase9EventStageEnvelope(envelope, SITE).length, 1);
});

test("relabelled, extended, unknown-kind or out-of-order evidence is refused", () => {
  const [event] = eventEnvelope([row], SITE, "pressing").events;
  const cases = [
    [{ ...event, actorUserId: "worker-2" }, /EDGE_EVENT_PAYLOAD_INVALID/],
    [{ ...event, localRef: 14 }, /EDGE_EVENT_PAYLOAD_INVALID/],
    [{ ...event, kind: "stock.adjust.v1" }, /EDGE_EVENT_KIND_NOT_ALLOWED/],
    [{ ...event, kind: "__proto__" }, /EDGE_EVENT_KIND_NOT_ALLOWED/],
    [{ ...event, payload: { ...event.payload, weightKg: 99 } }, /EDGE_EVENT_PAYLOAD_INVALID/],
    [{ ...event, payload: { ...event.payload, referenceNumber: "BALE-101" } }, /EDGE_EVENT_HASH_MISMATCH/],
    [{ ...event, extra: true }, /EDGE_EVENT_INVALID/],
  ];
  for (const [candidate, error] of cases) assert.throws(() => validatePhase9Event("pressing", candidate), error);
  assert.throws(() => validatePhase9Event("stock", event), /EDGE_EVENT_STREAM_INVALID/);
  const envelope = eventEnvelope([row], SITE, "pressing");
  assert.throws(
    () => validatePhase9EventStageEnvelope({ ...envelope, events: [event, event] }, SITE),
    /EDGE_EVENT_ORDER_INVALID/
  );
  assert.throws(() => validatePhase9EventStageEnvelope(envelope, "11111111-1111-4111-8111-111111111111"), /ENVELOPE/);
  assert.throws(() => eventEnvelope([{ ...row, payload_sha256: "0".repeat(64) }], SITE, "pressing"), /CHANGED/);
});

test("stage receipts must echo exact sequence, operation and digest", () => {
  const envelope = eventEnvelope([row], SITE, "pressing");
  const good = {
    protocol: "factory-lan-event-stage-receipt/v1",
    siteId: SITE,
    stream: "pressing",
    state: "staged-not-applied",
    events: [
      { sequence: "1", operationId: row.operation_id, payloadSha256: row.payload_sha256, state: "staged-not-applied" },
    ],
  };
  assert.equal(verifyEventStageReceipt(good, envelope).length, 1);
  assert.throws(
    () => verifyEventStageReceipt({ ...good, events: [{ ...good.events[0], state: "cloud-applied" }] }, envelope),
    /MISMATCH/
  );
  assert.throws(() => verifyEventStageReceipt({ ...good, stream: "other" }, envelope), /INVALID/);
});

test("applied receipts must match local evidence; rejected outcomes carry no cloud effect", () => {
  const local = new Map([["1", row]]);
  const base = {
    stream: "pressing",
    sequence: "1",
    operationId: row.operation_id,
    companyId: 5,
    actorUserId: "worker-1",
    kind: "pressing.confirmation.v1",
    localRef: 13,
    payloadSha256: row.payload_sha256,
  };
  const response = (events) => ({
    protocol: "factory-lan-event-applied-receipts/v1",
    siteId: SITE,
    stream: "pressing",
    events,
  });
  const scope = { siteId: SITE, stream: "pressing" };
  const applied = { ...base, cloudRef: 77, businessDate: "2026-10-30", outcome: "cloud-applied" };
  const rejected = { ...base, cloudRef: null, businessDate: null, outcome: "rejected-conflict" };
  assert.equal(verifyAppliedEventReceipts(response([applied]), scope, local).length, 1);
  assert.equal(verifyAppliedEventReceipts(response([rejected]), scope, local).length, 1);
  for (const bad of [
    { ...applied, businessDate: "2026-10-31" },
    { ...applied, companyId: 6 },
    { ...applied, outcome: "staged-not-applied" },
    { ...rejected, cloudRef: 77 },
    { ...applied, sequence: "2" },
  ]) {
    assert.throws(() => verifyAppliedEventReceipts(response([bad]), scope, local), /MISMATCH/);
  }
});

test("receipt queries are strict to site, stream and sequence", () => {
  const query = { protocol: "factory-lan-event-applied-query/v1", siteId: SITE, stream: "pressing", fromSequence: "1" };
  assert.equal(validatePhase9ReceiptQuery(query, SITE).stream, "pressing");
  for (const bad of [
    { ...query, stream: "vouchers" },
    { ...query, fromSequence: "0" },
    { ...query, extra: 1 },
  ]) {
    assert.throws(() => validatePhase9ReceiptQuery(bad, SITE), /PHASE9_RECEIPT_QUERY_INVALID/);
  }
});
