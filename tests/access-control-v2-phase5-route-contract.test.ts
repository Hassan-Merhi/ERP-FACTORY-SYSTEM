import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (name: string) => fs.readFileSync(path.join(root, name), "utf8");
// Collapse formatter line breaks inside call arguments so signatures stay stable under Prettier.
const readCode = (name: string) => read(name).replace(/\(\s+/g, "(").replace(/,\s+/g, ", ");

describe("Phase 5 shadow user API boundaries", () => {
  const routes = readCode("server/routes/admin/permissionControlCenterRoutes.ts");
  const store = read("server/services/security/accessControlV2Store.ts");
  const ui = read("client/src/pages/settings/UserAccessOverrides.tsx");

  it("guards member listing with authenticated canonical company admin", () => {
    expect(routes).toContain('app.get("/api/permissions-v2/users", requireAuth');
    expect(routes).toContain("const actor = await requirePolicyAdmin(req)");
    expect(routes).toContain("readV2CompanyMembers(actor.companyId)");
    expect(store).toContain("WHERE company_id=$1 ORDER BY user_id LIMIT 2000");
  });

  it("refuses fake user-role previews", () => {
    expect(routes).toContain("q.role !== companyRole");
    expect(routes).toContain("POLICY_ROLE_MISMATCH");
    expect(routes).toContain("const role = companyRole ?? q.role");
  });

  it("routes edits through audited versioned storage, not legacy roles", () => {
    expect(ui).toContain('"/api/permissions-v2/user-overrides"');
    expect(ui).toContain("expectedRevision");
    expect(ui).toContain("pendingRoleChanges");
    expect(ui).toContain('"inherit"');
    expect(ui).not.toContain('"/api/user-company-roles"');
    expect(store).toContain("INSERT INTO access_policy_change_audit");
    expect(store).not.toContain("UPDATE user_company_roles");
  });
});
