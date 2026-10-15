import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  select: vi.fn(),
  assertCompanyAccess: vi.fn(),
}));

vi.mock("../server/db", () => ({ db: { select: harness.select } }));

vi.mock("../server/security/companyAccessBoundary", async () => {
  const actual = await vi.importActual<typeof import("../server/security/companyAccessBoundary")>(
    "../server/security/companyAccessBoundary"
  );
  return {
    ...actual,
    assertCompanyAccess: harness.assertCompanyAccess,
  };
});

const { runWithCompanyRequestRuntimeContext } =
  await import("../server/services/security/companyRequestRuntimeContext");
const { createTenantDatabaseScope, runWithDatabaseScopeRuntimeContext, getDatabaseScopeRuntimeContext } =
  await import("../server/services/security/databaseScopeRuntimeContext");
const { CompanyAccessError } = await import("../server/security/companyAccessBoundary");
const { runWithVerifiedParentCompanyScope, runWithVerifiedPoParentScope, ParentCompanyPostingScopeError } =
  await import("../server/services/security/parentCompanyPostingScope");

const ACTIVE_COMPANY_ID = 41;
const PARENT_COMPANY_ID = 7;

function requestContext(companyId = ACTIVE_COMPANY_ID) {
  return {
    userId: "parent-posting-user",
    companyId,
    authorizedCompanyIds: [] as readonly number[],
    role: "Admin",
    developerBypass: false,
    method: "POST",
    path: "/api/po-import/import",
  };
}

/** `db.select().from().where().limit()` resolving to the given rows. */
function parentLinkRows(rows: Array<{ id?: number; parentCompanyId?: number | null }>) {
  harness.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  });
}

function runInRequest<T>(run: () => Promise<T>, companyId = ACTIVE_COMPANY_ID): Promise<T> {
  return runWithCompanyRequestRuntimeContext(requestContext(companyId), () =>
    runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(companyId, [], "active-company"), run)
  );
}

describe("parent company posting scope", () => {
  it("re-pins the database scope to the parent once the link and membership check out", async () => {
    parentLinkRows([{ id: ACTIVE_COMPANY_ID }]);
    harness.assertCompanyAccess.mockResolvedValue(undefined);

    const scopeInside = await runInRequest(() =>
      runWithVerifiedParentCompanyScope(PARENT_COMPANY_ID, async () => getDatabaseScopeRuntimeContext())
    );

    expect(scopeInside).toMatchObject({ kind: "tenant", companyId: PARENT_COMPANY_ID });
  });

  it("restores the active company scope after the parent posting finishes", async () => {
    parentLinkRows([{ id: ACTIVE_COMPANY_ID }]);
    harness.assertCompanyAccess.mockResolvedValue(undefined);

    const scopeAfter = await runInRequest(async () => {
      await runWithVerifiedParentCompanyScope(PARENT_COMPANY_ID, async () => undefined);
      return getDatabaseScopeRuntimeContext();
    });

    expect(scopeAfter).toMatchObject({ kind: "tenant", companyId: ACTIVE_COMPANY_ID });
  });

  it("reports a membership denial as a 403 rather than letting it surface as a fault", async () => {
    parentLinkRows([{ id: ACTIVE_COMPANY_ID }]);
    // Access to the active subsidiary, none to its parent: the boundary throws its own error type.
    harness.assertCompanyAccess.mockRejectedValue(
      new CompanyAccessError(403, "No access to this company", "COMPANY_ACCESS_DENIED")
    );
    const run = vi.fn();

    const error = await runInRequest(() =>
      runWithVerifiedParentCompanyScope(PARENT_COMPANY_ID, run).catch((caught: unknown) => caught)
    );

    expect(error).toBeInstanceOf(ParentCompanyPostingScopeError);
    expect((error as ParentCompanyPostingScopeError).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a company that is not the active company's recorded parent", async () => {
    parentLinkRows([]);
    harness.assertCompanyAccess.mockResolvedValue(undefined);
    const run = vi.fn();

    const error = await runInRequest(() =>
      runWithVerifiedParentCompanyScope(PARENT_COMPANY_ID, run).catch((caught: unknown) => caught)
    );

    expect(error).toBeInstanceOf(ParentCompanyPostingScopeError);
    expect((error as ParentCompanyPostingScopeError).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to run outside a tenant request scope, so background work cannot widen itself", async () => {
    parentLinkRows([{ id: ACTIVE_COMPANY_ID }]);
    harness.assertCompanyAccess.mockResolvedValue(undefined);
    const run = vi.fn();

    const error = await runWithVerifiedParentCompanyScope(PARENT_COMPANY_ID, run).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ParentCompanyPostingScopeError);
    expect(run).not.toHaveBeenCalled();
  });
  it("opens the verified child and parent in one authorized transaction scope", async () => {
    parentLinkRows([{ parentCompanyId: PARENT_COMPANY_ID }]);
    harness.assertCompanyAccess.mockResolvedValue(undefined);
    const value = await runInRequest(() =>
      runWithVerifiedPoParentScope(ACTIVE_COMPANY_ID, async (parentCompanyId) => ({
        parentCompanyId,
        scope: getDatabaseScopeRuntimeContext(),
      }))
    );
    expect(value.parentCompanyId).toBe(PARENT_COMPANY_ID);
    expect(value.scope).toMatchObject({
      kind: "tenant",
      companyId: ACTIVE_COMPANY_ID,
      scopeMode: "authorized-companies",
    });
    expect(value.scope?.kind === "tenant" && value.scope.authorizedCompanyIds).toContain(PARENT_COMPANY_ID);
    expect(harness.assertCompanyAccess).toHaveBeenCalledWith("parent-posting-user", PARENT_COMPANY_ID);
  });

  it("leaves standalone companies in their original tenant scope", async () => {
    parentLinkRows([{ parentCompanyId: null }]);
    const value = await runInRequest(() =>
      runWithVerifiedPoParentScope(ACTIVE_COMPANY_ID, async (parentCompanyId) => ({
        parentCompanyId,
        scope: getDatabaseScopeRuntimeContext(),
      }))
    );
    expect(value.parentCompanyId).toBeNull();
    expect(value.scope).toMatchObject({ companyId: ACTIVE_COMPANY_ID, scopeMode: "active-company" });
  });

  it("rejects parent-side edits when the child user lacks parent membership", async () => {
    parentLinkRows([{ parentCompanyId: PARENT_COMPANY_ID }]);
    harness.assertCompanyAccess.mockRejectedValue(new CompanyAccessError(403, "No access", "COMPANY_ACCESS_DENIED"));
    const performEdit = vi.fn();
    await expect(
      runInRequest(() => runWithVerifiedPoParentScope(ACTIVE_COMPANY_ID, performEdit))
    ).rejects.toMatchObject({ status: 403 });
    expect(performEdit).not.toHaveBeenCalled();
  });
});
