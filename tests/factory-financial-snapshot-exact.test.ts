/**
 * /api/factory/financial-snapshot values stock exactly: 0.5 kg of raw
 * material at 4.35 is worth 2.175, shown as 2.18 (the float product
 * 2.1749999999999998 was shown as 2.17); a 1.005 Dr capital opening shows
 * as -1.01 rather than -1.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const rowsFor = (table: never) => {
    switch (getTableName(table)) {
      case "factory_raw_stock":
        return [{ receivedKg: "0.5", usedKg: "0", costPerKg: "9", costPerKgUsd: "4.35" }];
      case "factory_mix_batches":
        return [{ totalWeightKg: "2", usedKg: "0.5", costPerKg: "1.45", status: "OPEN" }];
      case "ledger_accounts":
        return [
          {
            id: 5,
            name: "Capital",
            code: "CAP",
            accountType: "Equity",
            openingBalance: "1.005",
            openingBalanceSide: "Cr",
          },
        ];
      default:
        return [];
    }
  };
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "innerJoin", "groupBy"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return { db: { select: () => ({ from: (table: never) => chain(rowsFor(table)) }) } };
});

import { registerFactoryFinancialSnapshotRoutes } from "../server/routes/factory/employee-pos/pos-financial/financial-snapshot";

describe("factory financial snapshot", () => {
  it("values raw material, mix batches and capital exactly", async () => {
    let handler: (req: unknown, res: unknown) => Promise<void> = async () => undefined;
    registerFactoryFinancialSnapshotRoutes({
      get: (_path: string, _auth: unknown, h: typeof handler) => {
        handler = h;
      },
    } as never);
    let body: Record<string, unknown> = {};
    const res = {
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await handler({ session: { currentCompanyId: 7 } }, res);

    expect(body).toMatchObject({ rawMaterialValue: 2.18, mixBatchValue: 2.18, capitalTotal: -1.01 });
  });
});
