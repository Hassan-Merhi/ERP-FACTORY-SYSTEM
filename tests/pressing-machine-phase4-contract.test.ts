import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Formatting-insensitive source check: compares code tokens, not layout, so a
// Prettier reflow of the source cannot break the contract.
const normalizeCode = (code: string) =>
  code
    .replace(/\s+/g, "")
    .replace(/'/g, '"')
    .replace(/\((\w+)\)=>/g, "$1=>")
    .replace(/,([}\])])/g, "$1");
const expectCode = (code: string, expected: string) => expect(normalizeCode(code)).toContain(normalizeCode(expected));
const expectNoCode = (code: string, unexpected: string) =>
  expect(normalizeCode(code)).not.toContain(normalizeCode(unexpected));

const read = (path: string) => readFileSync(path, "utf8");
const route = read("server/routes/factory/factoryPressingConfirmationRoutes.ts");
const hub = read("server/routes/factoryRoutes.ts");
const client = read("client/src/pages/factory/pressing-scanner/pressingConfirmClient.ts");
const scanner = read("client/src/pages/factory/ContinuousPressingScanner.tsx");
const manager = read("client/src/pages/factory/PressingMachineManagement.tsx");
const ddl = read("migrations/20261027_001_factory_pressing_machine_tracking.sql");

describe("Pressing machine Phase 4 transaction safety", () => {
  it("wires server confirmation after the shared tenant and Factory access boundaries", () => {
    expectCode(route, 'app.post("/api/factory/pressing-machines/confirm", requireAuth');
    expectCode(route, "getActiveCompanyPermissionContext(req)");
    expectCode(hub, "registerFactoryPressingConfirmRoutes(app);");
    expect(hub.indexOf('app.use("/api/factory", enforceFactoryBackendAccess)')).toBeLessThan(
      hub.indexOf("registerFactoryPressingConfirmRoutes(app);")
    );
  });

  it("uses a locked active machine and the caller's own unended assignment", () => {
    expectCode(route, "pg_advisory_xact_lock");
    expectCode(route, "eq(factoryPressingMachines.companyId, companyId)");
    expectCode(route, "eq(factoryPressingAssignments.userId, userId)");
    expectCode(route, "eq(factoryPressingAssignments.machineId, machine.id)");
    expectCode(route, "isNull(factoryPressingAssignments.unassignedAt)");
    expectCode(route, '.for("update")');
    expectCode(route, "PRESSING_ASSIGNMENT_CHANGED");
  });

  it("resolves company-owned bales, allowing all non-deleted inventory statuses", () => {
    expectCode(route, "eq(factoryBales.companyId, companyId)");
    expectCode(route, "eq(factoryBales.referenceNumber, reference)");
    expectCode(route, "isNull(factoryBales.deletedAt)");
    expectCode(route, 'bale.status === "DELETED"');
    expectNoCode(route, "PRESSING_BALE_NOT_PENDING");
    expectCode(route, "PRESSING_BALE_NOT_FOUND");
    expectNoCode(route, "PRESSING_NON_BALE_ITEM");
    expectNoCode(route, "isNonBalePriorityProduct");
    expectCode(route, "Non-bale Priority products");
  });

  it("enforces one active confirmation across all machines and a unique request ID", () => {
    expectCode(route, "PRESSING_ALREADY_CONFIRMED");
    expectCode(route, "operatorName: priorProfile?.displayName?.trim()");
    expectCode(route, "operatorName: otherProfile?.displayName?.trim()");
    expectCode(scanner, 'data-testid="pressing-duplicate-user"');
    expectCode(scanner, "ALREADY SCANNED");
    expectCode(route, "userNameSnapshot: operator.displayName?.trim()");
    expectCode(route, "PRESSING_REQUEST_ID_REUSED");
    expectCode(route, "PRESSING_CONFIRMATION_VOIDED");
    expect(route).toMatch(/\.onConflictDoNothing\(\)\s*\.returning\(\)/);
    expectCode(ddl, "ON factory_pressing_confirmations (company_id, bale_id) WHERE voided_at IS NULL");
    expectCode(ddl, "ON factory_pressing_confirmations (company_id, request_id)");
    expectCode(route, "requestId: parsed.requestId");
    expectCode(route, "return res.status(result.replayed ? 200 : 201)");
  });

  it("saves exact server timestamp and audit in the transaction without stock writes", () => {
    expectCode(route, "confirmedAt: now");
    expectCode(route, "deviceCapturedAt");
    expectCode(route, "productionDate");
    expect(route).toMatch(/logAudit\(\s*\{/);
    expectCode(route, "}, tx)");
    expect(route).not.toMatch(
      /tx\.(?:update|insert|delete)\((?:factoryBales|factoryMixBatches|stockMovements|voucherEntries)\)/
    );
    expectNoCode(route, "adjustInventory");
    expectNoCode(route, "writeDaybookEntry");
    expectCode(route, "inventoryFinalized: false");
  });

  it("never marks a scan as confirmed until the server's receipt arrives", () => {
    expectCode(manager, "onBarcode={cameraRead}");
    expectCode(manager, "scanner.submit({");
    expectCode(client, "const receipt: unknown = await response.json()");
    expectCode(client, 'item.status === "PRESSING_COMPLETED"');
    expectCode(client, 'kind: "confirmed"');
    expectCode(client, "isPressingDuplicate(code)");
    expectCode(scanner, "last.confirmedAt");
    expectCode(scanner, "Server confirmed:");
  });
});
