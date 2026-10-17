import { afterEach, describe, expect, it, vi } from "vitest";
import { runApprovedLegacySoldBaleUnitCostRepair } from "../server/startup/runApprovedLegacySoldBaleUnitCostRepair";

const FLAG = "FACTORY_LEGACY_SOLD_BALE_COST_REPAIR_20261017";
const previous = process.env[FLAG];

afterEach(() => {
  if (previous === undefined) delete process.env[FLAG];
  else process.env[FLAG] = previous;
});

function fakePool(opts: { cutover?: boolean; count?: number } = {}) {
  const count = opts.count ?? 2;
  const statements: string[] = [];
  const query = vi.fn(async (text: string) => {
    statements.push(text);
    if (text.includes("factory_bale_recost_runs WHERE")) return { rows: [], rowCount: 0 };
    if (text.includes("gl_inventory_cutovers"))
      return { rows: opts.cutover ? [{}] : [], rowCount: opts.cutover ? 1 : 0 };
    if (text.includes("COUNT(*)::text AS total"))
      return { rows: [{ total: String(count), difference: "1440.00" }], rowCount: 1 };
    if (text.includes("GROUP BY old_status"))
      return { rows: [{ old_status: "SOLD", n: String(count), diff: "1440.00" }], rowCount: 1 };
    if (text.includes("FOR UPDATE OF b")) return { rows: [], rowCount: count };
    if (text.includes("INSERT INTO factory_legacy_bale_cost_repairs")) return { rows: [], rowCount: count };
    if (text.includes("UPDATE factory_bales")) return { rows: [], rowCount: count };
    if (text.includes("INSERT INTO factory_bale_recost_runs")) return { rows: [{ id: 7 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  return { pool: { connect: async () => ({ query, release }) } as never, statements, release };
}

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
    const { pool, statements, release } = fakePool();
    await runApprovedLegacySoldBaleUnitCostRepair(pool);

    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(statements.some((s) => s.includes("UPDATE factory_bales"))).toBe(false);
    expect(statements.some((s) => s.includes("INSERT INTO factory_legacy_bale_cost_repairs"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("approved mode records before/after rows, overwrites only bale cost and commits once", async () => {
    process.env[FLAG] = "approved-company-12";
    const { pool, statements } = fakePool();
    await runApprovedLegacySoldBaleUnitCostRepair(pool);

    const writes = statements.filter((s) => /\b(INSERT INTO|UPDATE)\b/.test(s));
    expect(writes.some((s) => s.includes("INSERT INTO factory_legacy_bale_cost_repairs"))).toBe(true);
    expect(writes.some((s) => s.includes("INSERT INTO factory_bale_recost_runs"))).toBe(true);
    const baleUpdate = writes.find((s) => s.includes("UPDATE factory_bales"));
    expect(baleUpdate).toMatch(/SET cost_per_kg = c\.new_cost_per_kg,\s+total_cost = c\.new_total_cost/);
    expect(baleUpdate).not.toMatch(/status\s*=\s*'/);
    expect(writes.some((s) => /UPDATE (customer_orders|customer_order_bales|vouchers|voucher_entries)/.test(s))).toBe(
      false
    );
    expect(statements.filter((s) => s === "COMMIT")).toHaveLength(1);
  });

  it("refuses and rolls back when an inventory GL cutover exists", async () => {
    process.env[FLAG] = "approved-company-12";
    const { pool, statements } = fakePool({ cutover: true });
    await expect(runApprovedLegacySoldBaleUnitCostRepair(pool)).rejects.toThrow(/refused/);
    expect(statements).toContain("ROLLBACK");
    expect(statements.some((s) => s.includes("UPDATE factory_bales"))).toBe(false);
  });
});
