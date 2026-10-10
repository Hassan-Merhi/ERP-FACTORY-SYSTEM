import { describe, expect, it } from "vitest";
import { allocatePoCharges } from "../server/routes/import/poChargeAllocation";

const noCharges = { freight: 0, surcharge: 0, fumigation: 0, documentCharges: 0, discount: 0, otherCharges: 0 };

describe("PO import charge split", () => {
  it("splits each charge by item value and adds back to the container charge exactly", () => {
    const splits = allocatePoCharges(
      [[100], [100], [100]],
      { ...noCharges, freight: "100.00", discount: "10.00", otherCharges: "0.02" },
      false
    );

    expect(splits.map((split) => split.freight.toFixed(2))).toEqual(["33.34", "33.33", "33.33"]);
    expect(
      splits.reduce((sum, split) => sum.plus(split.freight), splits[0].freight.minus(splits[0].freight)).toFixed(2)
    ).toBe("100.00");
    expect(splits.map((split) => split.discount.toFixed(2))).toEqual(["3.34", "3.33", "3.33"]);
    // Two cents over three POs: no share goes negative.
    expect(splits.map((split) => split.otherCharges.toFixed(2))).toEqual(["0.01", "0.01", "0.00"]);
  });

  it("totals each PO as items plus charges less discount, without float residue", () => {
    const [split] = allocatePoCharges(
      [["0.10", "0.20"]],
      {
        freight: "1.10",
        surcharge: "2.20",
        fumigation: "0.30",
        documentCharges: "0.40",
        discount: "0.50",
        otherCharges: "0.60",
      },
      false
    );

    expect(split.itemsTotal.toFixed()).toBe("0.3");
    expect(split.grandTotal.toFixed(2)).toBe("4.40");
    expect(split.intercoTotal.toFixed(2)).toBe("4.40");
  });

  it("leaves freight out of the intercompany total when the parent pays it", () => {
    const [split] = allocatePoCharges([[1000]], { ...noCharges, freight: "250.00", surcharge: "50.00" }, true);

    expect(split.grandTotal.toFixed(2)).toBe("1300.00");
    expect(split.intercoTotal.toFixed(2)).toBe("1050.00");
  });

  it("puts every charge on the last PO when no PO has item value", () => {
    const splits = allocatePoCharges([[0], [0]], { ...noCharges, freight: "80.00" }, false);

    expect(splits.map((split) => split.freight.toFixed(2))).toEqual(["0.00", "80.00"]);
  });
});
