import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildProductionTargetBonusReport } from "@shared/productionTargetBonusReporting";
import { buildProductionBonusReportWorkbook } from "./productionBonusHistoryExcel";

describe("production bonus formatted Excel report", () => {
  it("contains separate overview, workers, history and statement sheets with immutable award details", async () => {
    const report = buildProductionTargetBonusReport("2026-10-29", "2026-10-29", [{
      id: 2, workerId: 12, workerNameSnapshot: "=2+2", workerCodeSnapshot: "A12",
      productionDate: "2026-10-29", currency: "USD", targetBales: 7,
      creditedBales: 9, excessBales: 2, bonusPerExtraBale: "0.5000",
      amount: "1.00", status: "POSTED", approvedAt: "2026-10-29T16:00:00Z",
      postedAt: "2026-10-30T10:00:00Z", paymentVoucherId: 77,
      paymentVoucherNumber: "DEP-77", paymentAccountNameSnapshot: "Cashier",
      productionSnapshotId: "2026-10-29:12",
    }], "2026-10-30T10:00:00.000Z");
    const book = buildProductionBonusReportWorkbook(report, ExcelJS.Workbook);
    expect(book.worksheets.map(sheet => sheet.name)).toEqual([
      "Bonus Overview", "Worker Bonus Totals", "Bonus History", "Worker Statements",
    ]);
    expect(book.getWorksheet("Bonus Overview")!.getRow(6).getCell(4).value).toBe(1);
    const history = book.getWorksheet("Bonus History")!;
    expect(history.getRow(6).getCell(3).value).toBe("'=2+2");
    expect(history.getRow(6).getCell(10).value).toBe(1);
    expect(history.getRow(6).getCell(15).value).toBe(77);
    expect(book.getWorksheet("Worker Statements")!.getRow(6).getCell(11).value).toBe(1);
    const buffer = await book.xlsx.writeBuffer();
    expect(buffer.byteLength).toBeGreaterThan(1000);
  });

  it("rejects a forged workbook summary instead of exporting inconsistent money", () => {
    const report = buildProductionTargetBonusReport("2026-10-29", "2026-10-29", []);
    report.currencies.push({ currency: "USD", accepted: "500.00", pendingProposed: "0.00",
      approvedUnpaid: "500.00", paid: "0.00", rejected: "0.00", draft: "0.00",
      totalRows: 1, paidCount: 0, approvedCount: 1, pendingCount: 0 });
    const book = buildProductionBonusReportWorkbook(report, ExcelJS.Workbook);
    // Workbook totals are recomputed from source rows; injected summary ignored.
    expect(book.getWorksheet("Bonus Overview")!.rowCount).toBeLessThan(8);
  });
});
