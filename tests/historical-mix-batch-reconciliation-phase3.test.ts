import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  statements: [] as Array<{ sql: string; params: unknown[] }>,
  released: false,
  badQuery: false,
}));
vi.mock("../server/db", () => ({
  pool: {
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        h.statements.push({ sql, params });
        if (h.badQuery && sql.includes("FROM factory_mix_batches WHERE")) throw new Error("forced read error");
        return { rows: [] };
      },
      release: () => { h.released = true; },
    }),
  },
}));

import {
  classifyHistoricalMixBatch,
  getHistoricalMixBatchReconciliation,
  historicalMixAuditCsv,
  summarizeHistoricalMixAudit,
} from "../server/services/factory/historicalMixBatchReconciliation";

const header = (overrides: Record<string, unknown> = {}) => ({
  id: 231, batch_code: "FMB-2026-0231", status: "COMPLETED",
  batch_date: "2026-11-06", total_weight_kg: "15353.000",
  used_kg: "15353.000", total_cost: "8824.7659100",
  cost_per_kg: "0.5747910", deleted_at: null,
  ...overrides,
});
const source = (overrides: Record<string, unknown> = {}) => ({
  id: 99, mix_batch_id: 231, weight_kg: "15353.000",
  cost_per_kg: "0.5747910", total_cost: "8824.7659100",
  created_at: "2026-11-06T16:01:00", supplier_id: 41,
  inventory_supplier_id: 41, container_id: 20, source_batch_id: null,
  supplier_name: "ABO SOBHI DIRECT", supplier_company_id: 12,
  current_supplier_rate: "0.5566890",
  container_number: "CT-20", container_company_id: 12,
  container_supplier_id: 41, container_offloaded_at: "2026-11-05T10:00:00",
  upstream_company_id: null, upstream_batch_code: null,
  ...overrides,
});

describe("Phase 3 historical mix batch reconciliation", () => {
  it("separates later supplier-rate drift from historical arithmetic", () => {
    const batch = classifyHistoricalMixBatch(header(), [source()], [], 12);
    expect(batch.classification).toBe("CURRENT_RATE_ONLY");
    expect(batch.recordedTotalUsd).toBe("8824.7659100");
    expect(batch.sourceTotalUsd).toBe("8824.7659100");
    expect(batch.issues.some((x) => x.code === "CURRENT_SUPPLIER_RATE_CHANGED")).toBe(true);
    expect(batch.issues.some((x) => x.severity === "error")).toBe(false);
  });

  it("reports missing current supplier rates as unavailable rather than zero USD", () => {
    const batch = classifyHistoricalMixBatch(header(), [source({ current_supplier_rate: null })], [], 12);
    expect(batch.currentRateEstimateUsd).toBeNull();
    expect(batch.issues.map((x) => x.code)).toContain("CURRENT_SUPPLIER_RATE_MISSING");
    expect(batch.classification).toBe("CURRENT_RATE_ONLY");
  });

  it("marks zero historical source values for evidence review without auto-repair", () => {
    const batch = classifyHistoricalMixBatch(
      header({ total_weight_kg: "10725.000", total_cost: "0", cost_per_kg: "0" }),
      [source({ weight_kg: "10725.000", cost_per_kg: "0", total_cost: "0" })],
      [], 12,
    );
    expect(batch.classification).toBe("EVIDENCE_REVIEW");
    expect(batch.sources[0].rateProvenance).toBe("RECORDED_ZERO");
    expect(batch.recordedTotalUsd).toBe("0.0000000");
  });

  it("detects actual historical source and header arithmetic errors", () => {
    const batch = classifyHistoricalMixBatch(
      header({ total_cost: "9000.0000000" }),
      [source({ total_cost: "8824.7659100", cost_per_kg: "0.5500000" })], [], 12,
    );
    expect(batch.classification).toBe("ARITHMETIC_ERROR");
    expect(batch.issues.map((x) => x.code)).toContain("HEADER_SOURCE_COST_MISMATCH");
    expect(batch.issues.map((x) => x.code)).toContain("SOURCE_VALUE_MATH_MISMATCH");
  });

  it("flags owner-attribution errors and an offload dated later than the mix", () => {
    const batch = classifyHistoricalMixBatch(header(), [
      source({ inventory_supplier_id: 15, container_supplier_id: 41, container_offloaded_at: "2026-11-09T09:00:00" }),
    ], [], 12);
    expect(batch.issues.map((x) => x.code)).toContain("INVENTORY_SUPPLIER_LINK_MISMATCH");
    expect(batch.issues.map((x) => x.code)).toContain("CONTAINER_OFFLOAD_AFTER_BATCH");
    expect(batch.classification).toBe("EVIDENCE_REVIEW");
  });

  it("flags historical valued ADD adjustments with unclassified valuation basis", () => {
    const batch = classifyHistoricalMixBatch(header(), [source()], [{
      supplier_id: 41, date: "2026-11-04", adjustment_type: "ADD",
      cost_per_kg: "0.12", valuation_basis: null,
    }], 12);
    expect(batch.sources[0].priorAdjustmentCount).toBe(1);
    expect(batch.sources[0].unclassifiedPriorAdjustmentCount).toBe(1);
    expect(batch.classification).toBe("EVIDENCE_REVIEW");
  });

  it("keeps deleted batches in the scan but excludes them from active mismatch counters", () => {
    const deleted = classifyHistoricalMixBatch(
      header({ deleted_at: "2026-11-07", total_cost: "9999.0000000" }),
      [source()], [], 12,
    );
    const report = summarizeHistoricalMixAudit(12, [deleted]);
    expect(deleted.classification).toBe("DELETED_HISTORY");
    expect(report.summary.deletedBatches).toBe(1);
    expect(report.summary.activeBatches).toBe(0);
    expect(report.summary.headerMismatchBatches).toBe(0);
    expect(report.batches).toHaveLength(1);
  });

  it("escapes spreadsheet formula injection in batch codes and source names", () => {
    const row = classifyHistoricalMixBatch(header({ batch_code: "=2+3" }), [
      source({ supplier_name: "=malicious(1)" }),
    ], [], 12);
    const report = summarizeHistoricalMixAudit(12, [row]);
    expect(historicalMixAuditCsv(report, "batches")).toContain("'=2+3");
    expect(historicalMixAuditCsv(report, "sources")).toContain("'=malicious(1)");
  });

  it("uses a consistent, tenant-scoped, read-only snapshot and releases the connection", async () => {
    h.statements = [];
    h.released = false;
    h.badQuery = false;
    const report = await getHistoricalMixBatchReconciliation(12);
    expect(report.readOnly).toBe(true);
    expect(report.companyId).toBe(12);
    expect(h.statements[0].sql).toMatch(/REPEATABLE READ READ ONLY/);
    expect(h.statements.some((x) => x.sql.includes("app.current_company_id") && x.params[0] === "12")).toBe(true);
    expect(h.statements.filter((x) => x.sql.trimStart().startsWith("SELECT")).length).toBe(4);
    expect(h.statements.some((x) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(x.sql))).toBe(false);
    expect(h.statements.at(-1)?.sql).toBe("COMMIT");
    expect(h.released).toBe(true);
  });

  it("rolls back and releases connection on a failed read", async () => {
    h.statements = [];
    h.released = false;
    h.badQuery = true;
    await expect(getHistoricalMixBatchReconciliation(12)).rejects.toThrow("forced read error");
    expect(h.statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(h.released).toBe(true);
    h.badQuery = false;
  });
});
