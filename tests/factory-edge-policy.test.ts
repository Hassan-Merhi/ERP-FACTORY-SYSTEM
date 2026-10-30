import { describe, expect, it } from "vitest";
import { edgeBlocksWrite, edgeStatusPayload, readFactoryEdgeConfiguration, shouldStartEdgeBackgroundJobs } from "../server/edge/edgeRuntimePolicy.mjs";

const safe = {
  FACTORY_EDGE_MODE: "lan",
  FACTORY_EDGE_SITE_ID: "027d7472-4a29-4bb3-a4aa-5b30e4ad631f",
  FACTORY_EDGE_HOSTNAME: "erp.factory.internal",
  FACTORY_EDGE_WRITE_MODE: "read-only",
  NODE_ENV: "production",
  PGHOST: "postgres",
  PGPORT: "5432",
  PGUSER: "erp_edge",
  PGPASSWORD: "A".repeat(64),
  PGDATABASE: "erp_edge",
  PGSSLMODE: "disable",
  SESSION_SECRET: "A".repeat(64),
  ENABLE_SCHEDULERS: "false",
  RUN_STARTUP_MIGRATIONS: "true",
  CSRF_ENFORCE: "1",
};
describe("factory LAN edge deployment policy", () => {
  it("is cloud-only unless explicitly configured", () => {
    expect(readFactoryEdgeConfiguration({}).mode).toBe("cloud");
    expect(shouldStartEdgeBackgroundJobs(readFactoryEdgeConfiguration({}))).toBe(true);
    expect(() => readFactoryEdgeConfiguration({ FACTORY_EDGE_MODE: "true" })).toThrow("EDGE_MODE_INVALID");
  });
  it("accepts a private read-only LAN deployment", () => {
    expect(readFactoryEdgeConfiguration(safe)).toMatchObject({ mode: "lan", writeMode: "read-only", primary: false });
    expect(shouldStartEdgeBackgroundJobs(readFactoryEdgeConfiguration(safe))).toBe(false);
  });
  it.each([
    [{ PGHOST: "cloud.render.com" }, "EDGE_DATABASE_HOST_NOT_LOCAL"],
    [{ DATABASE_URL: "postgresql://cloud" }, "EDGE_DATABASE_URL_FORBIDDEN"],
    [{ FACTORY_EDGE_HOSTNAME: "https://erp.factory.internal" }, "EDGE_HOSTNAME_INVALID"],
    [{ FACTORY_EDGE_HOSTNAME: "127.0.0.1" }, "EDGE_HOSTNAME_INVALID"],
    [{ FACTORY_EDGE_SITE_ID: "not-a-uuid" }, "EDGE_SITE_ID_INVALID"],
    [{ SESSION_SECRET: "weak" }, "EDGE_SESSION_SECRET_WEAK"],
    [{ PGPASSWORD: "short" }, "EDGE_DATABASE_PASSWORD_WEAK"],
    [{ CSRF_ENFORCE: "0" }, "EDGE_CSRF_REQUIRED"],
    [{ ENABLE_SCHEDULERS: "true" }, "EDGE_SCHEDULERS_MUST_BE_DISABLED"],
    [{ RUN_STARTUP_MIGRATIONS: "false" }, "EDGE_MIGRATIONS_REQUIRED"],
    [{ NODE_ENV: "development" }, "EDGE_REQUIRES_PRODUCTION"],
    [{ CAPACITOR_ENABLED: "true" }, "EDGE_CROSS_ORIGIN_SESSIONS_DISABLED"],
    [{ FACTORY_EDGE_WRITE_MODE: "lan-primary" }, "EDGE_PRIMARY_CUTOVER_NOT_ACKNOWLEDGED"],
  ])("refuses unsafe configuration %j", (patch, code) => {
    expect(() => readFactoryEdgeConfiguration({ ...safe, ...patch })).toThrow(code);
  });
  it("requires explicit acknowledgment for LAN-primary mode", () => {
    const p = readFactoryEdgeConfiguration({
      ...safe,
      FACTORY_EDGE_WRITE_MODE: "lan-primary",
      FACTORY_EDGE_PRIMARY_ACK: "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED",
      FACTORY_EDGE_WRITER_EPOCH: "2",
      FACTORY_EDGE_BASELINE_SHA256: "a".repeat(64),
    });
    expect(p.primary).toBe(true);
    expect(edgeBlocksWrite(p, "POST", "/api/vouchers/with-entries")).toBe(false);
    expect(edgeBlocksWrite(p, "POST", "/api/factory/bales")).toBe(true);
    expect(edgeBlocksWrite(p, "PATCH", "/api/inventory/1")).toBe(true);
  });
  it("does not accept a manual ACK without the Phase 7 database identity", () => {
    expect(() => readFactoryEdgeConfiguration({
      ...safe,
      FACTORY_EDGE_WRITE_MODE: "lan-primary",
      FACTORY_EDGE_PRIMARY_ACK: "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED",
    })).toThrow("EDGE_PHASE7_WRITER_EPOCH_REQUIRED");
    expect(() => readFactoryEdgeConfiguration({
      ...safe,
      FACTORY_EDGE_WRITE_MODE: "lan-primary",
      FACTORY_EDGE_PRIMARY_ACK: "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED",
      FACTORY_EDGE_WRITER_EPOCH: "2",
      FACTORY_EDGE_BASELINE_SHA256: "invalid",
    })).toThrow("EDGE_PHASE7_BASELINE_DIGEST_REQUIRED");
    expect(() => readFactoryEdgeConfiguration({
      ...safe,
      FACTORY_EDGE_WRITER_EPOCH: "2",
    })).toThrow("EDGE_PHASE7_EPOCH_WITHOUT_PRIMARY");
  });
  it("only admits session traffic in read-only mode", () => {
    const p = readFactoryEdgeConfiguration(safe);
    expect(edgeBlocksWrite(p, "POST", "/api/vouchers/with-entries")).toBe(true);
    expect(edgeBlocksWrite(p, "PUT", "/api/stock-items/1")).toBe(true);
    expect(edgeBlocksWrite(p, "PATCH", "/api/user-presence")).toBe(true);
    expect(edgeBlocksWrite(p, "GET", "/api/inventory")).toBe(false);
    expect(edgeBlocksWrite(p, "POST", "/api/auth/login")).toBe(false);
    expect(edgeBlocksWrite(p, "POST", "/api/auth/logout")).toBe(false);
    expect(edgeBlocksWrite(p, "POST", "/api/auth/set-company")).toBe(false);
    expect(edgeBlocksWrite(p, "POST", "/api/csp-report")).toBe(false);
  });
  it("never claims cloud sync", () => {
    const p = readFactoryEdgeConfiguration(safe);
    expect(edgeStatusPayload(p, false)).toMatchObject({
      writeMode: "read-only",
      databaseProvisioned: false,
      cloudReplication: "not-configured",
    });
  });
});
