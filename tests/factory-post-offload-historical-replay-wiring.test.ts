import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("post-offload historical supplier-cost replay", () => {
  it("uses the exact protected replay engine instead of copying the current supplier rate", () => {
    const service = read("server/services/factory/postOffloadHistoricalReplay.ts");

    expect(service).toContain("previewHistoricalCostReplayWithExecutor");
    expect(service).toContain("buildHistoricalReplayScopeInternal");
    expect(service).toContain("computeReplayFingerprint");
    expect(service).toContain("applyHistoricalCostReplay");
    expect(service).toContain("expectedScope: normalizedScope");
    expect(service).toContain("REPLAY_ALGORITHM_VERSION");
    expect(service).not.toContain("currentRawMaterialCostPerKgUsd");
    expect(service).not.toContain("UPDATE factory_mix_batch_sources SET cost_per_kg");
  });

  it("includes completed batches while keeping finalized bales behind explicit admin replay", () => {
    const service = read("server/services/factory/postOffloadHistoricalReplay.ts");

    expect(service).toContain("const includeCompletedBatches = true");
    expect(service).toContain("const includeFinalizedBales = false");
    expect(service).toContain("replayBaleIdsForScope(normalizedScope, includeFinalizedBales)");
  });

  it("persists exact undo and audit records in the replay commit", () => {
    const service = read("server/services/factory/postOffloadHistoricalReplay.ts");

    expect(service).toContain("kind: EXACT_UNDO_KIND");
    expect(service).toContain("factory_recalc_undo_log");
    expect(service).toContain("HISTORICAL_REPLAY_EXACT");
    expect(service).toContain("post_offload_historical_replay_applied");
    expect(service).toContain("before: snapshots.before");
    expect(service).toContain("after: snapshots.after");
  });

  it("runs only after a successful mutation response and surfaces repair-required state", () => {
    const middleware = read("server/routes/factory/raw-stock/postOffloadHistoricalReplayMiddleware.ts");

    expect(middleware).toContain("if (res.statusCode >= 400 || body?.alreadyUndone === true)");
    expect(middleware).toContain("replayPostOffloadHistoricalCosts");
    expect(middleware).toContain("historicalReplay");
    expect(middleware).toContain("historicalCostsRecalculated");
    expect(middleware).toContain("historicalRepairRequired");
    expect(middleware).toContain('historicalReplay.status === "blocked"');
    expect(middleware).toContain('historicalReplay.status === "failed"');
  });

  it("registers the replay interceptor before post-offload container routes", () => {
    const active = read("server/routes/factory/factoryRawStockRoutes.ts");
    const activeReplay = active.indexOf('app.use("/api/factory/containers", postOffloadHistoricalReplayMiddleware)');
    const activeRoutes = active.indexOf("registerRawStockContainerRoutes(app);");
    expect(activeReplay).toBeGreaterThan(-1);
    expect(activeReplay).toBeLessThan(activeRoutes);
  });

  it("never changes inventory or production quantities", () => {
    const service = read("server/services/factory/postOffloadHistoricalReplay.ts");

    expect(service).not.toContain("received_kg =");
    expect(service).not.toContain("used_kg =");
    expect(service).not.toContain("weight_kg =");
    expect(service).not.toContain("quantity =");
    expect(service).not.toContain("voucher_entries");
    expect(service).not.toContain("factory_supplier_payments");
  });
});
