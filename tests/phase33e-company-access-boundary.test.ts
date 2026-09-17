import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  storage: {
    getUserCompaniesWithRoles: vi.fn(),
    getUser: vi.fn(),
    getAllCompanies: vi.fn(),
  },
}));

vi.mock("../server/storage", () => ({ storage: harness.storage }));

import {
  CompanyAccessError,
  assertActiveCompanyAccess,
  assertCompaniesAccess,
  assertCompanyAccess,
  getAccessibleCompanyIds,
  getCompanyAccessContext,
  isPrivilegedRole,
  parsePositiveCompanyId,
  resolveAuthorizedCompanyId,
  sendCompanyAccessError,
} from "../server/security/companyAccessBoundary";

function req(
  input: {
    userId?: string;
    currentCompanyId?: unknown;
    currentRole?: string;
    user?: { id?: string; role?: string };
  } = {}
) {
  return {
    session: {
      userId: input.userId ?? "user-1",
      currentCompanyId: input.currentCompanyId ?? 10,
      currentRole: input.currentRole ?? "Manager",
    },
    user: input.user,
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

describe("Phase 33E company access boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([]);
    harness.storage.getUser.mockResolvedValue({ id: "user-1", role: "Manager" });
    harness.storage.getAllCompanies.mockResolvedValue([]);
  });

  it("parses only positive integer company ids and returns structured validation errors", () => {
    expect(parsePositiveCompanyId(7)).toBe(7);
    expect(parsePositiveCompanyId("8", "targetCompanyId")).toBe(8);

    for (const value of [0, -1, 1.5, "", "abc", null, undefined]) {
      expect(() => parsePositiveCompanyId(value)).toThrowError(CompanyAccessError);
    }

    try {
      parsePositiveCompanyId("bad", "sourceCompanyId");
      throw new Error("expected validation error");
    } catch (error) {
      expect(error).toMatchObject({
        status: 400,
        code: "INVALID_COMPANY_ID",
        message: "sourceCompanyId must be a positive integer",
      });
    }
  });

  it("builds access context from the authenticated session and rejects missing authentication", () => {
    expect(getCompanyAccessContext(req())).toEqual({
      userId: "user-1",
      activeCompanyId: 10,
      role: "Manager",
    });

    expect(() =>
      getCompanyAccessContext(
        req({
          userId: "",
          currentCompanyId: 10,
          currentRole: "Manager",
          user: { id: "", role: "Manager" },
        })
      )
    ).toThrowError(expect.objectContaining({ code: "AUTH_REQUIRED", status: 401 }));
  });

  it("recognizes only Admin, Owner and Developer as privileged cross-company roles", () => {
    expect(isPrivilegedRole("Admin")).toBe(true);
    expect(isPrivilegedRole("Owner")).toBe(true);
    expect(isPrivilegedRole("Developer")).toBe(true);
    expect(isPrivilegedRole("Manager")).toBe(false);
    expect(isPrivilegedRole("POS")).toBe(false);
    expect(isPrivilegedRole(undefined)).toBe(false);
  });

  it("limits ordinary users to explicit company-role assignments and filters invalid ids", async () => {
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([
      { companyId: 10, role: "Manager" },
      { companyId: "11", role: "Owner" },
      { companyId: 0, role: "Manager" },
      { companyId: "bad", role: "Manager" },
    ]);

    await expect(getAccessibleCompanyIds("user-1")).resolves.toEqual(new Set([10, 11]));
    expect(harness.storage.getAllCompanies).not.toHaveBeenCalled();
  });

  it("gives a per-company Developer canonical access to every valid company", async () => {
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([{ companyId: 10, role: "Developer" }]);
    harness.storage.getAllCompanies.mockResolvedValue([{ id: 1 }, { id: "2" }, { id: 0 }, { id: -5 }, { id: "bad" }]);

    await expect(getAccessibleCompanyIds("dev-1")).resolves.toEqual(new Set([1, 2]));
    expect(harness.storage.getUser).not.toHaveBeenCalled();
  });

  it("honors an account-level Developer even when no company-role row says Developer", async () => {
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([{ companyId: 10, role: "Manager" }]);
    harness.storage.getUser.mockResolvedValue({ id: "dev-2", role: "Developer" });
    harness.storage.getAllCompanies.mockResolvedValue([{ id: 10 }, { id: 20 }, { id: 30 }]);

    await expect(getAccessibleCompanyIds("dev-2")).resolves.toEqual(new Set([10, 20, 30]));
  });

  it("allows assigned companies and denies unassigned single or multi-company requests", async () => {
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([
      { companyId: 10, role: "Manager" },
      { companyId: 20, role: "Manager" },
    ]);

    await expect(assertCompanyAccess("user-1", 10)).resolves.toBeUndefined();
    await expect(assertCompaniesAccess("user-1", [10, 20, 20])).resolves.toBeUndefined();

    await expect(assertCompanyAccess("user-1", 30)).rejects.toMatchObject({
      status: 403,
      code: "COMPANY_ACCESS_DENIED",
      message: "No access to this company",
    });
    await expect(assertCompaniesAccess("user-1", [10, 30])).rejects.toMatchObject({
      status: 403,
      code: "COMPANY_ACCESS_DENIED",
      message: "No access to one or more companies",
    });
  });

  it("blocks cross-company overrides before storage for non-privileged roles", async () => {
    await expect(resolveAuthorizedCompanyId(req({ currentRole: "Manager" }), 20)).rejects.toMatchObject({
      status: 403,
      code: "CROSS_COMPANY_FORBIDDEN",
    });
    expect(harness.storage.getUserCompaniesWithRoles).not.toHaveBeenCalled();
  });

  it("allows privileged cross-company overrides only when canonical membership also permits them", async () => {
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([
      { companyId: 10, role: "Admin" },
      { companyId: 20, role: "Admin" },
    ]);

    await expect(resolveAuthorizedCompanyId(req({ currentRole: "Admin" }), 20)).resolves.toBe(20);
    await expect(resolveAuthorizedCompanyId(req({ currentRole: "Admin" }), 30)).rejects.toMatchObject({
      code: "COMPANY_ACCESS_DENIED",
    });
  });

  it("uses the active company when no override is supplied and still verifies membership", async () => {
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([{ companyId: 10, role: "Manager" }]);

    await expect(resolveAuthorizedCompanyId(req(), undefined)).resolves.toBe(10);
    await expect(assertActiveCompanyAccess(req())).resolves.toEqual({
      userId: "user-1",
      activeCompanyId: 10,
      role: "Manager",
    });

    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([{ companyId: 20, role: "Manager" }]);
    await expect(assertActiveCompanyAccess(req())).rejects.toMatchObject({ code: "COMPANY_ACCESS_DENIED" });
  });

  it("verifies a Developer active company through the same canonical company set", async () => {
    harness.storage.getUserCompaniesWithRoles.mockResolvedValue([{ companyId: 99, role: "Developer" }]);
    harness.storage.getAllCompanies.mockResolvedValue([{ id: 10 }, { id: 20 }]);

    await expect(assertActiveCompanyAccess(req({ currentRole: "Developer", currentCompanyId: 20 }))).resolves.toEqual({
      userId: "user-1",
      activeCompanyId: 20,
      role: "Developer",
    });
  });

  it("serializes structured company errors without leaking unknown failures", () => {
    const structured = responseDouble();
    sendCompanyAccessError(structured, new CompanyAccessError(403, "Denied", "COMPANY_ACCESS_DENIED"));
    expect(structured.statusCode).toBe(403);
    expect(structured.body).toEqual({ message: "Denied", code: "COMPANY_ACCESS_DENIED" });

    const generic = responseDouble();
    sendCompanyAccessError(generic, new Error("database unavailable"), 502);
    expect(generic.statusCode).toBe(502);
    expect(generic.body).toEqual({ message: "database unavailable", code: "COMPANY_CONTEXT_FAILED" });

    const nonError = responseDouble();
    sendCompanyAccessError(nonError, "failure");
    expect(nonError.statusCode).toBe(500);
    expect(nonError.body).toEqual({ message: "Request failed", code: "COMPANY_CONTEXT_FAILED" });
  });
});
