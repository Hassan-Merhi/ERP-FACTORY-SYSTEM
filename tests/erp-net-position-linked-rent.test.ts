import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const responses: unknown[][] = [];
  const select = vi.fn(() => {
    const rows = responses.shift() ?? [];
    const query = {
      innerJoin: () => query,
      where: () => query,
      groupBy: async () => rows,
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (reason: unknown) => unknown
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return { from: () => query };
  });
  return { responses, select };
});

vi.mock("../server/db", () => ({ db: { select: harness.select } }));

import { computeRentalOutstanding } from "../server/routes/stats/netProfitRentalSection";

const owned = [
  { id: 18, startDate: "2026-01-01", currency: "USD" },
  { id: 19, startDate: "2026-01-01", currency: "USD" },
  { id: 20, startDate: "2026-02-01", currency: "USD" },
  { id: 21, startDate: "2026-01-01", currency: "USD" },
  { id: 22, startDate: "2026-01-01", currency: "USD" },
  { id: 23, startDate: "2026-01-01", currency: "USD" },
  { id: 24, startDate: "2026-01-01", currency: "USD" },
  { id: 27, startDate: "2026-04-01", currency: "USD" },
];
const linked = [
  { id: 2, startDate: "2026-01-01", currency: "USD" },
  { id: 7, startDate: "2026-01-01", currency: "USD" },
  { id: 8, startDate: "2026-01-01", currency: "USD" },
  { id: 29, startDate: "2026-01-01", currency: "USD" },
  { id: 30, startDate: "2026-05-01", currency: "USD" },
];

const expectedNovember = [
  [18, 3000], [19, 2000], [20, 1750], [21, 1500], [22, 1500], [23, 4200],
  [24, 3500], [27, 3500], [2, 2000], [7, 5000], [8, 5000], [29, 3000], [30, 3000],
].map(([contractId, expectedAmount]) => ({ contractId, expectedAmount: String(expectedAmount), year: 2026, month: 11 }));

describe("ERP Net Position rental payable: owned shops and linked Properties", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.responses.splice(0);
  });

  it("reconciles HADI L'SHI's $13,950 owned + $18,000 linked liabilities and $7,000 prepaid", async () => {
    harness.responses.push(
      owned,
      linked,
      expectedNovember,
      [
        { contractId: 24, paid: "7000" },
        { contractId: 27, paid: "7000" },
      ]
    );

    const result = await computeRentalOutstanding(1, "2026-11-06", 0);
    expect(result).toEqual({ prepaidRent: 7000, rentPayable: 31950 });
    expect(harness.select).toHaveBeenCalledTimes(4);
  });

  it("does not accrue a November 20 billing date on November 6", async () => {
    harness.responses.push(
      [{ id: 100, startDate: "2026-01-20", currency: "USD" }],
      [],
      [{ contractId: 100, expectedAmount: "2500", year: 2026, month: 11 }],
      []
    );
    expect(await computeRentalOutstanding(1, "2026-11-06", 0)).toEqual({
      prepaidRent: 0,
      rentPayable: 0,
    });
  });

  it("uses the as-of date and preserves prepaid amounts from posted payments", async () => {
    harness.responses.push(
      [{ id: 100, startDate: "2026-01-01", currency: "USD" }],
      [],
      [
        { contractId: 100, expectedAmount: "5000", year: 2026, month: 10 },
        { contractId: 100, expectedAmount: "5000", year: 2026, month: 11 },
      ],
      [{ contractId: 100, paid: "6500" }]
    );
    expect(await computeRentalOutstanding(1, "2026-10-31", 0)).toEqual({
      prepaidRent: 1500,
      rentPayable: 0,
    });
  });

  it("deduplicates a lease that appears in owned and linked selections", async () => {
    const repeated = { id: 100, startDate: "2026-01-01", currency: "USD" };
    harness.responses.push(
      [repeated],
      [repeated],
      [{ contractId: 100, expectedAmount: "4200", year: 2026, month: 11 }],
      []
    );
    expect(await computeRentalOutstanding(1, "2026-11-06", 0)).toEqual({
      prepaidRent: 0,
      rentPayable: 4200,
    });
  });
});
