import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDGE_SYNC_STAGE_VERSION, hashEvidence, makeStageSignature } from "../server/edge/edgeSyncStageProtocol.mjs";

vi.mock("../server/db", () => ({
  pool: { connect: vi.fn(), query: vi.fn() },
}));
vi.mock("../server/edge/edgeCloudStaging", () => ({
  stageVoucherEvents: vi.fn(async (_pool, payload) => ({
    protocol: "factory-lan-voucher-stage-receipt/v1",
    siteId: payload.siteId,
    state: "staged-not-applied",
    events: payload.events.map((e: { sequence: string; operationId: string; payloadSha256: string }) => ({
      sequence: e.sequence,
      operationId: e.operationId,
      payloadSha256: e.payloadSha256,
      state: "staged-not-applied",
    })),
  })),
  EdgeStageConflict: class EdgeStageConflict extends Error {},
}));

import { registerFactoryEdgeBoundary } from "../server/edge/edgeBoundary";
const siteId = "027d7472-4a29-4bb3-a4aa-5b30e4ad631f";
const key = "factory-sync-http-integration-fixture-".repeat(2);
const payload = { voucher: { id: 9, companyId: 3 }, entries: [] };
const envelope = {
  protocol: EDGE_SYNC_STAGE_VERSION,
  siteId,
  events: [
    {
      sequence: "1",
      operationId: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
      companyId: 3,
      actorUserId: "u3",
      localVoucherId: 9,
      kind: "voucher.with-entries.v1",
      payload,
      payloadSha256: hashEvidence(payload),
    },
  ],
};

function makeTestApp() {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FACTORY_EDGE_MODE", "cloud");
  vi.stubEnv("FACTORY_CLOUD_WRITE_MODE", "fenced");
  vi.stubEnv("FACTORY_CLOUD_FENCE_ACK", "CLOUD_WRITES_DISABLED_FOR_FACTORY_HANDOFF");
  vi.stubEnv("FACTORY_SYNC_RECEIVE_ENABLED", "1");
  vi.stubEnv("FACTORY_SYNC_SITE_ID", siteId);
  vi.stubEnv("FACTORY_SYNC_HMAC_KEY", key);
  const app = express();
  app.use(
    express.json({
      verify(req, _res, bytes) {
        (req as typeof req & { rawBody: Buffer }).rawBody = bytes;
      },
    })
  );
  registerFactoryEdgeBoundary(app);
  app.post("/api/vouchers/with-entries", (_req, res) => res.sendStatus(200));
  return app;
}

afterEach(() => vi.unstubAllEnvs());

describe("Phase 4 cloud HMAC receiver boundary", () => {
  it("accepts signed staging while all business POSTs remain fenced", async () => {
    const app = makeTestApp();
    const body = JSON.stringify(envelope);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signed = await request(app)
      .post("/api/edge/sync/stage")
      .set("Content-Type", "application/json")
      .set("X-Factory-Sync-Timestamp", timestamp)
      .set("X-Factory-Sync-Signature", makeStageSignature(Buffer.from(body), timestamp, key))
      .send(body);
    expect(signed.status).toBe(200);
    expect(signed.body.state).toBe("staged-not-applied");
    expect((await request(app).post("/api/vouchers/with-entries")).status).toBe(423);
  });

  it("never authorizes unsigned and modified stage requests", async () => {
    const app = makeTestApp();
    const body = JSON.stringify(envelope);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rejected = await request(app).post("/api/edge/sync/stage").set("Content-Type", "application/json").send(body);
    expect(rejected.status).toBe(401);
    const wrong = await request(app)
      .post("/api/edge/sync/stage")
      .set("Content-Type", "application/json")
      .set("X-Factory-Sync-Timestamp", timestamp)
      .set("X-Factory-Sync-Signature", makeStageSignature(Buffer.from(body), timestamp, key))
      .send(JSON.stringify({ ...envelope, siteId: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6" }));
    expect(wrong.status).toBe(401);
  });
});
