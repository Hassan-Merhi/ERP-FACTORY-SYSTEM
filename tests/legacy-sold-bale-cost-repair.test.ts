import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runApprovedLegacySoldBaleUnitCostRepair } from "../server/startup/runApprovedLegacySoldBaleUnitCostRepair";

const FLAG = "FACTORY_LEGACY_SOLD_BALE_COST_REPAIR_20261017";
const previous = process.env[FLAG];

afterEach(() => {
  if (previous === undefined) delete process.env[FLAG];
  else process.env[FLAG] = previous;
});

describe("legacy sold-bale unit cost repair (#2238)", () => {
  it("never connects without an explicit company-12 preview or approval", async () => {
    for (const value of [undefined, "", "approved", "approved-company-1", "enabled"]) {
      if (value === undefined) delete process.env[FLAG];
      else process.env[FLAG] = value;
      const connect = vi.fn();
      await runApprovedLegacySoldBaleUnitCostRepair({ connect } as never);
      expect(connect).not.toHaveBeenCalled();
    }
  });

  it("preview mode rolls back before writing anything", async () => {
    process.env[FLAG] = "preview-company-12";
    const statements: string[] = [];
    const query = vi.fn(async (text: string) => {
      statements.push(text);
      if (text.includes("factory_bale_recost_runs WHERE")) return { rows: [], rowCount: 0 };
      if (text.includes("gl_inventory_cutovers")) return { rows: [], rowCount: 0 };
      if (text.includes("COUNT(*)::text AS total"))
        return { rows: [{ total: "2", difference: "1440.00" }], rowCount: 1 };
      if (text.includes("GROUP BY old_status"))
        return { rows: [{ old_status: "SOLD", n: "2", diff: "1440.00" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const release = vi.fn();
    await runApprovedLegacySoldBaleUnitCostRepair({ connect: async () => ({ query, release }) } as never);

    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(statements.some((s) => s.includes("UPDATE factory_bales"))).toBe(false);
    expect(statements.some((s) => s.includes("INSERT INTO factory_legacy_bale_cost_repairs"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("only overwrites the legacy per-bale-as-per-kg signature and never touches sales or journals", () => {
    const source = readFileSync("server/startup/runApprovedLegacySoldBaleUnitCostRepair.ts", "utf8");
    expect(source).toContain("b.status IN ('SOLD', 'AVAILABLE', 'DELETED')");
    expect(source).toContain("ABS(b.cost_per_kg - p.production_price) < 0.001");
    expect(source).toContain("ABS(b.total_cost - b.cost_per_kg * b.weight_kg) < 0.01");
    expect(source).toContain("NOT EXISTS (SELECT 1 FROM factory_legacy_bale_cost_repairs r WHERE r.bale_id = b.id)");
    expect(source).toContain("gl_inventory_cutovers");
    expect(source).not.toMatch(/UPDATE (customer_orders|customer_order_bales|vouchers|voucher_entries)/);
    expect(source).not.toMatch(/SET status/);
  });
});
