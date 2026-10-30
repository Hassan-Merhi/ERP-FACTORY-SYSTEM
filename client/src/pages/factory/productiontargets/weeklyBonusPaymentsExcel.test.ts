import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildWeeklyBonusPaymentsWorkbook, type WeeklyBonusPaymentExportRow } from "./weeklyBonusPaymentsExcel";
const base:WeeklyBonusPaymentExportRow={
  reviewId:12,weekStart:"2026-10-26",weekEnd:"2026-11-01",workerId:5,workerName:"=SUM(1,2)",
  targetBales:"56.00",creditedBales:90,extraBales:"34.00",approvedAmount:"15.00",
  methodVersionId:3,decisionStatus:"approved",reviewedBy:"Admin",reviewedAt:"2026-11-02",
  snapshot:{categories:[{categoryLabel:"Bags",creditedBales:30},{categoryLabel:"Shoes",creditedBales:60}]},
  paymentId:77,paymentStatus:"POSTED",paymentDate:"2026-11-02",cashAccountName:"Cash Register",
  voucherId:81,reversalVoucherId:null,
};
describe("Phase 15 formatted weekly bonuses Excel",()=>{
  it("exports one record per week and worker, never one per category",async()=>{
    const book=buildWeeklyBonusPaymentsWorkbook([base],"2026-10-26","2026-10-26",ExcelJS.Workbook);
    expect(book.worksheets.map(s=>s.name)).toEqual(["Weekly Bonus Audit","Worker Totals"]);
    const audit=book.getWorksheet("Weekly Bonus Audit")!;
    expect(audit.getRow(6).getCell(3).value).toBe("'=SUM(1,2)");
    expect(audit.getRow(6).getCell(6).value).toBe(90);
    expect(audit.getRow(6).getCell(8).value).toBe("Bags (30), Shoes (60)");
    expect(audit.getRow(6).getCell(9).value).toBe(15);
    const worker=book.getWorksheet("Worker Totals")!;
    expect(worker.getRow(6).getCell(5).value).toBe(15);
    const buffer=await book.xlsx.writeBuffer();
    expect(buffer.byteLength).toBeGreaterThan(1000);
  });
  it("separates paid, unpaid and reversed claims without treating reversed as payable",()=>{
    const rows=[
      base,
      {...base,reviewId:13,weekStart:"2026-11-02",weekEnd:"2026-11-08",
        paymentStatus:null,paymentId:null,paymentDate:null,voucherId:null},
      {...base,reviewId:14,weekStart:"2026-11-09",weekEnd:"2026-11-15",
        paymentStatus:"REVERSED" as const,reversalVoucherId:91},
    ];
    const book=buildWeeklyBonusPaymentsWorkbook(rows,"2026-10-26","2026-11-09",ExcelJS.Workbook);
    const totals=book.getWorksheet("Worker Totals")!.getRow(6);
    expect(totals.getCell(3).value).toBe(3);
    expect(totals.getCell(4).value).toBe(15);
    expect(totals.getCell(5).value).toBe(15);
    expect(totals.getCell(6).value).toBe(15);
  });
});
