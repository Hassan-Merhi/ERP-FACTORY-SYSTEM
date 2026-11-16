import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalEdgeVoucherPayload,
  captureEdgeVoucherTx,
  ensureEdgeVoucherOutboxSchema,
} from "../server/edge/edgeVoucherOutbox";

const lan = {
  FACTORY_EDGE_MODE: "lan",
  FACTORY_EDGE_SITE_ID: "027d7472-4a29-4bb3-a4aa-5b30e4ad631f",
  FACTORY_EDGE_HOSTNAME: "erp.factory.internal",
  FACTORY_EDGE_WRITE_MODE: "lan-primary",
  FACTORY_EDGE_PRIMARY_ACK: "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED",
  // Phase 7: LAN-primary requires an exact writer epoch and baseline digest.
  FACTORY_EDGE_WRITER_EPOCH: "3",
  FACTORY_EDGE_BASELINE_SHA256: "a".repeat(64),
  NODE_ENV: "production",
  PGHOST: "postgres",
  PGPORT: "5432",
  PGUSER: "erp_edge",
  PGPASSWORD: "test-only-key-".repeat(6),
  PGDATABASE: "erp_edge",
  PGSSLMODE: "disable",
  SESSION_SECRET: "test-only-key-".repeat(6),
  ENABLE_SCHEDULERS: "false",
  RUN_STARTUP_MIGRATIONS: "true",
  CSRF_ENFORCE: "1",
};

const PRIMARY_ONLY = new Set(["FACTORY_EDGE_PRIMARY_ACK", "FACTORY_EDGE_WRITER_EPOCH", "FACTORY_EDGE_BASELINE_SHA256"]);

function setLan(primary = true) {
  vi.stubEnv("DATABASE_URL", undefined);
  for (const [key, value] of Object.entries(lan)) {
    if (key === "FACTORY_EDGE_WRITE_MODE" && !primary) vi.stubEnv(key, "read-only");
    else if (PRIMARY_ONLY.has(key) && !primary) vi.stubEnv(key, "");
    else vi.stubEnv(key, value);
  }
}

afterEach(() => vi.unstubAllEnvs());

describe("Phase 4 voucher outbox durability policy", () => {
  it("does nothing to cloud-posted vouchers", async () => {
    vi.stubEnv("FACTORY_EDGE_MODE", "cloud");
    const execute = vi.fn();
    await captureEdgeVoucherTx({ execute } as never, {
      companyId: 1,
      actorUserId: "worker",
      localVoucherId: 1,
      voucher: { id: 1 },
      entries: [],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("creates append-only schema on LAN, not in cloud", async () => {
    setLan();
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await ensureEdgeVoucherOutboxSchema({ query } as never);
    const ddl = query.mock.calls.map(([q]) => String(q)).join("\n");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS factory_edge_voucher_outbox");
    expect(ddl).toContain("BEFORE UPDATE OR DELETE");
    expect(ddl).toContain("UNIQUE (site_id, operation_id)");
  });

  it("canonicalizes equivalent JSONB payloads for reproducible SHA-256 fingerprints", () => {
    const a = canonicalEdgeVoucherPayload({ id: 4, metadata: { z: 1, a: 2 } }, [{ id: 5, debit: "1" }]);
    const b = canonicalEdgeVoucherPayload({ metadata: { a: 2, z: 1 }, id: 4 }, [{ debit: "1", id: 5 }]);
    expect(a).toBe(b);
  });

  it("captures an ordered source event only on LAN primary", async () => {
    setLan();
    const execute = vi.fn().mockResolvedValue([]);
    await captureEdgeVoucherTx({ execute } as never, {
      companyId: 5,
      actorUserId: "u5",
      localVoucherId: 42,
      requestId: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
      voucher: { id: 42, amount: "10.00" },
      entries: [{ debitAmount: "10.00" }],
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(execute.mock.calls[0])).toContain("pg_advisory_xact_lock");
    expect(JSON.stringify(execute.mock.calls[1])).toContain("factory_edge_voucher_outbox");
  });

  it("refuses invalid company scope and never captures on read-only LAN", async () => {
    setLan();
    const execute = vi.fn().mockResolvedValue([]);
    await expect(
      captureEdgeVoucherTx({ execute } as never, {
        companyId: 0,
        actorUserId: "u",
        localVoucherId: 5,
        voucher: {},
        entries: [],
      })
    ).rejects.toThrow("EDGE_OUTBOX_SCOPE_INVALID");
    expect(execute).not.toHaveBeenCalled();
    setLan(false);
    await captureEdgeVoucherTx({ execute } as never, {
      companyId: 5,
      actorUserId: "u",
      localVoucherId: 5,
      voucher: {},
      entries: [],
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
