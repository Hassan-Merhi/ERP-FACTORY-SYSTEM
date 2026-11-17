import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import {
  canReadAccountMigrationSource,
  isAccountMigrationSourceReadPath,
} from "../server/services/security/accountMigrationRequestPolicy";

const authSource = readFileSync("server/auth.ts", "utf8");
const accessManifest = readFileSync("config/route-access-manifest.json", "utf8");
const migrationSource = readFileSync("server/routes/admin/import-export/account-migration.ts", "utf8");

describe("account migration Admin source-read authorization", () => {
  it("allows the exact source read only for Admin and Developer", () => {
    expect(canReadAccountMigrationSource("GET", "/api/admin/account-migration/accounts/13", "Admin")).toBe(true);
    expect(canReadAccountMigrationSource("get", "/api/admin/account-migration/accounts/13", "Developer")).toBe(true);
    for (const role of ["Owner", "Manager", "POS", "ERP Tester", "", null]) {
      expect(canReadAccountMigrationSource("GET", "/api/admin/account-migration/accounts/13", role)).toBe(false);
    }
  });

  it("does not broaden other routes or mutating requests", () => {
    expect(isAccountMigrationSourceReadPath("POST", "/api/admin/account-migration/accounts/13")).toBe(false);
    expect(isAccountMigrationSourceReadPath("GET", "/api/admin/account-migration/accounts/0")).toBe(false);
    expect(isAccountMigrationSourceReadPath("GET", "/api/admin/account-migration/accounts/13/extra")).toBe(false);
    expect(isAccountMigrationSourceReadPath("GET", "/api/admin/account-migration/companies")).toBe(false);
    expect(isAccountMigrationSourceReadPath("GET", "/api/ledger-accounts/13")).toBe(false);
    expect(isAccountMigrationSourceReadPath("GET", "/api/admin/account-migration/undo")).toBe(false);
  });

  it("allows the cross-company read through central authentication after input validation", () => {
    expect(authSource).toContain("canReadAccountMigrationSource(req.method, req.path, role)");
    const boundary = authSource.indexOf("function authorizeExplicitCompanyScope");
    const invalid = authSource.indexOf('if (decision.kind === "invalid")', boundary);
    const exception = authSource.indexOf("canReadAccountMigrationSource(req.method, req.path, role)", boundary);
    const pinned = authSource.indexOf("assertRequestCompanyMatchesSession(", exception);
    expect(invalid).toBeGreaterThan(boundary);
    expect(exception).toBeGreaterThan(invalid);
    expect(pinned).toBeGreaterThan(exception);
  });

  it("preserves canonical company membership and route-level role checks", () => {
    // The allowance is declared on the one route that may use it and enforced
    // by the access boundary's company-scope stage.
    const declared = accessManifest.split("\n").filter((line) => line.includes('"account-migration-source"'));
    expect(declared).toHaveLength(1);
    expect(declared[0]).toContain('"id":"GET /api/admin/account-migration/accounts/:companyId#1"');
    // Enforcement of the allowance (role, then membership of the named company)
    // is exercised in tests/access-boundary-company-scope.test.ts.
    expect(migrationSource).toContain('requireRole("Admin", "Developer")');
    expect(migrationSource).toContain("await assertCompaniesAccess(context.userId, [companyId])");
  });
});
