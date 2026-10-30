import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EDGE_SYNC_STAGE_VERSION,
  hashEvidence,
  makeStageSignature,
  readCloudSyncStageConfiguration,
  validateStageEnvelope,
  verifyStageSignature,
} from "../server/edge/edgeSyncStageProtocol.mjs";
import { readSenderConfiguration, stagedEnvelope, verifyStageReceipt } from "../scripts/edge/send-voucher-outbox.mjs";

const siteId = "027d7472-4a29-4bb3-a4aa-5b30e4ad631f";
const key = "phase4-test-only-shared-voucher-stage-key-".repeat(2);
const payload = { voucher: { id: 30, companyId: 5, amount: "5.00" }, entries: [{ debit: "5.00" }] };
const event = {
  sequence: "1",
  operationId: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
  companyId: 5,
  actorUserId: "u5",
  localVoucherId: 30,
  kind: "voucher.with-entries.v1",
  payload,
  payloadSha256: hashEvidence(payload),
};
const envelope = { protocol: EDGE_SYNC_STAGE_VERSION, siteId, events: [event] };

describe("Phase 4 signed transport", () => {
  it("accepts an intact raw-body HMAC and rejects modified bodies, timestamps and keys", () => {
    const bytes = Buffer.from(JSON.stringify(envelope));
    const timestamp = "1793364000";
    const signature = makeStageSignature(bytes, timestamp, key);
    expect(() => verifyStageSignature(bytes, timestamp, signature, key, Number(timestamp))).not.toThrow();
    expect(() =>
      verifyStageSignature(Buffer.concat([bytes, Buffer.from(" ")]), timestamp, signature, key, Number(timestamp))
    ).toThrow("EDGE_SYNC_SIGNATURE_INVALID");
    expect(() => verifyStageSignature(bytes, timestamp, signature, key, Number(timestamp) + 301)).toThrow(
      "EDGE_SYNC_SIGNATURE_INVALID"
    );
    expect(() =>
      verifyStageSignature(bytes, timestamp, signature, "other-dedicated-key".repeat(5), Number(timestamp))
    ).toThrow("EDGE_SYNC_SIGNATURE_INVALID");
  });

  it("refuses invalid or divergent evidence and reordered sequence IDs", () => {
    expect(validateStageEnvelope(envelope, siteId)).toHaveLength(1);
    expect(() => validateStageEnvelope({ ...envelope, siteId: "wrong" }, siteId)).toThrow("EDGE_SYNC_ENVELOPE_INVALID");
    expect(() => validateStageEnvelope({ ...envelope, events: [{ ...event, payload: {} }] }, siteId)).toThrow(
      "EDGE_SYNC_EVENT_INVALID"
    );
    expect(() => validateStageEnvelope({ ...envelope, events: [event, event] }, siteId)).toThrow(
      "EDGE_SYNC_ORDER_INVALID"
    );
    expect(() => validateStageEnvelope({ ...envelope, events: [{ ...event, sequence: "1;DROP" }] }, siteId)).toThrow(
      "EDGE_SYNC_EVENT_INVALID"
    );
    const reordered = { entries: [{ debit: "5.00" }], voucher: { amount: "5.00", companyId: 5, id: 30 } };
    expect(hashEvidence(reordered)).toBe(event.payloadSha256);
  });

  it("only enables a receiver on a deliberately fenced cloud", () => {
    expect(readCloudSyncStageConfiguration({}).enabled).toBe(false);
    expect(() =>
      readCloudSyncStageConfiguration({
        FACTORY_SYNC_RECEIVE_ENABLED: "1",
        FACTORY_SYNC_SITE_ID: siteId,
        FACTORY_SYNC_HMAC_KEY: key,
      })
    ).toThrow("EDGE_SYNC_REQUIRES_FENCED_CLOUD");
    expect(
      readCloudSyncStageConfiguration({
        FACTORY_SYNC_RECEIVE_ENABLED: "1",
        FACTORY_SYNC_SITE_ID: siteId,
        FACTORY_SYNC_HMAC_KEY: key,
        FACTORY_CLOUD_WRITE_MODE: "fenced",
      }).enabled
    ).toBe(true);
  });

  it("rejects non-HTTPS relay origins and forged applied receipts", () => {
    const env = {
      FACTORY_EDGE_MODE: "lan",
      FACTORY_EDGE_SITE_ID: siteId,
      FACTORY_SYNC_SENDER_ENABLED: "1",
      FACTORY_SYNC_CLOUD_URL: "https://cloud.example.com",
      FACTORY_SYNC_HMAC_KEY: key,
      PGHOST: "postgres",
      PGUSER: "erp_edge",
      PGPASSWORD: "database-secret",
      PGDATABASE: "erp_edge",
      PGSSLMODE: "disable",
    };
    expect(readSenderConfiguration(env).endpoint).toBe("https://cloud.example.com/api/edge/sync/stage");
    expect(() => readSenderConfiguration({ ...env, FACTORY_SYNC_CLOUD_URL: "http://cloud.example.com" })).toThrow(
      "EDGE_SYNC_CLOUD_URL_INVALID"
    );
    expect(() => readSenderConfiguration({ ...env, FACTORY_SYNC_CLOUD_URL: "https://127.0.0.1" })).toThrow(
      "EDGE_SYNC_CLOUD_URL_INVALID"
    );
    const received = {
      protocol: "factory-lan-voucher-stage-receipt/v1",
      siteId,
      state: "staged-not-applied",
      events: [
        {
          sequence: event.sequence,
          operationId: event.operationId,
          payloadSha256: event.payloadSha256,
          state: "staged-not-applied",
        },
      ],
    };
    expect(verifyStageReceipt(received, envelope)).toHaveLength(1);
    expect(() => verifyStageReceipt({ ...received, state: "applied" }, envelope)).toThrow("EDGE_SYNC_RECEIPT_INVALID");
    expect(() =>
      verifyStageReceipt(
        {
          ...received,
          events: [{ ...received.events[0], payloadSha256: "0".repeat(64) }],
        },
        envelope
      )
    ).toThrow("EDGE_SYNC_RECEIPT_MISMATCH");
  });

  it("translates local DB rows to exact validated staging events", () => {
    const row = {
      sequence: "1",
      operation_id: event.operationId,
      company_id: event.companyId,
      actor_user_id: event.actorUserId,
      local_voucher_id: event.localVoucherId,
      operation_kind: event.kind,
      payload,
      payload_sha256: event.payloadSha256,
    };
    expect(stagedEnvelope([row], siteId)).toEqual(envelope);
    expect(() =>
      stagedEnvelope([{ ...row, payload_sha256: createHash("sha256").update("wrong").digest("hex") }], siteId)
    ).toThrow("EDGE_SYNC_LOCAL_EVIDENCE_CHANGED");
  });
});
