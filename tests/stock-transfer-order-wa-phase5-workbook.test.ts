import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { createNoCostExcel } from "../server/services/stockTransferNoCostWorkbook";

describe("approved Stock Transfer Order Excel without cost", () => {
  it("preserves the existing Truck Trip styling, source totals and grand total", async () => {
    const buffer = await createNoCostExcel({
      companyName: "Factory Company",
      destinationName: "Receiving Warehouse",
      transferDate: "2026-11-11",
      batchReference: "11111111-1111-4111-8111-111111111111",
      approvedOrders: ["STO-51", "STO-52"],
      items: [
        { stockItemName: "Blue shirts", sourceLocationName: "Location A", quantity: 30 },
        { stockItemName: "Blue shirts", sourceLocationName: "Location B", quantity: 20 },
        { stockItemName: "Red shirts", sourceLocationName: "Location A", quantity: 10 },
      ],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    expect(wb.worksheets.map(s => s.name)).toEqual(["Truck Trip", "Approved Orders"]);
    const rows = wb.getWorksheet("Truck Trip")!;
    expect(rows.getCell("A1").value).toBe("Factory Company");
    expect(rows.getCell("A4").value).toBe("ITEM  NAME");
    const values = rows.getColumn(1).values.map(v => String(v || ""));
    expect(values.some(v => v.includes("TOTAL LOCATION A"))).toBe(true);
    expect(values.some(v => v.includes("TOTAL LOCATION B"))).toBe(true);
    const grand = rows.getRow(rows.rowCount);
    expect(grand.getCell(1).value).toBe("TOTAL");
    expect(grand.getCell(3).value).toBe(60);
    const refs = wb.getWorksheet("Approved Orders")!;
    expect(refs.getCell("A6").value).toBe("Included Stock Transfer Orders");
    expect(refs.getCell("A7").value).toBe("STO-51");
    expect(refs.getCell("A8").value).toBe("STO-52");
  });

  it("does not include price, cost, rate, margin, financial value or Excel formulas", async () => {
    const workbook = await createNoCostExcel({
      companyName: "=cmd|fake",
      destinationName: "-danger",
      transferDate: "2026-11-11",
      batchReference: "11111111-1111-4111-8111-111111111111",
      approvedOrders: ["=BAD()", "@item-ref"],
      items: [{ stockItemName: "=SUM(1,1)", sourceLocationName: "+formula",
        quantity: 5 }],
    });
    const parsed = new ExcelJS.Workbook();
    await parsed.xlsx.load(workbook);
    const allText = parsed.worksheets.flatMap(sheet =>
      sheet.getRows(1, sheet.rowCount)?.flatMap(row =>
        row.values.slice(1).map(cell => typeof cell === "string" ? cell : String(cell ?? ""))
      ) || []);
    expect(allText).not.toContain("PRICE");
    expect(allText).not.toContain("COST");
    expect(allText).not.toContain("RATE");
    expect(allText).not.toContain("MARGIN");
    expect(parsed.getWorksheet("Truck Trip")?.getCell("A1").value).toBe("'=cmd|fake");
    expect(parsed.getWorksheet("Truck Trip")?.getCell("A5").value).toBe("'=SUM(1,1)");
    expect(parsed.getWorksheet("Approved Orders")?.getCell("A7").value).toBe("'=BAD()");
    for(const sheet of parsed.worksheets) {
      sheet.eachRow(row => row.eachCell(cell => {
        expect(typeof cell.value === "object" && cell.value !== null &&
          "formula" in cell.value).toBe(false);
      }));
    }
  });

  it("does not add approved-order metadata to manual Excel exports", async () => {
    const bytes = await createNoCostExcel({
      companyName: "Factory", destinationName: "Warehouse", transferDate: "2026-11-11",
      items: [{ stockItemName: "Article", sourceLocationName: "Location", quantity: 1 }],
    });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes);
    expect(book.worksheets.map(x => x.name)).toEqual(["Truck Trip"]);
  });
});
