import { describe, expect, it } from "vitest";
import { buildPosTransferImportEntries } from "../client/src/pages/vouchers/stock-transfer-form/posTransferExcelImport";

const stockItems = [
  { id: 11, code: "HMD11001", name: "Adult Jogger", uom: "PCS" },
  { id: 12, code: "HMD16001", name: "T-Jacket", uom: "PCS" },
];
const sourceInventory = [
  { stockItemId: 11, stockItemCode: "HMD11001", stockItemName: "Adult Jogger", quantity: "22", averageRate: "3.50" },
];

describe("POS stock transfer spreadsheet form import", () => {
  it("loads Excel column variants, matches case-insensitive codes and combines duplicate rows", () => {
    const result = buildPosTransferImportEntries(
      [
        { "Item Code": "hmd11001", Qty: 3 },
        { Barcode: " HMD11001 ", Quantity: "2" },
        { Code: "HMD16001", Quantity: 1 },
      ],
      stockItems, sourceInventory, 7, "MALI"
    );
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([
      {
        sourceLocationId: 7, sourceLocationName: "MALI",
        stockItemId: 11, stockItemCode: "HMD11001", stockItemName: "Adult Jogger",
        quantity: "5", rate: "3.50",
      },
      {
        sourceLocationId: 7, sourceLocationName: "MALI",
        stockItemId: 12, stockItemCode: "HMD16001", stockItemName: "T-Jacket",
        quantity: "1", rate: "",
      },
    ]);
  });

  it("reports bad or missing data by row so the UI cannot partially replace the form", () => {
    const result = buildPosTransferImportEntries(
      [
        { Barcode: "UNKNOWN", Quantity: 3 },
        { Barcode: "HMD11001", Quantity: -2 },
        { Quantity: 4 },
      ],
      stockItems, sourceInventory, 7, "MALI"
    );
    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toContain("Row 2");
    expect(result.errors[1]).toContain("Row 3");
    expect(result.errors[2]).toContain("Row 4");
  });

  it("requires a selected source and never allows a spreadsheet to set source location", () => {
    const row = [{ Barcode: "HMD11001", Quantity: 2, "Source Location": "OTHER SHOP" }];
    const missingSource = buildPosTransferImportEntries(row, stockItems, sourceInventory, 0, "");
    expect(missingSource.errors).toContain("Select your authorized From location before importing.");
    const imported = buildPosTransferImportEntries(row, stockItems, sourceInventory, 7, "MALI");
    expect(imported.entries[0]?.sourceLocationId).toBe(7);
    expect(imported.entries[0]?.sourceLocationName).toBe("MALI");
  });

  it("does not import an empty file", () => {
    const result = buildPosTransferImportEntries([], stockItems, sourceInventory, 7, "MALI");
    expect(result.entries).toEqual([]);
    expect(result.errors[0]).toMatch(/No stock items found/);
  });
});
