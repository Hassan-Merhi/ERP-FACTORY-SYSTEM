import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { offloadEconomicBasisChanged } from "../server/services/containers/offload-lifecycle/offloadCostBasisGuard";

const posted = [
  { stockItemId: 100, quantity: "3.000", totalValue: "249.39" },
  { stockItemId: 101, quantity: "2.000", totalValue: "90.61" },
];

describe("offloaded stock cost basis with downstream movements", () => {
  it("allows equivalent posted quantities/values across line reordering and formatting", () => {
    expect(
      offloadEconomicBasisChanged(
        posted,
        [
          { stockItemId: 101, quantity: "2", totalValue: "90.610" },
          { stockItemId: 100, quantity: "3", totalValue: "249.39" },
        ],
        130,
        130
      )
    ).toBe(false);
  });
  it("rejects changes to unit economics, posted bales, stock identity or location", () => {
    expect(
      offloadEconomicBasisChanged(
        posted,
        [{ stockItemId: 100, quantity: "3", totalValue: "249.40" }, posted[1]],
        130,
        130
      )
    ).toBe(true);
    expect(
      offloadEconomicBasisChanged(
        posted,
        [{ stockItemId: 100, quantity: "4", totalValue: "249.39" }, posted[1]],
        130,
        130
      )
    ).toBe(true);
    expect(
      offloadEconomicBasisChanged(
        posted,
        [
          { stockItemId: 100, quantity: "3", totalValue: "249.39" },
          { stockItemId: 103, quantity: "2", totalValue: "90.61" },
        ],
        130,
        130
      )
    ).toBe(true);
    expect(offloadEconomicBasisChanged(posted, posted, 130, 140)).toBe(true);
  });
  it("preserves legitimate aggregate totals even if posted lines were split", () => {
    expect(
      offloadEconomicBasisChanged(
        posted,
        [
          { stockItemId: 100, quantity: "1", totalValue: "83.13" },
          { stockItemId: 100, quantity: "2", totalValue: "166.26" },
          posted[1],
        ],
        130,
        130
      )
    ).toBe(false);
  });
  it("rejects repricing before reversing stock and covers sales/transfers/adjustments", () => {
    const source = readFileSync(
      new URL("../server/services/containers/offload-lifecycle/execute.ts", import.meta.url),
      "utf8"
    );
    expect(source).toContain("CONTAINER_OFFLOAD_DOWNSTREAM_COST_LOCKED");
    expect(source).toContain("schema.salesItems");
    expect(source).toContain("schema.stockTransferItems");
    expect(source).toContain("schema.canonicalStockMovements");
    expect(source.indexOf("offloadEconomicBasisChanged(previousItems")).toBeLessThan(
      source.indexOf("reversalDelta = await reverseExistingOffload")
    );
    expect(source).toContain(
      "if (salesAfterReceipt.length || transfersAfterReceipt.length || canonicalAfterReceipt.length)"
    );
  });
});
