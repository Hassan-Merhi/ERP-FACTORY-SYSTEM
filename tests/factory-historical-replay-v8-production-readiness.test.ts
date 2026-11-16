import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HISTORICAL_REPLAY_APPLY_MODE_ENV,
  HISTORICAL_REPLAY_APPLY_MODE_VALUE,
  HISTORICAL_REPLAY_RELEASE_ID_ENV,
  readHistoricalReplayProductionControl,
} from "../server/services/factory/historical-replay/productionReadinessV8";
import {
  clearHistoricalReplayPreparations,
  freezeHistoricalReplayApplyRequest,
  rememberHistoricalReplayPreparation,
} from "../client/src/lib/historicalReplayPreparedRequest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Historical Replay V8 production readiness", () => {
  it("keeps production apply disabled unless both exact controls are configured", () => {
    const disabled = readHistoricalReplayProductionControl({});
    expect(disabled.enabled).toBe(false);
    expect(disabled.releaseId).toBeNull();
    expect(disabled.configurationErrors.length).toBeGreaterThan(0);

    const enabled = readHistoricalReplayProductionControl({
      [HISTORICAL_REPLAY_APPLY_MODE_ENV]: HISTORICAL_REPLAY_APPLY_MODE_VALUE,
      [HISTORICAL_REPLAY_RELEASE_ID_ENV]: "2026-07-26-replay-01",
    });
    expect(enabled).toEqual({
      enabled: true,
      releaseId: "2026-07-26-replay-01",
      configurationErrors: [],
    });
  });

  it("registers V8 before every older replay route layer", () => {
    const registration = read("server/routes/factory/raw-stock/rawStockRecalcRoutes.ts");
    const v8Index = registration.indexOf("registerHistoricalReplayPhase8ReadinessRoutes(app)");
    const companyScopeIndex = registration.indexOf("registerHistoricalReplayFullCompanyScopeRoutes(app)");
    const safetyIndex = registration.indexOf("registerHistoricalReplayPhase6GuardRoutes(app)");
    const exactIndex = registration.indexOf("registerHistoricalReplayRoutesV4(app)");

    expect(v8Index).toBeGreaterThan(-1);
    expect(v8Index).toBeLessThan(companyScopeIndex);
    expect(companyScopeIndex).toBeLessThan(safetyIndex);
    expect(safetyIndex).toBeLessThan(exactIndex);
  });

  it("binds apply authorization to release, company, user, algorithm, and exact token hash", () => {
    const route = read(
      "server/routes/factory/raw-stock/historicalReplayReadinessRoutes.ts"
    );
    expect(route).toContain("HISTORICAL_REPLAY_V8_APPLY_AUTHORIZATION");
    expect(route).toContain("confirmationTokenHash");
    expect(route).toContain("verified.companyId !== companyId");
    expect(route).toContain("verified.userId !== userId");
    expect(route).toContain("verified.releaseId !== control.releaseId");
    expect(route).toContain("verified.algorithmVersion !== REPLAY_ALGORITHM_VERSION");
    expect(route).toContain("HISTORICAL_REPLAY_APPLY_DISABLED");
    expect(route).toContain("HISTORICAL_REPLAY_SCHEMA_NOT_READY");
  });

  it("freezes the second signed token with the server-prepared request", () => {
    clearHistoricalReplayPreparations();
    expect(rememberHistoricalReplayPreparation({
      confirmationToken: "prepared-token",
      safeSupplierIds: [8, 3],
      frozenOptions: {
        includeCompletedBatches: true,
        includeFinalizedBales: false,
      },
      algorithmVersion: "HISTORICAL_COST_REPLAY_V7_INVENTORY_OWNERSHIP_FINAL",
      fingerprint: "scope-fingerprint",
      applyAuthorizationToken: "v8-authorization",
      productionReleaseId: "2026-07-26-replay-01",
    })).toBe(true);

    expect(freezeHistoricalReplayApplyRequest(
      "POST",
      "/api/factory/raw-stock/recalc/historical-replay/apply",
      { confirmationToken: "prepared-token", supplierIds: [999] }
    )).toEqual({
      dryRun: false,
      confirmationToken: "prepared-token",
      supplierIds: [3, 8],
      includeCompletedBatches: true,
      includeFinalizedBales: false,
      algorithmVersion: "HISTORICAL_COST_REPLAY_V7_INVENTORY_OWNERSHIP_FINAL",
      fingerprint: "scope-fingerprint",
      applyAuthorizationToken: "v8-authorization",
      productionReleaseId: "2026-07-26-replay-01",
    });
  });

  it("does not add migration, replay, startup, or autonomous execution", () => {
    const route = read(
      "server/routes/factory/raw-stock/historicalReplayReadinessRoutes.ts"
    );
    const service = read(
      "server/services/factory/historical-replay/productionReadinessV8.ts"
    );
    expect(route).not.toMatch(/ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE/i);
    expect(service).not.toMatch(/ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE/i);
    expect(route).not.toContain("applyHistoricalCostReplay(");
    expect(service).not.toContain("applyHistoricalCostReplay(");
  });
});
