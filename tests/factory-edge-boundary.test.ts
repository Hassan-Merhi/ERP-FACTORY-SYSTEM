import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { makeFactoryEdgeWriteGuard } from "../server/edge/edgeBoundary";
import { readFactoryEdgeConfiguration } from "../server/edge/edgeRuntimePolicy.mjs";

const env = {
  FACTORY_EDGE_MODE: "lan",
  FACTORY_EDGE_SITE_ID: "027d7472-4a29-4bb3-a4aa-5b30e4ad631f",
  FACTORY_EDGE_HOSTNAME: "erp.factory.internal",
  NODE_ENV: "production", PGHOST: "postgres", PGPORT: "5432",
  PGUSER: "erp_edge", PGPASSWORD: "secure-value", PGDATABASE: "erp_edge", PGSSLMODE: "disable",
  SESSION_SECRET: "A".repeat(64), CSRF_ENFORCE: "1",
  ENABLE_SCHEDULERS: "false", RUN_STARTUP_MIGRATIONS: "true",
};
function fixture(override: Record<string, string>, provisioned: () => Promise<boolean>) {
  const config = readFactoryEdgeConfiguration({ ...env, ...override });
  const app = express();
  app.use("/api", makeFactoryEdgeWriteGuard(config, provisioned));
  app.post("/api/vouchers/with-entries", (_req, res) => res.json({ ok: true }));
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
    const app = fixture({
      FACTORY_EDGE_WRITE_MODE: "lan-primary",
      FACTORY_EDGE_PRIMARY_ACK: "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED",
    }, async () => false);
    expect((await request(app).post("/api/vouchers/with-entries")).body.code)
      .toBe("EDGE_DATABASE_NOT_PROVISIONED");
  });

  it("permits primary writes to pass through to existing auth/CSRF/route guards", async () => {
    const app = fixture({
      FACTORY_EDGE_WRITE_MODE: "lan-primary",
      FACTORY_EDGE_PRIMARY_ACK: "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED",
    }, async () => true);
    expect((await request(app).post("/api/vouchers/with-entries")).body.ok).toBe(true);
  });
});
