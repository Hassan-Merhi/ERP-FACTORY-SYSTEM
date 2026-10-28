import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
    expect(access).toContain('canManage: ["Admin", "Owner", "Developer"].includes(ctx.role) && !ctx.posViewOnly');
    expect(manager).toContain("access.data?.canManage === true");
    expect(manager).toContain('{fullControls && <><div className="relative min-w-0 flex-1">');
    expect(manager).toContain('data-testid="button-pressing-camera"');
    expect(manager).toContain('showCamera ? "Close Camera" : "Open Camera"');
    expect(manager).toContain("simpleControls={!fullControls}");
    expect(manager).not.toContain("Scan a bale like Ground Scan. Each accepted bale");
  });

  it("mounts workers' continuously scanning camera from the Open action without inner settings", () => {
    expect(camera).toContain("useState(simpleControls)");
    expect(camera).toContain("{!simpleControls && running && (");
    expect(camera).toContain("{!simpleControls && <div className=\"flex flex-wrap gap-2\">");
    expect(camera).toContain("stream?.getTracks().forEach(track => track.stop())");
    expect(camera).not.toContain("The camera stays open between reads.");
    expect(camera).not.toContain("Permanent history and filters are below.");
  });

  it("shows company worker totals without barcode detail or Excel controls", () => {
    expect(manager).toContain("fullControls");
    expect(manager).toContain("<PressingWorkerTotals");
    expect(manager).toContain("<PressingHistoryReport");
    expect(workerTotals).toContain('data-testid="pressing-worker-totals"');
    expect(workerTotals).toContain("Total Bales");
    expect(workerTotals).toContain("Total KG");
    expect(workerTotals).not.toContain("percentOfLeader");
    expect(workerTotals).not.toContain("progressbar");
    expect(workerTotals).not.toContain("Worker / progress");
    expect(workerTotals).toContain("Worker");
    expect(workerTotals).toContain("style.badge");
    expect(workerTotals).toContain('"worker-totals", companyId, userId');
    expect(workerTotals).not.toContain("referenceNumber");
    expect(workerTotals).not.toContain("Export Excel");
    expect(history).toContain("Export Excel");
    expect(stockEntry).toContain("isPressingOnlyWorker");
    expect(stockEntry).toContain("<PressingMachineManagement active />");
  });

  it("shows read-only hourly KG targets directly below pressing worker totals", () => {
    const totalsAt = manager.indexOf("<PressingWorkerTotals");
    const hourlyAt = manager.indexOf("<PressingHourlyTargets", totalsAt);
    expect(totalsAt).toBeGreaterThan(-1);
    expect(hourlyAt).toBeGreaterThan(totalsAt);
    expect(manager).toContain('import PressingHourlyTargets from "./PressingHourlyTargets"');
    expect(hourlyTargets).toContain("enabled: active,");
    expect(hourlyTargets).toContain('day ? "?day=" + encodeURIComponent(day) : ""');
    expect(hourlyTargets).toContain('value={day || data?.day || ""}');
    expect(hourlyTargets).toContain("{data.canEdit && <Button");
    expect(report).toContain("canEdit: ctx.canCorrect");
    expect(report).toContain("if (!ctx.canCorrect) throw new ReportPermissionError(403");
  });

  it("allows shared aggregates while restricting other workers' detailed records and corrections", () => {
    expect(report).toContain('const MANAGER_ROLES = new Set(["Admin", "Owner", "Developer"])');
    expect(report).toContain('push("c.user_id = ?", ctx.userId)');
    expect(report).toContain('app.get("/api/factory/pressing-machines/report/worker-totals", requireAuth');
    expect(report).toContain("UPPER(BTRIM(u.username)) IN ('P1', 'P2', 'P3')");
    expect(report).toContain("r.company_id = $1 AND r.user_id = u.id");
    expect(report).toContain("r.role IN ('User', 'Normal User')");
    expect(report).toContain('c.company_id = $1 AND c.user_id = u.id AND c.voided_at IS NULL');
    expect(report).not.toContain('SELECT user_id FROM factory_pressing_assignments WHERE company_id = $1');
    expect(report).toContain('c.voided_at IS NULL');
    expect(corrections).toContain('const SUPERVISORS = new Set(["Admin", "Owner"])');
  });
});
