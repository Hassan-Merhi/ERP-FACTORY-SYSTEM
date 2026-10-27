import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const route = read("server/routes/factory/factoryPressingConfirmationRoutes.ts");
const hub = read("server/routes/factoryRoutes.ts");
const client = read("client/src/pages/factory/pressing-scanner/pressingConfirmClient.ts");
const scanner = read("client/src/pages/factory/ContinuousPressingScanner.tsx");
const manager = read("client/src/pages/factory/PressingMachineManagement.tsx");
const ddl = read("migrations/20261027_001_factory_pressing_machine_tracking.sql");

describe("Pressing machine Phase 4 transaction safety", () => {
  it("wires server confirmation after the shared tenant and Factory access boundaries", () => {
    expect(route).toContain('app.post("/api/factory/pressing-machines/confirm", requireAuth');
    expect(route).toContain("getActiveCompanyPermissionContext(req)");
    expect(hub).toContain("registerFactoryPressingConfirmRoutes(app);");
    expect(hub.indexOf('app.use("/api/factory", enforceFactoryBackendAccess)'))
      .toBeLessThan(hub.indexOf("registerFactoryPressingConfirmRoutes(app);"));
  });

  it("uses a locked active machine and the caller's own unended assignment", () => {
    expect(route).toContain('pg_advisory_xact_lock');
    expect(route).toContain('eq(factoryPressingMachines.companyId, companyId)');
    expect(route).toContain('eq(factoryPressingAssignments.userId, userId)');
    expect(route).toContain('eq(factoryPressingAssignments.machineId, machine.id)');
    expect(route).toContain('isNull(factoryPressingAssignments.unassignedAt)');
    expect(route).toContain('.for("update")');
    expect(route).toContain("PRESSING_ASSIGNMENT_CHANGED");
  });

  it("resolves company-owned bales, allowing all non-deleted inventory statuses", () => {
    expect(route).toContain("eq(factoryBales.companyId, companyId)");
    expect(route).toContain("eq(factoryBales.referenceNumber, reference)");
    expect(route).toContain("isNull(factoryBales.deletedAt)");
    expect(route).toContain('bale.status === "DELETED"');
    expect(route).not.toContain("PRESSING_BALE_NOT_PENDING");
    expect(route).toContain("nonBalePriorityProductIds");
    expect(route).toContain("PRESSING_BALE_NOT_FOUND");
    expect(route).toContain("PRESSING_NON_BALE_ITEM");
  });

  it("enforces one active confirmation across all machines and a unique request ID", () => {
    expect(route).toContain("PRESSING_ALREADY_CONFIRMED");
    expect(route).toContain("PRESSING_REQUEST_ID_REUSED");
    expect(route).toContain("PRESSING_CONFIRMATION_VOIDED");
    expect(route).toContain('.onConflictDoNothing().returning()');
    expect(ddl).toContain("ON factory_pressing_confirmations (company_id, bale_id) WHERE voided_at IS NULL");
    expect(ddl).toContain("ON factory_pressing_confirmations (company_id, request_id)");
    expect(route).toContain("requestId: parsed.requestId");
    expect(route).toContain("return res.status(result.replayed ? 200 : 201)");
  });

  it("saves exact server timestamp and audit in the transaction without stock writes", () => {
    expect(route).toContain("confirmedAt: now");
    expect(route).toContain("deviceCapturedAt");
    expect(route).toContain("productionDate");
    expect(route).toContain("logAudit({");
    expect(route).toContain("}, tx)");
    expect(route).not.toMatch(/tx\.(?:update|insert|delete)\((?:factoryBales|factoryMixBatches|stockMovements|voucherEntries)\)/);
    expect(route).not.toContain("adjustInventory");
    expect(route).not.toContain("writeDaybookEntry");
    expect(route).toContain("inventoryFinalized: false");
  });

  it("never marks a scan as confirmed until the server's receipt arrives", () => {
    expect(manager).toContain("onBarcode={cameraRead}");
    expect(manager).toContain("scanner.submit({");
    expect(client).toContain("const receipt: unknown = await response.json()");
    expect(client).toContain('item.status === "PRESSING_COMPLETED"');
    expect(client).toContain('kind: "confirmed"');
    expect(client).toContain("isPressingDuplicate(code)");
    expect(scanner).toContain("last.confirmedAt");
    expect(scanner).toContain("Server confirmed:");
  });
});
