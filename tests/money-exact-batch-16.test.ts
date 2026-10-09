/**
 * Stock line totals and the rental payment allocator used binary floats.
 * 3 × 1.115 is 3.3449… as a float, so a stock transfer or adjustment line
 * edited to that quantity and rate was stored at 3.34 instead of 3.35. The
 * rental allocator splits a payment into stored monthly chunks; those chunks
 * must add back up to the payment to the cent.
 */
import { describe, it, expect, afterAll } from "vitest";

import { closeTestServer } from "./setup";
import { lineTotal } from "../server/storage/stock-ops/cost-prices";
import { buildAllocations } from "../server/routes/rental/shared/monthly-rows";

afterAll(() => {
  closeTestServer();
});

describe("exact stock line totals", () => {
  it("rounds quantity × rate half up at cents", () => {
    expect(lineTotal("3", "1.115")).toBe("3.35");
    expect(lineTotal("1.5", "1.13")).toBe("1.70");
  });

  it("refuses a quantity or rate that is not a number", () => {
    expect(() => lineTotal("abc", "1")).toThrow("Invalid quantity or rate value");
  });
});

describe("rental payment allocation", () => {
  it("splits a payment into monthly chunks that add back up to it", async () => {
    // A contract with no ledger rows yet: every month takes the full rent.
    const allocations = await buildAllocations(-1, 2099, 1, "300.30", "100.10");
    expect(allocations.map((allocation) => allocation.chunk)).toEqual(["100.10", "100.10", "100.10"]);
    expect(allocations.map((allocation) => [allocation.year, allocation.month])).toEqual([
      [2099, 1],
      [2099, 2],
      [2099, 3],
    ]);
  });

  it("puts the remainder in the last month", async () => {
    const allocations = await buildAllocations(-1, 2099, 11, "250.05", "100.00");
    expect(allocations.map((allocation) => [allocation.year, allocation.month, allocation.chunk])).toEqual([
      [2099, 11, "100.00"],
      [2099, 12, "100.00"],
      [2100, 1, "50.05"],
    ]);
  });
});
