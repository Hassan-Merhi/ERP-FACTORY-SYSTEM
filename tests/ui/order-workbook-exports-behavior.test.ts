/**
 * Two customer- and driver-facing Excel exports, checked cell by cell:
 *
 *  - the stock transfer "Truck Trip" sheet groups lines by source location with
 *    a subtotal per location and a grand total, and only shows rate/value
 *    columns when cost is included (drivers get the no-cost version);
 *  - the bale "Make Your Order" sheets list every product with its category,
 *    weight and chosen price, leave the Bales column for the customer, and
 *    total it with live formulas that must reference the data rows exactly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";

const written = vi.hoisted(() => ({ workbook: null as any, fileName: "" }));
vi.mock("@/lib/excelHelper", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/excelHelper")>();
  return {
    ...actual,
    writeFile: vi.fn(async (workbook: unknown, fileName: string) => {
      written.workbook = workbook;
      written.fileName = fileName;
    }),
  };
});

import { exportStockTransferOrderWorkbook } from "@/pages/stock-transfer-order/exportStockTransferOrderWorkbook";
import { downloadNoPriceBaleOrderSheet, downloadPricedBaleOrderSheet } from "@/pages/baleproducts/baleOrderSheetExport";

function rowValues(ws: ExcelJS.Worksheet) {
  const rows: unknown[][] = [];
  ws.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
  return rows;
}

const orderItems = [
  {
    stockItemId: 1,
    stockItemName: "Shoes",
    stockItemCode: "SH",
    uom: "BL",
    sourceLocationId: 1,
    sourceLocationName: "Main",
    quantity: 4,
    availableQty: 10,
    rate: 12.5,
  },
  {
    stockItemId: 2,
    stockItemName: "Bags",
    stockItemCode: "BG",
    uom: "BL",
    sourceLocationId: 2,
    sourceLocationName: "Depot",
    quantity: 2,
    availableQty: 5,
    rate: 30,
  },
  {
    stockItemId: 3,
    stockItemName: "Hats",
    stockItemCode: "HT",
    uom: "BL",
    sourceLocationId: 1,
    sourceLocationName: "Main",
    quantity: 6,
    availableQty: 8,
    rate: 5,
  },
];
const locations = [
  { id: 1, name: "Main" },
  { id: 2, name: "Depot" },
  { id: 9, name: "Shop 9" },
] as any;

describe("exportStockTransferOrderWorkbook", () => {
  beforeEach(() => {
    written.workbook = null;
  });

  it("groups lines by source location with subtotals, a grand total and cost columns", async () => {
    const result = await exportStockTransferOrderWorkbook({
      orderItems,
      locations,
      destinationLocationId: 9,
      transferDate: new Date(2026, 8, 5),
      companyName: "Test Co",
      includeCost: true,
    });

    expect(result.itemCount).toBe(3);
    expect(result.fileName).toBe(written.fileName);
    const ws = written.workbook.getWorksheet("Truck Trip") as ExcelJS.Worksheet;
    const rows = rowValues(ws);

    expect(rows[0][0]).toBe("Test Co");
    expect(rows[1].slice(0, 3)).toEqual(["TRUCK TRIP", "DESTINATION:", "Shop 9"]);
    expect(rows.find((r) => r[1] === "DATE :")?.[2]).toBe("9/5/26");
    const headerIndex = rows.findIndex((r) => r[0] === "ITEM  NAME");
    expect(rows[headerIndex]).toEqual(["ITEM  NAME", "LOCATION", "Quantity", "Rate", "Amount"]);

    // Main group (Shoes + Hats) then its subtotal, then Depot, then the grand total.
    const body = rows.slice(headerIndex + 1).map((r) => [r[0], r[2], r[4]]);
    expect(body).toEqual([
      ["Shoes", 4, 50],
      ["Hats", 6, 30],
      ["TOTAL MAIN", 10, 80],
      ["Bags", 2, 60],
      ["TOTAL DEPOT", 2, 60],
      ["TOTAL", 12, 140],
    ]);
    expect(ws.getColumn(4).values.filter((v) => v === 12.5)).toHaveLength(1);
  });

  it("omits rate and value for the driver copy", async () => {
    await exportStockTransferOrderWorkbook({
      orderItems,
      locations,
      destinationLocationId: 404,
      transferDate: new Date(2026, 8, 5),
      companyName: "Test Co",
      includeCost: false,
    });

    const ws = written.workbook.getWorksheet("Truck Trip") as ExcelJS.Worksheet;
    const rows = rowValues(ws);
    expect(rows[1].slice(0, 3)).toEqual(["TRUCK TRIP", "DESTINATION:", ""]);
    expect(rows.find((r) => r[0] === "ITEM  NAME")).toEqual(["ITEM  NAME", "LOCATION", "Quantity"]);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(3);
    expect(rows.at(-1)).toEqual(["TOTAL", "TOTAL", 12]);
  });
});

describe("bale order sheets", () => {
  let blobs: Blob[];
  let clicked: string[];

  beforeEach(() => {
    blobs = [];
    clicked = [];
    (URL as any).createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:order";
    });
    (URL as any).revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    // The logo is optional; a failed fetch must not stop the export.
    (global as any).fetch = vi.fn(async () => {
      throw new Error("offline");
    });
  });

  const products = [
    {
      id: 1,
      articleCode: "A-1",
      name: "Summer Mix",
      categoryId: 10,
      weightPerBaleKg: "45.5",
      sellingPrice: "120",
      productionPrice: "80",
    },
    {
      id: 2,
      articleCode: "A-2",
      name: "Winter Mix",
      categoryId: 11,
      weightPerBaleKg: null,
      sellingPrice: null,
      productionPrice: "0",
    },
  ] as any;
  const categoryMap = new Map([
    [10, "Clothing"],
    [11, "Coats"],
  ]);

  async function readDownloaded(): Promise<ExcelJS.Worksheet> {
    const bytes = Buffer.from(await blobs[0].arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as any);
    return wb.getWorksheet("Make Your Order")!;
  }

  it("builds the selling-price sheet with per-row and total formulas", async () => {
    const { priceHeader } = await downloadPricedBaleOrderSheet({ priceType: "selling", products, categoryMap });

    expect(priceHeader).toBe("Selling Price");
    expect(clicked).toEqual(["HMD_Order_Selling_Price.xlsx"]);
    const ws = await readDownloaded();

    expect(ws.getCell("C2").value).toBe("Make Your Order – Selling Price");
    expect((ws.getRow(6).values as unknown[]).slice(1)).toEqual([
      "#",
      "Article Code",
      "Name of Item",
      "Category",
      "Weight (kg)",
      "Selling Price",
      "Bales",
      "Total",
    ]);
    expect(ws.getCell("C7").value).toBe("Summer Mix");
    expect(ws.getCell("D7").value).toBe("Clothing");
    expect(ws.getCell("E7").value).toBe(45.5);
    expect(ws.getCell("F7").value).toBe(120);
    expect(ws.getCell("F8").value).toBe(0);
    expect(ws.getCell("H7").formula).toBe("F7*G7");
    expect(ws.getCell("H8").formula).toBe("F8*G8");
    expect(ws.getCell("G9").formula).toBe("SUM(G7:G8)");
    expect(ws.getCell("H9").formula).toBe("SUM(H7:H8)");
    expect(ws.getColumn(2).hidden).toBe(true);
  });

  it("uses production prices when asked", async () => {
    const { priceHeader } = await downloadPricedBaleOrderSheet({ priceType: "production", products, categoryMap });

    expect(priceHeader).toBe("Production Price");
    expect(clicked).toEqual(["HMD_Order_Production_Price.xlsx"]);
    const ws = await readDownloaded();
    expect(ws.getCell("F7").value).toBe(80);
  });

  it("builds the no-price sheet with a bales total only", async () => {
    await downloadNoPriceBaleOrderSheet({ products, categoryMap });

    expect(clicked).toEqual(["HMD_Order_No_Prices.xlsx"]);
    const ws = await readDownloaded();
    const names: unknown[] = [];
    ws.eachRow((row) => names.push(row.getCell(3).value));
    expect(names).toEqual(expect.arrayContaining(["Summer Mix", "Winter Mix"]));
    const header = ws.getRows(1, ws.rowCount)!.find((row) => (row.values as unknown[]).includes("Bales"))!;
    expect((header.values as unknown[]).includes("Selling Price")).toBe(false);
  });
});
