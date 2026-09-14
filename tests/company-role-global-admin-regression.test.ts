import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("Developer cross-company role administration regression", () => {
  it("lets Developer requests with an explicit target company reach the role/configuration policies", () => {
    const auth = read("server/auth.ts");

    expect(auth).toContain('if (role === "Developer") return true;');
    expect(auth).toContain("assertRequestCompanyMatchesSession(");
  });

  it("returns all company-role assignments to Developer while tenant admins remain active-company scoped", () => {
    const scope = read("server/middleware/companyUserRoleScope.ts");

    expect(scope).toContain('if (actorRole !== "Developer") {');
    expect(scope).toContain("filterRolesForCompany(rows.filter(hasCompanyId), companyId)");
    expect(scope).toContain('actorRole !== "Developer" && targetRole.companyId !== companyId');
  });

  it("validates Developer POS locations and cash mappings against the target company, not the open company", () => {
    const scope = read("server/middleware/userLocationConfigurationScope.ts");

    expect(scope).toContain(
      'const scopeCompanyId = actorRole === "Developer" ? route.companyId : activeCompanyId;'
    );
    expect(scope).toContain("eq(locations.companyId, scopeCompanyId)");
    expect(scope).toContain("eq(ledgerAccounts.companyId, scopeCompanyId)");
  });
});
