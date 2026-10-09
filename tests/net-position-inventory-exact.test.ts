/**
 * The net-position inventory valuations are computed exactly and rounded half
 * up to the cent from the exact value: 1,000 kg on the table at a blended
 * 35.175 / 1,000 kg is worth 35.18, where binary floats made 35.17.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/db", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  return {
    db: {
      execute: async (query: never) => {
        const text = dialect.sqlToQuery(query).sql;
        if (text.includes("total_mix_kg")) return { rows: [{ total_mix_kg: "1000", total_mix_cost: "35.175" }] };
        if (text.includes("total_selling_value"))
          return { rows: [{ total_kg: "0", total_selling_value: "0", wg_kg: "0" }] };
        return { rows: [] };
      },
    },
  };
});

import { computeNetPositionInventory } from "../server/routes/factory/employee-pos/netPositionInventory";

describe("net position inventory", () => {
  it("values material on the table to the exact cent", async () => {
    const inventory = await computeNetPositionInventory({
      companyId: 7,
      asOf: "2026-03-31",
      round2: (n: number) => Math.round((n + Number.EPSILON) * 100) / 100,
      getConfigFx: () => 1,
      configFxRates: {},
      supplierLockedRateMapNp: new Map(),
      allContainersF: [],
    });

    expect(inventory.balanceOnTableValue).toBe(35.18);
    expect(inventory.balanceOnTableSellingValue).toBe(35.18);
  });
});
