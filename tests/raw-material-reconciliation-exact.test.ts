/**
 * The raw-material reconciliation report sums kg and amounts exactly: 0.1 kg
 * and 0.2 kg received with 0.3 kg used leaves 0 kg free, not the binary-float
 * 5.55e-17.
 */
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]> }));

vi.mock("../server/services/factory/rawStockLockedRate", () => ({
  getLockedRateDiagnosticsForCompany: async () => [],
}));
vi.mock("../server/routes/helpers/supplierBalanceHelpers", () => ({ resolveParentCompanyId: async () => 7 }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "innerJoin", "groupBy"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return {
    db: {
      select: (fields?: Record<string, unknown>) => ({
        from: (table: never) => {
          const name = getTableName(table);
          if (name === "factory_mix_batch_sources" && fields && "reservedKgTotal" in fields)
            return chain([{ reservedKgTotal: "0" }]);
          if (name === "factory_raw_stock" && fields && "containerCompanyId" in fields) return chain([]);
          return chain(harness.rows[name] ?? []);
        },
      }),
    },
  };
});

import { getRawMaterialReconciliation } from "../server/services/factory/rawMaterialReconciliation";

describe("raw material reconciliation", () => {
  it("sums kg exactly", async () => {
    const row = (id: number, receivedKg: string, usedKg: string) => ({
      id,
      containerId: id,
      receivedKg,
      usedKg,
      containerNumber: `C-${id}`,
    });
    harness.rows = { factory_raw_stock: [row(1, "0.1", "0"), row(2, "0.2", "0.3")] };

    const { kgSummary } = await getRawMaterialReconciliation(7);

    expect(kgSummary).toMatchObject({ receivedKg: 0.3, usedKg: 0.3, freeKg: 0 });
  });
});
