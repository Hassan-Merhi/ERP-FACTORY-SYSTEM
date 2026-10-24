import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (name: string) => fs.readFileSync(path.join(root, name), "utf8");

describe("Phase 2 permission API security registration contract", () => {
  const routes = read("server/routes/admin/permissionControlCenterRoutes.ts");
  const registrar = read("server/routes/adminRoutes.ts");
  const migration = read("migrations/20261024_001_permissions_control_center_shadow.sql");
  const store = read("server/services/security/accessControlV2Store.ts");

  it("registers all seven routes with active-session authentication", () => {
    const signatures = [
      'app.get("/api/permissions-v2/catalog", requireAuth',
      'app.get("/api/permissions-v2/roles", requireAuth',
      'app.get("/api/permissions-v2/users/:userId/overrides", requireAuth',
      'app.get("/api/permissions-v2/preview", requireAuth',
      'app.get("/api/permissions-v2/audit", requireAuth',
      'app.put("/api/permissions-v2/role-rules", requireAuth',
      'app.put("/api/permissions-v2/user-overrides", requireAuth',
    ];
    for (const route of signatures) expect(routes, route).toContain(route);
    expect(registrar).toContain("registerPermissionControlCenterRoutes(app)");
    expect(routes).toContain("getActiveCompanyPermissionContext(req)");
    expect(routes).toContain('c.role !== "Admin" && c.role !== "Developer"');
    expect(routes).not.toContain("req.body.companyId");
  });

  it("requires conditional revision saves and blocks admin/self modifications", () => {
    expect(store).toContain("FOR UPDATE");
    expect(store).toContain("POLICY_STALE_REVISION");
    expect(store).toContain("SELF_ESCALATION_FORBIDDEN");
    expect(store).toContain("SYSTEM_ROLE_LOCKED");
    expect(store).toContain("COMMIT");
    expect(store).toContain("ROLLBACK");
    expect(store).toContain("INSERT INTO access_policy_change_audit");
    expect(store).not.toContain("UPDATE role_feature_permissions");
  });

  it("keeps schema additive, forced-company-RLS and audit append-only", () => {
    for (const table of [
      "access_role_templates", "access_role_rules", "access_user_overrides",
      "access_policy_versions", "access_policy_change_audit",
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("erp_company_scope_matches(company_id)");
    expect(migration).toContain("ACCESS_OVERRIDE_COMPANY_ROLE_REQUIRED");
    expect(migration).toContain("ACCESS_POLICY_AUDIT_APPEND_ONLY");
    expect(migration).not.toMatch(/(?:UPDATE|DELETE)\s+(?:FROM\s+)?(?:vouchers|voucher_entries|inventory|role_feature_permissions)\b/i);
  });

  it("never activates live policy or claims candidate action verified", () => {
    expect(store).toContain('mode: "shadow"');
    expect(routes).toContain("currentlyEnforcedByV2");
    expect(routes).toContain('enforced: false');
  });
});
