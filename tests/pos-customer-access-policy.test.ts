import { beforeEach, describe, expect, it, vi } from "vitest";
import { canCreatePosCustomers, canViewPosCustomers, hasZeroOpeningBalance } from "../shared/posCustomerAccess";

const harness = vi.hoisted(() => ({ getContext: vi.fn() }));

vi.mock("../server/services/security/activeCompanyPermissionContext", () => {
  class ActiveCompanyPermissionContextError extends Error {
    constructor(message: string, readonly status: number, readonly code: string) {
      super(message);
    }
  }
  return {
    getActiveCompanyPermissionContext: harness.getContext,
    ActiveCompanyPermissionContextError,
  };
});

import { requirePosCustomerPermission } from "../server/middleware/posCustomerPermission";

const cashier = {
  userId: "cashier",
  companyId: 10,
  role: "POS",
  canAccessCustomers: true,
  posViewOnly: false,
  developerBypass: false,
};

async function check(method: string) {
  const response = {
    code: 200,
    body: null as unknown,
    status(code: number) {
      this.code = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const next = vi.fn();
  await requirePosCustomerPermission({ method } as any, response as any, next);
  return { response, next };
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.getContext.mockResolvedValue({ ...cashier });
});

describe("Zambia POS customer permission policy", () => {
  it("permits enabled cashiers to both view and create customers", () => {
    expect(canViewPosCustomers(cashier)).toBe(true);
    expect(canCreatePosCustomers(cashier)).toBe(true);
  });

  it("denies POS users whose company flag is disabled, including direct API calls", async () => {
    harness.getContext.mockResolvedValue({ ...cashier, canAccessCustomers: false });
    for (const method of ["GET", "POST"]) {
      const { response, next } = await check(method);
      expect(response.code).toBe(403);
      expect(response.body).toMatchObject({ code: "POS_CUSTOMERS_ACCESS_DENIED" });
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("uses the live role rather than a stale request/session permission", async () => {
    const req = { method: "POST", user: { canAccessCustomers: false }, session: { canAccessCustomers: false } };
    const next = vi.fn();
    const res = { status: vi.fn(), json: vi.fn() };
    await requirePosCustomerPermission(req as any, res as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("prevents all writes for POS view-only, Create Only and View Only roles", async () => {
    for (const flags of [
      { ...cashier, posViewOnly: true },
      { ...cashier, role: "Create Only" },
      { ...cashier, role: "View Only" },
    ]) {
      expect(canViewPosCustomers(flags)).toBe(true);
      expect(canCreatePosCustomers(flags)).toBe(false);
      harness.getContext.mockResolvedValue(flags);
      const { response, next } = await check("POST");
      expect(response.code).toBe(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("developer bypass remains intact, but not missing company access", async () => {
    harness.getContext.mockResolvedValue({
      ...cashier,
      role: "Developer",
      canAccessCustomers: false,
      developerBypass: true,
    });
    expect((await check("POST")).next).toHaveBeenCalledOnce();
    harness.getContext.mockRejectedValueOnce(new Error("database offline"));
    const next = vi.fn();
    await requirePosCustomerPermission({ method: "GET" } as any, {} as any, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it("only permits no opening balance or an exact numeric zero", () => {
    for (const value of [undefined, null, "", "0", "0.00", 0]) {
      expect(hasZeroOpeningBalance(value)).toBe(true);
    }
    for (const value of ["1.00", "-10", "oops", NaN, {}, "Infinity", "0.01"]) {
      expect(hasZeroOpeningBalance(value)).toBe(false);
    }
  });
});
