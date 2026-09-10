import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("company deletion safety contract", () => {
  it("uses the dependency-aware deletion service as the canonical storage implementation", () => {
    const storage = source("server/storage.ts");

    expect(storage).toContain('import * as companyDeletion from "./storage/company-deletion"');
    expect(storage).toContain("...companyDeletion");
    expect(storage.indexOf("...companyDeletion")).toBeGreaterThan(storage.indexOf("...auth"));
  });

  it("derives company-owned cleanup from the live FK graph and performs it atomically", () => {
    const deletion = source("server/storage/company-deletion.ts");

    expect(deletion).toContain("pg_constraint");
    expect(deletion).toContain("constraint_row.confdeltype");
    expect(deletion).toContain('columns.has("company_id")');
    expect(deletion).toContain('columnsByTable.get(foreignKey.childTable)?.has("company_id")');
    expect(deletion).toContain('client.query("BEGIN")');
    expect(deletion).toContain('client.query("COMMIT")');
    expect(deletion).toContain('client.query("ROLLBACK")');
    expect(deletion).toContain("buildDeletionOrder");
    expect(deletion).toContain("restrictive foreign keys form a cycle");
  });

  it("preserves outside-company rows unless a nullable link can be detached safely", () => {
    const deletion = source("server/storage/company-deletion.ts");

    expect(deletion).toContain("detachNullableCompanyReferences");
    expect(deletion).toContain("detachOrRejectExternalRestrictiveReferences");
    expect(deletion).toContain("NOT COALESCE");
    expect(deletion).toContain("No data was deleted");
    expect(deletion).toContain('pgError?.code !== "23503"');
    expect(deletion).toContain("parent_company_id = NULL");
  });

  it("widens RLS only to already-authorized companies for the delete operation", () => {
    const routes = source("server/routes/auth/companyAccessRoutes.ts");

    expect(routes).toContain("resolveAuthorizedCompanyId(req, req.params.id)");
    expect(routes).toContain("getAccessibleCompanyIds(req.user.id)");
    expect(routes).toContain("createTenantDatabaseScope");
    expect(routes).toContain('"authorized-companies"');
    expect(routes).toContain("runWithDatabaseScopeRuntimeContext");
    expect(routes).toContain("ACTIVE_COMPANY_DELETE_FORBIDDEN");
  });
});
