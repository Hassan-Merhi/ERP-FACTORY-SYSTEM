/**
 * The historical net-position correction values stock left on the table as
 * kg x blended cost, rounded half up to cents from the exact product: 10 kg
 * mixed for 3.50 with 3.3 kg baled leaves 6.7 kg at 0.35/kg, which is 2.345
 * and shows 2.35. The float product 2.3449999999999998 showed 2.34 even with
 * the EPSILON nudge. Raw material is rebuilt the same way.
 */
import { describe, expect, it, vi } from "vitest";

const rows: Record<string, string>[] = [];
vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/db", () => ({ db: { execute: async () => ({ rows: [rows.shift() ?? {}] }) } }));

import { computeHistoricalOperationalValues } from "../server/routes/factory/employee-pos/netPositionHistoricalCorrection";

describe("historical net-position correction", () => {
  it("rounds balance on table and raw material from exact values", async () => {
    rows.push(
      { total_cost: "10.005", total_selling: "20.00" },
      { total_mix_kg: "10.000", total_mix_cost: "3.50" },
      { total_bale_kg: "3.300" },
      { value_after: "0.1" },
      { value_after: "0.2" },
      { value_after: "0" }
    );

    const values = await computeHistoricalOperationalValues(7, "2026-09-01", 4.475, "cost");

    expect(values).toEqual({
      inventoryValue: 10.01,
      balanceOnTableValue: 2.35,
      // 4.475 + 0.1 - 0.2 = 4.375, half up to 4.38 (the float sum gave 4.37)
      rawMaterialValue: 4.38,
    });
  });
});
