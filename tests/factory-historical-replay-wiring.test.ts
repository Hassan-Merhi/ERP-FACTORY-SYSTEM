import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { functionDefinition, hasColumn } from "./helpers/schemaManifest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Historical Replay final wiring", () => {
  it("routes the public facade to final scope, costing and apply implementations", () => {
    const facade = read("server/services/factory/historicalCostReplay.ts");
    expect(facade).toContain("computeCanonicalCostsV6 as computeCanonicalCosts");
    expect(facade).toContain("./historical-replay/exactScope");
    expect(facade).toContain("./historical-replay/exactApplyFinal");
    expect(facade).toContain("applyExactHistoricalCostReplayV6 as applyHistoricalCostReplay");

    const exactScope = read("server/services/factory/historical-replay/exactScope.ts");
    expect(exactScope).toContain("buildExactHistoricalReplayScopeV7Final");
    expect(exactScope).toContain("buildExactHistoricalReplayScopeInternalV7Final");
  });

  it("invalidates tokens prepared by incomplete earlier replay versions", () => {
    const types = read("server/services/factory/historical-replay/types.ts");
    expect(types).toContain('REPLAY_ALGORITHM_VERSION = "HISTORICAL_COST_REPLAY_V7_INVENTORY_OWNERSHIP_FINAL"');
  });

  it("registers full-company scope, safety guard and exact handlers before legacy routes", () => {
    const routes = read("server/routes/factory/raw-stock/rawStockRecalcRoutes.ts");
    const fullCompany = routes.indexOf("registerHistoricalReplayFullCompanyScopeRoutes(app)");
    const guard = routes.indexOf("registerHistoricalReplayPhase6GuardRoutes(app)");
    const exact = routes.indexOf("registerHistoricalReplayRoutesV4(app)");
    const legacy = routes.indexOf("registerLegacyRawStockRecalcRoutes(app)");
    expect(fullCompany).toBeGreaterThan(-1);
    expect(fullCompany).toBeLessThan(guard);
    expect(guard).toBeLessThan(exact);
    expect(exact).toBeLessThan(legacy);
  });

  it("keeps apply authority in the signed token after client state changes or reload", () => {
    const prepared = read("client/src/lib/historicalReplayPreparedRequest.ts");
    expect(prepared).toContain("server-returned, signed preparation state");
    expect(prepared).toContain("dryRun: false");
    expect(prepared).toContain("confirmationToken: token");
    expect(prepared).toContain("includeFinalizedBales: frozen.options.includeFinalizedBales");
    expect(prepared).toContain("applyAuthorizationToken");
    expect(prepared).toContain("productionReleaseId");
  });

  it("ships the schema migration and database-boundary ownership guard", () => {
    expect(hasColumn("factory_mix_batch_sources", "inventory_supplier_id")).toBe(true);
    expect(hasColumn("factory_raw_material_adjustments", "valuation_basis")).toBe(true);
    expect(functionDefinition("factory_resolve_mix_source_inventory_supplier")).toContain(
      "INVENTORY_SUPPLIER_UNRESOLVED"
    );
  });
});
