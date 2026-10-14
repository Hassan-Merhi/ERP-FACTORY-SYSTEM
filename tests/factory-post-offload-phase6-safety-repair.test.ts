import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Phase 6 post-offload safety and repair", () => {
  it("exposes a read-only readiness endpoint and a protected prepare/apply endpoint", () => {
    const routes = read("server/routes/factory/raw-stock/postOffloadPhase6SafetyRoutes.ts");

    expect(routes).toContain('const READINESS_PATH = "/api/factory/raw-stock/post-offload/readiness"');
    expect(routes).toContain('const REPAIR_PATH = "/api/factory/raw-stock/post-offload/repair"');
    expect(routes).toContain("requireRole(...ADMIN_ROLES)");
    expect(routes).toContain("inspectPostOffloadPhase6Readiness");
    expect(routes).toContain("preparePostOffloadPhase6Repair");
    expect(routes).toContain("applyPostOffloadPhase6Repair");
    expect(routes).toContain("repairWasCommitted");
    expect(routes).toContain("transactionRolledBack: !repairWasCommitted");
    expect(routes).toContain("partialChanges: false");
    expect(routes).toContain("undoLogId");
  });

  it("binds a short-lived approval to company, user, release, algorithm, state, scope, and row count", () => {
    const service = read("server/services/factory/postOffloadPhase6SafetyImpl.ts");

    for (const field of [
      "companyId",
      "userId",
      "releaseId",
      "algorithmVersion",
      "readinessVersion",
      "supplierIds",
      "scopeRowCount",
      "fingerprint",
      "stateFingerprint",
      "issuedAt",
      "expiresAt",
    ]) {
      expect(service).toContain(field);
    }
    expect(service).toContain("signRepairToken(payload)");
    expect(service).toContain("verifyRepairToken<PostOffloadPhase6TokenPayload>");
    expect(service).toContain("replayWriteScopesEqual(signedScope, fresh.scope)");
    expect(service).toContain("POST_OFFLOAD_PHASE6_TOKEN_STALE");
  });

  it("uses the existing exact replay engine with one-use token, exact undo, and atomic apply audit", () => {
    const service = read("server/services/factory/postOffloadPhase6SafetyImpl.ts");
    const exactApply = read("server/services/factory/historical-replay/exactApplyFinal.ts");

    expect(service).toContain("applyHistoricalCostReplay({");
    expect(service).toContain("tokenHash");
    expect(service).toContain("HISTORICAL_REPLAY_EXACT");
    expect(service).toContain("post_offload_phase6_applied");
    expect(service).toContain("RETURNING id");
    expect(exactApply).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(exactApply).toContain("pg_advisory_xact_lock(9003, $1)");
    expect(exactApply).toContain("factory_replay_consumed_tokens");
    expect(exactApply).toContain('await client.query("ROLLBACK")');
    expect(service).toContain("POST_OFFLOAD_PHASE6_POST_COMMIT_VERIFICATION_FAILED");
    expect(service).toContain("verificationError.repairCommitted = true");
  });

  it("persists readiness, preview, blocked, failed, and post-apply verification audit outcomes", () => {
    const routes = read("server/routes/factory/raw-stock/postOffloadPhase6SafetyRoutes.ts");
    const audit = read("server/services/factory/postOffloadPhase6Audit.ts");

    expect(routes).toContain("persistPostOffloadPhase6Audit");
    for (const action of [
      "post_offload_phase6_readiness_inspected",
      "post_offload_phase6_preview_generated",
      "post_offload_phase6_blocked",
      "post_offload_phase6_failed",
      "post_offload_phase6_verified",
    ]) {
      expect(routes + audit).toContain(action);
    }
    expect(audit).toContain("INSERT INTO audit_log");
    expect(audit).toContain("factory_offload_additional_charges");
  });

  it("includes completed batches but always excludes finalized and sold bales from automatic repair", () => {
    const service = read("server/services/factory/postOffloadPhase6SafetyImpl.ts");

    expect(service).toContain("const INCLUDE_COMPLETED_BATCHES = true");
    expect(service).toContain("const INCLUDE_FINALIZED_BALES = false");
    expect(service).toContain("includeCompletedBatches: true");
    expect(service).toContain("includeFinalizedBales: false");
    expect(service).toContain("finalizedBalesExcluded");
  });

  it("diagnoses accounting, FX, reversal, raw-stock, safety, schema, and production control state", () => {
    const service = read("server/services/factory/postOffloadPhase6SafetyImpl.ts");

    expect(service).toContain("unresolved_fx_charges");
    expect(service).toContain("missing_daybook_links");
    expect(service).toContain("missing_voucher_links");
    expect(service).toContain("incomplete_voucher_currency_rows");
    expect(service).toContain("missing_reversal_links");
    expect(service).toContain("raw_stock_cost_drift_rows");
    expect(service).toContain("inspectHistoricalReplayProductionSchema");
    expect(service).toContain("evaluateHistoricalReplaySafetyReadiness");
    expect(service).toContain("readHistoricalReplayProductionControl");
    expect(service).toContain('"ready" | "repair_required" | "blocked"');
    expect(service).toContain("actualChangeRows");
    expect(service).toContain("supplierRateChanges");
  });

  it("does not introduce quantity, payment, customer balance, or finalized-bale writes", () => {
    const service = read("server/services/factory/postOffloadPhase6SafetyImpl.ts");

    expect(service).not.toMatch(/SET\s+received_kg\s*=/i);
    expect(service).not.toMatch(/SET\s+used_kg\s*=/i);
    expect(service).not.toMatch(/SET\s+quantity\s*=/i);
    expect(service).not.toMatch(/SET\s+weight_kg\s*=/i);
    expect(service).not.toContain("factory_supplier_payments");
    expect(service).not.toContain("customer_balances");
    expect(service).not.toContain("includeFinalizedBales: true");
  });

  it("registers the Phase 6 routes in the active raw-stock aggregator", () => {
    for (const path of ["server/routes/factory/factoryRawStockRoutes.ts"]) {
      const routes = read(path);
      expect(routes).toContain("registerPostOffloadPhase6SafetyRoutes");
      expect(routes).toContain("registerPostOffloadPhase6SafetyRoutes(app)");
    }
  });
});
