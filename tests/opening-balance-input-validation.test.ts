/**
 * Opening-balance create and edit reject non-numeric amounts. Their checks
 * were `parseFloat(x) <= 0`, which NaN passes, so "abc" was stored as NaN in
 * the kg, cost and FX columns (Postgres numeric accepts 'NaN').
 */
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ writes: [] as unknown[] }));

vi.mock("../server/auth", () => ({ requireAuth: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../server/db", () => {
  const record = (values: unknown) => {
    harness.writes.push(values);
    return { returning: async () => [{ id: 1 }], then: (resolve: (v: unknown) => unknown) => resolve(undefined) };
  };
  return {
    db: {
      insert: () => ({ values: record }),
      update: () => ({ set: record }),
      transaction: async () => {
        throw new Error("no transaction expected");
      },
      select: () => {
        throw new Error("no query expected");
      },
    },
  };
});

import { registerRawStockOpeningBalanceRoutes } from "../server/routes/factory/raw-stock/opening-balance/crud";

async function call(method: "post" | "patch", body: Record<string, unknown>) {
  const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
  const register =
    (m: string) =>
    (_path: string, ...chain: never[]) =>
      (handlers[m] = chain.at(-1)!);
  registerRawStockOpeningBalanceRoutes({
    get: register("get"),
    post: register("post"),
    patch: register("patch"),
    delete: register("delete"),
  } as never);
  harness.writes = [];
  let status = 200;
  let message = "";
  await handlers[method](
    { params: { id: "8" }, body, session: { factoryCompanyId: 7 }, headers: {} },
    {
      status: (code: number) => ((status = code), { json: (b: { message: string }) => (message = b.message) }),
      json: () => undefined,
    }
  );
  return { status, message };
}

describe("opening balance input validation", () => {
  it.each([
    [{ supplierName: "Sup", receivedKg: "abc", costPerKg: "0.35" }, "Received KG must be positive"],
    [{ supplierName: "Sup", receivedKg: "100", costPerKg: "abc" }, "Cost per KG must be non-negative"],
  ])("rejects a non-numeric amount on create: %j", async (body, message) => {
    expect(await call("post", body)).toEqual({ status: 400, message });
    expect(harness.writes).toEqual([]);
  });

  it.each([
    [{ receivedKg: "abc" }, "Received KG must be positive"],
    [{ costPerKg: "abc" }, "Cost per KG must be non-negative"],
    [{ fxRateToUsd: "abc" }, "FX rate must be positive"],
    [{ commissionAmount: "abc" }, "Commission amount must be a number"],
  ])("rejects a non-numeric amount on edit: %j", async (body, message) => {
    expect(await call("patch", body)).toEqual({ status: 400, message });
    expect(harness.writes).toEqual([]);
  });
});
