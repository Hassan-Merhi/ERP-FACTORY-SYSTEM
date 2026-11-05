import { describe, expect, it } from "vitest";
import {
  edgeBlocksWrite,
  edgeStatusPayload,
  readFactoryEdgeConfiguration,
  shouldStartEdgeBackgroundJobs,
} from "../server/edge/edgeRuntimePolicy.mjs";

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
    expect(() =>
      readFactoryEdgeConfiguration({
        ...safe,
        FACTORY_EDGE_WRITE_MODE: "lan-primary",
        FACTORY_EDGE_PRIMARY_ACK: "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED",
      })
    ).toThrow("EDGE_PHASE7_WRITER_EPOCH_REQUIRED");
    expect(() =>
      readFactoryEdgeConfiguration({
        ...safe,
        FACTORY_EDGE_WRITE_MODE: "lan-primary",
        FACTORY_EDGE_PRIMARY_ACK: "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED",
        FACTORY_EDGE_WRITER_EPOCH: "2",
        FACTORY_EDGE_BASELINE_SHA256: "invalid",
      })
    ).toThrow("EDGE_PHASE7_BASELINE_DIGEST_REQUIRED");
    expect(() =>
      readFactoryEdgeConfiguration({
        ...safe,
        FACTORY_EDGE_WRITER_EPOCH: "2",
      })
    ).toThrow("EDGE_PHASE7_EPOCH_WITHOUT_PRIMARY");
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
  it("blocks alternate HTTP verbs on session exemptions and every unapproved business path", () => {
    for (const mode of ["read-only", "lan-primary"] as const) {
      const input = {
        ...safe,
        FACTORY_EDGE_WRITE_MODE: mode,
        ...(mode === "lan-primary"
          ? {
              FACTORY_EDGE_PRIMARY_ACK: "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED",
              FACTORY_EDGE_WRITER_EPOCH: "2",
              FACTORY_EDGE_BASELINE_SHA256: "a".repeat(64),
            }
          : {}),
      };
      const config = readFactoryEdgeConfiguration(input);
      for (const path of ["/api/auth/login", "/api/auth/logout", "/api/auth/set-company", "/api/csp-report"]) {
        expect(edgeBlocksWrite(config, "POST", path)).toBe(false);
        for (const verb of ["PUT", "PATCH", "DELETE"]) {
          expect(edgeBlocksWrite(config, verb, path)).toBe(true);
        }
      }
      // Phase 9: only the reviewed POST captures (pressing, stock quick-adjust,
      // POS cash sale) are approved, and only for LAN-primary.
      for (const approved of [
        "/api/factory/pressing-machines/confirm",
        "/api/inventory/quick-adjust",
        "/api/pos/sales",
        "/api/containers/42/offload",
        "/api/files/upload",
        "/api/vouchers/payment-receipt",
        "/api/stock-transfers",
        "/api/stock-items/bulk-update-prices",
        "/api/stock-items/import-barcodes",
        "/api/stock-items/42/location-prices",
      ]) {
        expect(edgeBlocksWrite(config, "POST", approved)).toBe(mode === "read-only");
        // Offload edits (PATCH) are approved too; every other verb stays blocked.
        const extraVerbs = approved === "/api/containers/42/offload" ? ["PATCH"] : [];
        for (const verb of ["PUT", "PATCH", "DELETE"]) {
          expect(edgeBlocksWrite(config, verb, approved)).toBe(extraVerbs.includes(verb) ? mode === "read-only" : true);
        }
      }
      // POS sale edits (returns): PUT and the PATCH alias only.
      for (const verb of ["PUT", "PATCH"]) {
        expect(edgeBlocksWrite(config, verb, "/api/vouchers/42/sales")).toBe(mode === "read-only");
      }
      for (const verb of ["POST", "DELETE"]) {
        expect(edgeBlocksWrite(config, verb, "/api/vouchers/42/sales")).toBe(true);
      }
      // POS sale cancellation: DELETE of a voucher (the route itself refuses non-sales).
      expect(edgeBlocksWrite(config, "DELETE", "/api/vouchers/42")).toBe(mode === "read-only");
      expect(edgeBlocksWrite(config, "PUT", "/api/vouchers/42")).toBe(true);
      // Phase 10 operator buttons: pause/resume on any LAN server; decisions only on the cloud.
      expect(edgeBlocksWrite(config, "POST", "/api/edge/operator/sync-control")).toBe(false);
      expect(edgeBlocksWrite(config, "POST", "/api/edge/operator/conflicts/decide")).toBe(true);
      expect(edgeBlocksWrite(config, "PUT", "/api/edge/operator/sync-control")).toBe(true);
      // Single stock item: edit (PATCH), delete and create are captured; merge stays cloud-only.
      expect(edgeBlocksWrite(config, "PATCH", "/api/stock-items/42")).toBe(mode === "read-only");
      expect(edgeBlocksWrite(config, "DELETE", "/api/stock-items/42")).toBe(mode === "read-only");
      expect(edgeBlocksWrite(config, "POST", "/api/stock-items")).toBe(mode === "read-only");
      for (const verb of ["POST", "PUT"]) {
        expect(edgeBlocksWrite(config, verb, "/api/stock-items/42")).toBe(true);
      }
      for (const verb of ["PUT", "PATCH", "DELETE"]) {
        expect(edgeBlocksWrite(config, verb, "/api/stock-items")).toBe(true);
      }
      // Plan batch 3: transfer edit (PUT), finalize/approve, revisions and their review.
      const open = mode === "read-only";
      expect(edgeBlocksWrite(config, "PUT", "/api/stock-transfers/42")).toBe(open);
      expect(edgeBlocksWrite(config, "POST", "/api/stock-transfers/42/approve")).toBe(open);
      expect(edgeBlocksWrite(config, "POST", "/api/stock-transfers/42/revisions")).toBe(open);
      expect(edgeBlocksWrite(config, "POST", "/api/stock-transfer-revisions/7/approve")).toBe(open);
      expect(edgeBlocksWrite(config, "POST", "/api/stock-transfer-revisions/7/reject")).toBe(open);
      expect(edgeBlocksWrite(config, "POST", "/api/vouchers/9/finalize")).toBe(open);
      for (const verb of ["POST", "PATCH", "DELETE"]) {
        expect(edgeBlocksWrite(config, verb, "/api/stock-transfers/42")).toBe(true);
      }
      expect(edgeBlocksWrite(config, "DELETE", "/api/stock-transfer-revisions/7")).toBe(true);
      expect(edgeBlocksWrite(config, "PATCH", "/api/stock-transfer-revisions/7/optional")).toBe(true);
      expect(edgeBlocksWrite(config, "POST", "/api/vouchers/9/reopen")).toBe(true);
      for (const step of [
        "parse",
        "validate",
        "import",
        "parse-multi-source",
        "validate-multi-source",
        "import-multi-source",
      ]) {
        expect(edgeBlocksWrite(config, "POST", `/api/stock-transfer-import/${step}`)).toBe(open);
        expect(edgeBlocksWrite(config, "PUT", `/api/stock-transfer-import/${step}`)).toBe(true);
      }
      expect(edgeBlocksWrite(config, "POST", "/api/locations/12/import-inventory")).toBe(open);
      expect(edgeBlocksWrite(config, "POST", "/api/locations/12/import-cost-prices")).toBe(true);
      expect(edgeBlocksWrite(config, "PUT", "/api/locations/12/import-inventory")).toBe(true);
      for (const path of [
        "/api/factory/pressing-machines/void",
        "/api/pos/retail/sales",
        "/api/containers/42/offload/extra",
        "/api/containers/abc/offload",
        "/api/inventory/silent-transfer/apply",
        "/api/attachments",
        "/api/files/42",
        "/api/payments",
        "/api/stock-items/import",
        "/api/stock-items/bulk-delete",
        "/api/stock-items/42/merge",
      ]) {
        for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
          expect(edgeBlocksWrite(config, verb, path)).toBe(true);
        }
      }
    }
  });
  it("lets only the conflict decision route through a fenced cloud", () => {
    const fenced = { mode: "cloud", primary: false, siteId: null, writeMode: "fenced" } as never;
    expect(edgeBlocksWrite(fenced, "POST", "/api/edge/operator/conflicts/decide")).toBe(false);
    expect(edgeBlocksWrite(fenced, "POST", "/api/edge/operator/sync-control")).toBe(true);
    expect(edgeBlocksWrite(fenced, "POST", "/api/vouchers/with-entries")).toBe(true);
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
