import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { generateGroupNetPositionExcel } from "../server/helpers/generateGroupNetPositionExcel";
import type { GroupNetPositionSnapshot } from "../server/helpers/groupNetPosition";

describe("Group Net Position Excel", () => {
  it("builds summary, side detail, and per-company sheets", async () => {
    const snapshot: GroupNetPositionSnapshot = {
      asOfDate: "2026-09-09",
      companyCount: 2,
      excludedCompanyTypes: ["properties"],
      totals: {
        forUsTotal: 180,
        onUsTotal: 70,
        sideNetPosition: 110,
        netAdjustments: -10,
        netPosition: 100,
      },
      intercompany: {
        mode: "already-excluded",
        additionalElimination: 0,
        note: "Normal Intercompany ledger accounts are already excluded.",
      },
      companies: [
        {
          companyId: 1,
          companyCode: "A",
          companyName: "Alpha & Co.",
          companyType: "erp",
          forUsTotal: 100,
          onUsTotal: 40,
          sideNetPosition: 60,
          netAdjustment: 0,
          netPosition: 60,
          netPositionLabel: "We Have More",
          forUsLines: [{ label: "Cash", value: 100, category: "Cash", side: "forUs" }],
          onUsLines: [{ label: "Loan", value: 40, category: "Loan", side: "onUs" }],
        },
        {
          companyId: 2,
          companyCode: "B",
          companyName: "Beta Supplier Partner",
          companyType: "supplier_partner",
          forUsTotal: 80,
          onUsTotal: 30,
          sideNetPosition: 50,
          netAdjustment: -10,
          netPosition: 40,
          netPositionLabel: "We Have More",
          forUsLines: [{ label: "Customer A/R", value: 80, category: "Asset", side: "forUs" }],
          onUsLines: [{ label: "Supplier Cash Payable", value: 30, category: "Liability", side: "onUs" }],
        },
      ],
    };

    const buffer = await generateGroupNetPositionExcel(snapshot);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    expect(workbook.getWorksheet("Group Summary")).toBeTruthy();
    expect(workbook.getWorksheet("What We Have")).toBeTruthy();
    expect(workbook.getWorksheet("What We Owe")).toBeTruthy();
    expect(workbook.worksheets).toHaveLength(5);

    const summary = workbook.getWorksheet("Group Summary")!;
    expect(summary.getCell("A1").value).toContain("2026-09-09");
    expect(summary.getCell("A2").value).toBe("Companies included");
    expect(summary.getCell("B2").value).toBe(2);
    expect(summary.getCell("A3").value).toBe("Excluded");
    expect(summary.getCell("B3").value).toBe("Properties");

    const companySheetNames = workbook.worksheets.slice(3).map((sheet) => sheet.name);
    expect(companySheetNames.some((name) => name.includes("Alpha"))).toBe(true);
    expect(companySheetNames.some((name) => name.includes("Beta"))).toBe(true);
  });
});
