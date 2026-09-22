import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  getActiveCompanyPermissionContext: vi.fn(),
  storage: {
    getUserCompaniesWithRoles: vi.fn(),
    getUser: vi.fn(),
    getAllCompanies: vi.fn(),
  },
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
  db: {
    select: vi.fn(),
  },
}));

vi.mock("../server/storage", () => ({ storage: harness.storage }));
vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/lib/logger", () => ({ logger: harness.logger }));
vi.mock("../server/services/security/activeCompanyPermissionContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/security/activeCompanyPermissionContext")>();
  return {
    ...actual,
    getActiveCompanyPermissionContext: harness.getActiveCompanyPermissionContext,
  };
});

import {
  isCrossCompanyReferenceRead,
  tenantCompanyParamBoundary,
  tenantIsolationBoundary,
} from "../server/middleware/tenantIsolationBoundary";
import {
  ActiveCompanyPermissionContextError,
  type ActiveCompanyPermissionContext,
} from "../server/services/security/activeCompanyPermissionContext";
import { getCompanyRequestRuntimeContext } from "../server/services/security/companyRequestRuntimeContext";
import { getDatabaseScopeRuntimeContext } from "../server/services/security/databaseScopeRuntimeContext";

function canonicalContext(overrides: Partial<ActiveCompanyPermissionContext> = {}): ActiveCompanyPermissionContext {
  return {
    userId: "user-1",
    companyId: 10,
    role: "Manager",
    developerBypass: false,
    assignedLocationId: null,
    cashAccountId: null,
    posStation: null,
    canSellNegativeStock: false,
    posViewOnly: false,
    daybookEditDays: 0,
    canAccessCustomers: false,
    canDeleteRecords: false,
    ...overrides,
  };
}

function request(
  input: {
    path?: string;
    method?: string;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    userId?: string | null;
    currentCompanyId?: number | null;
    currentRole?: string;
  } = {}
) {
  const path = input.path ?? "/api/vouchers";
  return {
    path,
    originalUrl: path,
    method: input.method ?? "GET",
    query: input.query ?? {},
    body: input.body ?? {},
    params: {},
    session: {
      userId: input.userId === undefined ? "user-1" : input.userId,
      currentCompanyId: input.currentCompanyId === undefined ? 10 : input.currentCompanyId,
      currentRole: input.currentRole ?? "Manager",
    },
  } as any;
}

function responseDouble() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((statusCode: number) => {
    res.statusCode = statusCode;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

async function runBoundary(req: any) {
  const res = responseDouble();
  let requestContext: unknown;
  let databaseContext: unknown;
  const next = vi.fn((error?: unknown) => {
    if (!error) {
      requestContext = getCompanyRequestRuntimeContext();
      databaseContext = getDatabaseScopeRuntimeContext();
    }
  });
  await tenantIsolationBoundary(req, res, next);
  return { res, next, requestContext, databaseContext };
}

describe("Phase 33E cross-company reference policy", () => {
  it("allows only the two explicit GET reference surfaces", () => {
    expect(isCrossCompanyReferenceRead("GET", "/api/locations")).toBe(true);
    expect(isCrossCompanyReferenceRead("get", "/api/ledger-accounts")).toBe(true);
    expect(isCrossCompanyReferenceRead("POST", "/api/locations")).toBe(false);
    expect(isCrossCompanyReferenceRead("GET", "/api/vouchers")).toBe(false);
  });
});

describe("Phase 33E global tenant isolation boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.getActiveCompanyPermissionContext.mockResolvedValue(canonicalContext());
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([{ companyId: 10, role: "Manager" }]);
    harness.storage.getUser.mockResolvedValue({ id: "user-1", role: "Manager" });
    harness.storage.getAllCompanies.mockResolvedValue([]);
  });

  it("ignores non-API, anonymous, and context-optional requests", async () => {
    const nonApi = await runBoundary(request({ path: "/assets/app.js" }));
    const anonymous = await runBoundary(request({ path: "/api/vouchers", userId: null }));
    const optional = await runBoundary(request({ path: "/api/csrf-token" }));

    expect(nonApi.next).toHaveBeenCalledOnce();
    expect(anonymous.next).toHaveBeenCalledOnce();
    expect(optional.next).toHaveBeenCalledOnce();
    expect(harness.getActiveCompanyPermissionContext).not.toHaveBeenCalled();
  });

  it("rejects malformed primary company ids with a stable 400 response", async () => {
    const { res, next } = await runBoundary(request({ query: { companyId: "bad" } }));

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      code: "COMPANY_ID_INVALID",
      message: "Invalid companyId in request query.",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects conflicting primary company ids before route execution", async () => {
    const { res, next } = await runBoundary(request({ query: { companyId: 10 }, body: { companyId: 20 } }));

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      code: "COMPANY_ID_CONFLICT",
      message: "All companyId values in the request must match.",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("allows the active company and installs active-company runtime scopes", async () => {
    const result = await runBoundary(request({ query: { companyId: 10 } }));

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.requestContext).toEqual(
      expect.objectContaining({
        userId: "user-1",
        companyId: 10,
        authorizedCompanyIds: [],
        role: "Manager",
      })
    );
    expect(result.databaseContext).toEqual({
      kind: "tenant",
      companyId: 10,
      authorizedCompanyIds: [],
      scopeMode: "active-company",
    });
  });

  it("denies a caller-supplied company override on an ordinary tenant route", async () => {
    const { res, next } = await runBoundary(request({ query: { companyId: 20 } }));

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "CROSS_COMPANY_ACCESS_DENIED" });
    expect(next).not.toHaveBeenCalled();
    expect(harness.logger.error).toHaveBeenCalledOnce();
  });

  it("keeps Developer pinned to the active company on ordinary tenant routes", async () => {
    harness.getActiveCompanyPermissionContext.mockResolvedValue(
      canonicalContext({ role: "Developer", developerBypass: true })
    );

    const { res, next } = await runBoundary(
      request({ path: "/api/vouchers", query: { companyId: 20 }, currentRole: "Developer" })
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "CROSS_COMPANY_ACCESS_DENIED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("allows Developer to add a user role to another company from the shared Users settings screen", async () => {
    harness.getActiveCompanyPermissionContext.mockResolvedValue(
      canonicalContext({ role: "Developer", developerBypass: true })
    );
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([{ companyId: 10, role: "Developer" }]);
    harness.storage.getUser.mockResolvedValue({ id: "user-1", role: "Developer" });
    harness.storage.getAllCompanies.mockResolvedValue([{ id: 10 }, { id: 20 }]);

    const result = await runBoundary(
      request({
        path: "/api/user-company-roles",
        method: "POST",
        body: { userId: "target-user", companyId: 20, role: "Admin" },
        currentRole: "Developer",
      })
    );

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.databaseContext).toEqual({
      kind: "tenant",
      companyId: 10,
      authorizedCompanyIds: [20],
      scopeMode: "authorized-companies",
    });
  });

  it("does not grant tenant Admin the Developer cross-company role-assignment exception", async () => {
    harness.getActiveCompanyPermissionContext.mockResolvedValue(canonicalContext({ role: "Admin" }));
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([
      { companyId: 10, role: "Admin" },
      { companyId: 20, role: "Admin" },
    ]);

    const { res, next } = await runBoundary(
      request({
        path: "/api/user-company-roles",
        method: "POST",
        body: { userId: "target-user", companyId: 20, role: "Manager" },
        currentRole: "Admin",
      })
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "CROSS_COMPANY_ACCESS_DENIED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("authorizes Developer POS location setup only for the company encoded in the route", async () => {
    harness.getActiveCompanyPermissionContext.mockResolvedValue(
      canonicalContext({ role: "Developer", developerBypass: true })
    );
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([{ companyId: 10, role: "Developer" }]);
    harness.storage.getUser.mockResolvedValue({ id: "user-1", role: "Developer" });
    harness.storage.getAllCompanies.mockResolvedValue([{ id: 10 }, { id: 20 }]);

    const result = await runBoundary(
      request({
        path: "/api/user-locations/target-user/20",
        method: "PUT",
        body: { locationIds: [200] },
        currentRole: "Developer",
      })
    );

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.databaseContext).toEqual({
      kind: "tenant",
      companyId: 10,
      authorizedCompanyIds: [20],
      scopeMode: "authorized-companies",
    });
  });

  it("requires a privileged role for the narrow cross-company reference reads", async () => {
    const { res, next } = await runBoundary(
      request({ path: "/api/locations", query: { companyId: 20 }, currentRole: "Manager" })
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      message: "Cross-company reference access requires Admin, Owner, or Developer",
      code: "CROSS_COMPANY_REFERENCE_FORBIDDEN",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("still requires canonical membership for an Admin cross-company reference read", async () => {
    harness.getActiveCompanyPermissionContext.mockResolvedValue(canonicalContext({ role: "Admin" }));
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([{ companyId: 10, role: "Admin" }]);
    harness.storage.getUser.mockResolvedValue({ id: "user-1", role: "Admin" });

    const { res } = await runBoundary(
      request({ path: "/api/ledger-accounts", query: { companyId: 20 }, currentRole: "Admin" })
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "COMPANY_ACCESS_DENIED" });
  });

  it("allows an assigned Admin reference read and narrows the database scope to that company", async () => {
    harness.getActiveCompanyPermissionContext.mockResolvedValue(canonicalContext({ role: "Admin" }));
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([
      { companyId: 10, role: "Admin" },
      { companyId: 20, role: "Owner" },
    ]);
    harness.storage.getUser.mockResolvedValue({ id: "user-1", role: "Admin" });

    const result = await runBoundary(
      request({ path: "/api/locations", query: { companyId: 20 }, currentRole: "Admin" })
    );

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.databaseContext).toEqual({
      kind: "tenant",
      companyId: 10,
      authorizedCompanyIds: [20],
      scopeMode: "authorized-companies",
    });
  });

  it("rejects malformed secondary intercompany company fields", async () => {
    const { res, next } = await runBoundary(request({ body: { targetCompanyId: "bad" } }));

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      message: "targetCompanyId must be a positive integer",
      code: "INVALID_COMPANY_ID",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("denies unassigned secondary companies even when the active company is valid", async () => {
    const { res, next } = await runBoundary(request({ body: { destinationCompanyId: 20 } }));

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "COMPANY_ACCESS_DENIED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("carries assigned secondary companies into the request database scope without widening route mode", async () => {
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([
      { companyId: 10, role: "Manager" },
      { companyId: 20, role: "Manager" },
    ]);
    const result = await runBoundary(request({ body: { sourceCompanyId: 20, destinationCompanyId: 20 } }));

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.databaseContext).toEqual({
      kind: "tenant",
      companyId: 10,
      authorizedCompanyIds: [20],
      scopeMode: "active-company",
    });
  });

  it("uses the full canonical assigned-company set only on a server-authorized global route", async () => {
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([
      { companyId: 30, role: "Manager" },
      { companyId: 10, role: "Manager" },
      { companyId: 20, role: "Owner" },
    ]);
    const result = await runBoundary(request({ path: "/api/global/transactions" }));

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.databaseContext).toEqual({
      kind: "tenant",
      companyId: 10,
      authorizedCompanyIds: [20, 30],
      scopeMode: "authorized-companies",
    });
  });

  it("returns canonical active-company context errors without falling through", async () => {
    harness.getActiveCompanyPermissionContext.mockRejectedValue(
      new ActiveCompanyPermissionContextError(
        "You no longer have access to the active company.",
        403,
        "ACTIVE_COMPANY_ROLE_REQUIRED"
      )
    );

    const { res, next } = await runBoundary(request());

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      code: "ACTIVE_COMPANY_ROLE_REQUIRED",
      message: "You no longer have access to the active company.",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("forwards unexpected middleware failures", async () => {
    const failure = new Error("unexpected context failure");
    harness.getActiveCompanyPermissionContext.mockRejectedValue(failure);

    const { next } = await runBoundary(request());

    expect(next).toHaveBeenCalledWith(failure);
  });
});

describe("Phase 33E :companyId path boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.getActiveCompanyPermissionContext.mockResolvedValue(canonicalContext());
  });

  async function runParam(req: any, raw: string) {
    const res = responseDouble();
    const next = vi.fn();
    await tenantCompanyParamBoundary(req, res, next, raw);
    return { res, next };
  }

  it("skips anonymous requests and the set-company route", async () => {
    const anonymous = await runParam(request({ userId: null }), "20");
    const setCompany = await runParam(request({ path: "/api/auth/set-company", method: "POST" }), "20");

    expect(anonymous.next).toHaveBeenCalledOnce();
    expect(setCompany.next).toHaveBeenCalledOnce();
    expect(harness.getActiveCompanyPermissionContext).not.toHaveBeenCalled();
  });

  it("rejects an invalid path company id", async () => {
    const { res, next } = await runParam(request(), "not-an-id");

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ code: "COMPANY_ID_INVALID", message: "Invalid companyId in request path." });
    expect(next).not.toHaveBeenCalled();
  });

  it("allows the active company and denies a different path company", async () => {
    const allowed = await runParam(request(), "10");
    const denied = await runParam(request(), "20");

    expect(allowed.next).toHaveBeenCalledOnce();
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.body).toMatchObject({ code: "CROSS_COMPANY_ACCESS_DENIED" });
    expect(denied.next).not.toHaveBeenCalled();
  });

  it("allows Developer path-company access only for user location administration", async () => {
    harness.getActiveCompanyPermissionContext.mockResolvedValue(
      canonicalContext({ role: "Developer", developerBypass: true })
    );
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([{ companyId: 10, role: "Developer" }]);
    harness.storage.getUser.mockResolvedValue({ id: "user-1", role: "Developer" });
    harness.storage.getAllCompanies.mockResolvedValue([{ id: 10 }, { id: 20 }]);

    const allowed = await runParam(
      request({ path: "/api/user-locations/target-user/20", method: "PUT", currentRole: "Developer" }),
      "20"
    );
    expect(allowed.next).toHaveBeenCalledOnce();

    const denied = await runParam(
      request({ path: "/api/companies/20/member-ids", method: "GET", currentRole: "Developer" }),
      "20"
    );
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.body).toMatchObject({ code: "CROSS_COMPANY_ACCESS_DENIED" });
    expect(denied.next).not.toHaveBeenCalled();
  });

  it("returns canonical context errors and forwards unknown errors", async () => {
    harness.getActiveCompanyPermissionContext.mockRejectedValueOnce(
      new ActiveCompanyPermissionContextError("Missing company role", 403, "ACTIVE_COMPANY_ROLE_REQUIRED")
    );
    const canonical = await runParam(request(), "10");
    expect(canonical.res.statusCode).toBe(403);
    expect(canonical.res.body).toMatchObject({ code: "ACTIVE_COMPANY_ROLE_REQUIRED" });

    const failure = new Error("param failure");
    harness.getActiveCompanyPermissionContext.mockRejectedValueOnce(failure);
    const unexpected = await runParam(request(), "10");
    expect(unexpected.next).toHaveBeenCalledWith(failure);
  });
});
