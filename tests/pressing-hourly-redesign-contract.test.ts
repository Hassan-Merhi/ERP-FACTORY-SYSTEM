import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codeShape, fragmentFor, shaped } from "./helpers/codeShape";

const read = (path: string) => readFileSync(path, "utf8");
const api = read("server/routes/factory/factoryPressingReportRoutes.ts");
const hourly = read("client/src/pages/factory/PressingHourlyTargets.tsx");
const overview = read("client/src/pages/factory/PressingHistoryReport.tsx");
const scanner = read("client/src/pages/factory/PressingMachineManagement.tsx");
const shell = read("client/src/pages/factory/BaleStockEntry.tsx");

describe("Pressing dashboard redesign", () => {
  it("keeps hourly KG targets date and company scoped with admin-only writes", () => {
    expect(api).toMatch(/if \(!ctx\.canCorrect\)\s*throw new ReportPermissionError\(\s*403/);
    expect(shaped(api)).toContain(fragmentFor(api, "pressingHourlyTargetsByDateKg"));
    expect(shaped(api)).toContain(fragmentFor(api, "ON CONFLICT (company_id) DO UPDATE SET"));
    expect(shaped(api)).toContain(fragmentFor(api, "hour: z.number().int().min(7).max(16)"));
    expect(shaped(api)).toContain(fragmentFor(api, "hourlyTargetsKg"));
    expect(shaped(api)).toContain(fragmentFor(api, "PRESSING_TIME_ZONE"));
  });
  it("lets supervisors edit each day's ten hours independently", () => {
    expect(shaped(hourly)).toContain(fragmentFor(hourly, 'aria-label={"Hourly target for " + hourLabel(hour)}'));
    expect(shaped(hourly)).toContain(fragmentFor(hourly, "body: JSON.stringify({ day: data.day, hour: localHour(hour), targetKgPerHour })"));
    expect(shaped(hourly)).toContain(fragmentFor(hourly, "{data.canEdit && <Button"));
    expect(shaped(hourly)).toContain(fragmentFor(hourly, "setDrafts"));
    expect(shaped(hourly)).toContain(fragmentFor(hourly, "Math.min(100, Math.max(0, percent))"));
    expect(shaped(hourly)).toContain(fragmentFor(hourly, "status"));
  });
  it("keeps no-scan hours neutral and shows future hours for target setup", () => {
    expect(shaped(hourly)).toContain(fragmentFor(hourly, 'if (!started) return "upcoming"'));
    expect(shaped(hourly)).toContain(fragmentFor(hourly, 'if (!bales) return "none"'));
    expect(shaped(hourly)).toContain(fragmentFor(hourly, "localHour(hour) >= 7 && localHour(hour) < 17"));
    expect(shaped(hourly)).toContain(fragmentFor(hourly, "const target = scheduled ? (hourTarget ?? worker.targetKgPerHour) : 0"));
    expect(shaped(hourly)).toContain(fragmentFor(hourly, "Asia/Beirut"));
  });
  it("preserves scanning, user permissions, worker KPI counts and navigation", () => {
    expect(shaped(scanner)).toContain(fragmentFor(scanner, "scanner.submit"));
    expect(shaped(scanner)).toContain(fragmentFor(scanner, "simpleControls={!fullControls}"));
    expect(shaped(scanner)).toContain(fragmentFor(scanner, 'data-testid="button-pressing-camera"'));
    expect(shaped(overview)).toContain(fragmentFor(overview, 'data-testid="pressing-kpi-approx-all"'));
    expect(shaped(overview)).toContain(fragmentFor(overview, "pressingKpiWorkers"));
    expect(shaped(shell)).toContain(fragmentFor(shell, 'data-testid="tab-pressing-machines"'));
    expect(shaped(shell)).toContain(fragmentFor(shell, "isPressingOnlyWorker"));
  });
});
