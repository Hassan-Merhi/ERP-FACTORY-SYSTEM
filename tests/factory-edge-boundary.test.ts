import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
vi.mock("../server/db", () => ({ pool: { query: vi.fn() } }));
import { makeFactoryEdgeWriteGuard } from "../server/edge/edgeBoundary";
import { readFactoryEdgeConfiguration } from "../server/edge/edgeRuntimePolicy.mjs";

const env = {
  FACTORY_EDGE_MODE: "lan",
  FACTORY_EDGE_SITE_ID: "027d7472-4a29-4bb3-a4aa-5b30e4ad631f",
  FACTORY_EDGE_HOSTNAME: "erp.factory.internal",
  NODE_ENV: "production",
  PGHOST: "postgres",
  PGPORT: "5432",
  PGUSER: "erp_edge",
  PGPASSWORD: "B".repeat(64),
  PGDATABASE: "erp_edge",
  PGSSLMODE: "disable",
  SESSION_SECRET: "A".repeat(64),
  CSRF_ENFORCE: "1",
  ENABLE_SCHEDULERS: "false",
  RUN_STARTUP_MIGRATIONS: "true",
};
const approvedJournal = {
  clientRequestId: "e53cdbd1-7c4b-4b5c-9a60-b4f9de710b8c",
  voucher: { voucherType: "Journal", voucherDate: "2026-10-30", currency: "USD", optional: false },
  entries: [
    { ledgerAccountId: 11, debitAmount: "10.00", creditAmount: "0" },
    { ledgerAccountId: 12, debitAmount: "0", creditAmount: "10.00" },
  ],
};

function fixture(
  override: Record<string, string>,
  provisioned: () => Promise<boolean>,
  hasAuthority: () => Promise<boolean> = async () => false
) {
  const config = readFactoryEdgeConfiguration({ ...env, ...override });
  const app = express();
  app.use(express.json());
  app.use("/api", makeFactoryEdgeWriteGuard(config, provisioned, hasAuthority));
  app.post("/api/vouchers/with-entries", (_req, res) => res.json({ ok: true }));
  app.post("/api/factory/bales", (_req, res) => res.json({ unsafe: true }));
  app.post("/api/auth/login", (_req, res) => res.json({ ok: true }));
  app.get("/api/inventory", (_req, res) => res.json([]));
  return app;
}

describe("edge runtime write safety", () => {
  it("returns 423 for any business write in default read-only deployment", async () => {
    const data = vi.fn().mockResolvedValue(true);
    const app = fixture({}, data);
    expect((await request(app).post("/api/vouchers/with-entries")).status).toBe(423);
    expect((await request(app).post("/api/vouchers/with-entries")).body.code).toBe("EDGE_READ_ONLY");
    expect((await request(app).post("/api/auth/login")).status).toBe(200);
    expect((await request(app).get("/api/inventory")).status).toBe(200);
    expect(data).not.toHaveBeenCalled();
  });

  it("refuses primary writes before database provisioning", async () => {
    const app = fixture(
      {
        FACTORY_EDGE_WRITE_MODE: "lan-primary",
        FACTORY_EDGE_PRIMARY_ACK: "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED",
        FACTORY_EDGE_WRITER_EPOCH: "2",
        FACTORY_EDGE_BASELINE_SHA256: "a".repeat(64),
      },
      async () => false
    );
    expect((await request(app).post("/api/vouchers/with-entries").send(approvedJournal)).body.code).toBe("EDGE_DATABASE_NOT_PROVISIONED");
  });

  it("rejects even a populated database when its Phase 7 PostgreSQL fence is missing", async () => {
    const app = fixture({
      FACTORY_EDGE_WRITE_MODE: "lan-primary",
      FACTORY_EDGE_PRIMARY_ACK: "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED",
      FACTORY_EDGE_WRITER_EPOCH: "2",
      FACTORY_EDGE_BASELINE_SHA256: "a".repeat(64),
    }, async () => true);
    const res = await request(app).post("/api/vouchers/with-entries").send(approvedJournal);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("EDGE_PHASE7_WRITER_AUTHORITY_UNVERIFIED");
  });

  it("permits primary writes to pass through to existing auth/CSRF/route guards", async () => {
    const app = fixture(
      {
        FACTORY_EDGE_WRITE_MODE: "lan-primary",
        FACTORY_EDGE_PRIMARY_ACK: "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED",
        FACTORY_EDGE_WRITER_EPOCH: "2",
        FACTORY_EDGE_BASELINE_SHA256: "a".repeat(64),
      },
      async () => true,
      async () => true
    );
    expect((await request(app).post("/api/vouchers/with-entries").send(approvedJournal)).body.ok).toBe(true);
    expect((await request(app).post("/api/vouchers/with-entries").send({ voucher: {} })).body.code)
      .toBe("EDGE_PHASE8_CAPTURE_UNSUPPORTED");
    const rejected = await request(app).post("/api/factory/bales");
    expect(rejected.status).toBe(423);
    expect(rejected.body.code).toBe("EDGE_SYNC_UNSUPPORTED_OPERATION");
  });
});
