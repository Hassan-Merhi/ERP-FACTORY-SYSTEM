/**
 * The PO/container repair (/api/containers/sync-all-vouchers) sums amounts as
 * exact decimals. numeric(20, 2) columns hold values a binary float cannot:
 * above about 10^15 a float has no cents left, so the old parseFloat sums wrote
 * container totals rounded to whole units.
 */
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  queue: [] as unknown[],
  updates: [] as Record<string, unknown>[],
  inserts: [] as unknown[],
}));

vi.mock("../server/auth", () => {
  const pass = (_q: unknown, _s: unknown, next: () => void) => next();
  return { requireAuth: pass, requireNonPOS: pass, requireRole: () => pass };
});
vi.mock("../server/storage", () => ({
  storage: { getParentCompanyId: async () => 7, getCompanySettings: async () => null },
}));
vi.mock("../server/db", () => {
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["from", "where", "innerJoin", "orderBy", "limit"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return {
    db: {
      select: () => chain(harness.queue.shift() ?? []),
      update: () => ({ set: (values: Record<string, unknown>) => (harness.updates.push(values), chain(undefined)) }),
      insert: () => ({ values: (values: unknown) => (harness.inserts.push(values), chain(undefined)) }),
      delete: () => chain(undefined),
    },
  };
});

import { registerContainerCostingRoutes } from "../server/routes/containers/accounting/costing";

function syncAllHandler() {
  let handler: ((req: unknown, res: unknown) => Promise<unknown>) | undefined;
  registerContainerCostingRoutes({
    post: (path: string, ...handlers: never[]) => {
      if (path === "/api/containers/sync-all-vouchers") handler = handlers.at(-1);
    },
  } as never);
  return handler!;
}

describe("container costing sync-all-vouchers", () => {
  it("writes container totals and charges to the exact cent", async () => {
    const po = {
      id: 11,
      companyId: 7,
      poNumber: "PO-11",
      containerId: 3,
      voucherId: null,
      itemsTotal: "12345678901234567.89",
      freight: "0.01",
      surcharge: "0",
      fumigation: "0",
      documentCharges: "0",
      discount: "0",
      otherCharges: "0",
      freightPaidBy: "supplier",
    };
    const container = { id: 3, itemsTotal: "0", chargesTotal: "0", grandTotal: "0" };
    // subsidiaries, POs, container numbers, stale FREIGHT voucher, container, six charge rows
    harness.queue = [[], [po], [{ id: 3, containerNumber: "C1" }], [], [container], [], [], [], [], [], []];
    harness.updates = [];
    harness.inserts = [];
    let body: { errors: string[]; updatedContainers: number } | undefined;
    await syncAllHandler()(
      { session: { currentCompanyId: 7 } },
      { status: () => ({ json: () => undefined }), json: (b: typeof body) => (body = b) }
    );

    expect(body?.errors).toEqual([]);
    expect(body?.updatedContainers).toBe(1);
    expect(harness.updates).toContainEqual({
      itemsTotal: "12345678901234567.89",
      chargesTotal: "0.01",
      grandTotal: "12345678901234567.90",
    });
    expect(harness.inserts).toEqual([{ containerId: 3, chargeType: "Freight", amount: "0.01" }]);
  });
});
