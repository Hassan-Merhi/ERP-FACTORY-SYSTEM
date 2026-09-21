import { describe, expect, it } from "vitest";

import type { InventoryItem } from "@/pages/pos/pos-components/posTypes";
import { getFilteredInventory, getPosPickerInventory, normalize } from "@/pages/pos/utils/posCalculations";

const inventory: InventoryItem[] = [
  {
    stockItemId: 910,
    code: "SH-10",
    name: "SH MEN T-SHIRT (SHORT)",
    stock: 20,
    price: 10,
    configuredPrice: 10,
  },
  {
    stockItemId: 902,
    code: "SH-2",
    name: "SH MEN T SHIRT LONG",
    stock: 20,
    price: 12,
    configuredPrice: 12,
  },
  {
    stockItemId: 901,
    code: "SH-1",
    name: "SH MEN T-SHIRT #BASIC",
    stock: 0,
    price: 8,
    configuredPrice: 8,
  },
];

describe("POS item picker selection order", () => {
  it("uses one punctuation-insensitive substring normalization for item names and codes", () => {
    expect(normalize("SH MEN T-SHIRT (SHORT)")).toBe("shmentshirtshort");
    expect(getFilteredInventory(inventory, "sh men tshirt short").map((item) => item.stockItemId)).toEqual([910]);
    expect(getFilteredInventory(inventory, "SH#1").map((item) => item.stockItemId)).toEqual([910, 901]);
  });

  it("returns the same deterministic order the visible desktop picker uses", () => {
    const visible = getPosPickerInventory(inventory, "sh");

    // The API order is deliberately 10, 2, 1. The picker uses natural code
    // order, and keyboard selection must consume this exact same array.
    expect(visible.map((item) => item.code)).toEqual(["SH-1", "SH-2", "SH-10"]);
    expect(visible[1].stockItemId).toBe(902);
  });

  it("keeps out-of-stock items hidden only in the unfiltered picker", () => {
    expect(getPosPickerInventory(inventory, "").map((item) => item.stockItemId)).toEqual([902, 910]);
    expect(getPosPickerInventory(inventory, "SH-1").map((item) => item.stockItemId)).toEqual([901, 910]);
  });
});
