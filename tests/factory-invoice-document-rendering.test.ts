import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/db", () => ({
  db: { execute: vi.fn() },
}));

import {
  buildCanonicalInvoiceExcel,
  buildCanonicalInvoicePdf,
  type CanonicalInvoiceDocument,
} from "../server/services/factoryInvoiceDocumentService";

const invoice: CanonicalInvoiceDocument = {
  version: 1,
  orderId: 11953,
  companyId: 1,
  invoiceNumber: "INV-011953",
  orderDate: "2026-09-19",
  status: "FINALIZED",
  customerName: "HASSAN DAKIK CLIENT",
  customerCode: "HDC",
  baseCurrency: "USD",
  containerNumber: "TCNU3846298",
  destination: "MALI",
  shippingCompany: "",
  subtotalBales: 34755,
  freightAmount: 3518,
  otherChargesTotal: 708,
  grandTotal: 38981,
  totalQtyBales: 606,
  lines: [
    {
      articleCode: "GS10001",
      productName: "CREAM SUMMER 45KG",
      productNameAr: null,
      productNameFr: null,
      category: "Cream Summer",
      categoryAr: null,
      categoryFr: null,
      qty: 2,
      weightPerBale: 45,
      totalWeight: 90,
      pricingMode: "per_bale",
      pricePerBale: 120,
      pricePerKg: 0,
      unitPrice: 120,
      totalPrice: 240,
    },
  ],
  charges: [
    { id: 1, name: "CLEARANCE", amount: 708, chargeType: "OTHER" },
    { id: 2, name: "Freight", amount: 3518, chargeType: "FREIGHT" },
  ],
  frozenAt: "2026-09-19T12:00:00.000Z",
};

describe("canonical factory invoice rendering", () => {
  it("renders Category in Excel and keeps quantitative cells numeric", async () => {
    const { buffer, fileName } = await buildCanonicalInvoiceExcel(invoice, { language: "en" });

    expect(fileName).toMatch(/\.xlsx$/);
    expect(buffer.subarray(0, 2).toString("ascii")).toBe("PK");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.worksheets[0];

    let headerRowNumber = 0;
    sheet.eachRow((row) => {
      const values = (row.values as unknown[]).map((value) => String(value ?? ""));
      if (values.includes("Category") && values.includes("Article Code")) headerRowNumber = row.number;
    });

    expect(headerRowNumber).toBeGreaterThan(0);
    const header = sheet.getRow(headerRowNumber);
    const headers = (header.values as unknown[]).map((value) => String(value ?? ""));
    const categoryColumn = headers.indexOf("Category");
    const qtyColumn = headers.indexOf("Qty");
    const totalWeightColumn = headers.indexOf("Total Wt");
    const unitPriceColumn = headers.indexOf("Price/Bale");
    const totalColumn = headers.indexOf("Total");

    const dataRow = sheet.getRow(headerRowNumber + 1);
    expect(dataRow.getCell(categoryColumn).value).toBe("Cream Summer");
    expect(dataRow.getCell(qtyColumn).value).toBe(2);
    expect(dataRow.getCell(totalWeightColumn).value).toBe(90);
    expect(dataRow.getCell(unitPriceColumn).value).toBe(120);
    expect(dataRow.getCell(totalColumn).value).toBe(240);
  });

  it("groups Cream first, then Number 1/2, and writes green category subtotals", async () => {
    const grouped: CanonicalInvoiceDocument = {
      ...invoice,
      lines: [
        {
          ...invoice.lines[0],
          articleCode: "W2",
          productName: "WINTER 2",
          category: "Winter 2",
          qty: 1,
          totalWeight: 40,
          pricingMode: "per_bale",
          unitPrice: 80,
          pricePerBale: 80,
          totalPrice: 80,
        },
        {
          ...invoice.lines[0],
          articleCode: "W1",
          productName: "WINTER 1",
          category: "Winter 1",
          qty: 2,
          totalWeight: 80,
          pricingMode: "per_kg",
          unitPrice: 8.5,
          pricePerKg: 8.5,
          pricePerBale: 0,
          totalPrice: 680,
        },
        {
          ...invoice.lines[0],
          articleCode: "C2",
          productName: "CREAM WINTER",
          category: "Cream Winter",
          qty: 1,
          totalWeight: 50,
          pricingMode: "per_bale",
          unitPrice: 100,
          pricePerBale: 100,
          totalPrice: 100,
        },
        {
          ...invoice.lines[0],
          articleCode: "S1",
          productName: "SUMMER 1",
          category: "Summer 1",
          qty: 2,
          totalWeight: 70,
          pricingMode: "per_kg",
          unitPrice: 8.5,
          pricePerKg: 8.5,
          pricePerBale: 0,
          totalPrice: 595,
        },
        {
          ...invoice.lines[0],
          articleCode: "C1",
          productName: "CREAM SUMMER",
          category: "Cream Summer",
          qty: 2,
          totalWeight: 90,
          pricingMode: "per_bale",
          unitPrice: 120,
          pricePerBale: 120,
          totalPrice: 240,
        },
        {
          ...invoice.lines[0],
          articleCode: "S2",
          productName: "SUMMER 2",
          category: "Summer 2",
          qty: 1,
          totalWeight: 45,
          pricingMode: "per_bale",
          unitPrice: 90,
          pricePerBale: 90,
          totalPrice: 90,
        },
      ],
    };

    const { buffer } = await buildCanonicalInvoiceExcel(grouped, { language: "en" });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.worksheets[0];

    const rows = sheet.getSheetValues().filter(Array.isArray) as unknown[][];
    const productCells = rows.map((row) => String(row?.[3] ?? ""));

    const creamSubtotalIndex = productCells.indexOf("SUB-TOTAL CREAM");
    const number1SubtotalIndex = productCells.indexOf("SUB-TOTAL NUMBER 1");
    const number2SubtotalIndex = productCells.indexOf("SUB-TOTAL NUMBER 2");

    expect(creamSubtotalIndex).toBeGreaterThan(0);
    expect(number1SubtotalIndex).toBeGreaterThan(creamSubtotalIndex);
    expect(number2SubtotalIndex).toBeGreaterThan(number1SubtotalIndex);

    const number1Rows = rows.slice(creamSubtotalIndex + 1, number1SubtotalIndex);
    expect(number1Rows.map((row) => String(row?.[3] ?? ""))).toEqual(["SUMMER 1", "WINTER 1"]);

    const subtotalRow = rows[number1SubtotalIndex];
    expect(subtotalRow?.[5]).toBe(4);
    expect(subtotalRow?.[7]).toBe(150);
    expect(subtotalRow?.[8]).toBe(8.5);
    expect(subtotalRow?.[9]).toBe(1275);
  });

  it("renders the same canonical document as a valid PDF", async () => {
    const { buffer, fileName } = await buildCanonicalInvoicePdf(invoice, { language: "en" });

    expect(fileName).toMatch(/\.pdf$/);
    expect(buffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(500);
  });

  it("uses a neutral Unit Price heading when pricing modes are mixed", async () => {
    const mixed: CanonicalInvoiceDocument = {
      ...invoice,
      lines: [
        invoice.lines[0],
        {
          ...invoice.lines[0],
          articleCode: "GS10002",
          productName: "SUMMER KG ITEM",
          category: "Summer",
          pricingMode: "per_kg",
          pricePerBale: 0,
          pricePerKg: 1.25,
          unitPrice: 1.25,
          totalPrice: 112.5,
        },
      ],
    };

    const { buffer } = await buildCanonicalInvoiceExcel(mixed, { language: "en" });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const values = workbook.worksheets[0]
      .getSheetValues()
      .flatMap((row: any) => (Array.isArray(row) ? row : []))
      .map(String);

    expect(values).toContain("Unit Price");
  });
});
