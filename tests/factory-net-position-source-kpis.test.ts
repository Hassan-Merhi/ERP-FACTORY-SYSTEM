import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  scenario: "table" as "table" | "raw",
  sql: [] as string[],
}));

vi.mock("../server/db", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  return {
    db: {
      execute: async (query: never) => {
        const text = dialect.sqlToQuery(query).sql;
        state.sql.push(text);

        if (text.includes("total_mix_kg")) {
          return { rows: [{ total_mix_kg: "3000", total_mix_cost: "2601" }] };
        }
        if (text.includes("AS total_kg") && text.includes("FROM factory_bales")) {
          // 1,000 kg of valid bales; 30 kg of REPACKED originals are excluded.
          return { rows: [{ total_kg: "1000" }] };
        }
        if (text.includes("AS total_selling_value")) {
          return { rows: [{ total_selling_value: "0" }] };
        }
        if (text.includes("GROUP") && text.includes("factory_raw_stock")) {
          return {
            rows: state.scenario === "raw"
              ? [1, 2].map((supplier_id) => ({
                  supplier_id,
                  total_recv: "1",
                  total_used: "0",
                  avg_cpk_local: "1.005",
                  avg_cpk_usd: "1.005",
                  remaining_value_local: "1.005",
                  remaining_value_usd: "1.005",
                }))
              : [],
          };
        }
        return { rows: [] };
      },
    },
  };
});

import { getFactoryBalanceOnTableSnapshot } from "../server/services/factory/productionBalanceOnTable";
import { computeNetPositionInventory } from "../server/routes/factory/employee-pos/netPositionInventory";

const context = () => ({
  companyId: 7,
  asOf: "2026-10-14",
  getConfigFx: () => 1,
  configFxRates: {},
  supplierLockedRateMapNp: new Map<number, number>([
    [1, 1.005],
    [2, 1.005],
  ]),
  allContainersF: [],
});

describe("factory net position matches operational source KPIs", () => {
  it("uses Production Overview's 10dp rate and excludes REPACKED originals", async () => {
    state.scenario = "table";
    state.sql = [];
    const snapshot = await getFactoryBalanceOnTableSnapshot(7, "2026-10-14");
    expect(snapshot.weightKg).toBe(2000);
    expect(snapshot.costPerKg).toBe(0.867);
    expect(snapshot.value).toBe(1734);
    const balesSql = state.sql.find((query) => query.includes("AS total_kg"));
    expect(balesSql).toContain("'REPACKED'");
    expect(balesSql).toContain("stock_entry_date");

    const inventory = await computeNetPositionInventory(context());
    expect(inventory.balanceOnTableValue).toBe(snapshot.value);
  });

  it("sums the Raw Materials page's individually rounded supplier values", async () => {
    state.scenario = "raw";
    state.sql = [];
    const inventory = await computeNetPositionInventory(context());
    // Each source row shows $1.01 after toFixed(2); summing their unrounded
    // $1.005 values first would incorrectly display $2.01 instead of $2.02.
    expect(inventory.rawMaterialStockValue).toBe(2.02);
  });
});
