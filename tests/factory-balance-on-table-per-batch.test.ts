import { describe, expect, it, vi } from "vitest";

import {
  calculateBatchRemainingValuation,
  calculateCumulativeBatchRate,
} from "../server/routes/factory/bale-exports/production-value-math";

describe("Balance on Table: stored batch-specific remaining cost", () => {
  it("values only each active remaining pool, without counting closed carry-forward parents twice", () => {
    const report = calculateBatchRemainingValuation([
      { id: 1, totalWeightKg: "100", totalCost: "50", usedKg: "100" },
      { id: 2, totalWeightKg: "60", totalCost: "30", usedKg: "10" },
      { id: 3, totalWeightKg: "200", totalCost: "200", usedKg: "150" },
    ]);
    expect(report.remainingWeight.toNumber()).toBe(100);
    expect(report.remainingValue.toDecimalPlaces(2).toNumber()).toBe(75);
    expect(report.weightedRate.toNumber()).toBe(0.75);
    expect(report.batches.map((batch) => batch.id)).toEqual([2, 3]);
    // Old global average was 250 / 300 = 0.8333333333.
    expect(calculateCumulativeBatchRate({
      cumulativeMixCost: "250",
      cumulativeMixWeightKg: "300",
    }).eq(report.weightedRate)).toBe(false);
  });

  it("maintains fractional precision, then rounds only display values", () => {
    const report = calculateBatchRemainingValuation([
      { id: 1, totalWeightKg: "3", totalCost: "1", usedKg: "1" },
      { id: 2, totalWeightKg: "1", totalCost: "2", usedKg: "0" },
    ]);
    expect(report.remainingWeight.toNumber()).toBe(3);
    expect(report.remainingValue.toDecimalPlaces(2).toNumber()).toBe(2.67);
    expect(report.weightedRate.toString()).toBe("0.8888888889");
  });

  it("rejects negative weights, overused batches and negative cost instead of inventing a rate", () => {
    const report = calculateBatchRemainingValuation([
      { id: 1, totalWeightKg: "100", totalCost: "100", usedKg: "101" },
      { id: 2, totalWeightKg: "100", totalCost: "-10", usedKg: "50" },
      { id: 3, totalWeightKg: "100", totalCost: "0", usedKg: "50" },
    ]);
    expect(report.remainingWeight.toNumber()).toBe(50);
    expect(report.remainingValue.toNumber()).toBe(0);
    expect(report.weightedRate.toNumber()).toBe(0);
    expect(report.negativeOrOverusedBatches).toBe(1);
    expect(report.invalidCostBatches).toBe(1);
  });
});

const state = vi.hoisted(() => ({ sql: [] as string[] }));
vi.mock("../server/db", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  return {
    db: {
      execute: async (query: never) => {
        const sqlText = dialect.sqlToQuery(query).sql;
        state.sql.push(sqlText);
        if (sqlText.includes("AS total_weight_kg") && sqlText.includes("FROM factory_mix_batches")) {
          return {
            rows: [
              { id: 1, total_weight_kg: "100", total_cost: "100", used_kg: "100", needs_replay: false, carry_forward_from_id: null },
              { id: 2, total_weight_kg: "40", total_cost: "40", used_kg: "40", needs_replay: true, carry_forward_from_id: 1 },
              { id: 3, total_weight_kg: "60", total_cost: "120", used_kg: "0", needs_replay: false, carry_forward_from_id: null },
            ],
          };
        }
        if (sqlText.includes("AS total_kg") && sqlText.includes("FROM factory_bales")) {
          return { rows: [{ total_kg: "70" }] };
        }
        if (sqlText.includes("BOOL_OR(is_carry)")) {
          return { rows: [{ batch_id: 2, used_kg: "10", has_carry: false }] };
        }
        return { rows: [] };
      },
    },
  };
});

import { getFactoryBalanceOnTableSnapshot } from "../server/services/factory/productionBalanceOnTable";

describe("Balance on Table: date-scoped source accounting", () => {
  it("replays only batches changed after the cutoff, preserves original-batch cumulative rate for production profit", async () => {
    state.sql = [];
    const report = await getFactoryBalanceOnTableSnapshot(7, "2026-09-30");
    expect(report.weightKg).toBe(90);
    expect(report.value).toBe(150);
    expect(report.costPerKg).toBeCloseTo(150 / 90, 9);
    expect(report.batchRateDecimal.toNumber()).toBe(1.375);
    expect(report.diagnostics.inferredHistoricalBatchCount).toBe(1);
    expect(report.diagnostics.weightDifferenceKg).toBe(0);
    expect(report.warnings).toContain("WIP_HISTORICAL_USAGE_INFERRED_FROM_EVENTS");
    const historySql = state.sql.find((sqlText) => sqlText.includes("BOOL_OR(is_carry)"));
    expect(historySql).toContain("factory_daily_usages");
    expect(historySql).toContain("factory_mix_batch_sources");
    expect(historySql).toContain("carry_forward_from_id");
    expect(historySql).toContain("stock_entry_date");
    expect(state.sql[0]).toContain("carry_forward_from_id");
    expect(state.sql[0]).toContain("updated_at");
  });
});
