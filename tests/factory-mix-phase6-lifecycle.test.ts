import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  statements: [] as string[],
  fail: false,
  released: false,
}));
vi.mock("../server/db", () => ({
  pool: {
    connect: async () => ({
      query: async (sql: string) => {
        state.statements.push(sql);
        if (state.fail && sql.includes("FROM factory_mix_batches m")) throw new Error("read failed");
        if (sql.includes("FROM factory_mix_batches m")) return { rows: [
          {
            id: 53, batch_code: "FMB-2026-0039", status: "COMPLETED",
            batch_date: "2026-03-31", deleted_at: null,
            total_weight_kg: "5593.000", used_kg: "5754.000",
            cost_per_kg: "0.57", total_cost: "3188.0100",
            carry_forward_from_id: null, parent_id: null, parent_company_id: null,
            parent_batch_code: null, parent_batch_date: null, parent_cost_per_kg: null,
  parent_status: null, parent_deleted_at: null,
            carry_source_count: "0", carry_source_kg: "0", carry_source_usd: "0",
            daily_usage_count: "0", daily_usage_kg: "0", child_count: "0",
          },
        ] };
        return { rows: [] };
      },
      release: () => { state.released = true; },
    }),
  },
}));

import {
  MixLifecycleRefusal,
  mixKilograms,
  requireMixLifecycleDate,
  requireMixLifecycleAvailable,
  requireMixLifecycleUsage,
  requireMixFinalizeDecision,
  requireMixDeletionSafe,
  validateMixLifecycleUsageRequest,
} from "../server/services/factory/mixLifecyclePhase6";
import {
  classifyMixLifecycleEvidence,
  summarizePhase6MixLifecycle,
  getPhase6MixLifecycleReport,
  phase6MixLifecycleCsv,
} from "../server/services/factory/mixPhase6LifecycleAudit";

const openBatch = (overrides: Record<string, unknown> = {}) => ({
  id: 50, batchCode: "FMB-2026-0036", status: "ACTIVE",
  totalWeightKg: "100.000", usedKg: "40.000", deletedAt: null,
  ...overrides,
});
const saved = (overrides: Record<string, unknown> = {}) => ({
  id: 50, batch_code: "FMB-2026-0036", status: "COMPLETED",
  batch_date: "2026-03-26", deleted_at: null,
  total_weight_kg: "8715.000", used_kg: "8695.000",
  cost_per_kg: "0.6325000", total_cost: "5512.2375000",
  carry_forward_from_id: null, parent_id: null, parent_company_id: null,
  parent_batch_code: null, parent_batch_date: null, parent_cost_per_kg: null,
  parent_status: null, parent_deleted_at: null,
  carry_source_count: "0", carry_source_kg: "0", carry_source_usd: "0",
  daily_usage_count: "0", daily_usage_kg: "0", child_count: "0",
  ...overrides,
});

describe("Phase 6 exact-kg mix lifecycle guards", () => {
  it("normalizes whole and 3dp quantities without allowing rounding or float overflow", () => {
    expect(mixKilograms("12").toFixed(3)).toBe("12.000");
    expect(mixKilograms("0.001").toFixed(3)).toBe("0.001");
    expect(mixKilograms(22.375).toFixed(3)).toBe("22.375");
    for (const input of [0, "-1", "0", "1.0009", "1e4", "1abc", 0.0004, null, "100.0000", Infinity]) {
      expect(() => mixKilograms(input)).toThrow(MixLifecycleRefusal);
    }
  });

  it("validates an actual business date, not just the YYYY-MM-DD pattern", () => {
    expect(requireMixLifecycleDate("2026-11-09")).toBe("2026-11-09");
    for (const date of ["2026-02-30", "2026-13-01", "11/09/2026", "2026-1-1", null]) {
      expect(() => requireMixLifecycleDate(date)).toThrow(MixLifecycleRefusal);
    }
  });

  it("does not silently discard duplicate, invalid or zero-usage entries", () => {
    const request = { usedDate: "2026-11-09", usages: [{ batchId: 5, kgUsed: 15.125 }] };
    const valid = validateMixLifecycleUsageRequest(request);
    expect(valid.entries[0].kgUsed.toFixed(3)).toBe("15.125");
    expect(valid.usedDate).toBe("2026-11-09");
    expect(() => validateMixLifecycleUsageRequest({ ...request, usages: [
      { batchId: 5, kgUsed: 10 }, { batchId: 5, kgUsed: 1 },
    ] })).toThrow(MixLifecycleRefusal);
    expect(() => validateMixLifecycleUsageRequest({ ...request, usages: [{ batchId: 5, kgUsed: 0 }] }))
      .toThrow(MixLifecycleRefusal);
    expect(() => validateMixLifecycleUsageRequest({ ...request, usages: [{ batchId: "5", kgUsed: 1 }] }))
      .toThrow(MixLifecycleRefusal);
    expect(() => validateMixLifecycleUsageRequest({ usedDate: "2026-11-09", usages: [] }))
      .toThrow(MixLifecycleRefusal);
  });

  it("rejects completed, closed, deleted, corrupted and overdrawn batches", () => {
    expect(() => requireMixLifecycleAvailable(openBatch({ status: "COMPLETED" }))).toThrow();
    expect(() => requireMixLifecycleAvailable(openBatch({ status: "CLOSED" }))).toThrow();
    expect(() => requireMixLifecycleAvailable(openBatch({ deletedAt: new Date() }))).toThrow();
    expect(() => requireMixLifecycleAvailable(openBatch({ usedKg: "100.001" }))).toThrow();
    expect(() => requireMixLifecycleAvailable(openBatch({ usedKg: "-1" }))).toThrow();
    expect(() => requireMixLifecycleUsage(openBatch(), "60.001")).toThrow();
    expect(requireMixLifecycleUsage(openBatch(), "60.000").leftoverKg.toFixed(3)).toBe("0.000");
    expect(requireMixLifecycleUsage(openBatch(), "59.999").leftoverKg.toFixed(3)).toBe("0.001");
  });

  it("requires exact kg, deliberate waste confirmation and a written reason for finalization", () => {
    expect(() => requireMixFinalizeDecision(openBatch(), {})).toThrow(MixLifecycleRefusal);
    expect(() => requireMixFinalizeDecision(openBatch(), {
      confirmRemainderAsWaste: true, wasteKg: "60.000", wasteReason: "short",
    })).toThrow(MixLifecycleRefusal);
    expect(() => requireMixFinalizeDecision(openBatch(), {
      confirmRemainderAsWaste: true, wasteKg: "59.999",
      wasteReason: "Verified historical production write-off",
    })).toThrow(MixLifecycleRefusal);
    const approved = requireMixFinalizeDecision(openBatch(), {
      confirmRemainderAsWaste: true, wasteKg: "60.000",
      wasteReason: "Verified physical mixing waste on the approved production sheet",
    });
    expect(approved.remainingKg.toFixed(3)).toBe("60.000");
    expect(approved.wasteReason).toContain("production sheet");
    expect(requireMixFinalizeDecision(openBatch({ usedKg: "100.000" }), {}).remainingKg.toFixed(3)).toBe("0.000");
  });
  it("blocks deletion of completed, consumed, linked or carried mixes before raw-stock recredit", () => {
    expect(() => requireMixDeletionSafe(openBatch({ usedKg: "0" }), false)).not.toThrow();
    expect(() => requireMixDeletionSafe(openBatch({ status: "COMPLETED" }), false)).toThrow(MixLifecycleRefusal);
    expect(() => requireMixDeletionSafe(openBatch({ status: "CLOSED" }), false)).toThrow(MixLifecycleRefusal);
    expect(() => requireMixDeletionSafe(openBatch({ usedKg: "1.000" }), false)).toThrow(MixLifecycleRefusal);
    expect(() => requireMixDeletionSafe(openBatch({ usedKg: "0", carryForwardFromId: 4 }), false)).toThrow(MixLifecycleRefusal);
    expect(() => requireMixDeletionSafe(openBatch({ usedKg: "0" }), true)).toThrow(MixLifecycleRefusal);
  });
});

describe("Phase 6 historical completion / carry-forward evidence", () => {
  it("preserves remaining kg and flags the completed status rather than manufacturing a carry-forward", () => {
    const row = classifyMixLifecycleEvidence(saved(), 12);
    expect(row.remainingKg).toBe("20.000");
    expect(row.issues.map(issue => issue.code)).toContain("COMPLETED_WITH_REMAINDER");
    expect(row.classification).toBe("REQUIRES_REVIEW");
    expect(row.carryForwardFromId).toBeNull();
    expect(row.estimatedRemainingUsd).toBe("12.6500000");
  });

  it("detects over-consumption without clamping the original used kilograms", () => {
    const row = classifyMixLifecycleEvidence(saved({
      id: 53, batch_code: "FMB-2026-0039", total_weight_kg: "5593.000", used_kg: "5754.000",
    }), 12);
    expect(row.issues.map(issue => issue.code)).toContain("OVERUSED");
    expect(row.remainingKg).toBe("-161.000");
    expect(row.classification).toBe("INVALID_QUANTITY");
  });

  it("checks parent-source weight, cost and date in a carry-forward", () => {
    const row = classifyMixLifecycleEvidence(saved({
      status: "CARRY_FORWARD", carry_forward_from_id: 49,
      parent_id: 49, parent_company_id: 12, parent_status: "CLOSED",
      parent_deleted_at: null, parent_batch_code: "FMB-2026-0035",
      parent_batch_date: "2026-03-25", parent_cost_per_kg: "0.6325000",
      batch_date: "2026-03-26", total_weight_kg: "100.000", used_kg: "0",
      total_cost: "63.2500000", carry_source_count: "1",
      carry_source_kg: "100.000", carry_source_usd: "63.2500000",
    }), 12);
    expect(row.issues).toEqual([]);
    const damaged = classifyMixLifecycleEvidence(saved({
      status: "CARRY_FORWARD", carry_forward_from_id: 49, parent_id: 49,
      parent_company_id: 12, total_weight_kg: "100.000", used_kg: "0",
      carry_source_count: "0", carry_source_kg: "0", carry_source_usd: "0",
    }), 12);
    expect(damaged.issues.map(i => i.code)).toContain("CARRY_SOURCE_MISSING");
  });

  it("marks missing / foreign parent IDs and downstream daily usage over-allocation", () => {
    const row = classifyMixLifecycleEvidence(saved({
      carry_forward_from_id: 999, parent_id: null, parent_company_id: null,
      daily_usage_count: "2", daily_usage_kg: "10000.000",
    }), 12);
    expect(row.issues.map(i => i.code)).toContain("CARRY_PARENT_MISSING");
    expect(row.issues.map(i => i.code)).toContain("DAILY_USAGE_EXCEEDS_RECORDED_TOTAL");
  });

  it("excludes deleted history from active discrepancy totals and formula-escapes batch codes", () => {
    const report = summarizePhase6MixLifecycle(12, [
      saved({ id: 1, batch_code: "=danger", deleted_at: "2026-11-09" }),
      saved({ id: 2, batch_code: "FMB-2" }),
      saved({ id: 3, batch_code: "FMB-3", total_weight_kg: "50", used_kg: "51" }),
    ]);
    expect(report.summary.allBatches).toBe(3);
    expect(report.summary.activeBatches).toBe(2);
    expect(report.summary.deletedBatches).toBe(1);
    expect(report.summary.completedWithRemainderBatches).toBe(1);
    expect(report.summary.overusedBatches).toBe(1);
    expect(report.summary.overusedKg).toBe("1.000");
    expect(phase6MixLifecycleCsv(report)).toContain("'=danger");
  });
});

describe("Phase 6 read-only, tenant-scoped snapshot", () => {
  beforeEach(() => { state.statements = []; state.fail = false; state.released = false; });

  it("does not write a historical fix and uses one repeatable-read snapshot", async () => {
    const report = await getPhase6MixLifecycleReport(12);
    expect(report.summary.overusedBatches).toBe(1);
    expect(report.batches[0].batchCode).toBe("FMB-2026-0039");
    expect(state.statements[0]).toContain("REPEATABLE READ READ ONLY");
    expect(state.statements.some(sql => sql.includes("app.current_company_id"))).toBe(true);
    expect(state.statements.some(sql => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql))).toBe(false);
    expect(state.statements.at(-1)).toBe("COMMIT");
    expect(state.released).toBe(true);
  });

  it("rolls back the snapshot and releases the client when a query fails", async () => {
    state.fail = true;
    await expect(getPhase6MixLifecycleReport(12)).rejects.toThrow("read failed");
    expect(state.statements.at(-1)).toBe("ROLLBACK");
    expect(state.released).toBe(true);
  });
});
