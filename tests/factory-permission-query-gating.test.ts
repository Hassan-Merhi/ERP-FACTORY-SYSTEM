import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("Factory protected query gating", () => {
  it("gates Overview payroll reads by their owning Payroll & Benefits tabs", () => {
    const source = read("client/src/pages/factory/dailyproductionreport/useDailyProductionReport.tsx");
    expect(source).toContain("canReadWorkerAttendanceReport");
    expect(source).toContain('"hide_tab_workers_report"');
    expect(source).toContain("enabled: canReadWorkerAttendanceReport && !!from && !!to");
    expect(source).toContain("canReadWorkerPayrollSummary");
    expect(source).toContain('"hide_tab_workers_payroll"');
    expect(source).toContain("enabled: canReadWorkerPayrollSummary");
  });

  it("gates Stock Entry production-session by Production Targets access", () => {
    const source = read("client/src/pages/factory/BaleStockEntry.tsx");
    expect(source).toContain("canReadProductionSession");
    expect(source).toContain('"hide_tab_stockentry_production_targets"');
    expect(source).toContain("enabled: canReadProductionSession");
  });

  it("gates Stock Entry History support reads by their owning surfaces", () => {
    const source = read("client/src/pages/StockEntryHistory.tsx");
    expect(source).toContain("enabled: canReadWorkerPicker");
    expect(source).toContain("enabled: canReadProductionTargets && Boolean(targetDate)");
  });

  it("waits for the owned container record before loading container items", () => {
    const source = read("client/src/pages/ContainerVerification.tsx");
    expect(source).toContain("enabled: !!containerId && !!containerData?.container");
  });
});
