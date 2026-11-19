/**
 * Cloud edge sync receiver: every signed endpoint (voucher stage, Phase 9
 * event stage, attachment file stage, Phase 8 and Phase 9 receipt queries).
 * Pinned: disabled configuration registers nothing, HTTPS is required in
 * production, unsigned / wrong-domain / replayed (stale timestamp) / tampered
 * requests get 401 before any store is touched, and store refusals map to
 * 400 / 409 / 503. The staging stores are mocked at the module boundary.
 */
import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class EdgeStageConflict extends Error {}
  class Phase9StageConflict extends Error {}
  return {
    EdgeStageConflict,
    Phase9StageConflict,
    stageVoucherEvents: vi.fn(),
    stagePhase9Events: vi.fn(),
    stagePhase9AttachmentFile: vi.fn(),
    getPhase9AppliedReceipts: vi.fn(),
    getAppliedCloudReceipts: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock("../server/edge/edgeRateLimit", () => ({
  edgeSyncRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../server/edge/edgeCloudStaging", () => ({
  stageVoucherEvents: h.stageVoucherEvents,
  EdgeStageConflict: h.EdgeStageConflict,
}));
vi.mock("../server/edge/phase9CloudEventStore.mjs", () => ({
  stagePhase9Events: h.stagePhase9Events,
  stagePhase9AttachmentFile: h.stagePhase9AttachmentFile,
  getPhase9AppliedReceipts: h.getPhase9AppliedReceipts,
  Phase9StageConflict: h.Phase9StageConflict,
}));
vi.mock("../server/edge/phase8AppliedReceipts.mjs", () => ({
  PHASE8_RECEIPT_QUERY_PATH: "/api/edge/sync/applied-receipts",
  getAppliedCloudReceipts: h.getAppliedCloudReceipts,
}));

import { registerCloudEdgeSyncReceiver } from "../server/edge/edgeSyncReceiver";
import {
  EVENT_STAGE_SIGNATURE_DOMAIN,
  FILE_STAGE_SIGNATURE_DOMAIN,
  makeStageSignature,
} from "../server/edge/edgeSyncStageProtocol.mjs";

const siteId = "027d7472-4a29-4bb3-a4aa-5b30e4ad631f";
const key = "edge-sync-receiver-coverage-fixture-key-".repeat(2);
const STAGE = "/api/edge/sync/stage";
const EVENTS = "/api/edge/sync/events/stage";
const EVENT_RECEIPTS = "/api/edge/sync/events/applied-receipts";
const FILES = "/api/edge/sync/files/stage";
const PHASE8 = "/api/edge/sync/applied-receipts";

function makeApp(env: Record<string, string> = {}, withRawBody = true) {
  vi.stubEnv("FACTORY_EDGE_MODE", "cloud");
  vi.stubEnv("FACTORY_CLOUD_WRITE_MODE", "fenced");
  vi.stubEnv("FACTORY_SYNC_RECEIVE_ENABLED", "1");
  vi.stubEnv("FACTORY_SYNC_SITE_ID", siteId);
  vi.stubEnv("FACTORY_SYNC_HMAC_KEY", key);
  vi.stubEnv("FACTORY_PHASE8_RECEIPTS_ENABLED", "1");
  vi.stubEnv("FACTORY_PHASE9_RECEIPTS_ENABLED", "1");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const app = express();
  app.use(
    express.json({
      verify(req, _res, bytes) {
        if (withRawBody) (req as typeof req & { rawBody: Buffer }).rawBody = bytes;
      },
    })
  );
  registerCloudEdgeSyncReceiver(app);
  return app;
}

const now = () => String(Math.floor(Date.now() / 1000));

function signedJson(
  app: express.Express,
  path: string,
  body: unknown,
  domain?: Parameters<typeof makeStageSignature>[3],
  timestamp = now(),
  secret = key
) {
  const raw = JSON.stringify(body);
  return request(app)
    .post(path)
    .set("Content-Type", "application/json")
    .set("X-Factory-Sync-Timestamp", timestamp)
    .set("X-Factory-Sync-Signature", makeStageSignature(Buffer.from(raw), timestamp, secret, domain))
    .send(raw);
}

function signedFile(app: express.Express, bytes: Buffer, sha = createHash("sha256").update(bytes).digest("hex")) {
  const timestamp = now();
  return request(app)
    .post(FILES)
    .set("Content-Type", "application/octet-stream")
    .set("X-Factory-File-Sha256", sha)
    .set("X-Factory-Sync-Timestamp", timestamp)
    .set("X-Factory-Sync-Signature", makeStageSignature(Buffer.from(sha), timestamp, key, FILE_STAGE_SIGNATURE_DOMAIN))
    .send(bytes);
}

const allStores = () => [
  h.stageVoucherEvents,
  h.stagePhase9Events,
  h.stagePhase9AttachmentFile,
  h.getPhase9AppliedReceipts,
  h.getAppliedCloudReceipts,
];

beforeEach(() => {
  for (const store of allStores()) store.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("edge sync receiver configuration", () => {
  it("registers no route when receiving is disabled, and no receipt routes unless opted in", async () => {
    vi.stubEnv("FACTORY_SYNC_RECEIVE_ENABLED", "0");
    const off = express();
    registerCloudEdgeSyncReceiver(off);
    expect((await request(off).post(STAGE).send({})).status).toBe(404);

    const app = makeApp({ FACTORY_PHASE8_RECEIPTS_ENABLED: "0", FACTORY_PHASE9_RECEIPTS_ENABLED: "0" });
    expect((await request(app).post(PHASE8).send({})).status).toBe(404);
    expect((await request(app).post(EVENT_RECEIPTS).send({})).status).toBe(404);
    expect((await request(app).post(STAGE).send({})).status).toBe(401);
  });

  it("requires HTTPS in production on every endpoint", async () => {
    const app = makeApp({ NODE_ENV: "production" });
    for (const path of [STAGE, EVENTS, EVENT_RECEIPTS, FILES, PHASE8]) {
      const res = await request(app).post(path).send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("EDGE_SYNC_HTTPS_REQUIRED");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    for (const store of allStores()) expect(store).not.toHaveBeenCalled();
  });
});

describe("edge sync receiver authentication refusals", () => {
  it("refuses unsigned, missing raw body, stale (replayed) and wrong-key requests on JSON endpoints", async () => {
    const app = makeApp();
    for (const path of [STAGE, EVENTS, EVENT_RECEIPTS, PHASE8]) {
      expect((await request(app).post(path).send({ a: 1 })).body.code).toBe("EDGE_SYNC_AUTH_FAILED");
      const stale = String(Math.floor(Date.now() / 1000) - 3600);
      expect((await signedJson(app, path, { a: 1 }, undefined, stale)).status).toBe(401);
      expect((await signedJson(app, path, { a: 1 }, undefined, now(), `${key}x`)).status).toBe(401);
    }
    const noRaw = makeApp({}, false);
    for (const path of [STAGE, EVENTS, PHASE8]) {
      expect((await signedJson(noRaw, path, { a: 1 })).status).toBe(401);
    }
    for (const store of allStores()) expect(store).not.toHaveBeenCalled();
  });

  it("does not accept a voucher-domain signature on the event endpoints, or the reverse", async () => {
    const app = makeApp();
    expect((await signedJson(app, EVENTS, { a: 1 })).status).toBe(401);
    expect((await signedJson(app, EVENT_RECEIPTS, { a: 1 })).status).toBe(401);
    expect((await signedJson(app, STAGE, { a: 1 }, EVENT_STAGE_SIGNATURE_DOMAIN)).status).toBe(401);
    expect(h.stageVoucherEvents).not.toHaveBeenCalled();
    expect(h.stagePhase9Events).not.toHaveBeenCalled();
  });

  it("refuses a file with a malformed digest or a signature for another digest", async () => {
    const app = makeApp();
    const bytes = Buffer.from("attachment");
    expect((await signedFile(app, bytes, "XYZ")).status).toBe(401);
    const otherSha = createHash("sha256").update("other").digest("hex");
    const timestamp = now();
    const forged = await request(app)
      .post(FILES)
      .set("Content-Type", "application/octet-stream")
      .set("X-Factory-File-Sha256", otherSha)
      .set("X-Factory-Sync-Timestamp", timestamp)
      .set("X-Factory-Sync-Signature", makeStageSignature(bytes, timestamp, key, FILE_STAGE_SIGNATURE_DOMAIN))
      .send(bytes);
    expect(forged.status).toBe(401);
    expect(h.stagePhase9AttachmentFile).not.toHaveBeenCalled();
  });

  it("refuses a signed file whose body is not octet-stream", async () => {
    const app = makeApp();
    const sha = createHash("sha256").update("x").digest("hex");
    const timestamp = now();
    const res = await request(app)
      .post(FILES)
      .set("Content-Type", "text/plain")
      .set("X-Factory-File-Sha256", sha)
      .set("X-Factory-Sync-Timestamp", timestamp)
      .set(
        "X-Factory-Sync-Signature",
        makeStageSignature(Buffer.from(sha), timestamp, key, FILE_STAGE_SIGNATURE_DOMAIN)
      )
      .send("x");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("EDGE_FILE_BODY_INVALID");
  });
});

describe("edge sync receiver store outcomes", () => {
  it("stages vouchers and maps conflicts, envelope refusals and store failures", async () => {
    const app = makeApp();
    h.stageVoucherEvents.mockResolvedValueOnce({ state: "staged-not-applied" });
    const ok = await signedJson(app, STAGE, { events: [] });
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe("staged-not-applied");
    expect(h.stageVoucherEvents).toHaveBeenCalledWith(expect.anything(), { events: [] }, siteId);

    h.stageVoucherEvents.mockRejectedValueOnce(new h.EdgeStageConflict("EDGE_SYNC_SEQUENCE_CONFLICT"));
    expect((await signedJson(app, STAGE, {})).status).toBe(409);
    h.stageVoucherEvents.mockRejectedValueOnce(new Error("EDGE_SYNC_VERSION_INVALID"));
    const stale = await signedJson(app, STAGE, {});
    expect(stale.status).toBe(400);
    expect(stale.body.code).toBe("EDGE_SYNC_VERSION_INVALID");
    h.stageVoucherEvents.mockRejectedValueOnce(new Error("connection lost"));
    expect((await signedJson(app, STAGE, {})).body.code).toBe("EDGE_SYNC_STAGE_UNAVAILABLE");
  });

  it("stages Phase 9 events and maps conflicts, scope refusals and store failures", async () => {
    const app = makeApp();
    const sign = (body: unknown) => signedJson(app, EVENTS, body, EVENT_STAGE_SIGNATURE_DOMAIN);
    h.stagePhase9Events.mockResolvedValueOnce({ staged: 1 });
    expect((await sign({ events: [1] })).body).toEqual({ staged: 1 });
    h.stagePhase9Events.mockRejectedValueOnce(new h.Phase9StageConflict("EDGE_EVENT_REPLAY_CONFLICT"));
    expect((await sign({})).status).toBe(409);
    h.stagePhase9Events.mockRejectedValueOnce(new Error("EDGE_EVENT_SCOPE_INVALID"));
    const scope = await sign({});
    expect(scope.status).toBe(400);
    expect(scope.body.code).toBe("EDGE_EVENT_SCOPE_INVALID");
    h.stagePhase9Events.mockRejectedValueOnce("not an error");
    expect((await sign({})).status).toBe(503);
  });

  it("stages attachment bytes and maps conflicts and store failures", async () => {
    const app = makeApp();
    const bytes = Buffer.from("attachment-bytes");
    h.stagePhase9AttachmentFile.mockResolvedValueOnce({ stored: true });
    const ok = await signedFile(app, bytes);
    expect(ok.status).toBe(200);
    expect(h.stagePhase9AttachmentFile.mock.calls[0][3]).toEqual(bytes);
    h.stagePhase9AttachmentFile.mockRejectedValueOnce(new h.Phase9StageConflict("EDGE_FILE_HASH_MISMATCH"));
    expect((await signedFile(app, bytes)).status).toBe(409);
    h.stagePhase9AttachmentFile.mockRejectedValueOnce(new Error("disk full"));
    expect((await signedFile(app, bytes)).body.code).toBe("EDGE_FILE_STAGE_UNAVAILABLE");
  });

  it("answers the Phase 9 receipt query and maps invalid queries and failures", async () => {
    const app = makeApp();
    const sign = (body: unknown) => signedJson(app, EVENT_RECEIPTS, body, EVENT_STAGE_SIGNATURE_DOMAIN);
    h.getPhase9AppliedReceipts.mockResolvedValueOnce({ receipts: [] });
    expect((await sign({ q: 1 })).body).toEqual({ receipts: [] });
    h.getPhase9AppliedReceipts.mockRejectedValueOnce(new Error("PHASE9_RECEIPT_QUERY_INVALID"));
    expect((await sign({})).status).toBe(400);
    h.getPhase9AppliedReceipts.mockRejectedValueOnce(new Error("timeout"));
    expect((await sign({})).body.code).toBe("PHASE9_RECEIPT_QUERY_UNAVAILABLE");
  });

  it("answers the Phase 8 receipt query and maps invalid queries and failures", async () => {
    const app = makeApp();
    h.getAppliedCloudReceipts.mockResolvedValueOnce({ applied: [] });
    expect((await signedJson(app, PHASE8, { q: 1 })).body).toEqual({ applied: [] });
    h.getAppliedCloudReceipts.mockRejectedValueOnce(new Error("PHASE8_RECEIPT_QUERY_INVALID"));
    expect((await signedJson(app, PHASE8, {})).status).toBe(400);
    h.getAppliedCloudReceipts.mockRejectedValueOnce(new Error("timeout"));
    expect((await signedJson(app, PHASE8, {})).body.code).toBe("PHASE8_RECEIPT_QUERY_UNAVAILABLE");
  });
});
