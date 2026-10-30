import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const api = read("server/routes/factory/factoryPressingReportRoutes.ts");
const hourly = read("client/src/pages/factory/PressingHourlyTargets.tsx");
const overview = read("client/src/pages/factory/PressingHistoryReport.tsx");
const scanner = read("client/src/pages/factory/PressingMachineManagement.tsx");
const shell = read("client/src/pages/factory/BaleStockEntry.tsx");

describe("Pressing dashboard redesign", () => {
  it("keeps hourly KG targets date and company scoped with admin-only writes", () => {
    expect(api).toContain("if (!ctx.canCorrect) throw new ReportPermissionError(403");
    expect(api).toContain("pressingHourlyTargetsByDateKg");
    expect(api).toContain("ON CONFLICT (company_id) DO UPDATE SET");
    expect(api).toContain("hour: z.number().int().min(7).max(16)");
    expect(api).toContain("hourlyTargetsKg");
    expect(api).toContain("PRESSING_TIME_ZONE");
  });
  it("lets supervisors edit each day's ten hours independently", () => {
    expect(hourly).toContain('aria-label={"Hourly target for " + hourLabel(hour)}');
    expect(hourly).toContain("body: JSON.stringify({ day: data.day, hour: localHour(hour), targetKgPerHour })");
    expect(hourly).toContain("{data.canEdit && <Button");
    expect(hourly).toContain("setDrafts");
    expect(hourly).toContain("Math.min(100, Math.max(0, percent))");
    expect(hourly).toContain('status');
  });
  it("keeps no-scan hours neutral and shows future hours for target setup", () => {
    expect(hourly).toContain('if (!started) return "upcoming"');
    expect(hourly).toContain('if (!bales) return "none"');
    expect(hourly).toContain("localHour(hour) >= 7 && localHour(hour) < 17");
    expect(hourly).toContain('const target = hourTarget ?? worker.targetKgPerHour');
    expect(hourly).toContain("Asia/Beirut");
  });
  it("preserves scanning, user permissions, worker KPI counts and navigation", () => {
    expect(scanner).toContain("scanner.submit");
    expect(scanner).toContain('simpleControls={!fullControls}');
    expect(scanner).toContain('data-testid="button-pressing-camera"');
    expect(overview).toContain('data-testid="pressing-kpi-approx-all"');
    expect(overview).toContain("pressingKpiWorkers");
    expect(shell).toContain('data-testid="tab-pressing-machines"');
    expect(shell).toContain("isPressingOnlyWorker");
  });
});
