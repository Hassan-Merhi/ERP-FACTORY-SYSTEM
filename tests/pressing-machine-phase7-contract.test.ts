import fs from "node:fs";
import { describe, expect, it } from "vitest";
const read=(path:string)=>fs.readFileSync(path,"utf8");
const ops=read("server/routes/factory/factoryPressingOperationsRoutes.ts");
const confirm=read("server/routes/factory/factoryPressingConfirmationRoutes.ts");
const helper=read("server/services/factory/pressingShiftTime.ts");
const ui=read("client/src/pages/factory/PressingShiftAnalytics.tsx");
const parent=read("client/src/pages/factory/PressingMachineManagement.tsx");
const registration=read("server/routes/factoryRoutes.ts");
const schema=read("shared/schema/factory/pressing-machine-tracking.ts");
describe("Pressing Machines Phase 7 integration and safety",()=>{
  it("registers authenticated shift/downtime/analytics routes under Factory access boundary",()=>{
    expect(registration).toContain("registerFactoryPressingOperationsRoutes(app)");
    expect(registration.indexOf('app.use("/api/factory", enforceFactoryBackendAccess)'))
      .toBeLessThan(registration.indexOf("registerFactoryPressingOperationsRoutes(app)"));
    for(const uri of ["/shifts/current","/shifts","/downtime","/downtime/start","/analytics"]){
      expect(ops).toContain('"/api/factory/pressing-machines'+uri+'"');
    }
  });
  it("enforces supervisor roles, company scope and immutable audit actions for writes",()=>{
    expect(ops).toContain("MANAGERS.has(ctx.role)");
    expect(ops).toContain("getActiveCompanyPermissionContext(req)");
    expect(ops).toContain("PRESSING_SUPERVISOR_REQUIRED");
    expect(ops).toContain("eq(factoryPressingShifts.companyId, ctx.companyId)");
    expect(ops).toContain("eq(factoryPressingDowntime.companyId,ctx.companyId)");
    expect(ops).toContain("await logAudit");
    expect(ops).toContain("}, tx)");
  });
  it("prevents overlapping shifts, inconsistent company timezones and concurrent conflicting writes",()=>{
    expect(ops).toContain("validateSchedule(tx, ctx.companyId");
    expect(ops).toContain("PRESSING_SHIFT_TIMEZONE_CONFLICT");
    expect(ops).toContain("PRESSING_SHIFT_OVERLAP");
    expect(ops).toContain("pg_advisory_xact_lock");
    expect(helper).toContain("intervalsOverlap");
    expect(helper).toContain("start < end ? minute >= start");
  });
  it("applies server-confirmed shifts and breaks sessions across shift boundaries",()=>{
    expect(confirm).toContain("matchingShift(activeShifts as PressingShiftDefinition[], now)");
    expect(confirm).toContain("const shiftId = activeShift?.id ?? null");
    expect(confirm).toContain("session.shiftId !== shiftId");
    expect(confirm).toContain("tx.update(factoryPressingSessions)");
    expect(confirm).toContain("shiftId, startedAt: now");
    expect(confirm).toContain("assignmentId: assignment.id, sessionId: session.id, shiftId,");
    expect(confirm).toContain("confirmedAt: now");
  });
  it("does not count activity on a machine with explicit active downtime",()=>{
    expect(confirm).toContain("isNull(factoryPressingDowntime.endedAt)");
    expect(confirm).toContain("PRESSING_MACHINE_DOWN");
    expect(ops).toContain("DOWNTIME_ALREADY_OPEN");
    expect(ops).toContain("isNull(factoryPressingDowntime.endedAt)");
    expect(schema).toContain("factory_pressing_downtime_open_machine_uk");
  });
  it("reports only accepted unvoided scans; log downtime instead of guessing stop times",()=>{
    expect(ops).toContain("FROM factory_pressing_confirmations WHERE ");
    expect(ops).toContain('"voided_at IS NULL"');
    expect(ops).toContain('COUNT(*)::integer AS "bales"');
    expect(ops).toContain('SUM(weight_kg)');
    expect(ops).toContain("factory_pressing_downtime d");
    expect(ops).toContain('rateMethod:"OBSERVED_FIRST_TO_LAST_SCAN"');
    expect(ops).toContain("observedSeconds");
    expect(ops).toContain("balesPerHour");
    expect(ops).toContain("kgPerHour");
    expect(ops).toContain("ANALYTICS_TOO_LARGE");
  });
  it("provides a supervisor workflow without giving operators write controls",()=>{
    expect(parent).toContain("<PressingShiftAnalytics");
    expect(parent).toContain("canManage={canManage}");
    expect(ui).toContain("{canManage && <>");
    expect(ui).toContain("Start Downtime");
    expect(ui).toContain("End Downtime");
    expect(ui).toContain("Save schedule");
    expect(ui).toContain("Save Target");
    expect(ui).toContain("Observed h");
    expect(ui).toContain("not a measured mechanical cycle time");
  });
  it("keeps stock valuation, bale finalization and ERP voucher writes untouched",()=>{
    expect(ops).not.toContain("adjustInventory");
    expect(ops).not.toContain("writeDaybookEntry");
    expect(confirm).not.toMatch(/tx\.(?:update|insert|delete)\(factoryBales\)/);
    expect(ops).not.toMatch(/(?:UPDATE|INSERT INTO) (?:factory_bales|voucher_entries|stock_movements)/);
  });
});
