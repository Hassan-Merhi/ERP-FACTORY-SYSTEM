import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codeShape, fragmentFor, shaped } from "./helpers/codeShape";

const read = (file: string) => readFileSync(file, "utf8");
const manager = read("client/src/pages/factory/PressingMachineManagement.tsx");
const camera = read("client/src/pages/factory/ContinuousPressingScanner.tsx");
const history = read("client/src/pages/factory/PressingHistoryReport.tsx");
const workerTotals = read("client/src/pages/factory/PressingWorkerTotals.tsx");
const hourlyTargets = read("client/src/pages/factory/PressingHourlyTargets.tsx");
const stockEntry = read("client/src/pages/factory/BaleStockEntry.tsx");
const access = read("server/routes/factory/factoryPressingMachineManagementRoutes.ts");
const report = read("server/routes/factory/factoryPressingReportRoutes.ts");
const corrections = read("server/routes/factory/factoryPressingCorrectionRoutes.ts");

describe("Pressing worker camera-only access", () => {
  it("grants full scanner UI to Admin, Owner and Developer using the authenticated company role", () => {
    expect(shaped(access)).toContain(fragmentFor(access, 'canManage: ["Admin", "Owner", "Developer"].includes(ctx.role) && !ctx.posViewOnly'));
    expect(shaped(manager)).toContain(fragmentFor(manager, "access.data?.canManage === true"));
    expect(shaped(manager)).toContain(fragmentFor(manager, '{fullControls && <><div className="relative min-w-0 flex-1">'));
    expect(shaped(manager)).toContain(fragmentFor(manager, 'data-testid="button-pressing-camera"'));
    expect(shaped(manager)).toContain(fragmentFor(manager, 'showCamera ? "Close Camera" : "Open Camera"'));
    expect(shaped(manager)).toContain(fragmentFor(manager, "simpleControls={!fullControls}"));
    expect(shaped(manager)).not.toContain(fragmentFor(manager, "Scan a bale like Ground Scan. Each accepted bale"));
  });

  it("mounts workers' continuously scanning camera from the Open action without inner settings", () => {
    expect(shaped(camera)).toContain(fragmentFor(camera, "useState(simpleControls)"));
    expect(shaped(camera)).toContain(fragmentFor(camera, "{!simpleControls && running && ("));
    expect(shaped(camera)).toContain(fragmentFor(camera, '{!simpleControls && <div className="flex flex-wrap gap-2">'));
    expect(shaped(camera)).toContain(fragmentFor(camera, "stream?.getTracks().forEach(track => track.stop())"));
    expect(shaped(camera)).not.toContain(fragmentFor(camera, "The camera stays open between reads."));
    expect(shaped(camera)).not.toContain(fragmentFor(camera, "Permanent history and filters are below."));
  });

  it("shows company worker totals without barcode detail or Excel controls", () => {
    expect(shaped(manager)).toContain(fragmentFor(manager, "fullControls"));
    expect(shaped(manager)).toContain(fragmentFor(manager, "<PressingWorkerTotals"));
    expect(shaped(manager)).toContain(fragmentFor(manager, "<PressingHistoryReport"));
    expect(shaped(workerTotals)).toContain(fragmentFor(workerTotals, 'data-testid="pressing-worker-totals"'));
    expect(shaped(workerTotals)).toContain(fragmentFor(workerTotals, "Total Items"));
    expect(shaped(workerTotals)).toContain(fragmentFor(workerTotals, "Total KG"));
    expect(shaped(workerTotals)).not.toContain(fragmentFor(workerTotals, "percentOfLeader"));
    expect(shaped(workerTotals)).not.toContain(fragmentFor(workerTotals, "progressbar"));
    expect(shaped(workerTotals)).not.toContain(fragmentFor(workerTotals, "Worker / progress"));
    expect(shaped(workerTotals)).toContain(fragmentFor(workerTotals, "Worker"));
    expect(shaped(workerTotals)).toContain(fragmentFor(workerTotals, "style.badge"));
    expect(shaped(workerTotals)).toContain(fragmentFor(workerTotals, '"worker-totals", companyId, userId, day'));
    expect(shaped(workerTotals)).not.toContain(fragmentFor(workerTotals, "referenceNumber"));
    expect(shaped(workerTotals)).not.toContain(fragmentFor(workerTotals, "Export Excel"));
    expect(shaped(history)).toContain(fragmentFor(history, "Export Excel"));
    expect(shaped(stockEntry)).toContain(fragmentFor(stockEntry, "isPressingOnlyWorker"));
    expect(shaped(stockEntry)).toContain(fragmentFor(stockEntry, "<PressingMachineManagement active />"));
  });

  it("filters worker scoreboard to one Beirut production day without lifetime totals", () => {
    expect(shaped(workerTotals)).toContain(fragmentFor(workerTotals, "Daily confirmed scans (Beirut time)"));
    expect(shaped(workerTotals)).toContain(fragmentFor(workerTotals, 'type="date"'));
    expect(shaped(workerTotals)).toContain(fragmentFor(workerTotals, "max={totals.data?.serverToday}"));
    expect(shaped(workerTotals)).toContain(fragmentFor(workerTotals, 'day ? "?day=" + encodeURIComponent(day) : ""'));
    expect(shaped(workerTotals)).toContain(fragmentFor(workerTotals, 'value={day || totals.data?.day || ""}'));
    expect(shaped(workerTotals)).not.toContain(fragmentFor(workerTotals, "All-time confirmed scans"));
    expect(shaped(report)).toContain(fragmentFor(report, "const serverToday = factoryLocalDate(new Date(), PRESSING_TIME_ZONE)"));
    expect(shaped(report)).toContain(fragmentFor(report, "c.confirmed_at >= ($2::date::timestamp AT TIME ZONE"));
    expect(shaped(report)).toContain(fragmentFor(report, "c.confirmed_at < (($2::date + 1)::timestamp AT TIME ZONE"));
    expect(shaped(report)).toContain(fragmentFor(report, "return res.json({ day, serverToday, workers: result.rows })"));
  });

  it("shows read-only hourly KG targets directly below pressing worker totals", () => {
    const totalsAt = codeShape(manager).indexOf(codeShape("<PressingWorkerTotals"));
    const hourlyAt = manager.indexOf("<PressingHourlyTargets", totalsAt);
    expect(totalsAt).toBeGreaterThan(-1);
    expect(hourlyAt).toBeGreaterThan(totalsAt);
    expect(shaped(manager)).toContain(fragmentFor(manager, 'import PressingHourlyTargets from "./PressingHourlyTargets"'));
    expect(shaped(hourlyTargets)).toContain(fragmentFor(hourlyTargets, "enabled: active,"));
    expect(shaped(hourlyTargets)).toContain(fragmentFor(hourlyTargets, 'day ? "?day=" + encodeURIComponent(day) : ""'));
    expect(shaped(hourlyTargets)).toContain(fragmentFor(hourlyTargets, 'value={day || data?.day || ""}'));
    expect(shaped(hourlyTargets)).toContain(fragmentFor(hourlyTargets, "{data.canEdit && <Button"));
    expect(shaped(report)).toContain(fragmentFor(report, "canEdit: ctx.canCorrect"));
    expect(report).toMatch(/if \(!ctx\.canCorrect\)\s*throw new ReportPermissionError\(\s*403/);
  });

  it("allows shared aggregates while restricting other workers' detailed records and corrections", () => {
    expect(shaped(report)).toContain(fragmentFor(report, 'const MANAGER_ROLES = new Set(["Admin", "Owner", "Developer"])'));
    expect(shaped(report)).toContain(fragmentFor(report, 'push("c.user_id = ?", ctx.userId)'));
    expect(shaped(report)).toContain(fragmentFor(report, 'app.get("/api/factory/pressing-machines/report/worker-totals", requireAuth'));
    expect(shaped(report)).toContain(fragmentFor(report, "UPPER(BTRIM(u.username)) IN ('P1', 'P2', 'P3')"));
    expect(shaped(report)).toContain(fragmentFor(report, "r.company_id = $1 AND r.user_id = u.id"));
    expect(shaped(report)).toContain(fragmentFor(report, "r.role IN ('User', 'Normal User')"));
    expect(shaped(report)).toContain(fragmentFor(report, "c.company_id = $1 AND c.user_id = u.id AND c.voided_at IS NULL"));
    expect(shaped(report)).not.toContain(fragmentFor(report, "SELECT user_id FROM factory_pressing_assignments WHERE company_id = $1"));
    expect(shaped(report)).toContain(fragmentFor(report, "c.voided_at IS NULL"));
    expect(shaped(corrections)).toContain(fragmentFor(corrections, 'const SUPERVISORS = new Set(["Admin", "Owner"])'));
  });
});
