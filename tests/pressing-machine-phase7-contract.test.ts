import fs from "node:fs";
import { describe, expect, it } from "vitest";
const read = (path:string) => fs.readFileSync(path,"utf8");
const routes = read("server/routes/factoryRoutes.ts");
const page = read("client/src/pages/factory/PressingMachineManagement.tsx");
const access = read("server/routes/factory/factoryPressingMachineManagementRoutes.ts");
const confirm = read("server/routes/factory/factoryPressingConfirmationRoutes.ts");
const report = read("server/routes/factory/factoryPressingReportRoutes.ts");
const history = read("client/src/pages/factory/PressingHistoryReport.tsx");

describe("Simplified pressing workflow replaces Phase 7 operational configuration",()=>{
  it("does not register shift/downtime/productivity APIs",()=>{
    expect(routes).not.toContain("registerFactoryPressingOperationsRoutes(app)");
    for(const uri of ["/shifts","/downtime","/analytics"])
      expect(routes).not.toContain("registerFactoryPressingOperationsRoutes");
    // File and legacy records may remain for history/migration integrity,
    // but dead API routes must not be registered in the Express app.
  });
  it("does not expose shift, machine downtime or targets on the page",()=>{
    expect(page).not.toContain("PressingShiftAnalytics");
    expect(page).not.toContain("MachineManagerCard");
    expect(page).not.toContain("targetBalesPerHour");
    expect(page).not.toContain("Save Target");
    expect(page).not.toContain("Start Downtime");
    expect(page).not.toContain("Add Shift");
    expect(history).toContain('aria-label="Pressing user filter"');
    expect(history).not.toContain('Shift ID');
  });
  it("pressing confirmation is attributed to authenticated user with no shift dependency",()=>{
    expect(confirm).toContain("const shiftId = null");
    expect(confirm).toContain("userId, userNameSnapshot: operator.username");
    expect(confirm).not.toContain("matchingShift(");
    expect(confirm).not.toContain("factoryPressingDowntime");
    expect(confirm).not.toContain("PRESSING_MACHINE_DOWN");
  });
  it("newly granted users can activate scanning without an admin machine assignment",()=>{
    expect(access).toContain('"/api/factory/pressing-machines/activate"');
    expect(access).toContain('machineCode: "PRESSING-SCAN"');
    expect(access).toContain('eq(factoryPressingAssignments.userId, userId)');
    expect(access).toContain("pg_advisory_xact_lock");
    expect(page).toContain("activate()");
    expect(page).toContain('Scan bale reference / barcode...');
  });
  it("historical pressing rows remain queryable and no Factory financial writes are introduced",()=>{
    expect(report).toContain("FROM factory_pressing_confirmations c");
    expect(report).toContain("c.voided_at IS NULL");
    expect(confirm).not.toContain("adjustInventory");
    expect(access).not.toContain("writeDaybookEntry");
    expect(page).toContain("<PressingHistoryReport");
  });
});
