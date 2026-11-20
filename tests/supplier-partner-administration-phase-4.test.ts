import { describe, expect, it } from "vitest";
import path from "node:path";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

const root = process.cwd();
// A split module is read together with the siblings extracted from it.
const read = (file: string) => readModuleFamily(path.join(root, file));

describe("Supplier Partner setup navigation", () => {
  const setup = read("client/src/pages/sp/SpSetup.tsx");
  const navigation = read("client/src/lib/supplier-partner-navigation.ts");
  const panel = read("client/src/pages/sp/SpSetupPanel.tsx");
  const routeGuard = read("client/src/app/authenticatedAppRouteGuard.ts");

  it("exposes setup without the retired migration tab", () => {
    expect(setup).toContain("<SpSetupPanel />");
    expect(setup).not.toContain("GcLshiMigration");
    expect(navigation).not.toContain("/sp/setup?tab=migration");
  });

  it("limits setup to Admin or Developer", () => {
    expect(setup).toContain('role === "Admin" || role === "Developer"');
    expect(setup).toContain('<Redirect replace to="/sp/reports" />');
  });

  it("canonicalizes both historical migration URLs with replacement history", () => {
    expect(routeGuard).toContain('currentLocation === "/sp/migration"');
    expect(routeGuard).toContain('currentLocation === "/sp/gc-migration"');
    expect(routeGuard).toContain('decision = { kind: "redirect", to: "/sp/setup" }');
  });

  it("preserves the existing setup API and repair behavior", () => {
    expect(panel).toContain('queryKey: ["/api/sp/setup/status"]');
    // The setup POST now carries the CHANGE SP SETUP confirmation payload that
    // spAccessControl requires, but it must remain the same endpoint and method.
    expect(panel).toContain('apiRequest("POST", "/api/sp/setup", payload)');
    expect(panel).toContain("repairedSupplierVoucherLinks");
  });
});
