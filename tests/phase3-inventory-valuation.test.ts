import { describe, expect, it } from "vitest";
import { applyPhase3InventoryMovement } from "../server/services/accounting/phase3InventoryValuation";

function state(quantity: string, averageRate: string, totalValue: string) {
  return {
    quantity: new (require("decimal.js"))(quantity),
    averageRate: new (require("decimal.js"))(averageRate),
    totalValue: new (require("decimal.js"))(totalValue),
  };
}

describe("Phase 3 inventory valuation replay", () => {
  it("deducts a normal issue at the stored cost basis", () => {
    const next = applyPhase3InventoryMovement(state("10", "10", "100"), {
      quantityDelta: "-4",
      unitCost: "10",
    });
    expect(next.quantity.toFixed(3)).toBe("6.000");
    expect(next.totalValue.toFixed(2)).toBe("60.00");
    expect(next.averageRate.toFixed(2)).toBe("10.00");
  });

  it("floors asset value at zero when an issue takes stock negative", () => {
    const next = applyPhase3InventoryMovement(state("6", "10", "60"), {
      quantityDelta: "-8",
      unitCost: "10",
    });
    expect(next.quantity.toFixed(3)).toBe("-2.000");
    expect(next.totalValue.toFixed(2)).toBe("0.00");
    expect(next.averageRate.toFixed(2)).toBe("10.00");
  });

  it("settles a negative shortage before valuing the positive remainder of a receipt", () => {
    const stillShort = applyPhase3InventoryMovement(state("-2", "10", "0"), {
      quantityDelta: "1",
      unitCost: "12",
    });
    expect(stillShort.quantity.toFixed(3)).toBe("-1.000");
    expect(stillShort.totalValue.toFixed(2)).toBe("0.00");
    expect(stillShort.averageRate.toFixed(2)).toBe("12.00");

    const positive = applyPhase3InventoryMovement(stillShort, {
      quantityDelta: "3",
      unitCost: "12",
    });
    expect(positive.quantity.toFixed(3)).toBe("2.000");
    expect(positive.totalValue.toFixed(2)).toBe("24.00");
    expect(positive.averageRate.toFixed(2)).toBe("12.00");
  });

  it("calculates weighted average value for receipts into positive stock", () => {
    const next = applyPhase3InventoryMovement(state("5", "10", "50"), {
      quantityDelta: "5",
      unitCost: "20",
    });
    expect(next.quantity.toFixed(3)).toBe("10.000");
    expect(next.totalValue.toFixed(2)).toBe("150.00");
    expect(next.averageRate.toFixed(2)).toBe("15.00");
  });

  it("keeps a same-cost transfer valuation-neutral across two locations", () => {
    const source = applyPhase3InventoryMovement(state("10", "8", "80"), {
      quantityDelta: "-3",
      unitCost: "8",
    });
    const destination = applyPhase3InventoryMovement(state("2", "8", "16"), {
      quantityDelta: "3",
      unitCost: "8",
    });

    const before = 80 + 16;
    const after = Number(source.totalValue.toFixed(2)) + Number(destination.totalValue.toFixed(2));
    expect(after).toBe(before);
  });
});
